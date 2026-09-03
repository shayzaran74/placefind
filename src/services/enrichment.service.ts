import { Venue, IVenueDocument, DataSource } from '../models/Venue';
import { GooglePlacesService, IGooglePlaceRaw } from './googlePlaces.service';
import { getProvider } from '../providers';
import { parseTurkishAddress } from './mapsParser';
import { ScannerService } from './scanner.service';
import { ScraperService } from './scraper.service';
import { ImageService } from './image.service';
import { GeocoderService } from './geocoder.service';
import { config } from '../config';

export interface IEnrichOptions {
  /** Provider that produced the place row, used for details/photo handling. */
  provider?: string;
  /** Re-scan even if the venue already exists. */
  force?: boolean;
  /** Convert Google Places venue photos to WebP (extra API cost). */
  includePhotos?: boolean;
  maxPhotos?: number;
  /**
   * Let the venue's own page name it. Set for URL ingestion, where the only
   * name we start with is a hostname; a Maps row's name stays authoritative.
   */
  preferScannedName?: boolean;
  /** Page budget for the menu crawler. */
  maxMenuPages?: number;
}

export interface IEnrichReport {
  place_id: string;
  venue_id?: string;
  name: string;
  created: boolean;
  skipped: boolean;
  images_converted: number;
  bytes_saved: number;
  extraction_method: string;
  /** Pages fetched to assemble the menu. */
  pages_crawled?: number;
  warnings: string[];
}

/**
 * Full per-venue pipeline: Places details -> website audit -> menu scrape ->
 * WebP conversion -> MongoDB upsert. Used by both the synchronous API path and
 * the Redis-backed scraper workers so behaviour cannot drift between them.
 */
export class EnrichmentService {
  public static async enrichPlace(
    place: IGooglePlaceRaw,
    source: DataSource,
    options: IEnrichOptions = {}
  ): Promise<IEnrichReport> {
    const warnings: string[] = [];
    const existing = await Venue.findOne({ google_place_id: place.place_id });

    if (existing && !options.force) {
      return {
        place_id: place.place_id,
        venue_id: String(existing._id),
        name: existing.name,
        created: false,
        skipped: true,
        images_converted: 0,
        bytes_saved: 0,
        extraction_method: existing.menu?.extraction_method || 'none',
        pages_crawled: existing.menu?.pages_crawled,
        warnings,
      };
    }

    // 1. Details. Scraper providers already return a complete row, so only the
    //    Places API path pays for a second round-trip.
    const provider = getProvider(options.provider || '');
    const details =
      provider?.getDetails && !place.source_ids
        ? (await provider.getDetails(place)) || place
        : place;

    // 2. Website audit: contacts, socials, QR menu, ordering channels
    const scan = await ScannerService.scanWebsite(details.website);
    if (scan.error) warnings.push(`scan: ${scan.error}`);

    // The venue's own page is a first-class source: it states the address it
    // prints on its door, the coordinates its owner pinned, the meal cards it
    // takes. Used only to fill gaps - a provider row always wins.
    const profile = scan.profile;

    // 3. Menu scrape (entry page + its section pages) + WebP conversion
    const menu = await ScraperService.scrapeAndExtractMenu(
      details.name,
      scan.qr_menu_url || details.website,
      // Only mock venues may fall back to the sample menu.
      source === 'mock',
      { maxPages: options.maxMenuPages }
    );
    if (menu.warning) warnings.push(`menu: ${menu.warning}`);

    let imagesConverted = menu.images_converted;
    let bytesSaved = menu.bytes_saved;

    // 4. Venue photos through the same WebP pipeline (spec §2.2)
    const photos: IVenueDocument['photos'] = [];
    if (options.includePhotos && (details.photos?.length || profile?.images.length)) {
      const refs = (details.photos || []).slice(0, options.maxPhotos ?? 3);
      const urls = refs
        .map((ref) =>
          // Scraped rows hold a downloadable URL; API rows need a signed photo URL.
          ref.direct_url || GooglePlacesService.photoUrl(ref.photo_reference, config.webpMaxWidth)
        )
        .filter((url): url is string => Boolean(url));

      // No provider photography: the venue's own logo and cover art are the
      // only imagery that actually depicts this venue.
      if (!urls.length && profile?.images.length) {
        urls.push(...profile.images.slice(0, options.maxPhotos ?? 3));
      }

      const converted = await ImageService.convertMany(
        urls.map((url, i) => ({ url, prefix: `venue_${place.place_id.slice(-8)}_${i}` }))
      );

      converted.forEach((result, i) => {
        photos.push({
          original_image_url: urls[i],
          webp_image_url: result.url,
          width: result.width,
          height: result.height,
        });
        if (result.converted) {
          imagesConverted++;
          if (result.original_bytes && result.webp_bytes) {
            bytesSaved += result.original_bytes - result.webp_bytes;
          }
        }
      });
    }

    // 5. Address: Places API gives address_components; scrapers give a single
    //    formatted string, so fall back to parsing it.
    const componentAddress = GooglePlacesService.parseAddress(details);
    const printedAddress = profile?.address;
    const stringParts = parseTurkishAddress(details.formatted_address || printedAddress);
    const address = {
      formatted: componentAddress.formatted || printedAddress || '',
      country: componentAddress.country,
      city: details.address_parts?.city || componentAddress.city || stringParts.city,
      district: details.address_parts?.district || componentAddress.district || stringParts.district,
      neighborhood:
        details.address_parts?.neighborhood || componentAddress.neighborhood || stringParts.neighborhood,
      postal_code: details.address_parts?.postal_code || stringParts.postal_code,
    };

    // Google's phone is a reliable seed; scanned numbers augment it.
    const googlePhone =
      details.international_phone_number || details.formatted_phone_number || undefined;
    const phoneNumbers = Array.from(
      new Set(
        [googlePhone, ...scan.phone_numbers]
          .filter((p): p is string => Boolean(p))
          .map((p) => ScannerService.normalizePhone(p) || p)
      )
    );

    // A URL-ingested venue starts life named after its hostname; its own page
    // knows better. Provider rows keep the name the provider gave them.
    const name = (options.preferScannedName && profile?.name) || details.name;

    // Coordinates: provider first, then the point the venue itself published,
    // and fallback to geocoding the address if neither provided coordinates.
    let point =
      details.geometry?.location ?? place.geometry?.location ?? profile?.coordinates;

    if (!point && (address.formatted || address.city || address.district)) {
      point = await GeocoderService.geocode({
        address: address.formatted,
        neighborhood: address.neighborhood,
        district: address.district,
        city: address.city,
      });
    }

    const hasCoordinates =
      point &&
      typeof point.lat === 'number' &&
      typeof point.lng === 'number' &&
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lng) &&
      !(Math.abs(point.lat) < 0.01 && Math.abs(point.lng) < 0.01);

