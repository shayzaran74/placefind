import axios from 'axios';
import https from 'https';
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

  /**
   * Hosts whose last Playwright render threw, and when we learned it.
   *
   * A crawl fetches every page of one menu from one host, so without this the
   * whole crawl pays the same navigation timeout page after page before
   * falling back. The verdict expires because a stall is usually the site
   * having a bad minute, not a permanent property of the host.
   */
  private static staticOnlyHosts = new Map<string, number>();
  private static readonly STATIC_ONLY_TTL_MS = 10 * 60_000;

  private static hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  private static isStaticOnly(host: string): boolean {
    const since = this.staticOnlyHosts.get(host);
    if (since === undefined) return false;
    if (Date.now() - since < this.STATIC_ONLY_TTL_MS) return true;
    this.staticOnlyHosts.delete(host);
    return false;
  }

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
    const host = this.hostOf(url);
    const browser = this.isStaticOnly(host) ? null : await this.getBrowser();

    if (browser) {
      let context: any;
      try {
        context = await browser.newContext({ userAgent: USER_AGENT, locale: 'tr-TR' });
        const page = await context.newPage();
        // 'commit' returns as soon as the response lands. Waiting for
        // DOMContentLoaded *inside* goto makes the render hostage to a single
        // stalled subresource: one blocking script that never returns throws
        // the whole navigation away after the full timeout, even though the
        // document itself arrived in milliseconds. The waits below reach the
        // same milestones but best-effort, so a stall costs us the markup JS
        // would have added rather than the page.
        const response = await page.goto(url, {
          waitUntil: 'commit',
          timeout: config.scraperTimeoutMs,
        });
        const domReady = await page
          .waitForLoadState('domcontentloaded', {
            timeout: Math.min(config.scraperTimeoutMs, 10000),
          })
          .then(() => true)
          .catch(() => false);

        // Give client-side menu rendering a chance to settle. Skipped when the
        // document never finished parsing: networkidle is a strictly later
        // milestone, so waiting for it would only spend a second budget on the
        // same stalled request.
        if (domReady) {
          await page
            .waitForLoadState('networkidle', { timeout: Math.min(config.scraperTimeoutMs, 8000) })
            .catch(() => undefined);
        }

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
        // Spare the rest of this crawl the same timeout (see staticOnlyHosts).
        if (host) this.staticOnlyHosts.set(host, Date.now());
      } finally {
        await context?.close().catch(() => undefined);
      }
    }

    const response = await axios.get(url, {
      timeout: config.scraperTimeoutMs,
      maxRedirects: 5,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
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
