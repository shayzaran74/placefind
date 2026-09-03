import axios from 'axios';
import * as cheerio from 'cheerio';
import { RenderService } from './render.service';
import { config } from '../config';

export interface IMenuPage {
  url: string;
  html: string;
  /** 'playwright' | 'static_html' */
  method: string;
  /** Link text that led here; names the section when the page has no heading. */
  title_hint?: string;
}

export interface ICrawlOutcome {
  pages: IMenuPage[];
  /** Section links found on the entry page, before the page budget applies. */
  discovered: number;
  warnings: string[];
}

interface ICandidate {
  url: string;
  score: number;
  order: number;
  title_hint?: string;
}

/**
 * Crawls a QR menu site (spec §2 - Scraper Workers).
 *
 * A QR menu is rarely one page. The landing page is a *category grid*: it
 * shows section tiles and nothing else, so scraping only the entry URL yields
 * zero products even though the menu is fully public one click away. This
 * service walks that one click - entry page plus its section pages - and hands
 * the whole set to the extractor.
 *
 * Depth is deliberately 1. Platforms mirror each product onto its own detail
 * page (`/118/478/` repeats everything on `/118/`), so following item links
 * multiplies requests without adding a single field.
 */
export class MenuCrawlerService {
  /** Asset and document extensions that are never a menu section page. */
  private static assetRe = /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|mp4|webm|mp3|zip|rar|woff2?|ttf)(\?|$)/i;

  /** Pages that exist on every site and never hold products. */
  private static negativeRe =
    /\/(iletisim|contact|hakkimizda|hakkinda|about|blog|haber|news|gizlilik|privacy|kvkk|cerez|cookie|policy|terms|kosullar|sepet|cart|checkout|odeme|login|giris|uye|account|profil|rezervasyon|reservation|sube|branch|galeri|gallery|yorum|review|sss|faq|kariyer|career)\b/i;

  /** Path words that mark a menu section. */
  private static positiveRe =
    /\/(menu|menü|menuler|menüler|kategori|kategoriler|category|categories|bolum|bölüm|urunler|ürünler|products|yemek|yemekler|icecek|içecek|drinks|food|tatli|tatlı|dessert|pasta|dondurma|borek|börek)\b/i;

  /** Link labels that mark a menu section even when the path is opaque. */
  private static positiveTextRe =
    /(menü|menu|kategori|bölüm|bolum|ürün|urun|yemek|içecek|icecek|kahvalt|tatlı|tatli|pide|kebap|pizza|burger|çorba|corba|salata|drink|food|dessert|starter|main|pasta|dondurma|börek|borek)/i;

  /** Locale-prefixed mirrors of the same menu ("/en/118/"). */
  private static localeRe = /^\/([a-z]{2})\//i;

  private static robotsCache = new Map<string, Promise<string[]>>();

  /**
   * Normalises a link for de-duplication: absolute, no fragment, no trailing
   * "index.html". Returns null for anything that is not a same-origin page.
   */
  public static normalize(href: string, baseUrl: string): string | null {
    let url: URL;
    let base: URL;
    try {
      base = new URL(baseUrl);
      url = new URL(href, baseUrl);
    } catch {
      return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.host !== base.host) return null;
    if (this.assetRe.test(url.pathname)) return null;

    url.hash = '';
    url.pathname = url.pathname.replace(/\/index\.(html?|php|aspx?)$/i, '/');
    return url.toString();
  }

  /**
   * Ranks the same-origin links on a menu landing page by how likely they are
   * to be a section of the menu.
   *
   * Scoring rather than a selector list: every platform names its grid
   * differently, and a fixed selector silently drops the sections it does not
   * happen to match. Signals are additive so a page only needs to state one.
   */
  public static discoverSectionUrls(
    $: cheerio.CheerioAPI,
    baseUrl: string,
    limit = 20
  ): Array<{ url: string; title_hint?: string }> {
    const entry = this.normalize(baseUrl, baseUrl);
    const entryPath = (() => {
      try {
        return new URL(baseUrl).pathname;
      } catch {
        return '/';
      }
    })();

    // A grid of sections repeats one class across its tiles; a lone link in a
    // footer does not. Counting the class is how we spot the grid without
    // knowing its name.
    const classCounts = new Map<string, number>();
    $('a[href]').each((_, el) => {
      const className = ($(el).attr('class') || '').trim();
      if (!className) return;
      classCounts.set(className, (classCounts.get(className) || 0) + 1);
    });

    const byUrl = new Map<string, ICandidate>();

    $('a[href]').each((index, el) => {
      const $el = $(el);
      const url = this.normalize($el.attr('href') || '', baseUrl);
      if (!url || url === entry) return;

      const path = new URL(url).pathname;
      if (this.negativeRe.test(path)) return;

      // Skip translated mirrors of the same menu unless we started inside one.
      const locale = path.match(this.localeRe);
      if (locale && !this.localeRe.test(entryPath)) return;

      const text = $el.text().replace(/\s+/g, ' ').trim();
      const className = ($el.attr('class') || '').trim();

      let score = 0;
      // Opaque numeric section ids ("/118/") are the QR-platform convention.
      if (/^\/(?:[a-z]{2}\/)?\d{1,6}\/?$/i.test(path)) score += 3;
      if (this.positiveRe.test(path)) score += 3;
      if (/menu|kategori|category|section|bolum|bölüm|grid|tile|chart/i.test(className)) score += 2;
      if (text && text.length <= 60 && this.positiveTextRe.test(text)) score += 2;
      if (className && (classCounts.get(className) || 0) >= 3) score += 2;
      // A tile carrying its own artwork is a section header, not a nav item.
      if ($el.find('img').length || /background-image/i.test($el.attr('style') || '')) score += 1;
      // Deep paths are product detail pages; the section lives one level up.
      if (path.split('/').filter(Boolean).length > 2) score -= 2;

      if (score < 3) return;

      const existing = byUrl.get(url);
      if (existing && existing.score >= score) return;
      byUrl.set(url, {
        url,
        score,
        order: index,
        title_hint: text && text.length <= 80 ? text : existing?.title_hint,
      });
    });

    const ranked = Array.from(byUrl.values()).sort(
      (a, b) => b.score - a.score || a.order - b.order
    );

    // Drop links that sit *inside* a section we are already fetching: the
    // "favourites" strip on a landing page points straight at product pages
    // (`/118/487/`), and every one of those products is already listed on its
    // own section page (`/118/`). Keeping them would multiply requests for
    // rows the merge step then de-duplicates away.
    const kept: ICandidate[] = [];
    for (const candidate of ranked) {
      const path = new URL(candidate.url).pathname;
      const nested = kept.some((other) => {
        const parent = new URL(other.url).pathname.replace(/\/?$/, '/');
        return path !== parent && path.startsWith(parent);
      });
      if (!nested) kept.push(candidate);
    }

    return kept
      .slice(0, Math.max(0, limit))
      .map(({ url, title_hint }) => ({ url, title_hint }));
  }

  /** Parses the `User-agent: *` group of a robots.txt into its rules. */
  public static parseRobots(body: string): string[] {
    const rules: string[] = [];
    let inWildcardGroup = false;
    let sawWildcard = false;

    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;

      const [rawField, ...rest] = line.split(':');
      const field = rawField.trim().toLowerCase();
      const value = rest.join(':').trim();

      if (field === 'user-agent') {
        // Consecutive User-agent lines share one rule block.
        if (inWildcardGroup && sawWildcard) continue;
        inWildcardGroup = value === '*';
        sawWildcard = false;
        continue;
      }

      if (!inWildcardGroup) continue;
      sawWildcard = true;
      if (field === 'disallow' && value) rules.push(`-${value}`);
      if (field === 'allow' && value) rules.push(`+${value}`);
    }

    return rules;
  }

  private static async robotRules(origin: string): Promise<string[]> {
    let cached = this.robotsCache.get(origin);
    if (!cached) {
      cached = axios
        .get(`${origin}/robots.txt`, {
          timeout: 5000,
          responseType: 'text',
          transformResponse: [(data) => data],
          validateStatus: (status) => status < 500,
        })
        // A missing or unreadable robots.txt grants no rules, so nothing is
        // blocked - the same reading every crawler applies.
        .then((response) => (response.status === 200 ? this.parseRobots(String(response.data)) : []))
        .catch(() => []);
      this.robotsCache.set(origin, cached);
    }
    return cached;
  }

  /** Longest-match wins, Allow beating Disallow at equal length (RFC 9309). */
  public static isAllowed(rules: string[], pathname: string): boolean {
    let verdict = true;
    let matched = -1;

    for (const rule of rules) {
      const prefix = rule.slice(1);
      if (!pathname.startsWith(prefix)) continue;
      if (prefix.length > matched || (prefix.length === matched && rule[0] === '+')) {
        matched = prefix.length;
        verdict = rule[0] === '+';
      }
    }

    return verdict;
  }

  private static async allowed(url: string): Promise<boolean> {
    if (!config.menuCrawlRespectRobots) return true;
    try {
      const parsed = new URL(url);
      const rules = await this.robotRules(parsed.origin);
      return this.isAllowed(rules, parsed.pathname);
    } catch {
      return true;
    }
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Renders the entry page and, when it is a section grid, its sections.
   * Failures on individual sections are reported and skipped: a menu that is
   * 7/8 complete beats no menu at all.
   */
  public static async crawl(
    entryUrl: string,
    options: { maxPages?: number; crawl?: boolean } = {}
  ): Promise<ICrawlOutcome> {
    const warnings: string[] = [];

    if (!(await this.allowed(entryUrl))) {
      return {
        pages: [],
        discovered: 0,
        warnings: [`robots.txt disallows crawling ${entryUrl}`],
      };
    }

    const entry = await RenderService.render(entryUrl);
    const pages: IMenuPage[] = [{ url: entry.url, html: entry.html, method: entry.method }];

    const crawlEnabled = options.crawl ?? config.menuCrawlEnabled;
    const maxPages = Math.max(1, options.maxPages ?? config.menuCrawlMaxPages);
    if (!crawlEnabled || maxPages <= 1) return { pages, discovered: 0, warnings };

    const $ = cheerio.load(entry.html);
    const sections = this.discoverSectionUrls($, entry.url, maxPages - 1);

    const visited = new Set([this.normalize(entry.url, entry.url) || entry.url]);

    for (const section of sections) {
      if (visited.has(section.url)) continue;
      visited.add(section.url);

      if (!(await this.allowed(section.url))) {
        warnings.push(`robots.txt disallows ${section.url}`);
        continue;
      }

      // Same-origin pages of a menu we were pointed at: polite pacing, not the
      // multi-second backoff the Maps scraper needs to stay unbanned.
      await this.delay(config.menuCrawlDelayMs);

      try {
        const rendered = await RenderService.render(section.url);
        pages.push({
          url: rendered.url,
          html: rendered.html,
          method: rendered.method,
          title_hint: section.title_hint,
        });
      } catch (error: any) {
        warnings.push(`section fetch failed (${section.url}): ${error.message}`);
      }
    }

    return { pages, discovered: sections.length, warnings };
  }
}
