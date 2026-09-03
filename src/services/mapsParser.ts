/**
 * Pure parsing helpers for the Google Maps scraper.
 *
 * Deliberately browser-free so every rule here is unit-testable without
 * launching Chromium — the DOM-touching code lives in
 * src/providers/mapsScraper.provider.ts.
 */

export interface IParsedPlaceHref {
  /** Google's stable customer id, e.g. "0x14cab9206d79cf0b:0x46da4e133c86ea24". */
  cid?: string;
  /** Knowledge-graph entity id from the !16s segment, e.g. "/g/11c1b0j0kq". */
  entity_id?: string;
  /** ChIJ… place id, present only on some hrefs. */
  place_id?: string;
  lat?: number;
  lng?: number;
  /** False when lat/lng came from the map viewport rather than the venue. */
  coords_precise?: boolean;
  name?: string;
}

export interface IParsedAddressParts {
  city?: string;
  district?: string;
  neighborhood?: string;
  postal_code?: string;
}

export interface IBlockSignal {
  url?: string;
  status?: number;
  title?: string;
  html?: string;
}

/**
 * Maps a search radius (meters) to a Google Maps zoom level.
 * Lower zoom = wider area; Google clamps roughly between 3z and 21z.
 */
export function radiusToZoom(radiusMeters: number): number {
  const radius = Math.max(1, radiusMeters);
  // ~1200m of visible half-width per zoom step around z15 at mid latitudes.
  const zoom = Math.round(15 - Math.log2(radius / 2000));
  return Math.min(19, Math.max(10, zoom));
}

/** Builds a Google Maps search URL centred on lat/lng. */
export function buildSearchUrl(
  query: string,
  lat: number,
  lng: number,
  radiusMeters: number,
  locale = 'en'
): string {
  const zoom = radiusToZoom(radiusMeters);
  return (
    `https://www.google.com/maps/search/${encodeURIComponent(query.trim())}/` +
    `@${lat},${lng},${zoom}z?hl=${encodeURIComponent(locale)}`
  );
}

/**
 * Extracts identifiers and coordinates from a Maps result href.
 *
 * Real example (captured from a live probe):
 *   https://www.google.com/maps/place/VAU+COFFEE+KADIK%C3%96Y/data=!4m7!3m6
 *     !1s0x14cab9206d79cf0b:0x46da4e133c86ea24!8m2!3d40.991179!4d29.0281696!16s%2Fg%2F...
 */
export function parsePlaceHref(href: string, ariaLabel?: string): IParsedPlaceHref {
  const decoded = safeDecode(href);
  const result: IParsedPlaceHref = {};

  const cid = decoded.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  if (cid) result.cid = cid[1];

  const placeId = decoded.match(/!19s(ChIJ[\w-]+)|!1s(ChIJ[\w-]+)/);
  if (placeId) result.place_id = placeId[1] || placeId[2];

  const entity = decoded.match(/!16s(\/[a-z]\/[\w-]+)/i);
  if (entity) result.entity_id = entity[1];

  // Coordinates: only the !3d/!4d pair is the venue itself. The @lat,lng in the
  // path is the map viewport - on a direct place URL that is the search origin,
  // so using it would pin every venue to the same point.
  const precise = decoded.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (precise) {
    result.lat = parseFloat(precise[1]);
    result.lng = parseFloat(precise[2]);
    result.coords_precise = true;
  } else {
    const viewport = decoded.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (viewport) {
      result.lat = parseFloat(viewport[1]);
      result.lng = parseFloat(viewport[2]);
      result.coords_precise = false;
    }
  }

  if (ariaLabel && ariaLabel.trim()) {
    result.name = ariaLabel.trim();
  } else {
    const slug = decoded.match(/\/maps\/place\/([^/@]+)/);
    if (slug) result.name = slug[1].replace(/\+/g, ' ').trim();
  }

  return result;
}

/**
 * Derives a stable venue key. Scraped places rarely expose a ChIJ… place id,
 * so the CID becomes the identity and is namespaced to keep it distinguishable
 * from real Places API ids.
 */
export function buildPlaceKey(parsed: IParsedPlaceHref): string | null {
  if (parsed.place_id) return parsed.place_id;
  if (parsed.cid) return `gmaps_${parsed.cid.replace(/[^0-9a-fx]/gi, '_')}`;
  if (parsed.entity_id) return `gmaps${parsed.entity_id.replace(/\//g, '_')}`;
  if (parsed.name && parsed.lat !== undefined && parsed.lng !== undefined) {
    const slug = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    return `gmaps_${slug}_${parsed.lat.toFixed(5)}_${parsed.lng.toFixed(5)}`;
  }
  return null;
}

/**
 * Splits a Turkish formatted address into administrative parts.
 * Maps returns one formatted string (no address_components), e.g.
 *   "Osmanağa, Halitağa Cd. No:10A, 34714 Kadıköy/İstanbul"
 */
