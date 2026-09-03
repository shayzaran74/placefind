import crypto from 'crypto';
import { Request, Response } from 'express';
import mongoose, { FilterQuery } from 'mongoose';
import { Venue, IVenueDocument } from '../models/Venue';
import { searchPlaces, providerStatus } from '../providers';
import { EnrichmentService } from '../services/enrichment.service';
import { ExporterService, ExportFormat } from '../services/exporter.service';
import { ImageService } from '../services/image.service';
import {
  enqueueScrape,
  enqueueDiscovery,
  getScrapeQueue,
  getQueueStats,
  isDiscoverJob,
} from '../queue/scrape.queue';
import { ApiError, asyncHandler } from '../middleware/error';
import { IGooglePlaceRaw } from '../services/googlePlaces.service';

const MAX_EXPORT = 5000;
const MAX_INGEST_URLS = 25;

/**
 * Stable id for a venue we know only by URL.
 *
 * Derived from the origin plus path so the same menu ingested twice updates one
 * row instead of forking a duplicate, and so the id survives tracking query
 * strings a QR code might carry (`?utm_source=qr`).
 */
export function urlPlaceId(url: URL): string {
  const key = `${url.origin}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  return `web_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}`;
}

/**
 * Provisional name until the page states its own. The hostname is what the
 * operator recognises in the job list; the scan replaces it.
 */
function hostLabel(url: URL): string {
  return url.hostname.replace(/^www\./i, '');
}

/** Accepts "example.com/menu" as readily as a full URL. */
export function parseIngestUrl(raw: unknown): URL {
  const text = String(raw ?? '').trim();
  if (!text) throw new ApiError(400, 'A menu or website URL is required');

  let candidate: URL;
  try {
    candidate = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new ApiError(400, `"${text}" is not a valid URL`);
  }

  if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') {
    throw new ApiError(400, `Only http(s) URLs can be ingested, got "${candidate.protocol}"`);
  }
  if (!candidate.hostname.includes('.')) {
    throw new ApiError(400, `"${text}" has no resolvable host`);
  }

  return candidate;
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: unknown): boolean | undefined {
  if (value === undefined || value === '' || value === 'all') return undefined;
  return ['1', 'true', 'yes'].includes(String(value).toLowerCase());
}

/** Builds a Mongo filter from the dashboard's query parameters. */
function buildFilter(query: Record<string, any>): FilterQuery<IVenueDocument> {
  const filter: FilterQuery<IVenueDocument> = {};

  if (query.city) filter['address.city'] = new RegExp(`^${String(query.city).trim()}`, 'i');
  if (query.district) filter['address.district'] = new RegExp(`^${String(query.district).trim()}`, 'i');
  if (query.type) filter.primary_type = String(query.type);
  if (query.provider) filter['digital_presence.qr_menu_provider'] = String(query.provider);
  if (query.source) filter.data_source = String(query.source);
  if (query.provider_name) filter.provider = String(query.provider_name);
  if (query.status) filter['enrichment.status'] = String(query.status);

  const hasQrMenu = bool(query.has_qr_menu);
  if (hasQrMenu !== undefined) filter['digital_presence.has_qr_menu'] = hasQrMenu;

  const hasWebsite = bool(query.has_website);
  if (hasWebsite !== undefined) filter['digital_presence.has_website'] = hasWebsite;

  const hasOrdering = bool(query.supports_online_ordering);
  if (hasOrdering !== undefined) filter['digital_presence.supports_online_ordering'] = hasOrdering;

  const hasEmail = bool(query.has_email);
  if (hasEmail === true) filter['contacts.emails.0'] = { $exists: true };
  if (hasEmail === false) filter['contacts.emails.0'] = { $exists: false };

  if (query.min_rating) filter.rating = { $gte: num(query.min_rating, 0) };
  if (query.q) filter.name = new RegExp(String(query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  return filter;
}

function sendExport(res: Response, venues: IVenueDocument[], format: ExportFormat, filename: string): void {
  if (format === 'xml') {
    res.header('Content-Type', 'application/xml; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="${filename}.xml"`);
    res.send(ExporterService.manyToXML(venues));
    return;
  }

  if (format === 'csv') {
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.send(ExporterService.manyToCSV(venues));
    return;
  }

  res.header('Content-Type', 'application/json; charset=utf-8');
  res.send(ExporterService.manyToJSON(venues));
}

