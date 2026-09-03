import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int(process.env.PORT, 3000),
  env: process.env.NODE_ENV || 'development',

  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/placefind_db',
  redisUri: process.env.REDIS_URI || 'redis://localhost:6379',

  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || '',

  /** WebP image pipeline (spec §2.2) */
  webpQuality: int(process.env.WEBP_QUALITY, 85),
  webpMaxWidth: int(process.env.WEBP_MAX_WIDTH, 1200),
  uploadsDir: path.resolve(process.env.UPLOADS_DIR || './uploads/images'),
  /** Public CDN/S3 origin prefixed to stored .webp paths. Empty => relative paths. */
  cdnBaseUrl: (process.env.CDN_BASE_URL || '').replace(/\/$/, ''),

  /**
   * Place data providers. The Playwright Google Maps scraper is the default so
   * the platform runs with no Google API key; hosted scrapers act as fallbacks
   * when the scraper is blocked (see src/providers/index.ts).
   */
  placesProvider: (process.env.PLACES_PROVIDER || 'maps_scraper').trim(),
  placesFallbackProviders: (process.env.PLACES_FALLBACK_PROVIDERS ?? 'outscraper,apify')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),

  /** Google Maps scraper */
  // 'en' keeps aria-labels and decimal separators stable; TR pages return "4,7".
  mapsLocale: process.env.MAPS_LOCALE || 'en',
  scraperMinDelayMs: int(process.env.SCRAPER_MIN_DELAY_MS, 2000),
  scraperMaxDelayMs: int(process.env.SCRAPER_MAX_DELAY_MS, 3000),
  scraperMaxScrolls: int(process.env.SCRAPER_MAX_SCROLLS, 15),
  scraperProxyUrl: process.env.SCRAPER_PROXY_URL || '',

  /** Hosted Google Maps scraping services (paid fallbacks) */
  outscraperApiKey: process.env.OUTSCRAPER_API_KEY || '',
  apifyApiKey: process.env.APIFY_API_KEY || '',
  apifyActorId: process.env.APIFY_ACTOR_ID || 'compass/crawler-google-places',

  /**
   * Menu site crawler. A QR menu's landing page is usually a category grid,
   * so the extractor needs its section pages too (see MenuCrawlerService).
   */
  menuCrawlEnabled: bool(process.env.MENU_CRAWL_ENABLED, true),
  menuCrawlMaxPages: int(process.env.MENU_CRAWL_MAX_PAGES, 20),
  /** Same-origin pacing; the multi-second Maps delay is not needed here. */
  menuCrawlDelayMs: int(process.env.MENU_CRAWL_DELAY_MS, 400),
  menuCrawlRespectRobots: bool(process.env.MENU_CRAWL_RESPECT_ROBOTS, true),

  /** Scraper workers (spec §2 - Playwright) */
  scraperConcurrency: int(process.env.SCRAPER_CONCURRENCY, 2),
  scraperTimeoutMs: int(process.env.SCRAPER_TIMEOUT_MS, 20000),
  /** BullMQ throughput cap: `max` jobs per `durationMs` per worker. */
  scraperRateLimitMax: int(process.env.SCRAPER_RATE_LIMIT_MAX, 15),
  scraperRateLimitDurationMs: int(process.env.SCRAPER_RATE_LIMIT_DURATION_MS, 60_000),
  playwrightEnabled: bool(process.env.PLAYWRIGHT_ENABLED, true),
  /** Optional remote browser (e.g. ws://browserless:3000). Falls back to static HTTP fetch. */
  playwrightWsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT || '',
  playwrightExecutablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '',

  /**
   * When true, Google Places falls back to sample venues if the API is
   * unavailable. Responses are always tagged with `data_source` so mock rows
   * are never mistaken for live intelligence.
   */
  allowMockData: bool(process.env.ALLOW_MOCK_DATA, true),

  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 120),
};

export type AppConfig = typeof config;
