import { create } from 'xmlbuilder2';
import { IVenueDocument } from '../models/Venue';
import { config } from '../config';

export type ExportFormat = 'json' | 'xml' | 'csv';

/**
 * Export engine producing the schemas defined in the specification:
 *  - JSON: the §3.1 MongoDB document shape
 *  - XML : the §3.2 `<placefind_export>` schema
 *  - CSV : flat lead-list for sales/CRM import
 */
export class ExporterService {
  private static money(value: number | undefined): string {
    return (value ?? 0).toFixed(2);
  }

  private static formatUrl(url?: string): string | undefined {
    if (!url) return undefined;
    if (url.startsWith('/') && config.cdnBaseUrl) {
      return `${config.cdnBaseUrl}${url}`;
    }
    return url;
  }

  /** §3.1 document shape, with lat/lng echoed for convenience. */
  public static venueToObject(venue: IVenueDocument): Record<string, any> {
    return {
      id: String(venue._id),
      google_place_id: venue.google_place_id,
      name: venue.name,
      primary_type: venue.primary_type,
      rating: venue.rating,
      user_ratings_total: venue.user_ratings_total,
      price_level: venue.price_level,
      // Venues ingested from a URL may have no coordinates; the key stays
      // present but null so consumers can tell "unknown" from "0, 0".
      location:
        venue.location?.coordinates && venue.location.coordinates.length === 2
          ? {
              type: 'Point',
              coordinates: venue.location.coordinates,
              latitude: venue.location.coordinates[1],
              longitude: venue.location.coordinates[0],
            }
          : null,
      address: {
        formatted: venue.address?.formatted,
        country: venue.address?.country,
        city: venue.address?.city,
        district: venue.address?.district,
        neighborhood: venue.address?.neighborhood,
        postal_code: venue.address?.postal_code,
      },
      contacts: {
        phone_numbers: venue.contacts?.phone_numbers || [],
        emails: venue.contacts?.emails || [],
        website_url: venue.contacts?.website_url,
        social_media: venue.contacts?.social_media || {},
      },
      digital_presence: {
        has_website: venue.digital_presence?.has_website ?? false,
        has_qr_menu: venue.digital_presence?.has_qr_menu ?? false,
        qr_menu_provider: venue.digital_presence?.qr_menu_provider,
        qr_menu_url: venue.digital_presence?.qr_menu_url,
        supports_online_ordering: venue.digital_presence?.supports_online_ordering ?? false,
        ordering_channels: venue.digital_presence?.ordering_channels || [],
      },
      photos: (venue.photos || []).map((photo) => ({
        ...photo,
        webp_image_url: this.formatUrl(photo.webp_image_url),
      })),
      menu: {
        currency: venue.menu?.currency || 'TRY',
        updated_at: venue.menu?.updated_at,
        source_url: venue.menu?.source_url,
        extraction_method: venue.menu?.extraction_method,
        categories: (venue.menu?.categories || []).map((category) => ({
          category_id: category.category_id,
          name: category.name,
          items: (category.items || []).map((item) => ({
            item_id: item.item_id,
            name: item.name,
            description: item.description,
            price: item.price,
            currency: item.currency,
            original_image_url: item.original_image_url,
            webp_image_url: this.formatUrl(item.webp_image_url),
            is_available: item.is_available,
            allergens: item.allergens,
            variants: item.variants,
          })),
        })),
      },
      // Optional enrichment beyond the specification schema.
      categories: venue.categories,
      opening_hours: venue.opening_hours,
      plus_code: venue.plus_code,
      source_ids: venue.source_ids,
      data_source: venue.data_source,
      provider: venue.provider,
      created_at: venue.created_at,
      updated_at: venue.updated_at,
    };
  }

  public static toJSON(venue: IVenueDocument): string {
    return this.manyToJSON([venue]);
  }

  public static manyToJSON(venues: IVenueDocument[]): string {
    return JSON.stringify(
      {
        status: 'success',
        generated_at: new Date().toISOString(),
        count: venues.length,
        venues: venues.map((venue) => this.venueToObject(venue)),
      },
      null,
      2
    );
  }

  public static toXML(venue: IVenueDocument): string {
    return this.manyToXML([venue]);
  }