export class VenueController {
  /**
   * POST /api/v1/venues/search
   * GEO or city/keyword scan. Dispatches enrichment to the Redis worker queue
   * when available, otherwise processes inline.
   */
  public static searchAndEnrichVenues = asyncHandler(async (req: Request, res: Response) => {
    const {
      lat,
      lng,
      radius,
      keyword,
      city,
      query,
      provider,
      max_results,
      async: asyncMode,
      force,
      include_photos,
    } = req.body || {};

    const latitude = num(lat, 40.9876);
    const longitude = num(lng, 29.0234);
    const rad = Math.min(Math.max(num(radius, 2000), 1), 50000);

    if (latitude < -90 || latitude > 90) throw new ApiError(400, 'lat must be between -90 and 90');
    if (longitude < -180 || longitude > 180) throw new ApiError(400, 'lng must be between -180 and 180');

    // A free-text query (or a city without coordinates) drives a text search.
    const textQuery = query || (city && lat === undefined ? `${keyword || 'restaurant cafe'} ${city}` : undefined);
    const maxResults = Math.min(120, Math.max(1, Math.trunc(num(max_results, 20))));
    const useQueue = asyncMode !== false;

    // Discovery runs in the worker: only that image ships Chromium, and a Maps
    // scrape takes ~30s, which must not block an HTTP request.
    if (useQueue) {
      const discoveryJobId = await enqueueDiscovery({
        lat: latitude,
        lng: longitude,
        radius: rad,
        keyword,
        query: textQuery ? String(textQuery) : undefined,
        maxResults,
        provider: provider ? String(provider) : undefined,
        force: Boolean(force),
        includePhotos: Boolean(include_photos),
      });

      if (discoveryJobId) {
        res.status(202).json({
          status: 'accepted',
          mode: 'queued',
          job_id: discoveryJobId,
          provider: provider || 'default chain',
          message:
            'Discovery queued. The worker scrapes the provider chain, then enriches each venue. ' +
            'Poll /api/v1/venues/jobs/:jobId or GET /api/v1/venues.',
        });
        return;
      }
    }

    // Redis unavailable (or async disabled): run the whole pipeline inline.
    const result = await searchPlaces({
      lat: latitude,
      lng: longitude,
      radius: rad,
      keyword,
      query: textQuery ? String(textQuery) : undefined,
      maxResults,
      provider: provider ? String(provider) : undefined,
    });

    const warnings: string[] = result.warning ? [result.warning] : [];
    if (useQueue) warnings.push('Redis queue unavailable - the scan ran synchronously.');
    for (const attempt of result.attempted || []) {
      warnings.push(`${attempt.provider}: ${attempt.reason}`);
    }

    if (result.blocked) {
      res.status(503).json({
        status: 'error',
        provider: result.provider,
        blocked: true,
        warnings,
        message: result.warning || 'No place provider could serve this request.',
      });
      return;
    }

    const reports = [];
    for (const place of result.places) {
      reports.push(
        await EnrichmentService.enrichPlace(place, result.source, {
          provider: result.provider,
          force: Boolean(force),
          includePhotos: Boolean(include_photos),
        })
      );
    }

    const venues = await Venue.find({
      google_place_id: { $in: result.places.map((p) => p.place_id) },
    }).lean();

    res.json({
      status: 'success',
      mode: 'sync',
      count: venues.length,
      data_source: result.source,
      provider: result.provider,
      warnings,
      reports,
      data: venues,
    });
  });

  /**
   * POST /api/v1/venues/ingest
   * Ingests venues the operator already knows the address of: `{ url }` or
   * `{ urls: [...] }`.
   *
   * The full enrichment pipeline runs unchanged - website audit, menu crawl,
   * WebP conversion - so a URL-sourced venue is queryable and exportable
   * exactly like a Maps-discovered one. What differs is provenance: these rows
   * carry `data_source: "web_menu"` and no Google place id.
   */
  public static ingestUrls = asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    const rawUrls: unknown[] = Array.isArray(body.urls)
      ? body.urls
      : body.url !== undefined
        ? [body.url]
        : [];

    if (!rawUrls.length) throw new ApiError(400, 'Provide "url" or a non-empty "urls" array');
    if (rawUrls.length > MAX_INGEST_URLS) {
      throw new ApiError(400, `At most ${MAX_INGEST_URLS} URLs per request, got ${rawUrls.length}`);
    }

