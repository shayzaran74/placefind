import * as cheerio from 'cheerio';

/**
 * Business identity advertised by a venue's own page.
 *
 * A QR menu page is the venue's own publication, so it carries facts Google
 * Maps does not: the exact address block it prints in its footer, the meal
 * cards it accepts, the languages it publishes in, and - through its
 * "get directions" links - the coordinates the owner themselves pinned.
 * Every field is optional: nothing here is invented when the page is silent.
 */
export interface ISiteProfile {
  name?: string;
  address?: string;
  coordinates?: { lat: number; lng: number };
  /** Free-form opening-hour lines exactly as published. */
  opening_hours?: string[];
  /** Meal cards and payment rails, canonicalised ("Sodexo", "Multinet"...). */
  payment_methods?: string[];
  /** ISO-639-1 codes the page is published in. */
  languages?: string[];
  /** Logo / cover imagery, absolute URLs, most representative first. */
  images: string[];
}

interface IPaymentRule {
  name: string;
  pattern: RegExp;
}

export class SiteProfileService {
  /**
   * TR meal-card market plus the card schemes. Matched only inside payment /
   * footer blocks: a bare "visa" anywhere on a page is not a payment signal.
   */
  private static paymentRules: IPaymentRule[] = [
    { name: 'Sodexo', pattern: /sodexo/i },
    { name: 'Multinet', pattern: /multinet/i },
    { name: 'SetCard', pattern: /set-?card/i },
    { name: 'Edenred', pattern: /edenred|ticket-?restaurant/i },
    { name: 'Metropol', pattern: /metropol-?card/i },
    { name: 'Paye', pattern: /\bpaye\b/i },
    { name: 'Winwin', pattern: /win-?win/i },
    { name: 'Visa', pattern: /\bvisa\b/i },
    { name: 'Mastercard', pattern: /master-?card/i },
    { name: 'Troy', pattern: /\btroy\b/i },
    { name: 'Nakit', pattern: /\bnakit\b/i },
    { name: 'Kredi Kartı', pattern: /kredi\s*kart/i },
    { name: 'Yemek Kartı', pattern: /yemek\s*(kart|çek|cek)/i },
  ];

  /** Turkish and English weekday names introduce an opening-hours line. */
  private static dayNameRe =
    /(pazartesi|salı|sali|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hafta ?içi|hafta ?sonu|her ?gün)/i;

  private static timeRangeRe = /\d{1,2}[:.]\d{2}\s*[-–—/]\s*\d{1,2}[:.]\d{2}/;

  /** Words that belong to the publishing platform, not to the venue. */
  private static platformNoiseRe =
    /(qr\s*men[uü]|dijital\s*men[uü]|digital\s*menu|online\s*men[uü]|men[uü]\s*kart|^men[uü]$|qrmatic|finedine|menulux|adisyo|menutown|qmenu|powered\s*by|ana\s*sayfa|home)/i;

  private static clean(value?: string | null): string | undefined {
    const text = (value || '').replace(/\s+/g, ' ').trim();
    return text || undefined;
  }

