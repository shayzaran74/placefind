import { config } from '../config';

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

/** Rotates the User-Agent so repeated scrapes do not share one fingerprint. */
export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** Random think-time between navigations (anti-ban pacing). */
export function randomDelayMs(): number {
  const min = Math.min(config.scraperMinDelayMs, config.scraperMaxDelayMs);
  const max = Math.max(config.scraperMinDelayMs, config.scraperMaxDelayMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launches (or connects to) Chromium. Shared by RenderService and the Maps
 * scraper so browser configuration lives in exactly one place.
 */
export async function launchBrowser(): Promise<any> {
  const { chromium } = await import('playwright-core');

  if (config.playwrightWsEndpoint) {
    return chromium.connect(config.playwrightWsEndpoint, { timeout: 15000 });
  }

  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    ...(config.playwrightExecutablePath ? { executablePath: config.playwrightExecutablePath } : {}),
    ...(config.scraperProxyUrl ? { proxy: { server: config.scraperProxyUrl } } : {}),
  });
}
