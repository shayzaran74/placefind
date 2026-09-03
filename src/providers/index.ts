import { config } from '../config';
import { MapsScraperProvider } from './mapsScraper.provider';
import { OutscraperProvider } from './outscraper.provider';
import { ApifyProvider } from './apify.provider';
import { PlacesApiProvider } from './placesApi.provider';
import {
  IPlaceProvider,
  IProviderResult,
  IProviderSearchParams,
  ProviderBlockedError,
  ProviderName,
} from './types';

export * from './types';

const providers: Record<ProviderName, IPlaceProvider | null> = {
  maps_scraper: new MapsScraperProvider(),
  outscraper: new OutscraperProvider(),
  apify: new ApifyProvider(),
  places_api: new PlacesApiProvider(),
  mock: null,
};

export function getProvider(name: string): IPlaceProvider | null {
  return providers[name as ProviderName] ?? null;
}

/** Primary provider first, then the configured fallbacks, de-duplicated. */
function resolveChain(preferred?: string): IPlaceProvider[] {
  const order = [preferred || config.placesProvider, ...config.placesFallbackProviders];
  const seen = new Set<string>();
  const chain: IPlaceProvider[] = [];

  for (const name of order) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const provider = getProvider(name);
    if (provider) chain.push(provider);
  }

  return chain;
}

/**
 * Runs the provider chain: the free Playwright scraper first, falling through
 * to a hosted scraper when it is blocked or errors. If every provider is
 * unavailable the result is marked `blocked` with the reasons attached, so the
 * caller reports the failure instead of silently returning nothing.
 */
export async function searchPlaces(
  params: IProviderSearchParams & { provider?: string }
): Promise<IProviderResult> {
  const chain = resolveChain(params.provider);
  const attempted: Array<{ provider: ProviderName; reason: string }> = [];

  if (!chain.length) {
    return {
      places: [],
      source: 'mock',
      provider: 'mock',
      blocked: true,
      warning: `No place provider is registered for "${params.provider || config.placesProvider}".`,
      attempted,
    };
  }

  for (const provider of chain) {
    if (!provider.isConfigured()) {
      attempted.push({ provider: provider.name, reason: 'not configured (missing API key or disabled)' });
      continue;
    }

    try {
      console.log(`[Providers] Trying "${provider.name}"...`);
      const result = await provider.search(params);

      // An empty result from a working provider is a real answer, not a failure.
      return { ...result, attempted: attempted.length ? attempted : undefined };
    } catch (error: any) {
      const blocked = error instanceof ProviderBlockedError;
      attempted.push({
        provider: provider.name,
        reason: blocked ? `blocked: ${error.message}` : error.message,
      });
      console.warn(`[Providers] "${provider.name}" failed: ${error.message}`);
    }
  }

  const blockedByBotWall = attempted.some((entry) => entry.reason.startsWith('blocked:'));

  return {
    places: [],
    source: 'mock',
    provider: chain[0].name,
    blocked: true,
    warning: blockedByBotWall
      ? 'Google Maps blocked the scraper and no hosted fallback is configured. ' +
        'Set OUTSCRAPER_API_KEY or APIFY_API_KEY, or route the scraper through a residential proxy.'
      : 'No place provider could serve this request.',
    attempted,
  };
}

/** Provider availability for /health and the dashboard status strip. */
export function providerStatus(): {
  active: string;
  fallbacks: string[];
  available: Array<{ provider: ProviderName; configured: boolean }>;
} {
  return {
    active: config.placesProvider,
    fallbacks: config.placesFallbackProviders,
    available: (Object.keys(providers) as ProviderName[])
      .filter((name) => providers[name])
      .map((name) => ({ provider: name, configured: providers[name]!.isConfigured() })),
  };
}
