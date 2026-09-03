import mongoose, { Schema, Document } from 'mongoose';

export type DataSource =
  | 'google_places'
  | 'maps_scraper'
  | 'outscraper'
  | 'apify'
  /** Ingested from a URL the operator supplied (venue's own site / QR menu). */
  | 'web_menu'
  | 'mock'
  | 'manual';

export interface IMenuItem {
  item_id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  original_image_url?: string;
  webp_image_url?: string;
  is_available: boolean;
  /** Allergen notes as written on the source menu, e.g. "Glüten içerir." */
  allergens?: string[];
  /** Sellable size/portion options, e.g. { name: "Büyük Boy", price: 240 }. */
  variants?: Array<{ name: string; price: number }>;
}

export interface IMenuCategory {
  category_id: string;
  name: string;
  items: IMenuItem[];
}

export interface IVenuePhoto {
  original_image_url?: string;
  webp_image_url?: string;
  width?: number;
  height?: number;
}

export interface IVenueDocument extends Document {
  google_place_id: string;
  name: string;
  primary_type: string;
  rating?: number;
  user_ratings_total?: number;
  price_level?: number;
  /**
   * Optional on purpose: a venue ingested from its menu URL has coordinates
   * only if its page states them. Storing [0, 0] instead would put the venue
   * in the Atlantic and corrupt every radius query it appears in.
   */
  location?: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  address: {
    formatted: string;
    country?: string;
    city?: string;
    district?: string;
    neighborhood?: string;
    postal_code?: string;
  };
  contacts: {
    phone_numbers: string[];
    emails: string[];
    website_url?: string;
    social_media?: {
      instagram?: string;
      facebook?: string;
      twitter?: string;
      tiktok?: string;
      youtube?: string;
      whatsapp?: string;
    };
  };
  digital_presence: {
    has_website: boolean;
    has_qr_menu: boolean;
    qr_menu_provider?: string;
    qr_menu_url?: string;
    supports_online_ordering: boolean;
    ordering_channels?: Array<{ name: string; url: string }>;
  };
  photos: IVenuePhoto[];
  menu: {
    currency: string;
    updated_at: Date;
    source_url?: string;
    /** How the menu was obtained: playwright | static_html | sample | none */
    extraction_method?: string;
    /** Pages fetched to assemble this menu (a QR menu is rarely one page). */
    pages_crawled?: number;
    /** Every page that contributed products. */
    source_pages?: string[];
    categories: IMenuCategory[];
  };
  // ── Optional enrichment beyond the specification schema (additive) ────────
  /** Google Maps category labels. */
  categories?: string[];
  opening_hours?: { weekday_text: string[]; open_now?: boolean };
  /** Meal cards and payment rails the venue advertises ("Sodexo", "Multinet"). */
  payment_methods?: string[];
  /** ISO-639-1 codes the venue publishes its menu in. */
  languages?: string[];
  plus_code?: string;
  /** Upstream identifiers; scraped venues carry a CID rather than a ChIJ id. */
  source_ids?: { cid?: string; place_id?: string; entity_id?: string };

  /** Provenance so mock rows are never mistaken for live intelligence. */
  data_source: DataSource;
  /** Which provider produced this row (maps_scraper, outscraper, ...). */
  provider?: string;
  /** Pipeline state driven by the Redis/BullMQ enrichment queue. */
  enrichment: {
    status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'captcha_blocked';
    last_job_id?: string;
    last_run_at?: Date;
    error?: string;
  };
  created_at: Date;
  updated_at: Date;
}

const MenuItemSchema = new Schema<IMenuItem>(
  {
    item_id: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    price: { type: Number, required: true },
    currency: { type: String, default: 'TRY' },
    original_image_url: { type: String },
    webp_image_url: { type: String },
    is_available: { type: Boolean, default: true },
    allergens: { type: [String], default: undefined },
    variants: {
      type: [{ _id: false, name: { type: String }, price: { type: Number } }],
      default: undefined,
    },
  },
  { _id: false }
);