export function parseTurkishAddress(formatted?: string): IParsedAddressParts {
  const parts: IParsedAddressParts = {};
  if (!formatted) return parts;

  const segments = formatted.split(',').map((segment) => segment.trim()).filter(Boolean);

  // A venue's own site prints the country; Maps does not. Drop it, otherwise
  // the country ends up stored as the city.
  const countryRe = /^(t[üu]rkiye|turkey|tr|kktc|k\.k\.t\.c\.?|cyprus|kibris|kıbrıs)$/i;
  while (segments.length > 1 && countryRe.test(segments[segments.length - 1])) {
    segments.pop();
  }
  if (!segments.length) return parts;

  const tail = segments[segments.length - 1];

  // "34714 Kadıköy/İstanbul" or "Kadıköy/İstanbul"
  const postal = tail.match(/\b(\d{5})\b/);
  if (postal) parts.postal_code = postal[1];

  const withoutPostal = tail.replace(/\b\d{5}\b/, '').trim();
  const slash = withoutPostal.split('/');
  if (slash.length >= 2) {
    parts.district = slash[0].trim() || undefined;
    parts.city = slash[slash.length - 1].trim() || undefined;
  } else if (withoutPostal) {
    parts.city = withoutPostal;
  }

  // The leading segment is the neighbourhood when it carries no street number.
  if (segments.length >= 2) {
    const head = segments[0];
    if (!/\d|cd\.|cad\.|sok|sk\.|blv|bulvar|no:/i.test(head)) {
      parts.neighborhood = head.replace(/\s+(mah\.?|mahallesi)$/i, '').trim() || undefined;
    }
  }

  return parts;
}

/** Parses "4.7" (hl=en) or "4,7" (hl=tr) into a number. */
export function parseRating(text?: string): number | undefined {
  if (!text) return undefined;
  const match = text.match(/(\d+[.,]\d+|\d+)/);
  if (!match) return undefined;
  const value = parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= 5 ? value : undefined;
}

/**
 * Parses "150 reviews" / "(1.840)" / "150 yorum" into a count.
 *
 * Rejects star-rating labels ("4.2 stars"): Google renders the rating and the
 * review count in sibling spans, and reading the wrong one silently turns a
 * 4.2 rating into 42 reviews.
 */
export function parseReviewCount(text?: string): number | undefined {
  if (!text) return undefined;
  if (/star|yıldız/i.test(text)) return undefined;

  const match = text.replace(/[()\s]/g, '').match(/([\d.,]+)/);
  if (!match) return undefined;

  // A bare decimal like "4.2" is a rating, not a count.
  if (/^\d+[.,]\d$/.test(match[1])) return undefined;

  const value = parseInt(match[1].replace(/[.,]/g, ''), 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Great-circle distance in meters between two coordinates. */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Extracts "+905321234567" from a data-item-id like "phone:tel:+90 532 123 45 67". */
export function parsePhoneItemId(dataItemId?: string): string | undefined {
  if (!dataItemId) return undefined;
  const match = dataItemId.match(/phone:tel:(.+)$/i);
  return match ? match[1].trim() : undefined;
}

/** Strips the "Address: " / "Adres: " prefix Google puts on aria-labels. */
export function stripAriaPrefix(value?: string | null): string | undefined {
  if (!value) return undefined;
  return value.replace(/^[^:]{1,24}:\s*/, '').trim() || undefined;
}

/** Normalises scraped opening-hours rows into "Monday: 09:00–22:00" strings. */
export function parseOpeningHours(rows: Array<{ day?: string; hours?: string }>): string[] {
  return rows
    .map(({ day, hours }) => {
      const cleanDay = (day || '').replace(/\s+/g, ' ').trim();
      const cleanHours = (hours || '').replace(/\s+/g, ' ').trim();
      if (!cleanDay && !cleanHours) return '';
      if (!cleanHours) return cleanDay;
      return `${cleanDay}: ${cleanHours}`;
    })
    .filter(Boolean);
}

/**
 * Detects a Google bot-protection wall. The scraper stops and reports when this
 * fires — it never attempts to solve or bypass the challenge.
 */
export function detectBlock(signal: IBlockSignal): boolean {
  const { url = '', status, title = '', html = '' } = signal;

  if (status === 429 || status === 503) return true;
  if (/\/sorry\/|consent\.google\.com\/m\?|ipv4\.google\.com\/sorry/i.test(url)) return true;
  if (/unusual traffic|before you continue to google|our systems have detected/i.test(title)) return true;

  const head = html.slice(0, 200_000);
  if (/id=["']captcha-form["']|g-recaptcha|recaptcha\/api\.js|\/sorry\/index/i.test(head)) return true;
  if (/our systems have detected unusual traffic/i.test(head)) return true;

  return false;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
