import axios from 'axios';
import { config } from '../config';
import { DataSource } from '../models/Venue';

export interface IGooglePhotoRef {
  photo_reference: string;
  width?: number;
  height?: number;
  /** Set by scraper providers that already hold a downloadable image URL. */
  direct_url?: string;
}

export interface IGooglePlaceRaw {
  place_id: string;
  name: string;
  formatted_address?: string;
  vicinity?: string;
  geometry?: {
    location: {
      lat: number;
      lng: number;
    };
  };
  rating?: number;
  user_ratings_total?: number;
  price_level?: number;
  formatted_phone_number?: string;
  international_phone_number?: string;
  website?: string;
  types?: string[];
  photos?: IGooglePhotoRef[];
  address_components?: Array<{
    long_name: string;
    short_name: string;
    types: string[];
  }>;

  // ── Enrichment fields supplied by the Maps scraper / hosted providers ──────
  /** Google Maps category labels, e.g. ["Coffee shop", "Cafe"]. */
  categories?: string[];
  opening_hours?: { weekday_text: string[]; open_now?: boolean };
  plus_code?: string;
  /** Pre-split address parts for sources that return no address_components. */
  address_parts?: {
    city?: string;
    district?: string;
    neighborhood?: string;
    postal_code?: string;
  };
  source_ids?: { cid?: string; place_id?: string; entity_id?: string };
}

export interface INearbySearchResult {
  places: IGooglePlaceRaw[];
  source: DataSource;
  /** Populated when the live API could not be used. */
  warning?: string;
}

export interface IParsedAddress {
  formatted: string;
  country?: string;
  city?: string;
  district?: string;
  neighborhood?: string;
}

export class GooglePlacesService {
  private static baseUrl = 'https://maps.googleapis.com/maps/api/place';

  public static get isLive(): boolean {
    const key = config.googlePlacesApiKey;
    return Boolean(key) && !key.startsWith('YOUR_');
  }

