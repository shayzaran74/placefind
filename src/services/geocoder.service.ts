import axios from 'axios';

export interface IGeocodeQuery {
  address?: string;
  neighborhood?: string;
  district?: string;
  city?: string;
}

export class GeocoderService {
  /**
   * Attempts to geocode an address using free OpenStreetMap Nominatim API,
   * falling back from full address to neighborhood/district/city combinations.
   */
  public static async geocode(query: IGeocodeQuery): Promise<{ lat: number; lng: number } | undefined> {
    const candidates: string[] = [];

    if (query.address) {
      // Remove door numbers, slashes, and noise for better geocoding match
      const cleaned = query.address
        .replace(/no:\s*\d+[a-z]?/i, '')
        .replace(/[\/\\()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) candidates.push(cleaned);
    }

    if (query.neighborhood && query.district && query.city) {
      candidates.push(`${query.neighborhood}, ${query.district}, ${query.city}`);
    }

    if (query.district && query.city) {
      candidates.push(`${query.district}, ${query.city}`);
    }

    if (query.city) {
      candidates.push(query.city);
    }

    for (const candidate of candidates) {
      try {
        const response = await axios.get('https://nominatim.openstreetmap.org/search', {
          params: {
            q: candidate,
            format: 'json',
            limit: 1,
          },
          headers: {
            'User-Agent': 'PlaceFindSaaS/1.0 (Venue Intelligence Platform)',
          },
          timeout: 4000,
        });

        if (Array.isArray(response.data) && response.data.length > 0) {
          const item = response.data[0];
          const lat = parseFloat(item.lat);
          const lng = parseFloat(item.lon);

          if (
            Number.isFinite(lat) &&
            Number.isFinite(lng) &&
            Math.abs(lat) <= 90 &&
            Math.abs(lng) <= 180 &&
            !(Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01)
          ) {
            return { lat, lng };
          }
        }
      } catch {
        // Silently continue to next fallback candidate
      }
    }

    return undefined;
  }
}
