import { config } from '../config';
import { IGooglePlaceRaw } from '../services/googlePlaces.service';
import { launchBrowser, randomUserAgent, randomDelayMs, sleep } from '../services/browser';
import {
  buildSearchUrl,
  buildPlaceKey,
  parsePlaceHref,
  parseRating,
  parseReviewCount,
  parsePhoneItemId,
  parseOpeningHours,
  parseTurkishAddress,
  distanceMeters,
  stripAriaPrefix,
  detectBlock,
} from '../services/mapsParser';
import {
  IPlaceProvider,
  IProviderResult,
  IProviderSearchParams,
  ProviderBlockedError,
} from './types';

/**
 * Free Google Maps scraper (no API key).
 *
 * Drives a real Chromium through the public Maps UI: runs the search, scrolls
 * the results feed, then visits each place page and reads the detail panel.
 *
 * Bot protection is DETECTED, never bypassed: on a CAPTCHA or /sorry/
 * interstitial the run aborts with ProviderBlockedError so the registry can
 * fall back to a hosted service and the venue is recorded as captcha_blocked.
 */
export class MapsScraperProvider implements IPlaceProvider {
  public readonly name = 'maps_scraper' as const;

  public isConfigured(): boolean {
    // Needs only a Chromium binary, which ships in the worker image.
    return config.playwrightEnabled;
  }

  public async search(params: IProviderSearchParams): Promise<IProviderResult> {
    const query = (params.query || params.keyword || 'restaurant cafe').trim();
    const maxResults = params.maxResults ?? 20;
    const url = buildSearchUrl(query, params.lat, params.lng, params.radius, config.mapsLocale);

    let browser: any;
    let context: any;

    try {
      browser = await launchBrowser();
      context = await browser.newContext({
        userAgent: randomUserAgent(),
        locale: config.mapsLocale === 'en' ? 'en-US' : 'tr-TR',
        viewport: { width: 1440, height: 900 },
        timezoneId: 'Europe/Istanbul',
      });

      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.scraperTimeoutMs + 15000,
      });

      await this.assertNotBlocked(page, response?.status());
      await this.dismissConsent(page);

      // Maps either renders a results feed or redirects to a single place page.
      // Which one it is settles asynchronously, so wait for whichever arrives
      // rather than sampling after a fixed sleep.
      await page
        .waitForFunction(
          () =>
            Boolean(document.querySelector('[role="feed"]')) ||
            Boolean(document.querySelector('a.hfpxzc')) ||
            window.location.pathname.includes('/maps/place/'),
          { timeout: 20000 }
        )
        .catch(() => undefined);
      await page.waitForTimeout(1200);

      // An exact business-name match redirects straight to the place page: there
      // is no results feed to scrape, but the venue is already on screen.
      if (page.url().includes('/maps/place/')) {
        const single = await this.scrapeCurrentPlace(page, page.url());
        return {
          places: single ? [single] : [],
          source: 'maps_scraper',
          provider: this.name,
          warning: single ? undefined : 'Google Maps opened a place page that could not be parsed.',
        };
      }

      const hrefs = await this.collectResultLinks(page, maxResults);
      if (!hrefs.length) {
        return {
          places: [],
          source: 'maps_scraper',
          provider: this.name,
          warning: `Google Maps returned no results for "${query}".`,
        };
      }

      const places: IGooglePlaceRaw[] = [];
      // Allow a little slack so venues right on the boundary are not lost.
      const radiusLimit = params.radius * 1.25;
      let partial = 0;

      for (const { href, ariaLabel } of hrefs.slice(0, maxResults)) {
        // Pace navigations so we look like a person, not a crawler.
        await sleep(randomDelayMs());

        try {
          const place = await this.scrapePlace(page, href, ariaLabel);
          if (place) places.push(place);
        } catch (error: any) {
          if (error instanceof ProviderBlockedError) throw error;

          // Detail panel failed - keep the row using what the link already told
          // us (name, coordinates, identifiers) instead of losing the venue.
          const fallback = this.placeFromHref(href, ariaLabel);
          if (fallback) {
            partial++;
            places.push(fallback);
          }
          console.warn(`[MapsScraper] Detail scrape failed for "${ariaLabel}": ${error.message}`);
        }
      }

      // Google's text search ignores the viewport, so enforce the radius here.
      const withinRadius = places.filter((place) => {
        const location = place.geometry?.location;
        if (!location) return true;
        return distanceMeters(params.lat, params.lng, location.lat, location.lng) <= radiusLimit;
      });

      const dropped = places.length - withinRadius.length;
      const notes: string[] = [];
      if (partial) notes.push(`${partial} of ${places.length} rows have link-level data only`);
      if (dropped) notes.push(`${dropped} results outside the ${params.radius}m radius were dropped`);

