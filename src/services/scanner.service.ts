import * as cheerio from 'cheerio';
import { RenderService } from './render.service';
import { ISiteProfile, SiteProfileService } from './siteProfile.service';

export interface IScanAuditResult {
  has_website: boolean;
  website_reachable: boolean;
  has_qr_menu: boolean;
  qr_menu_provider?: string;
  qr_menu_url?: string;
  supports_online_ordering: boolean;
  emails: string[];
  phone_numbers: string[];
  social_media: {
    instagram?: string;
    facebook?: string;
    twitter?: string;
    tiktok?: string;
    youtube?: string;
    whatsapp?: string;
  };
  ordering_channels: Array<{ name: string; url: string }>;
  /** Business identity printed on the page itself (address, coords, hours...). */
  profile?: ISiteProfile;
  /** Present when the site could not be scanned - never fabricated data. */
  error?: string;
}

interface IProviderRule {
  name: string;
  pattern: RegExp;
  /**
   * Keyword rules match ordinary page copy ("dijital menü"), not a platform
   * domain, so they cannot be read as "this platform published this page".
   */
  generic?: boolean;
}

export class ScannerService {
  /** QR menu platforms, TR market first. */
  private static knownQrProviders: IProviderRule[] = [
    { name: 'Akınsoft', pattern: /akinsoft\.com\.tr|qrmenuapp\.akinsoft/i },
    { name: 'KarekodApp', pattern: /karekodapp\.com\.tr/i },
    { name: 'QrMatic', pattern: /qrmatic\.link|qrmatic\.com/i },
    { name: 'FineDine', pattern: /finedine(?:menu)?\.(?:co|com)|finedinemenu/i },
    { name: 'Menulux', pattern: /menulux\.(?:com|net)/i },
    { name: 'Adisyo', pattern: /adisyo\.com|qr\.adisyo/i },
    { name: 'MenuTown', pattern: /menutown\.com/i },
    { name: 'Ordable', pattern: /ordable\.(?:com|co)/i },
    { name: 'Menum', pattern: /menum\.(?:com|app)/i },
    { name: 'Qmenu', pattern: /qmenu\.(?:com|com\.tr)/i },
    { name: 'MenuDijital', pattern: /menudijital\.com/i },
    { name: 'Menulog/QR', pattern: /menulog\.com\.tr|qrmenu\.com\.tr/i },
    { name: 'Garsonum', pattern: /garsonum\.com/i },
    { name: 'Nitro Menu', pattern: /nitromenu\.(?:com|net)/i },
    { name: 'Sunmi/QRMenu', pattern: /qrmenu|qr-menu|dijital-?menu|dijitalmenu/i, generic: true },
    { name: 'PDF Menu', pattern: /href=["'][^"']*menu[^"']*\.pdf/i, generic: true },
  ];