  /**
   * Nearby search by lat/lng/radius. Returns the data source so callers can
   * distinguish live Google rows from sample rows.
   */
  public static async nearbySearch(params: {
    lat: number;
    lng: number;
    radius: number; // meters
    keyword?: string;
    type?: string;
    maxResults?: number;
  }): Promise<INearbySearchResult> {
    if (!this.isLive) {
      const warning = 'GOOGLE_PLACES_API_KEY is not configured - returning sample data.';
      if (!config.allowMockData) return { places: [], source: 'mock', warning };
      console.warn(`[GooglePlacesService] ${warning}`);
      return { places: this.getMockPlaces(params.lat, params.lng), source: 'mock', warning };
    }

    try {
      const collected: IGooglePlaceRaw[] = [];
      const limit = params.maxResults ?? 60;
      let pageToken: string | undefined;

      // Google returns up to 20 rows per page, 3 pages max.
      for (let page = 0; page < 3 && collected.length < limit; page++) {
        const response: any = await axios.get(`${this.baseUrl}/nearbysearch/json`, {
          timeout: 12000,
          params: pageToken
            ? { pagetoken: pageToken, key: config.googlePlacesApiKey }
            : {
                location: `${params.lat},${params.lng}`,
                radius: params.radius,
                keyword: params.keyword || undefined,
                type: params.type || 'restaurant',
                key: config.googlePlacesApiKey,
              },
        });

        const status = response.data.status;
        if (status === 'ZERO_RESULTS') break;
        if (status !== 'OK') {
          throw new Error(
            `Google Places API status ${status}${
              response.data.error_message ? `: ${response.data.error_message}` : ''
            }`
          );
        }

        collected.push(...(response.data.results as IGooglePlaceRaw[]));
        pageToken = response.data.next_page_token;
        if (!pageToken) break;
        // next_page_token needs a moment before it becomes valid.
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      return { places: collected.slice(0, limit), source: 'google_places' };
    } catch (error: any) {
      const warning = `Live Google Places lookup failed: ${error.message}`;
      console.warn(`[GooglePlacesService] ${warning}`);
      if (!config.allowMockData) return { places: [], source: 'mock', warning };
      return { places: this.getMockPlaces(params.lat, params.lng), source: 'mock', warning };
    }
  }

  /** Text search ("cafes in Kadikoy") for city/keyword driven scans. */
  public static async textSearch(params: {
    query: string;
    maxResults?: number;
  }): Promise<INearbySearchResult> {
    if (!this.isLive) {
      const warning = 'GOOGLE_PLACES_API_KEY is not configured - returning sample data.';
      if (!config.allowMockData) return { places: [], source: 'mock', warning };
      return { places: this.getMockPlaces(40.9876, 29.0234), source: 'mock', warning };
    }

    try {
      const response: any = await axios.get(`${this.baseUrl}/textsearch/json`, {
        timeout: 12000,
        params: { query: params.query, key: config.googlePlacesApiKey },
      });

      if (response.data.status === 'ZERO_RESULTS') {
        return { places: [], source: 'google_places' };
      }
      if (response.data.status !== 'OK') {
        throw new Error(`Google Places API status ${response.data.status}`);
      }

      return {
        places: (response.data.results as IGooglePlaceRaw[]).slice(0, params.maxResults ?? 60),
        source: 'google_places',
      };
    } catch (error: any) {
      const warning = `Live Google Places text search failed: ${error.message}`;
      console.warn(`[GooglePlacesService] ${warning}`);
      if (!config.allowMockData) return { places: [], source: 'mock', warning };
      return { places: this.getMockPlaces(40.9876, 29.0234), source: 'mock', warning };
    }
  }

  /** Full details for a place id (adds website, phone, address components, photos). */
  public static async getPlaceDetails(placeId: string): Promise<IGooglePlaceRaw | null> {
    if (!this.isLive) {
      return config.allowMockData ? this.getMockPlaceDetails(placeId) : null;
    }

    try {
      const response: any = await axios.get(`${this.baseUrl}/details/json`, {
        timeout: 12000,
        params: {
          place_id: placeId,
          fields:
            'place_id,name,formatted_address,geometry,rating,user_ratings_total,price_level,formatted_phone_number,international_phone_number,website,types,address_components,photos',
          key: config.googlePlacesApiKey,
        },
      });

      if (response.data.status === 'OK') {
        return response.data.result as IGooglePlaceRaw;
      }
      return null;
    } catch (error: any) {
      console.warn(`[GooglePlacesService] getPlaceDetails error: ${error.message}`);
      return null;
    }
  }

  /** Builds a downloadable URL for a Google photo reference. */
  public static photoUrl(photoReference: string, maxWidth = 1200): string | null {
    if (!this.isLive) return null;
    return `${this.baseUrl}/photo?maxwidth=${maxWidth}&photo_reference=${encodeURIComponent(
      photoReference
    )}&key=${config.googlePlacesApiKey}`;
  }

  /**
   * Maps Google `address_components` onto the spec's address block
   * (country / city / district / neighborhood) instead of hardcoding a city.
   */
  public static parseAddress(place: IGooglePlaceRaw): IParsedAddress {
    const formatted = place.formatted_address || place.vicinity || '';
    const components = place.address_components || [];

    const pick = (...types: string[]): string | undefined => {
      for (const type of types) {
        const match = components.find((c) => c.types.includes(type));
        if (match) return match.long_name;
      }
      return undefined;
    };

    const parsed: IParsedAddress = {
      formatted,
      country: pick('country'),
      // In TR, administrative_area_level_1 is the province (Istanbul).
      city: pick('administrative_area_level_1', 'locality'),
      // ...and level_2 / level_4 is the district (Kadikoy).
      district: pick('administrative_area_level_2', 'administrative_area_level_4', 'sublocality'),
      neighborhood: pick('neighborhood', 'sublocality_level_1', 'administrative_area_level_4'),
    };

    // Fall back to parsing the formatted string: "..., Kadıköy/İstanbul"
    if ((!parsed.city || !parsed.district) && formatted) {
      const tail = formatted.split(',').pop()?.trim() || '';
      const slash = tail.split('/');
      if (slash.length === 2) {
        parsed.district = parsed.district || slash[0].trim();
        parsed.city = parsed.city || slash[1].trim();
      }
    }

    return parsed;
  }

  /** Sample venues used when no API key is present (tagged data_source: 'mock'). */
  private static getMockPlaces(lat: number, lng: number): IGooglePlaceRaw[] {
    const baseLat = Number.isFinite(lat) ? lat : 40.9876;
    const baseLng = Number.isFinite(lng) ? lng : 29.0234;

    return [
      {
        place_id: 'ChIJN1tL-r8zxokR0GJgptSuGQw',
        name: 'Moda Espresso & Bistro',
        formatted_address: 'Caferağa Mah. Moda Cad. No:42, Kadıköy/İstanbul',
        geometry: { location: { lat: baseLat, lng: baseLng } },
        rating: 4.8,
        user_ratings_total: 320,
        price_level: 2,
        formatted_phone_number: '+90 216 345 67 89',
        website: 'https://modaespresso.example.com',
        types: ['cafe', 'restaurant', 'food', 'point_of_interest'],
        address_components: [
          { long_name: 'Caferağa', short_name: 'Caferağa', types: ['neighborhood', 'political'] },
          { long_name: 'Kadıköy', short_name: 'Kadıköy', types: ['administrative_area_level_2', 'political'] },
          { long_name: 'İstanbul', short_name: '34', types: ['administrative_area_level_1', 'political'] },
          { long_name: 'Turkey', short_name: 'TR', types: ['country', 'political'] },
        ],
      },
      {
        place_id: 'ChIJX92KaL8zxokR9LKgptSuGQx',
        name: 'Bosphorus Gourmet Restaurant',
        formatted_address: 'Bebek Mah. Cevdet Paşa Cad. No:100, Beşiktaş/İstanbul',
        geometry: { location: { lat: baseLat + 0.091, lng: baseLng + 0.02 } },
        rating: 4.6,
        user_ratings_total: 512,
        price_level: 3,
        formatted_phone_number: '+90 212 265 43 21',
        website: 'https://bosphorusgourmet.example.com',
        types: ['restaurant', 'food', 'point_of_interest'],
        address_components: [
          { long_name: 'Bebek', short_name: 'Bebek', types: ['neighborhood', 'political'] },
          { long_name: 'Beşiktaş', short_name: 'Beşiktaş', types: ['administrative_area_level_2', 'political'] },
          { long_name: 'İstanbul', short_name: '34', types: ['administrative_area_level_1', 'political'] },
          { long_name: 'Turkey', short_name: 'TR', types: ['country', 'political'] },
        ],
      },
      {
        place_id: 'ChIJP81ZbL8zxokR7QKgptSuGQy',
        name: 'Karaköy Lokantası',
        formatted_address: 'Kemankeş Mah. Kemankeş Cad. No:37, Beyoğlu/İstanbul',
        geometry: { location: { lat: baseLat + 0.033, lng: baseLng - 0.041 } },
        rating: 4.5,
        user_ratings_total: 1840,
        price_level: 2,
        formatted_phone_number: '+90 212 292 44 55',
        website: 'https://karakoylokantasi.example.com',
        types: ['restaurant', 'food', 'point_of_interest'],
        address_components: [
          { long_name: 'Kemankeş', short_name: 'Kemankeş', types: ['neighborhood', 'political'] },
          { long_name: 'Beyoğlu', short_name: 'Beyoğlu', types: ['administrative_area_level_2', 'political'] },
          { long_name: 'İstanbul', short_name: '34', types: ['administrative_area_level_1', 'political'] },
          { long_name: 'Turkey', short_name: 'TR', types: ['country', 'political'] },
        ],
      },
    ];
  }

  private static getMockPlaceDetails(placeId: string): IGooglePlaceRaw {
    const known = this.getMockPlaces(40.9876, 29.0234).find((p) => p.place_id === placeId);
    return known || this.getMockPlaces(40.9876, 29.0234)[0];
  }
}
