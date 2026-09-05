import * as cheerio from 'cheerio';
import { IMenuCategory, IMenuItem } from '../models/Venue';
import { RenderService } from './render.service';
import { ImageService } from './image.service';

export interface IInstagramPost {
  imageUrl: string;
  text: string;
}

export interface IInstagramMatchResult {
  matched_items: number;
  images_converted: number;
  bytes_saved: number;
}

export class InstagramMatcherService {
  /**
   * Normalises Turkish text for fuzzy keyword matching.
   * "TEPSİ KEBABI 🔥" -> "tepsi kebabi"
   */
  public static normalizeText(text: string): string {
    if (!text) return '';
    return text
      .replace(/İ/g, 'i')
      .replace(/I/g, 'ı')
      .toLowerCase()
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      .replace(/ı/g, 'i')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extracts media posts (image URL + caption/text) from an Instagram profile page.
   */
  public static async fetchInstagramPosts(instagramUrl: string): Promise<IInstagramPost[]> {
    if (!instagramUrl || !instagramUrl.includes('instagram.com')) return [];

    try {
      console.log(`[InstagramMatcher] Rendering profile: ${instagramUrl}`);
      const rendered = await RenderService.render(instagramUrl);
      const html = rendered.html || '';
      const $ = cheerio.load(html);
      const posts: IInstagramPost[] = [];
      const seenImages = new Set<string>();

      // 1. Extract JSON caption texts and media references from Instagram JSON state
      const jsonTexts: string[] = [];
      const captionRegex = /"text"\s*:\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = captionRegex.exec(html)) !== null) {
        let txt = m[1];
        try {
          txt = JSON.parse(`"${txt}"`);
        } catch {
          txt = txt.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        }
        txt = txt.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
        if (txt.length >= 3 && !txt.includes('http') && !txt.includes('Meta AI')) {
          jsonTexts.push(txt);
        }
      }

      // 2. Extract DOM img elements (alt text + cdninstagram image URL)
      $('img').each((_, imgEl) => {
        const $img = $(imgEl);
        const src = $img.attr('src') || $img.attr('data-src') || '';
        const alt = $img.attr('alt') || '';
        if (
          src &&
          !seenImages.has(src) &&
          (src.includes('cdninstagram') || src.includes('fbcdn') || src.startsWith('http')) &&
          !src.includes('s150x150') &&
          !src.includes('profile_pic')
        ) {
          seenImages.add(src);
          posts.push({ imageUrl: src, text: alt });
        }
      });

      // 3. Pair JSON caption texts with posts missing detailed alt text
      let textIdx = 0;
      for (const post of posts) {
        if (!post.text || post.text.includes('Photo by') || post.text.includes('Video by')) {
          if (jsonTexts[textIdx]) {
            post.text = `${post.text} ${jsonTexts[textIdx]}`;
            textIdx++;
          }
        }
      }

      console.log(`[InstagramMatcher] Extracted ${posts.length} Instagram media posts.`);
      return posts;
    } catch (error: any) {
      console.warn(`[InstagramMatcher] Failed to fetch Instagram profile (${instagramUrl}): ${error.message}`);
      return [];
    }
  }

  /**
   * Matches Instagram media posts with menu items and converts matched images to WebP.
   */
  public static async matchAndEnrichMenu(
    categories: IMenuCategory[],
    instagramUrl: string
  ): Promise<IInstagramMatchResult> {
    const posts = await this.fetchInstagramPosts(instagramUrl);
    if (!posts.length || !categories.length) {
      return { matched_items: 0, images_converted: 0, bytes_saved: 0 };
    }

    let matchedItemsCount = 0;
    const conversions: Array<{ url: string; prefix: string }> = [];
    const targetItems: IMenuItem[] = [];

    for (const category of categories) {
      for (const item of category.items) {
        // Skip items that already have an image
        if (item.original_image_url || item.webp_image_url) continue;

        const normalizedItemName = this.normalizeText(item.name);
        if (normalizedItemName.length < 3) continue;

        // Skip purely generic portion words like "kg", "porsyon", "tek", "duble"
        const cleanItemName = normalizedItemName.replace(/\b(kg|porsyon|servis|tek|duble|yarim|yrm|cl)\b/g, '').trim();
        if (cleanItemName.length < 3) continue;

        const itemWords = cleanItemName.split(' ').filter((w) => w.length > 2);
        if (!itemWords.length) continue;

        // Search posts for matching caption/alt text
        for (const post of posts) {
          const normalizedPostText = this.normalizeText(post.text);
          if (!normalizedPostText) continue;

          // Check direct substring match or high keyword overlap
          const exactMatch = normalizedPostText.includes(normalizedItemName);
          const wordMatches = itemWords.filter((w) => normalizedPostText.includes(w));
          const matchRatio = wordMatches.length / itemWords.length;

          if (exactMatch || (itemWords.length >= 2 && matchRatio >= 0.75) || (itemWords.length === 1 && wordMatches.length === 1 && normalizedPostText.includes(itemWords[0]))) {
            console.log(`[InstagramMatcher] Matched item '${item.name}' with Instagram post: "${post.text.slice(0, 60)}..."`);
            item.original_image_url = post.imageUrl;
            matchedItemsCount++;
            conversions.push({ url: post.imageUrl, prefix: item.item_id });
            targetItems.push(item);
            break; // Stop after first matched post for this item
          }
        }
      }
    }

    // Convert all newly assigned Instagram images to WebP via ImageService
    let imagesConverted = 0;
    let bytesSaved = 0;

    if (conversions.length) {
      console.log(`[InstagramMatcher] Converting ${conversions.length} Instagram images to WebP...`);
      const results = await ImageService.convertMany(conversions);
      results.forEach((res, idx) => {
        targetItems[idx].webp_image_url = res.url;
        if (res.converted) {
          imagesConverted++;
          if (res.original_bytes && res.webp_bytes) {
            bytesSaved += res.original_bytes - res.webp_bytes;
          }
        }
      });
    }

    return {
      matched_items: matchedItemsCount,
      images_converted: imagesConverted,
      bytes_saved: bytesSaved,
    };
  }
}
