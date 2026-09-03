import axios from 'axios';
import { config } from '../config';

export interface IRenderResult {
  html: string;
  /** Final URL after redirects. */
  url: string;
  /** 'playwright' when JS was executed, 'static_html' for a plain fetch. */
  method: 'playwright' | 'static_html';
  status?: number;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetches page HTML for the scraper workers (spec §2 - Playwright workers).
 *
 * Most QR menu platforms (FineDine, Menulux, Adisyo...) render their menu
 * client-side, so a plain HTTP fetch returns an empty shell. When a Chromium
 * build is reachable we render with Playwright; otherwise we degrade to a
 * static fetch rather than failing the job.
 */
export class RenderService {
  private static browserPromise: Promise<any> | null = null;
  private static playwrightUnavailable = false;

  private static async getBrowser(): Promise<any | null> {
    if (!config.playwrightEnabled || this.playwrightUnavailable) return null;

    if (!this.browserPromise) {
      this.browserPromise = (async () => {
        // Imported lazily: the platform must run without a Chromium download.
        const { chromium } = await import('playwright-core');

        if (config.playwrightWsEndpoint) {
          return chromium.connect(config.playwrightWsEndpoint, { timeout: 10000 });
        }

        return chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
          ...(config.playwrightExecutablePath
            ? { executablePath: config.playwrightExecutablePath }
            : {}),
        });
      })().catch((error: any) => {
        console.warn(
          `[RenderService] Playwright unavailable (${error.message}). Falling back to static HTML fetch.`
        );
        this.playwrightUnavailable = true;
        this.browserPromise = null;
        return null;
      });
    }

    return this.browserPromise;
  }

  public static async render(url: string): Promise<IRenderResult> {
    const browser = await this.getBrowser();

    if (browser) {
      let context: any;
      try {
        context = await browser.newContext({ userAgent: USER_AGENT, locale: 'tr-TR' });
        const page = await context.newPage();
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: config.scraperTimeoutMs,
        });
        // Give client-side menu rendering a chance to settle.
        await page
          .waitForLoadState('networkidle', { timeout: Math.min(config.scraperTimeoutMs, 8000) })
          .catch(() => undefined);

        // Playwright sayfa kaydırma ve lazy load yükletme
        await page
          .evaluate(async () => {
            await new Promise<void>((resolve) => {
              let totalHeight = 0;
              const distance = 400;
              const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= document.body.scrollHeight) {
                  clearInterval(timer);
                  resolve();
                }
              }, 150);
            });
          })
          .catch(() => undefined);
        await page.waitForTimeout(1500).catch(() => undefined); // Resimlerin yüklenmesini bekle

        const html = await page.content();
        return { html, url: page.url(), method: 'playwright', status: response?.status() };
      } catch (error: any) {
        console.warn(`[RenderService] Playwright render failed for ${url}: ${error.message}`);
      } finally {
        await context?.close().catch(() => undefined);
      }
    }

    const response = await axios.get(url, {
      timeout: config.scraperTimeoutMs,
      maxRedirects: 5,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' },
      responseType: 'text',
      transformResponse: [(data) => data],
      validateStatus: (status) => status < 500,
    });

    return {
      html: typeof response.data === 'string' ? response.data : String(response.data),
      url,
      method: 'static_html',
      status: response.status,
    };
  }

  public static async close(): Promise<void> {
    const browser = await this.browserPromise?.catch(() => null);
    if (browser) await browser.close().catch(() => undefined);
    this.browserPromise = null;
  }
}