  /** Builds the §3.2 `<placefind_export>` document for one or many venues. */
  public static manyToXML(venues: IVenueDocument[]): string {
    const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('placefind_export', {
      generated_at: new Date().toISOString(),
      count: String(venues.length),
    });

    for (const venue of venues) {
      const venueNode = root.ele('venue', { id: String(venue._id) });

      venueNode.ele('google_place_id').txt(venue.google_place_id).up();
      venueNode.ele('name').txt(venue.name).up();
      venueNode.ele('primary_type').txt(venue.primary_type || '').up();
      if (venue.rating !== undefined) venueNode.ele('rating').txt(String(venue.rating)).up();

      const coordinates = venue.location?.coordinates;
      const locationNode = venueNode.ele(
        'location',
        coordinates ? { lat: String(coordinates[1]), lng: String(coordinates[0]) } : {}
      );
      if (venue.address?.formatted) locationNode.ele('address').txt(venue.address.formatted).up();
      locationNode.ele('city').txt(venue.address?.city || '').up();
      locationNode.ele('district').txt(venue.address?.district || '').up();
      if (venue.address?.country) locationNode.ele('country').txt(venue.address.country).up();
      locationNode.up();

      const contactsNode = venueNode.ele('contacts');
      for (const email of venue.contacts?.emails || []) contactsNode.ele('email').txt(email).up();
      for (const phone of venue.contacts?.phone_numbers || []) contactsNode.ele('phone').txt(phone).up();
      if (venue.contacts?.website_url) contactsNode.ele('website').txt(venue.contacts.website_url).up();
      const social = venue.contacts?.social_media || {};
      for (const [platform, url] of Object.entries(social)) {
        if (url) contactsNode.ele('social', { platform }).txt(String(url)).up();
      }
      contactsNode.up();

      const presence = venue.digital_presence;
      const presenceNode = venueNode.ele('digital_presence');
      presenceNode.ele('has_website').txt(String(presence?.has_website ?? false)).up();
      presenceNode.ele('has_qr_menu').txt(String(presence?.has_qr_menu ?? false)).up();
      presenceNode.ele('qr_provider').txt(presence?.qr_menu_provider || '').up();
      if (presence?.qr_menu_url) presenceNode.ele('qr_menu_url').txt(presence.qr_menu_url).up();
      presenceNode
        .ele('supports_online_ordering')
        .txt(String(presence?.supports_online_ordering ?? false))
        .up();
      for (const channel of presence?.ordering_channels || []) {
        presenceNode.ele('ordering_channel', { name: channel.name || '' }).txt(channel.url || '').up();
      }
      presenceNode.up();

      // Additive enrichment nodes; the spec §3.2 elements above are unchanged.
      if (venue.categories?.length) {
        const categoriesNode = venueNode.ele('categories');
        for (const category of venue.categories) categoriesNode.ele('category').txt(category).up();
        categoriesNode.up();
      }
      if (venue.opening_hours?.weekday_text?.length) {
        const hoursNode = venueNode.ele('opening_hours');
        for (const day of venue.opening_hours.weekday_text) hoursNode.ele('day').txt(day).up();
        hoursNode.up();
      }
      if (venue.plus_code) venueNode.ele('plus_code').txt(venue.plus_code).up();
      if (venue.data_source) venueNode.ele('data_source').txt(venue.data_source).up();

      const menuNode = venueNode.ele('menu', { currency: venue.menu?.currency || 'TRY' });
      for (const category of venue.menu?.categories || []) {
        const categoryNode = menuNode.ele('category', { name: category.name, id: category.category_id });
        for (const item of category.items || []) {
          const itemNode = categoryNode.ele('item', { id: item.item_id });
          itemNode.ele('name').txt(item.name).up();
          if (item.description) itemNode.ele('description').txt(item.description).up();
          itemNode.ele('price').txt(this.money(item.price)).up();
          for (const allergen of item.allergens || []) {
            itemNode.ele('allergen').txt(allergen).up();
          }
          for (const variant of item.variants || []) {
            itemNode.ele('variant', { name: variant.name }).txt(this.money(variant.price)).up();
          }
          if (item.webp_image_url) itemNode.ele('image_webp').txt(item.webp_image_url).up();
          itemNode.ele('is_available').txt(String(item.is_available ?? true)).up();
          itemNode.up();
        }
        categoryNode.up();
      }
      menuNode.up();
      venueNode.up();
    }

    return root.end({ prettyPrint: true });
  }

  /** Flat CSV lead list - one row per venue. */
  public static manyToCSV(venues: IVenueDocument[]): string {
    const headers = [
      'id',
      'google_place_id',
      'name',
      'primary_type',
      'rating',
      'user_ratings_total',
      'latitude',
      'longitude',
      'city',
      'district',
      'address',
      'phones',
      'emails',
      'website',
      'instagram',
      'has_website',
      'has_qr_menu',
      'qr_menu_provider',
      'qr_menu_url',
      'supports_online_ordering',
      'menu_categories',
      'menu_items',
      'data_source',
      'provider',
      'categories',
      'plus_code',
      'postal_code',
      'opening_hours',
    ];

    const escape = (value: unknown): string => {
      const text = value === undefined || value === null ? '' : String(value);
      return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const rows = venues.map((venue) => {
      const categories = venue.menu?.categories || [];
      const itemCount = categories.reduce((sum, c) => sum + (c.items?.length || 0), 0);

      return [
        String(venue._id),
        venue.google_place_id,
        venue.name,
        venue.primary_type,
        venue.rating,
        venue.user_ratings_total,
        venue.location?.coordinates?.[1],
        venue.location?.coordinates?.[0],
        venue.address?.city,
        venue.address?.district,
        venue.address?.formatted,
        (venue.contacts?.phone_numbers || []).join(' | '),
        (venue.contacts?.emails || []).join(' | '),
        venue.contacts?.website_url,
        venue.contacts?.social_media?.instagram,
        venue.digital_presence?.has_website,
        venue.digital_presence?.has_qr_menu,
        venue.digital_presence?.qr_menu_provider,
        venue.digital_presence?.qr_menu_url,
        venue.digital_presence?.supports_online_ordering,
        categories.length,
        itemCount,
        venue.data_source,
        venue.provider,
        (venue.categories || []).join(' | '),
        venue.plus_code,
        venue.address?.postal_code,
        (venue.opening_hours?.weekday_text || []).join(' | '),
      ]
        .map(escape)
        .join(',');
    });

    // BOM keeps Turkish characters intact when opened in Excel.
    return `﻿${headers.join(',')}\n${rows.join('\n')}`;
  }
}