  private static absolute(url: string | undefined, baseUrl: string): string | undefined {
    if (!url || url.startsWith('data:')) return undefined;
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      return undefined;
    }
  }

  /** Every JSON-LD node on the page, `@graph` containers flattened. */
  private static jsonLdNodes($: cheerio.CheerioAPI): any[] {
    const nodes: any[] = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text();
      if (!raw.trim()) return;

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      const graph = parsed['@graph'] || parsed;
      for (const node of Array.isArray(graph) ? graph : [graph]) {
        if (node && typeof node === 'object') nodes.push(node);
      }
    });

    return nodes;
  }

  /**
   * Strips the publisher's boilerplate off a page title.
   * "Barış Pide | QR Menü - QrMatic.Link" -> "Barış Pide".
   */
  public static cleanTitle(title?: string): string | undefined {
    const text = this.clean(title);
    if (!text) return undefined;

    const segments = text
      .split(/\s*[|·•]\s*|\s+[-–—]\s+/)
      .map((segment) => segment.trim())
      .filter(Boolean);

    const meaningful = segments.filter(
      (segment) => !this.platformNoiseRe.test(segment) && segment.length >= 2
    );

    const chosen = meaningful[0] || segments[0];
    return chosen && chosen.length <= 120 ? chosen : undefined;
  }

  /**
   * Venue name. Ordered by how much the source knows about *this* venue:
   * structured data, then the page's own company block, then social meta -
   * `og:site_name` is deliberately last-resort because menu platforms put
   * their own brand there.
   */
  private static extractName($: cheerio.CheerioAPI, nodes: any[]): string | undefined {
    for (const node of nodes) {
      const type = String(node['@type'] || '');
      if (/Restaurant|FoodEstablishment|CafeOrCoffeeShop|LocalBusiness|Organization/i.test(type)) {
        const name = this.clean(node.name);
        if (name) return name;
      }
    }

    const companyBlock = this.clean(
      $('[class*="company-name"], [class*="restaurant-name"], [class*="firma-ad"], [itemprop="name"]')
        .first()
        .text()
    );
    if (companyBlock && companyBlock.length <= 120) return companyBlock;

    return (
      this.cleanTitle($('meta[name="twitter:title"]').attr('content')) ||
      this.cleanTitle($('meta[property="og:title"]').attr('content')) ||
      this.cleanTitle($('title').first().text())
    );
  }

  /** Postal address as printed by the venue. */
  private static extractAddress($: cheerio.CheerioAPI, nodes: any[]): string | undefined {
    for (const node of nodes) {
      const address = node.address;
      if (!address) continue;
      if (typeof address === 'string') {
        const text = this.clean(address);
        if (text) return text;
      } else if (typeof address === 'object') {
        const parts = [
          address.streetAddress,
          address.addressLocality,
          address.postalCode,
          address.addressRegion,
          address.addressCountry,
        ]
          .map((part: any) => this.clean(typeof part === 'object' ? part?.name : part))
          .filter(Boolean);
        if (parts.length) return parts.join(', ');
      }
    }

    const candidates = $('address, [class*="address"], [class*="adres"], [itemprop="streetAddress"]')
      .toArray()
      .map((el) => this.clean($(el).text()))
      .filter((text): text is string => Boolean(text) && text!.length >= 12 && text!.length <= 250);

    // Also look for elements following headings or labels like "Adres", "Address", "İletişim"
    $('h1, h2, h3, h4, h5, h6, strong, b, label, dt').each((_, el) => {
      const labelText = $(el).text().trim().toLowerCase();
      if (/^(adres|address)\b/i.test(labelText)) {
        const nextEl = $(el).next();
        const parent = $(el).parent();
        const siblingText = this.clean(nextEl.text()) || this.clean(parent.find('p, span, div').not(el).text());
        if (siblingText && siblingText.length >= 10 && siblingText.length <= 250) {
          candidates.push(siblingText);
        }
      }
    });

    // A real address block names a district or carries a postcode; a nav item
    // whose class merely contains "address" does neither.
    return (
      candidates.find((text) => /\b\d{5}\b/.test(text) || /\//.test(text)) || candidates[0]
    );
  }

  /**
   * Coordinates the owner pinned themselves, read from the map links every
   * QR menu prints ("Yol Tarifi"). Each provider orders the pair differently,
   * so the parameter - not the position in the URL - decides.
   */
  public static extractCoordinates(html: string): { lat: number; lng: number } | undefined {
    const valid = (lat: number, lng: number): boolean =>
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180 &&
      // 0,0 is the Atlantic, not a restaurant: it means the site shipped an
      // unconfigured map widget.
      !(Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01);

    // Yandex is checked first and its own pattern is the only one allowed to
    // read a `ll=` pair: it prints *longitude first*, so letting the generic
    // rule below match a Yandex link would silently transpose the venue.
    const yandex = html.match(
      /yandex\.[a-z.]+\/(?:maps|harita)\/[^"'\s]*[?&](?:ll|pt)=(-?\d{1,3}\.\d{3,}),(-?\d{1,3}\.\d{3,})/i
    );
    if (yandex) {
      const lng = parseFloat(yandex[1]);
      const lat = parseFloat(yandex[2]);
      if (valid(lat, lng)) return { lat, lng };
    }

    const latLngPatterns: RegExp[] = [
      // maps.google.com/?q=39.91,32.75 · google.com/maps/@39.91,32.75,17z
      /(?:maps\.google\.[a-z.]+\/\?q=|google\.[a-z.]+\/maps\/(?:place\/[^/]*\/)?@|[?&](?:q|ll|daddr|destination)=)(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/gi,
      // maps.apple.com/?ll=39.91,32.75
      /maps\.apple\.com\/[^"'\s]*[?&]ll=(-?\d{1,3}\.\d{3,}),(-?\d{1,3}\.\d{3,})/gi,
      // openstreetmap.org/?mlat=39.91&mlon=32.75
      /mlat=(-?\d{1,3}\.\d{3,})&(?:amp;)?mlon=(-?\d{1,3}\.\d{3,})/gi,
    ];

    for (const pattern of latLngPatterns) {
      for (const match of html.matchAll(pattern)) {
        // A Yandex link its own pattern could not read must not fall through
        // to a latitude-first reading here.
        const context = html.slice(Math.max(0, (match.index ?? 0) - 120), match.index ?? 0);
        if (/yandex\.[a-z.]+[^"'\s]*$/i.test(context)) continue;

        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        if (valid(lat, lng)) return { lat, lng };
      }
    }

    // Google's embed iframe: !2d<lng>!3d<lat>
    const embed = html.match(/!2d(-?\d{1,3}\.\d{3,})!3d(-?\d{1,3}\.\d{3,})/);
    if (embed) {
      const lng = parseFloat(embed[1]);
      const lat = parseFloat(embed[2]);
      if (valid(lat, lng)) return { lat, lng };
    }

    // schema.org GeoCoordinates.
    const geo = html.match(
      /"latitude"\s*:\s*"?(-?\d{1,3}\.\d{3,})"?[^}]*?"longitude"\s*:\s*"?(-?\d{1,3}\.\d{3,})"?/i
    );
    if (geo) {
      const lat = parseFloat(geo[1]);
      const lng = parseFloat(geo[2]);
      if (valid(lat, lng)) return { lat, lng };
    }

    return undefined;
  }

  private static extractOpeningHours($: cheerio.CheerioAPI, nodes: any[]): string[] | undefined {
    const lines: string[] = [];

    for (const node of nodes) {
      const spec = node.openingHoursSpecification || node.openingHours;
      if (!spec) continue;

      for (const entry of Array.isArray(spec) ? spec : [spec]) {
        if (typeof entry === 'string') {
          const text = this.clean(entry);
          if (text) lines.push(text);
          continue;
        }
        const days = entry?.dayOfWeek;
        const dayText = (Array.isArray(days) ? days : [days])
          .map((day: any) => this.clean(String(day || '').split('/').pop()))
          .filter(Boolean)
          .join(', ');
        const open = this.clean(entry?.opens);
        const close = this.clean(entry?.closes);
        if (dayText && open && close) lines.push(`${dayText}: ${open} - ${close}`);
      }
    }

    if (lines.length) return Array.from(new Set(lines)).slice(0, 14);

    // Fall back to printed hour lines: a day name and a time range together.
    $('[class*="hour"], [class*="saat"], [class*="calisma"], [class*="çalışma"], [class*="open"], li, p, td')
      .toArray()
      .forEach((el) => {
        const text = this.clean($(el).text());
        if (!text || text.length > 90) return;
        if (!this.dayNameRe.test(text) || !this.timeRangeRe.test(text)) return;
        if (!lines.includes(text)) lines.push(text);
      });

    return lines.length ? lines.slice(0, 14) : undefined;
  }

  /**
   * Meal cards and payment rails. Scanned only inside payment/footer markup so
   * an unrelated "visa" (visa requirements, a font name) is not exported as an
   * accepted card.
   */
  private static extractPaymentMethods($: cheerio.CheerioAPI): string[] | undefined {
    const scopes = $(
      '[class*="payment"], [class*="odeme"], [class*="ödeme"], [class*="meal-card"], [class*="card"], [class*="kart"], footer'
    ).toArray();
    if (!scopes.length) return undefined;

    // Attribute values matter as much as text: cards are usually just logos.
    const haystack = scopes
      .map((el) => {
        const $el = $(el);
        const attrs = $el
          .find('img')
          .toArray()
          .map((img) => `${$(img).attr('src') || ''} ${$(img).attr('alt') || ''} ${$(img).attr('title') || ''}`)
          .join(' ');
        return `${$el.text()} ${attrs}`;
      })
      .join(' ');

    const found = this.paymentRules
      .filter((rule) => rule.pattern.test(haystack))
      .map((rule) => rule.name);

    return found.length ? Array.from(new Set(found)) : undefined;
  }

  /** Languages the menu is published in, from hreflang and language switchers. */
  private static extractLanguages($: cheerio.CheerioAPI): string[] | undefined {
    const codes = new Set<string>();

    const push = (value?: string | null): void => {
      const code = (value || '').trim().toLowerCase().split('-')[0];
      if (/^[a-z]{2}$/.test(code)) codes.add(code);
    };

    push($('html').attr('lang'));
    $('link[rel="alternate"][hreflang]').each((_, el) => push($(el).attr('hreflang')));
    // Language switchers link to a locale-prefixed copy of the same page.
    $('a[href]').each((_, el) => {
      const match = ($(el).attr('href') || '').match(/^(?:https?:\/\/[^/]+)?\/([a-z]{2})\//i);
      if (match) push(match[1]);
    });

    return codes.size ? Array.from(codes).sort() : undefined;
  }

  /** Logo and cover imagery, ordered logo-first. */
  private static extractImages($: cheerio.CheerioAPI, baseUrl: string): string[] {
    const images: string[] = [];

    const add = (url?: string): void => {
      const absolute = this.absolute(url, baseUrl);
      // Icons and flags are chrome, not venue photography.
      if (!absolute || images.includes(absolute)) return;
      if (/\/(flags?|icons?|cards?)\//i.test(absolute) || /\.svg($|\?)/i.test(absolute)) return;
      images.push(absolute);
    };

    add($('img[class*="logo"], [class*="logo"] img').first().attr('src'));

    // Header/hero art is normally a CSS background rather than an <img>. Take
    // the first banner that actually declares one: `.popup-header` and friends
    // also match a class-name search and would otherwise shadow the real cover.
    for (const el of $('header, [class*="hero"], [class*="cover"], [class*="banner"], [class*="header"]').toArray()) {
      const background = ($(el).attr('style') || '').match(/url\((['"]?)([^'")]+)\1\)/i);
      if (background) {
        add(background[2]);
        break;
      }
    }

    add($('meta[property="og:image"]').attr('content'));

    // Category and banner photos from QR menus (e.g. Akınsoft category-photo)
    $('[class*="category-photo"], [class*="restaurant-top-image"], [class*="category"] img').each((_, el) => {
      const $el = $(el);
      const dataSrc = $el.attr('data-src') || $el.attr('data-original') || $el.attr('src');
      if (dataSrc) add(dataSrc);
      const style = $el.attr('style') || '';
      const bgMatch = style.match(/url\((['"]?)([^'")]+)\1\)/i);
      if (bgMatch) add(bgMatch[2]);
    });

    return images.slice(0, 10);
  }

  /**
   * Reads the venue's own identity off a rendered page. Fields the page does
   * not state stay undefined - this never guesses a value.
   */
  public static extract($: cheerio.CheerioAPI, html: string, baseUrl: string): ISiteProfile {
    const nodes = this.jsonLdNodes($);

    return {
      name: this.extractName($, nodes),
      address: this.extractAddress($, nodes),
      coordinates: this.extractCoordinates(html),
      opening_hours: this.extractOpeningHours($, nodes),
      payment_methods: this.extractPaymentMethods($),
      languages: this.extractLanguages($),
      images: this.extractImages($, baseUrl),
    };
  }
}