const MenuCategorySchema = new Schema<IMenuCategory>(
  {
    category_id: { type: String, required: true },
    name: { type: String, required: true },
    items: [MenuItemSchema],
  },
  { _id: false }
);

const VenuePhotoSchema = new Schema<IVenuePhoto>(
  {
    original_image_url: { type: String },
    webp_image_url: { type: String },
    width: { type: Number },
    height: { type: Number },
  },
  { _id: false }
);

const VenueSchema = new Schema<IVenueDocument>(
  {
    google_place_id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    primary_type: { type: String, default: 'restaurant' },
    rating: { type: Number },
    user_ratings_total: { type: Number },
    price_level: { type: Number },
    location: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        // Left unset when no source states the venue's position; a sparse
        // 2dsphere index simply skips those rows.
        type: [Number], // [lng, lat]
      },
    },
    address: {
      formatted: { type: String, required: true },
      country: { type: String },
      city: { type: String },
      district: { type: String },
      neighborhood: { type: String },
      postal_code: { type: String },
    },
    contacts: {
      phone_numbers: [{ type: String }],
      emails: [{ type: String }],
      website_url: { type: String },
      social_media: {
        instagram: { type: String },
        facebook: { type: String },
        twitter: { type: String },
        tiktok: { type: String },
        youtube: { type: String },
        whatsapp: { type: String },
      },
    },
    digital_presence: {
      has_website: { type: Boolean, default: false },
      has_qr_menu: { type: Boolean, default: false },
      qr_menu_provider: { type: String },
      qr_menu_url: { type: String },
      supports_online_ordering: { type: Boolean, default: false },
      ordering_channels: [
        {
          _id: false,
          name: { type: String },
          url: { type: String },
        },
      ],
    },
    photos: { type: [VenuePhotoSchema], default: [] },
    menu: {
      currency: { type: String, default: 'TRY' },
      updated_at: { type: Date, default: Date.now },
      source_url: { type: String },
      extraction_method: { type: String, default: 'none' },
      pages_crawled: { type: Number },
      source_pages: { type: [String], default: undefined },
      categories: [MenuCategorySchema],
    },
    categories: { type: [String], default: undefined },
    opening_hours: {
      weekday_text: { type: [String], default: undefined },
      open_now: { type: Boolean },
    },
    payment_methods: { type: [String], default: undefined },
    languages: { type: [String], default: undefined },
    plus_code: { type: String },
    source_ids: {
      cid: { type: String },
      place_id: { type: String },
      entity_id: { type: String },
    },
    data_source: {
      type: String,
      enum: ['google_places', 'maps_scraper', 'outscraper', 'apify', 'web_menu', 'mock', 'manual'],
      default: 'maps_scraper',
    },
    provider: { type: String },
    enrichment: {
      status: {
        type: String,
        enum: ['pending', 'queued', 'processing', 'completed', 'failed', 'captcha_blocked'],
        default: 'pending',
      },
      last_job_id: { type: String },
      last_run_at: { type: Date },
      error: { type: String },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// 2dsphere spatial index enables instant $near / $geoWithin queries (spec §2.1).
// Sparse: venues ingested by URL may have no coordinates to index.
VenueSchema.index({ location: '2dsphere' }, { sparse: true });
// Supporting indexes for the dashboard's filter/segment queries
VenueSchema.index({ 'address.city': 1, 'address.district': 1 });
VenueSchema.index({ 'digital_presence.has_qr_menu': 1 });
VenueSchema.index({ 'digital_presence.qr_menu_provider': 1 });
VenueSchema.index({ 'source_ids.cid': 1 }, { sparse: true });
VenueSchema.index({ name: 'text', 'address.formatted': 'text' });

export const Venue = mongoose.model<IVenueDocument>('Venue', VenueSchema);