    const payload: any = {
      google_place_id: details.place_id,
      name,
      primary_type: details.types?.[0] || 'restaurant',
      rating: details.rating,
      user_ratings_total: details.user_ratings_total,
      price_level: details.price_level,
      ...(hasCoordinates
        ? {
            location: {
              type: 'Point' as const,
              coordinates: [point!.lng, point!.lat] as [number, number],
            },
          }
        : {}),
      address: {
        formatted: address.formatted || details.vicinity || name,
        country: address.country,
        city: address.city,
        district: address.district,
        neighborhood: address.neighborhood,
        postal_code: address.postal_code,
      },
      contacts: {
        phone_numbers: phoneNumbers,
        emails: scan.emails,
        website_url: details.website,
        social_media: scan.social_media,
      },
      digital_presence: {
        has_website: Boolean(details.website),
        has_qr_menu: scan.has_qr_menu,
        qr_menu_provider: scan.qr_menu_provider,
        qr_menu_url: scan.qr_menu_url,
        supports_online_ordering: scan.supports_online_ordering,
        ordering_channels: scan.ordering_channels,
      },
      photos,
      menu: {
        currency: menu.currency,
        updated_at: new Date(),
        source_url: menu.source_url,
        extraction_method: menu.extraction_method,
        pages_crawled: menu.pages_crawled,
        source_pages: menu.source_pages,
        categories: menu.categories,
      },
      categories: details.categories,
      opening_hours:
        details.opening_hours ||
        (profile?.opening_hours ? { weekday_text: profile.opening_hours } : undefined),
      payment_methods: profile?.payment_methods,
      languages: profile?.languages,
      plus_code: details.plus_code,
      source_ids: details.source_ids,
      data_source: source,
      provider: options.provider || source,
      enrichment: {
        status: 'completed' as const,
        last_run_at: new Date(),
        error: warnings.length ? warnings.join(' | ') : undefined,
      },
    };

    const updateOps: any = { $set: payload };
    if (!hasCoordinates) {
      updateOps.$unset = { location: 1 };
    }

    const venue = await Venue.findOneAndUpdate(
      { google_place_id: details.place_id },
      updateOps,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return {
      place_id: details.place_id,
      venue_id: String(venue._id),
      name: venue.name,
      created: !existing,
      skipped: false,
      images_converted: imagesConverted,
      bytes_saved: bytesSaved,
      extraction_method: menu.extraction_method,
      pages_crawled: menu.pages_crawled,
      warnings,
    };
  }
}