  private static knownOrderProviders: IProviderRule[] = [
    { name: 'Yemeksepeti', pattern: /yemeksepeti\.com/i },
    { name: 'GetirYemek', pattern: /getir\.com\/(?:yemek|food)|getiryemek/i },
    { name: 'Trendyol Yemek', pattern: /trendyol\.com\/(?:yemek|go\/yemek)/i },
    { name: 'Migros Yemek', pattern: /migrosyemek\.com/i },
    { name: 'UberEats', pattern: /ubereats\.com/i },
    { name: 'Deliveroo', pattern: /deliveroo\.[a-z.]+/i },
    { name: 'Direct Web Order', pattern: /href=["'][^"']*\/(?:siparis|order|sepet|checkout)\b/i },
  ];

  private static socialPatterns: Array<{ key: keyof IScanAuditResult['social_media']; pattern: RegExp }> = [
    { key: 'instagram', pattern: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.\-]+/i },
    { key: 'facebook', pattern: /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9_.\-]+/i },
    { key: 'twitter', pattern: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_.\-]+/i },
    { key: 'tiktok', pattern: /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9_.\-]+/i },
    { key: 'youtube', pattern: /https?:\/\/(?:www\.)?youtube\.com\/(?:c\/|channel\/|@)[A-Za-z0-9_.\-]+/i },
    { key: 'whatsapp', pattern: /https?:\/\/(?:api\.whatsapp\.com\/send|wa\.me)\/?[^"'\s]*/i },
  ];

  /** Telemetry/SaaS-infrastructure addresses that are never a venue contact. */
  private static machineEmailDomains =
    /(sentry\.io|sentry[\w-]*\.wixpress\.com|wixpress\.com|\.sentry\.|bugsnag|datadoghq|newrelic|litespeed|example\.(com|org|net)|domain\.com|yourdomain|email\.com|sentry-next)/i;

  /**
   * Unedited template addresses shipped by site builders - Wix's Turkish
   * templates use ornek@sitem.com ("example@mysite.com"), which would otherwise
   * be exported as a real lead.
   */
  private static placeholderEmails =
    /^(ornek|örnek|example|sample|test|demo|isim|ad|adiniz|name|your[\w-]*|mail|e-?mail|info)@(sitem|siteniz|siteadi|yoursite|mysite|website|sitename|domain|example|test|demo|mail|email|abc)\./i;

  /**
   * Filters out asset filenames and machine-generated addresses so the lead
   * list holds contactable mailboxes rather than error-reporting endpoints.
   */
  public static isContactEmail(value?: string): boolean {
    if (!value) return false;
    const email = value.trim().toLowerCase();

    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return false;
    if (/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(email)) return false;
    if (this.machineEmailDomains.test(email)) return false;
    if (this.placeholderEmails.test(email)) return false;

    const [localPart] = email.split('@');
    // Hash-like local parts (Sentry DSNs, build ids) are not mailboxes.
    if (/^[0-9a-f]{16,}$/.test(localPart)) return false;
    if (/^(noreply|no-reply|donotreply|do-not-reply)$/.test(localPart)) return false;

    return true;
  }

  private static emptyResult(overrides: Partial<IScanAuditResult> = {}): IScanAuditResult {
    return {
      has_website: false,
      website_reachable: false,
      has_qr_menu: false,
      supports_online_ordering: false,
      emails: [],
      phone_numbers: [],
      social_media: {},
      ordering_channels: [],
      ...overrides,
    };
  }

  /**
   * Normalises a TR phone number to E.164 (+90XXXXXXXXXX).
   * Returns null for anything that is not a plausible 10-digit subscriber
   * number, so run-on digit strings scraped out of markup are discarded
   * rather than stored as bogus contact data.
   */
  public static normalizePhone(raw: string): string | null {
    const trimmed = raw.replace(/[^\d+]/g, '');
    if (!trimmed) return null;

    // Strip the country/trunk prefix down to the 10-digit subscriber number.
    let subscriber: string;
    if (trimmed.startsWith('+90')) subscriber = trimmed.slice(3);
    else if (trimmed.startsWith('90') && trimmed.length === 12) subscriber = trimmed.slice(2);
    else if (trimmed.startsWith('0')) subscriber = trimmed.slice(1);
    else if (trimmed.startsWith('+')) {
      // Non-TR international number: keep it if the length is sane.
      const digits = trimmed.slice(1);
      return digits.length >= 8 && digits.length <= 15 ? trimmed : null;
    } else subscriber = trimmed;

    // TR subscriber numbers are exactly 10 digits and open with an area/mobile
    // prefix in 2-9 (2xx-4xx geographic, 5xx mobile, 8xx/9xx service). A
    // leading 0 or 1 means we matched a digit run, not a phone number.
    if (!/^[2-9]\d{9}$/.test(subscriber)) return null;
    return `+90${subscriber}`;
  }

  private static resolveUrl(href: string, base: string): string {
    try {
      return new URL(href, base).toString();
    } catch {
      return href;
    }
  }

  public static cleanExtractedUrl(rawUrl: string): string {
    let text = rawUrl.replace(/\\/g, '');

    // Handle Instagram redirect links: https://l.instagram.com/?u=...
    if (text.includes('instagram.com') && text.includes('u=')) {
      try {
        const parsed = new URL(text);
        const target = parsed.searchParams.get('u');
        if (target) text = target;
      } catch {}
    }

    // Unescape unicode percent encodings (e.g. u00253A -> %3A -> :)
    text = text.replace(/u0025/gi, '%').replace(/u002f/gi, '/');
    try {
      text = decodeURIComponent(text);
    } catch {}
    try {
      text = decodeURIComponent(text);
    } catch {}

    return text.trim();
  }

  /**
   * Scans a venue website for contacts, social profiles, QR menu platform and
   * online ordering integrations. On failure it reports the error and returns
   * empty fields - it never invents contact data.
   */
  public static async scanWebsite(websiteUrl?: string): Promise<IScanAuditResult> {
    if (!websiteUrl) return this.emptyResult();

    let rendered;
    try {
      rendered = await RenderService.render(websiteUrl);
    } catch (error: any) {
      console.warn(`[ScannerService] Failed to scan ${websiteUrl}: ${error.message}`);
      return this.emptyResult({ has_website: true, error: error.message });
    }

    const html = rendered.html || '';
    const $ = cheerio.load(html);
    const baseUrl = rendered.url || websiteUrl;

    // --- Contacts -----------------------------------------------------------
    const emails = new Set<string>();
    $('a[href^="mailto:"]').each((_, el) => {
      const value = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
      if (this.isContactEmail(value)) emails.add(value.toLowerCase());
    });
    for (const match of html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []) {
      if (this.isContactEmail(match)) emails.add(match.toLowerCase());
    }

    const phones = new Set<string>();
    $('a[href^="tel:"]').each((_, el) => {
      const normalized = this.normalizePhone((($(el).attr('href') || '').replace(/^tel:/i, '')));
      if (normalized) phones.add(normalized);
    });
    // Anchored on both sides so a match can never start or end mid-way through
    // a longer digit run (ids, timestamps) and yield a fabricated number.
    const phoneRe = /(?<![\d+])(?:\+90|0)[\s.\-]?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{2}[\s.\-]?\d{2}(?![\d])/g;
    for (const match of html.match(phoneRe) || []) {
      const normalized = this.normalizePhone(match);
      if (normalized) phones.add(normalized);
    }

    // --- Social media -------------------------------------------------------
    // Platform boilerplate (facebook.com/help, instagram.com/accounts, share
    // and intent links) is not the venue's profile.
    const genericSocialPath =
      /\/(help|privacy|policies?|policy|terms|about|legal|login|signup|accounts?|sharer?|share|intent|explore|developers?|business|pages?\/create)(\/|$|\?)/i;

    const socialMedia: IScanAuditResult['social_media'] = {};
    for (const { key, pattern } of this.socialPatterns) {
      const matches = html.match(new RegExp(pattern.source, 'gi')) || [];
      const profile = matches.find((url) => !genericSocialPath.test(url));
      if (profile) socialMedia[key] = profile;
    }

    // --- QR menu detection --------------------------------------------------
    let hasQrMenu = false;
    let qrProvider: string | undefined;
    let qrUrl: string | undefined;

    for (const provider of this.knownQrProviders) {
      const selfHosted = provider.pattern.test(baseUrl);
      if (!selfHosted && !provider.pattern.test(html)) continue;

      hasQrMenu = true;
      qrProvider = provider.name;

      // The scanned page may *be* the menu (a qrmatic.link subdomain, a
      // /menu.pdf link). In that case the page itself is the menu URL.
      if (selfHosted) {
        qrUrl = baseUrl;
        break;
      }

      // Otherwise take the outbound link - but skip the platform's own
      // marketing site, which menu pages link to in their "powered by"
      // footer and whose path is bare.
      const link = $('a[href]')
        .toArray()
        .map((el) => $(el).attr('href') || '')
        .filter((href) => provider.pattern.test(href))
        .find((href) => {
          const resolved = this.resolveUrl(href, baseUrl);
          try {
            const parsed = new URL(resolved);
            return parsed.pathname.length > 1 || Boolean(parsed.search);
          } catch {
            return false;
          }
        });
      let extractedUrl: string | undefined = link ? this.resolveUrl(link, baseUrl) : undefined;
      if (!extractedUrl) {
        const matches = html.match(
          new RegExp(`https?:\\\\?\\/\\\\?\\/[^"'\\s<>]*(?:${provider.pattern.source})[^"'\\s<>]*`, 'gi')
        );
        if (matches && matches.length) {
          const cleaned = this.cleanExtractedUrl(matches[0]);
          try {
            const parsed = new URL(cleaned);
            if (parsed.pathname.length > 1 || Boolean(parsed.search)) {
              extractedUrl = cleaned;
            }
          } catch {}
        }
      }

      qrUrl = extractedUrl ? this.cleanExtractedUrl(extractedUrl) : provider.generic ? undefined : selfHosted ? baseUrl : undefined;
      if (qrUrl) break;
    }

    // Raw URL match fallback in scripts/text for social profiles (Instagram bio links, Linktree, etc.)
    if (!qrUrl) {
      for (const provider of this.knownQrProviders) {
        if (provider.generic) continue;
        const matches = html.match(
          new RegExp(`https?:\\\\?\\/\\\\?\\/[^"'\\s<>]*(?:${provider.pattern.source})[^"'\\s<>]*`, 'gi')
        );
        if (matches && matches.length) {
          const rawUrl = matches[0].replace(/\\/g, '');
          try {
            const parsed = new URL(rawUrl);
            if (parsed.pathname.length > 1 || Boolean(parsed.search)) {
              hasQrMenu = true;
              qrProvider = provider.name;
              qrUrl = rawUrl;
              break;
            }
          } catch {
            // invalid url
          }
        }
      }
    }

    // Self-hosted menu page (e.g. /menu, /menu.html) still counts as a digital menu.
    if (!hasQrMenu) {
      const menuLink = $('a[href]')
        .toArray()
        .map((el) => $(el).attr('href') || '')
        .find((href) => /\/(menu|menu-?list|menuler|menü)\b/i.test(href));
      if (menuLink) {
        hasQrMenu = true;
        qrProvider = 'Self-hosted';
        qrUrl = this.resolveUrl(menuLink, baseUrl);
      }
    }

    // --- Online ordering ----------------------------------------------------
    const orderingChannels: Array<{ name: string; url: string }> = [];
    for (const orderProvider of this.knownOrderProviders) {
      if (!orderProvider.pattern.test(html)) continue;

      const link = $('a[href]')
        .toArray()
        .map((el) => $(el).attr('href') || '')
        .find((href) => orderProvider.pattern.test(href) || orderProvider.pattern.test(`href="${href}"`));

      orderingChannels.push({
        name: orderProvider.name,
        url: link ? this.resolveUrl(link, baseUrl) : baseUrl,
      });
    }

    return {
      has_website: true,
      website_reachable: true,
      profile: SiteProfileService.extract($, html, baseUrl),
      has_qr_menu: hasQrMenu,
      qr_menu_provider: qrProvider,
      qr_menu_url: qrUrl,
      supports_online_ordering: orderingChannels.length > 0,
      emails: Array.from(emails),
      phone_numbers: Array.from(phones),
      social_media: socialMedia,
      ordering_channels: orderingChannels,
    };
  }
}