    const lat = body.lat !== undefined ? num(body.lat, NaN) : undefined;
    const lng = body.lng !== undefined ? num(body.lng, NaN) : undefined;
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lng);
    if ((lat !== undefined || lng !== undefined) && !hasPoint) {
      throw new ApiError(400, 'lat and lng must be supplied together as numbers');
    }
    if (hasPoint && (lat! < -90 || lat! > 90 || lng! < -180 || lng! > 180)) {
      throw new ApiError(400, 'lat/lng out of range');
    }

    // Only meaningful for a single URL: one coordinate pair cannot describe
    // several different venues.
    if (hasPoint && rawUrls.length > 1) {
      throw new ApiError(400, 'lat/lng may only be given when ingesting a single URL');
    }

    const name = body.name ? String(body.name).trim() : undefined;
    if (name && rawUrls.length > 1) {
      throw new ApiError(400, 'name may only be given when ingesting a single URL');
    }

    const force = Boolean(body.force);
    const includePhotos = Boolean(body.include_photos);
    const maxMenuPages = body.max_pages !== undefined
      ? Math.min(60, Math.max(1, Math.trunc(num(body.max_pages, 20))))
      : undefined;
    const useQueue = body.async !== false;

    const places: IGooglePlaceRaw[] = rawUrls.map((raw) => {
      const url = parseIngestUrl(raw);
      return {
        place_id: urlPlaceId(url),
        name: name || hostLabel(url),
        website: url.toString(),
        types: ['restaurant'],
        ...(hasPoint ? { geometry: { location: { lat: lat!, lng: lng! } } } : {}),
      };
    });

    const jobOptions = {
      provider: 'web_menu',
      force,
      includePhotos,
      preferScannedName: !name,
      maxMenuPages,
    };

    // Queued by default: a crawl walks every section page of the menu, which
    // takes far longer than an HTTP request should.
    if (useQueue) {
      const queued: Array<{ url: string; place_id: string; job_id: string }> = [];
      for (const place of places) {
        const jobId = await enqueueScrape({ place, source: 'web_menu', ...jobOptions });
        if (!jobId) break;
        queued.push({ url: place.website!, place_id: place.place_id, job_id: jobId });
      }

      if (queued.length === places.length) {
        res.status(202).json({
          status: 'accepted',
          mode: 'queued',
          count: queued.length,
          jobs: queued,
          message:
            'Ingestion queued. The worker audits each site, crawls its menu sections and ' +
            'converts images. Poll /api/v1/venues/jobs/:jobId or GET /api/v1/venues?source=web_menu.',
        });
        return;
      }
    }

    // Redis unavailable (or async disabled): run the pipeline inline.
    const reports = [];
    for (const place of places) {
      reports.push(await EnrichmentService.enrichPlace(place, 'web_menu', jobOptions));
    }

    const venues = await Venue.find({
      google_place_id: { $in: places.map((place) => place.place_id) },
    }).lean();

    res.json({
      status: 'success',
      mode: 'sync',
      count: venues.length,
      warnings: useQueue ? ['Redis queue unavailable - ingestion ran synchronously.'] : [],
      reports,
      data: venues,
    });
  });

  /** GET /api/v1/venues - filtered, paginated listing. */
  public static listVenues = asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, Math.trunc(num(req.query.page, 1)));
    const limit = Math.min(200, Math.max(1, Math.trunc(num(req.query.limit, 20))));
    const filter = buildFilter(req.query as Record<string, any>);

    const sortField = String(req.query.sort || 'updated_at');
    const allowedSort = ['updated_at', 'created_at', 'rating', 'name', 'user_ratings_total'];
    const sort: Record<string, 1 | -1> = {
      [allowedSort.includes(sortField) ? sortField : 'updated_at']:
        String(req.query.order) === 'asc' ? 1 : -1,
    };

    const [venues, total] = await Promise.all([
      Venue.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      Venue.countDocuments(filter),
    ]);

    res.json({
      status: 'success',
      count: venues.length,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 },
      data: venues,
    });
  });

  /**
   * GET /api/v1/venues/nearby?lat=&lng=&radius=
   * 2dsphere `$near` query (spec §2.1).
   */
  public static findNearby = asyncHandler(async (req: Request, res: Response) => {
    const lat = num(req.query.lat, NaN);
    const lng = num(req.query.lng, NaN);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new ApiError(400, 'lat and lng query parameters are required');
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new ApiError(400, 'lat/lng out of range');
    }

    const radius = Math.min(Math.max(num(req.query.radius, 2000), 1), 100000);
    const limit = Math.min(200, Math.max(1, Math.trunc(num(req.query.limit, 50))));

    const filter: FilterQuery<IVenueDocument> = {
      ...buildFilter(req.query as Record<string, any>),
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: radius,
        },
      },
    };

    const venues = await Venue.find(filter).limit(limit).lean();

    // $near returns nearest-first; surface the actual distance for the UI.
    const withDistance = venues.map((venue: any) => ({
      ...venue,
      distance_meters: Math.round(
        haversine(lat, lng, venue.location.coordinates[1], venue.location.coordinates[0])
      ),
    }));

    res.json({
      status: 'success',
      query: { lat, lng, radius_meters: radius },
      count: withDistance.length,
      data: withDistance,
    });
  });

  /**
   * POST /api/v1/venues/within
   * 2dsphere `$geoWithin` over a bounding box or a GeoJSON polygon (spec §2.1).
   */
  public static findWithin = asyncHandler(async (req: Request, res: Response) => {
    const { bbox, polygon } = req.body || {};
    let geoWithin: Record<string, any>;

    if (Array.isArray(bbox) && bbox.length === 4) {
      // [minLng, minLat, maxLng, maxLat]
      const [minLng, minLat, maxLng, maxLat] = bbox.map(Number);
      if ([minLng, minLat, maxLng, maxLat].some((v) => !Number.isFinite(v))) {
        throw new ApiError(400, 'bbox must contain four numbers: [minLng, minLat, maxLng, maxLat]');
      }
      geoWithin = { $box: [[minLng, minLat], [maxLng, maxLat]] };
    } else if (Array.isArray(polygon) && polygon.length >= 3) {
      const ring = polygon.map((point: number[]) => [Number(point[0]), Number(point[1])]);
      // GeoJSON requires an explicitly closed ring.
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
      geoWithin = { $geometry: { type: 'Polygon', coordinates: [ring] } };
    } else {
      throw new ApiError(400, 'Provide either bbox: [minLng, minLat, maxLng, maxLat] or polygon: [[lng, lat], ...]');
    }

    const limit = Math.min(500, Math.max(1, Math.trunc(num(req.body.limit, 100))));
    const filter: FilterQuery<IVenueDocument> = {
      ...buildFilter(req.body || {}),
      location: { $geoWithin: geoWithin },
    };

    const venues = await Venue.find(filter).limit(limit).lean();
    res.json({ status: 'success', count: venues.length, data: venues });
  });

  /** GET /api/v1/venues/stats - market intelligence aggregates. */
  public static getStats = asyncHandler(async (_req: Request, res: Response) => {
    const [totals] = await Venue.aggregate([
      {
        $group: {
          _id: null,
          total_venues: { $sum: 1 },
          with_website: { $sum: { $cond: ['$digital_presence.has_website', 1, 0] } },
          with_qr_menu: { $sum: { $cond: ['$digital_presence.has_qr_menu', 1, 0] } },
          with_online_ordering: { $sum: { $cond: ['$digital_presence.supports_online_ordering', 1, 0] } },
          with_email: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$contacts.emails', []] } }, 0] }, 1, 0] } },
          avg_rating: { $avg: '$rating' },
          menu_items: {
            $sum: {
              $reduce: {
                input: { $ifNull: ['$menu.categories', []] },
                initialValue: 0,
                in: { $add: ['$$value', { $size: { $ifNull: ['$$this.items', []] } }] },
              },
            },
          },
        },
      },
    ]);

    const [byProvider, byCity, bySource] = await Promise.all([
      Venue.aggregate([
        { $match: { 'digital_presence.qr_menu_provider': { $nin: [null, ''] } } },
        { $group: { _id: '$digital_presence.qr_menu_provider', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 15 },
      ]),
      Venue.aggregate([
        { $match: { 'address.city': { $nin: [null, ''] } } },
        { $group: { _id: '$address.city', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 15 },
      ]),
      Venue.aggregate([{ $group: { _id: '$data_source', count: { $sum: 1 } } }]),
    ]);

    const summary = totals || {
      total_venues: 0,
      with_website: 0,
      with_qr_menu: 0,
      with_online_ordering: 0,
      with_email: 0,
      avg_rating: null,
      menu_items: 0,
    };
    delete (summary as any)._id;

    res.json({
      status: 'success',
      summary: {
        ...summary,
        avg_rating: summary.avg_rating ? Math.round(summary.avg_rating * 100) / 100 : null,
        qr_menu_penetration_percent: summary.total_venues
          ? Math.round((summary.with_qr_menu / summary.total_venues) * 1000) / 10
          : 0,
      },
      by_qr_provider: byProvider.map((r) => ({ provider: r._id, count: r.count })),
      by_city: byCity.map((r) => ({ city: r._id, count: r.count })),
      by_data_source: bySource.map((r) => ({ source: r._id, count: r.count })),
      image_pipeline: ImageService.storageStats(),
      queue: await getQueueStats(),
      providers: providerStatus(),
    });
  });

  /** GET /api/v1/venues/export?format=json|xml|csv - bulk export with filters. */
  public static exportAll = asyncHandler(async (req: Request, res: Response) => {
    const format = (String(req.query.format || 'json').toLowerCase() as ExportFormat) || 'json';
    if (!['json', 'xml', 'csv'].includes(format)) {
      throw new ApiError(400, `Unsupported format "${format}". Use json, xml or csv.`);
    }

    const limit = Math.min(MAX_EXPORT, Math.max(1, Math.trunc(num(req.query.limit, 1000))));
    const venues = (await Venue.find(buildFilter(req.query as Record<string, any>))
      .sort({ updated_at: -1 })
      .limit(limit)) as IVenueDocument[];

    sendExport(res, venues, format, `placefind_export_${new Date().toISOString().slice(0, 10)}`);
  });

  /** GET /api/v1/venues/jobs/:jobId - enrichment job status. */
  public static getJobStatus = asyncHandler(async (req: Request, res: Response) => {
    const stats = await getQueueStats();
    if (!stats.available) throw new ApiError(503, 'Redis queue is not available');

    const job = await getScrapeQueue().getJob(String(req.params.jobId));
    if (!job) throw new ApiError(404, 'Job not found');

    res.json({
      status: 'success',
      data: {
        id: job.id,
        name: job.name,
        state: await job.getState(),
        attempts_made: job.attemptsMade,
        progress: job.progress,
        kind: isDiscoverJob(job.data) ? 'discovery' : 'enrichment',
        place: isDiscoverJob(job.data) ? undefined : job.data.place?.name,
        result: job.returnvalue,
        failed_reason: job.failedReason,
        processed_on: job.processedOn,
        finished_on: job.finishedOn,
      },
    });
  });

  /** GET /api/v1/venues/:id */
  public static getVenueById = asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid venue id');

    const venue = await Venue.findById(req.params.id).lean();
    if (!venue) throw new ApiError(404, 'Venue not found');

    res.json({ status: 'success', data: venue });
  });

  /** GET /api/v1/venues/:id/export?format=json|xml|csv */
  public static exportVenue = asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid venue id');

    const format = (String(req.query.format || 'json').toLowerCase() as ExportFormat) || 'json';
    if (!['json', 'xml', 'csv'].includes(format)) {
      throw new ApiError(400, `Unsupported format "${format}". Use json, xml or csv.`);
    }

    const venue = (await Venue.findById(req.params.id)) as IVenueDocument | null;
    if (!venue) throw new ApiError(404, 'Venue not found');

    sendExport(res, [venue], format, `venue_${venue._id}`);
  });

  /** POST /api/v1/venues/:id/refresh - re-run the pipeline for one venue. */
  public static refreshVenue = asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid venue id');

    const venue = await Venue.findById(req.params.id);
    if (!venue) throw new ApiError(404, 'Venue not found');

    const coordinates = venue.location?.coordinates;
    const place = {
      place_id: venue.google_place_id,
      name: venue.name,
      // A URL-ingested venue may have no coordinates yet; the re-run reads them
      // off the page again rather than seeding the pipeline with a fake point.
      geometry: coordinates
        ? { location: { lat: coordinates[1], lng: coordinates[0] } }
        : undefined,
      website: venue.contacts?.website_url,
    };

    const jobId = await enqueueScrape({
      place,
      source: venue.data_source,
      provider: venue.provider,
      force: true,
      includePhotos: Boolean(req.body?.include_photos),
    });

    if (jobId) {
      venue.enrichment.status = 'queued';
      venue.enrichment.last_job_id = jobId;
      await venue.save();
      res.status(202).json({ status: 'accepted', mode: 'queued', job_id: jobId });
      return;
    }

    const report = await EnrichmentService.enrichPlace(place, venue.data_source, {
      provider: venue.provider,
      force: true,
      includePhotos: Boolean(req.body?.include_photos),
    });
    res.json({ status: 'success', mode: 'sync', report });
  });

  /** DELETE /api/v1/venues/:id */
  public static deleteVenue = asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid venue id');

    const venue = await Venue.findByIdAndDelete(req.params.id);
    if (!venue) throw new ApiError(404, 'Venue not found');

    res.json({ status: 'success', message: `Venue "${venue.name}" deleted` });
  });
}

/** Great-circle distance in meters. */
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