      return {
        places: withinRadius,
        source: 'maps_scraper',
        provider: this.name,
        warning: notes.length ? notes.join('; ') : undefined,
      };
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  /** Throws ProviderBlockedError when Google shows a bot wall. */
  private async assertNotBlocked(page: any, status?: number): Promise<void> {
    const [url, title, html] = await Promise.all([
      Promise.resolve(page.url()),
      page.title().catch(() => ''),
      page.content().catch(() => ''),
    ]);

    if (detectBlock({ url, status, title, html })) {
      throw new ProviderBlockedError(
        this.name,
        `Google Maps blocked the scraper (status=${status ?? 'n/a'}, url=${url.slice(0, 120)}). ` +
          'Configure OUTSCRAPER_API_KEY/APIFY_API_KEY or a residential proxy to continue.'
      );
    }
  }

  /** Chooses the privacy-preserving option on the EU consent interstitial. */
  private async dismissConsent(page: any): Promise<void> {
    if (!/consent\.google\.|\/consent/i.test(page.url())) return;

    const rejectButton = page
      .locator('button[aria-label*="Reject all" i], button:has-text("Reject all"), button:has-text("Tümünü reddet")')
      .first();

    if (await rejectButton.count()) {
      await rejectButton.click({ timeout: 8000 }).catch(() => undefined);
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
    }
  }

  /** Scrolls the results feed until it stops growing or maxResults is reached. */
  private async collectResultLinks(
    page: any,
    maxResults: number
  ): Promise<Array<{ href: string; ariaLabel: string }>> {
    const feed = page.locator('[role="feed"]').first();
    if (!(await feed.count())) return this.readResultLinks(page);

    let previous = 0;
    for (let scroll = 0; scroll < config.scraperMaxScrolls; scroll++) {
      const count = await page.locator('a.hfpxzc').count();
      if (count >= maxResults) break;

      // Two stable passes mean the list is exhausted.
      if (count === previous && scroll > 0) break;
      previous = count;

      await feed.evaluate((el: any) => el.scrollTo(0, el.scrollHeight)).catch(() => undefined);
      await page.waitForTimeout(2000);
      await this.assertNotBlocked(page);
    }

    return this.readResultLinks(page);
  }

  private async readResultLinks(page: any): Promise<Array<{ href: string; ariaLabel: string }>> {
    return page.locator('a.hfpxzc').evaluateAll((nodes: any[]) =>
      nodes
        .map((node) => ({
          href: node.getAttribute('href') || '',
          ariaLabel: node.getAttribute('aria-label') || '',
        }))
        .filter((entry) => entry.href.includes('/maps/place/'))
    );
  }

  /** Minimal place built from the result link when detail scraping fails. */
  private placeFromHref(href: string, ariaLabel: string): IGooglePlaceRaw | null {
    const parsed = parsePlaceHref(href, ariaLabel);
    const key = buildPlaceKey(parsed);
    if (!key || !parsed.name) return null;

    return {
      place_id: key,
      name: parsed.name,
      geometry:
        parsed.lat !== undefined && parsed.lng !== undefined
          ? { location: { lat: parsed.lat, lng: parsed.lng } }
          : undefined,
      types: ['restaurant'],
      source_ids: { cid: parsed.cid, entity_id: parsed.entity_id, place_id: parsed.place_id },
    };
  }

  /** Navigates to one place page and reads its detail panel. */
  private async scrapePlace(
    page: any,
    href: string,
    ariaLabel: string
  ): Promise<IGooglePlaceRaw | null> {
    const response = await page.goto(href, {
      waitUntil: 'domcontentloaded',
      timeout: config.scraperTimeoutMs + 10000,
    });
    await this.assertNotBlocked(page, response?.status());
    return this.readPlaceDetail(page, href, ariaLabel);
  }

  /** Reads the detail panel of the place page already open in `page`. */
  private async scrapeCurrentPlace(page: any, url: string): Promise<IGooglePlaceRaw | null> {
    return this.readPlaceDetail(page, url);
  }

