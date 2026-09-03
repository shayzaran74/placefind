import axios from 'axios';
import { config } from '../config';
import { IGooglePlaceRaw } from '../services/googlePlaces.service';
import { parseTurkishAddress } from '../services/mapsParser';
import { IPlaceProvider, IProviderResult, IProviderSearchParams } from './types';

/**
 * Outscraper hosted Google Maps scraper (~$2-4 per 1.000 places).
 * Used as a fallback when the local Playwright scraper is blocked.
 * https://app.outscraper.com/api-docs
 */
export class OutscraperProvider implements IPlaceProvider {
  public readonly name = 'outscraper' as const;
  private static endpoint = 'https://api.app.outscraper.com/maps/search-v3';

  public isConfigured(): boolean {
    return Boolean(config.outscraperApiKey);
  }

  public async search(params: IProviderSearchParams): Promise<IProviderResult> {
    const query = (params.query || params.keyword || 'restaurant cafe').trim();
    const limit = params.maxResults ?? 20;

    const response: any = await axios.get(OutscraperProvider.endpoint, {
      timeout: 180_000,
      headers: { 'X-API-KEY': config.outscraperApiKey },
      params: {
        query,
        limit,
        // Outscraper accepts a coordinate hint as "@lat,lng,zoom".
        coordinates: `${params.lat},${params.lng}`,
        language: config.mapsLocale,
        async: false,
      },
    });

    // Results arrive as an array of arrays (one per query).
    const raw: any[] = (response.data?.data || []).flat();
    const places = raw.map((row) => this.normalize(row)).filter((p): p is IGooglePlaceRaw => Boolean(p));

    return { places, source: 'outscraper', provider: this.name };
  }

  private normalize(row: any): IGooglePlaceRaw | null {
    const placeId = row.place_id || row.google_id || row.cid;
    if (!placeId || !row.name) return null;

    const addressParts = parseTurkishAddress(row.full_address || row.address);

    return {
      place_id: String(placeId),
      name: String(row.name),
      formatted_address: row.full_address || row.address,
      geometry:
        row.latitude != null && row.longitude != null
          ? { location: { lat: Number(row.latitude), lng: Number(row.longitude) } }
          : undefined,
      rating: row.rating != null ? Number(row.rating) : undefined,
      user_ratings_total: row.reviews != null ? Number(row.reviews) : undefined,
      formatted_phone_number: row.phone,
      international_phone_number: row.phone,
      website: row.site || row.website,
      types: row.type ? [row.type] : row.subtypes ? String(row.subtypes).split(',') : ['restaurant'],
      categories: row.subtypes ? String(row.subtypes).split(',').map((s: string) => s.trim()) : undefined,
      opening_hours: row.working_hours
        ? {
            weekday_text: Object.entries(row.working_hours).map(([day, hours]) => `${day}: ${hours}`),
          }
        : undefined,
      plus_code: row.plus_code,
      address_parts: {
        city: row.city || addressParts.city,
        district: row.district || addressParts.district,
        neighborhood: row.borough || addressParts.neighborhood,
        postal_code: row.postal_code || addressParts.postal_code,
      },
      source_ids: { cid: row.cid, place_id: row.place_id, entity_id: row.google_id },
      photos: row.photo ? [{ photo_reference: row.photo, direct_url: row.photo }] : undefined,
    };
  }
}
