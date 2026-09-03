import { DataSource } from '../models/Venue';
import { IGooglePlaceRaw } from '../services/googlePlaces.service';

export type ProviderName = 'maps_scraper' | 'outscraper' | 'apify' | 'places_api' | 'mock';

/**
 * Raised when a source refuses to serve us — CAPTCHA, /sorry/ interstitial,
 * HTTP 429/503. Signals the registry to try a fallback provider; it is never a
 * cue to solve or work around the challenge.
 */
export class ProviderBlockedError extends Error {
  public readonly provider: ProviderName;

  constructor(provider: ProviderName, message: string) {
    super(message);
    this.name = 'ProviderBlockedError';
    this.provider = provider;
  }
}

export interface IProviderSearchParams {
  lat: number;
  lng: number;
  radius: number;
  keyword?: string;
  /** Free-text query; overrides lat/lng/keyword when present. */
  query?: string;
  maxResults?: number;
}

export interface IProviderResult {
  places: IGooglePlaceRaw[];
  source: DataSource;
  provider: ProviderName;
  /** True when every candidate provider was blocked or unavailable. */
  blocked?: boolean;
  warning?: string;
  /** Providers that were tried and rejected before this result. */
  attempted?: Array<{ provider: ProviderName; reason: string }>;
}

export interface IPlaceProvider {
  readonly name: ProviderName;
  /** False when a required API key or dependency is missing. */
  isConfigured(): boolean;
  search(params: IProviderSearchParams): Promise<IProviderResult>;
  /** Optional: providers that return complete rows from search can omit this. */
  getDetails?(place: IGooglePlaceRaw): Promise<IGooglePlaceRaw | null>;
}