  private async readPlaceDetail(
    page: any,
    href: string,
    ariaLabel?: string
  ): Promise<IGooglePlaceRaw | null> {
    const parsed = parsePlaceHref(href, ariaLabel);

    // Maps is a SPA: `domcontentloaded` fires long before the detail pane is
    // populated, and a fixed sleep silently yields an empty record. Wait for
    // the pane itself, then let the remaining fields settle.
    const paneReady0 = await page
      .waitForSelector('button[data-item-id="address"], div[role="main"][aria-label] h1', {
        timeout: 15000,
        state: 'attached',
      })
      .then(() => true)
      .catch(() => false);

    if (!paneReady0) {
      throw new Error('Detail pane did not render in time');
    }

    // The rating block hydrates after the pane. Soft-wait for it: many venues
    // genuinely have no reviews, so a timeout here is not an error.
    await page
      .waitForSelector('div.F7nice', { timeout: 4000, state: 'attached' })
      .catch(() => undefined);
    await page.waitForTimeout(800);

    // Maps rewrites the URL once the place resolves, adding the venue's real
    // !3d/!4d coordinates. Before that, `@lat,lng` is only the viewport centre
    // (i.e. our search origin), which would store every venue at one point.
    const settledUrl: string = page.url();
    const settled = parsePlaceHref(settledUrl, ariaLabel);
    if (settled.coords_precise && settled.lat !== undefined && settled.lng !== undefined) {
      parsed.lat = settled.lat;
      parsed.lng = settled.lng;
      parsed.coords_precise = true;
    }

    // Never persist viewport coordinates as the venue's location.
    if (!parsed.coords_precise) {
      parsed.lat = undefined;
      parsed.lng = undefined;
    }
    parsed.cid = parsed.cid || settled.cid;
    parsed.entity_id = parsed.entity_id || settled.entity_id;
    parsed.place_id = parsed.place_id || settled.place_id;

    const detail = await page.evaluate(() => {
      const text = (selector: string): string | undefined => {
        const el = document.querySelector(selector);
        return el?.textContent?.trim() || undefined;
      };
      const attr = (selector: string, name: string): string | undefined =>
        document.querySelector(selector)?.getAttribute(name) || undefined;
      // aria-label carries a "Address: …" prefix; textContent is the bare value.
      // Take whichever exists so a locale change cannot empty the record.
      const labelOrText = (selector: string): string | undefined =>
        attr(selector, 'aria-label') || text(selector);

      // The search panel also renders an <h1> ("Results"), so scope the name to
      // the detail pane: it is the [role="main"] carrying the venue's aria-label.
      const panes = Array.from(document.querySelectorAll('div[role="main"]'));
      const pane = panes.find((el) => {
        const label = el.getAttribute('aria-label') || '';
        return label && !/^results$/i.test(label) && !/^sonu/i.test(label);
      }) as HTMLElement | undefined;

      const name = pane?.getAttribute('aria-label') || pane?.querySelector('h1')?.textContent?.trim();

      // Opening hours live in a table whose rows pair a day with its hours.
      const hourRows = Array.from(document.querySelectorAll('table tr'))
        .map((row) => {
          const cells = row.querySelectorAll('td, th');
          return {
            day: cells[0]?.textContent?.trim() || '',
            hours: cells[1]?.textContent?.trim() || '',
          };
        })
        .filter((row) => row.day && row.hours)
        .slice(0, 7);

      const categories = Array.from(document.querySelectorAll('button[jsaction*="category"]'))
        .map((el) => el.textContent?.trim() || '')
        .filter(Boolean);

      const heroImage =
        attr('button[jsaction*="heroHeaderImage"] img', 'src') ||
        attr('div[role="main"] img[decoding]', 'src');

      return {
        name,
        ratingText: text('div.F7nice span[aria-hidden="true"]'),
        // The count lives on a <span aria-label="2,475 reviews">; F7nice's own
        // aria-label is the star rating ("4.2 stars") and must not be read here.
        reviewsText:
          Array.from(document.querySelectorAll('[aria-label]'))
            .map((el) => el.getAttribute('aria-label') || '')
            .find((label) => /^[\d.,\s]+(reviews?|yorum)/i.test(label.trim())) ||
          Array.from(document.querySelectorAll('div.F7nice span, button[jsaction*="reviewChart"] span'))
            .map((el) => (el.textContent || '').trim())
            .find((value) => /^[\d.,]+\s*(reviews?|yorum)$/i.test(value)),
        addressLabel: labelOrText('button[data-item-id="address"]'),
        website: attr('a[data-item-id="authority"]', 'href'),
        phoneItemId: attr('button[data-item-id^="phone:tel:"]', 'data-item-id'),
        plusCodeLabel: labelOrText('button[data-item-id="oloc"]'),
        categories,
        hourRows,
        heroImage,
      };
    });

    const formattedAddress = stripAriaPrefix(detail.addressLabel);
    const addressParts = parseTurkishAddress(formattedAddress);
    const phone = parsePhoneItemId(detail.phoneItemId);
    const openingHours = parseOpeningHours(detail.hourRows || []);
    const name = detail.name || parsed.name;

    // A direct place URL can be thin on identifiers; the pane's name plus the
    // resolved coordinates still yield a stable key.
    const key = buildPlaceKey({ ...parsed, name: name || parsed.name });
    if (!key || !name) return null;

    const place: IGooglePlaceRaw = {
      place_id: key,
      name,
      formatted_address: formattedAddress,
      geometry:
        parsed.lat !== undefined && parsed.lng !== undefined
          ? { location: { lat: parsed.lat, lng: parsed.lng } }
          : undefined,
      rating: parseRating(detail.ratingText),
      user_ratings_total: parseReviewCount(detail.reviewsText),
      formatted_phone_number: phone,
      international_phone_number: phone,
      website: detail.website,
      types: detail.categories?.length ? detail.categories : ['restaurant'],
      categories: detail.categories,
      opening_hours: openingHours.length ? { weekday_text: openingHours } : undefined,
      plus_code: stripAriaPrefix(detail.plusCodeLabel),
      address_parts: addressParts,
      source_ids: { cid: parsed.cid, entity_id: parsed.entity_id, place_id: parsed.place_id },
      photos: detail.heroImage ? [{ photo_reference: detail.heroImage, direct_url: detail.heroImage }] : undefined,
    };

    return place;
  }
}
