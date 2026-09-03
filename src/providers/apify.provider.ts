import axios from 'axios';
import { config } from '../config';
import { IGooglePlaceRaw } from '../services/googlePlaces.service';
import { parseTurkishAddress } from '../services/mapsParser';
import { IPlaceProvider, IProviderResult, IProviderSearchParams } from './types';

/**
 * Apify hosted Google Maps scraper (~$2-4 per 1.000 places).
 * Runs an actor synchronously and reads its dataset.
 * https://apify.com/compass/crawler-google-places
 */
export class ApifyProvider implements IPlaceProvider {
  public readonly name = 'apify' as const;

  public isConfigured(): boolean {
    return Boolean(config.apifyApiKey);
  }

  public async search(params: IProviderSearchParams): Promise<IProviderResult> {
    const query = (params.query || params.keyword || 'restaurant cafe').trim();
    const actor = config.apifyActorId.replace('/', '~');

    // run-sync-get-dataset-items blocks until the run finishes and returns rows.
    const response: any = await axios.post(
      `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`,
      {
        searchStringsArray: [query],
        customGeolocation: {
          type: 'Point',
          coordinates: [params.lng, params.lat],
          radiusKm: Math.max(1, Math.round(params.radius / 1000)),
        },
        maxCrawledPlacesPerSearch: params.maxResults ?? 20,
        language: config.mapsLocale,
        skipClosedPlaces: false,
      },
      {
        timeout: 300_000,
        params: { token: config.apifyApiKey },
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const rows: any[] = Array.isArray(response.data) ? response.data : [];
    const places = rows.map((row) => this.normalize(row)).filter((p): p is IGooglePlaceRaw => Boolean(p));

    return { places, source: 'apify', provider: this.name };
  }

  private normalize(row: any): IGooglePlaceRaw | null {
    const placeId = row.placeId || row.cid || row.fid;
    if (!placeId || !row.title) return null;

    const addressParts = parseTurkishAddress(row.address);

    return {
      place_id: String(placeId),
      name: String(row.title),
      formatted_address: row.address,
      geometry: row.location
        ? { location: { lat: Number(row.location.lat), lng: Number(row.location.lng) } }
        : undefined,
      rating: row.totalScore != null ? Number(row.totalScore) : undefined,
      user_ratings_total: row.reviewsCount != null ? Number(row.reviewsCount) : undefined,
      formatted_phone_number: row.phone,
      international_phone_number: row.phone,
      website: row.website,
      types: row.categories?.length ? row.categories : [row.categoryName || 'restaurant'],
      categories: row.categories,
      opening_hours: row.openingHours?.length
        ? { weekday_text: row.openingHours.map((h: any) => `${h.day}: ${h.hours}`) }
        : undefined,
      plus_code: row.plusCode,
      address_parts: {
        city: row.city || addressParts.city,
        district: row.neighborhood || addressParts.district,
        neighborhood: row.neighborhood || addressParts.neighborhood,
        postal_code: row.postalCode || addressParts.postal_code,
      },
      source_ids: { cid: row.cid, place_id: row.placeId, entity_id: row.fid },
      photos: row.imageUrl ? [{ photo_reference: row.imageUrl, direct_url: row.imageUrl }] : undefined,
    };
  }
}
