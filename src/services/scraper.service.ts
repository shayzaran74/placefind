import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { IMenuCategory, IMenuItem } from '../models/Venue';
import { ImageService } from './image.service';
import { MenuCrawlerService } from './menuCrawler.service';
import { InstagramMatcherService } from './instagramMatcher.service';
import { config } from '../config';

export interface IScrapeResult {
  currency: string;
  categories: IMenuCategory[];
  source_url?: string;
  /** playwright | static_html | schema_org | sample | none */
  extraction_method: string;
  images_converted: number;
  bytes_saved: number;
  /** Pages actually fetched: 1 for a single-page menu, N for a crawled one. */
  pages_crawled: number;
  /** Every page that contributed products, in fetch order. */
  source_pages?: string[];
  warning?: string;
}

export interface IScrapeOptions {
  /** Follow the entry page's section links. Defaults to MENU_CRAWL_ENABLED. */
  crawl?: boolean;
  /** Hard cap on fetched pages, entry page included. */
  maxPages?: number;
  /** Instagram profile URL to match post photos when menu items lack images. */
  instagramUrl?: string;
}

interface IRawItem {
  name: string;
  description?: string;
  price: number;
  image?: string;
}

const CURRENCY_SYMBOLS: Array<{ symbol: RegExp; code: string }> = [
  { symbol: /₺|\bTL\b|\bTRY\b/i, code: 'TRY' },
  { symbol: /€|\bEUR\b/i, code: 'EUR' },
  { symbol: /\$|\bUSD\b/, code: 'USD' },
  { symbol: /£|\bGBP\b/i, code: 'GBP' },
];

/**
 * Menu extraction worker logic (spec §2 - Scraper Workers).
 *
 * Strategy order:
 *   1. schema.org JSON-LD `Menu` / `hasMenu` blocks - the reliable path.
 *   2. Heuristic DOM parsing of category/item/price blocks.
 *   3. Sample menu, only when explicitly allowed (ALLOW_MOCK_DATA).
 *
 * Every extracted image goes through the WebP pipeline before storage.
 */
export class ScraperService {
  private static slug(value: string, prefix: string): string {
    const hash = crypto.createHash('md5').update(value).digest('hex').slice(0, 8);
    return `${prefix}_${hash}`;
  }

  /** Parses "₺110,00" / "110.00 TL" / "1.250,50" into a number. */
  public static parsePrice(raw: string): number | null {
    const match = raw.match(/(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
    if (!match) return null;

    let text = match[1].replace(/\s/g, '');
    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');

    if (lastComma > lastDot) {
      // European format: 1.250,50
      text = text.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
      // US format: 1,250.50
      text = text.replace(/,/g, '');
    } else {
      text = text.replace(',', '.');
    }

    const value = parseFloat(text);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  public static detectCurrency(html: string): string {
    for (const { symbol, code } of CURRENCY_SYMBOLS) {
      if (symbol.test(html)) return code;
    }
    return 'TRY';
  }

  /** Pass 1: schema.org Menu / MenuSection / MenuItem in JSON-LD. */
  private static extractFromJsonLd($: cheerio.CheerioAPI): IMenuCategory[] {
    const categories: IMenuCategory[] = [];

    const walkSections = (sections: any[]): void => {
      for (const section of sections) {
        if (!section) continue;

        const items: IMenuItem[] = [];
        const offers = section.hasMenuItem || section.menuItem || [];

        for (const entry of Array.isArray(offers) ? offers : [offers]) {
          if (!entry?.name) continue;
          const offer = Array.isArray(entry.offers) ? entry.offers[0] : entry.offers;
          const price = offer?.price !== undefined ? this.parsePrice(String(offer.price)) : null;

          const rawImage = typeof entry.image === 'string' ? entry.image : entry.image?.url;
          const image = rawImage ? ImageService.optimizeUrl(rawImage) : undefined;

          items.push({
            item_id: this.slug(entry.name, 'item'),
            name: String(entry.name).trim(),
            description: entry.description ? String(entry.description).trim() : undefined,
            price: price ?? 0,
            currency: offer?.priceCurrency || 'TRY',
            original_image_url: image,
            is_available: true,
          });
        }

        if (items.length) {
          categories.push({
            category_id: this.slug(section.name || `section-${categories.length}`, 'cat'),
            name: section.name ? String(section.name).trim() : 'Menü',
            items,
          });
        }

        // Menus nest sections arbitrarily deep.
        const nested = section.hasMenuSection || section.menuSection;
        if (nested) walkSections(Array.isArray(nested) ? nested : [nested]);
      }
    };

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
        if (!node) continue;
        const menus = node.hasMenu || (node['@type'] === 'Menu' ? node : null);
        for (const menu of Array.isArray(menus) ? menus : menus ? [menus] : []) {
          const sections = menu.hasMenuSection || menu.hasMenuItem ? [menu] : [];
          walkSections(
            sections.length
              ? (menu.hasMenuSection
                  ? Array.isArray(menu.hasMenuSection)
                    ? menu.hasMenuSection
                    : [menu.hasMenuSection]
                  : [menu])
              : []
          );
        }
      }
    });

    return categories;
  }

  /**
   * Extracts the highest-resolution image URL from a DOM element, checking srcset,
   * data-srcset, data-src, data-original, data-lazy-src, data-high-res, CSS background-image,
   * and optimizing low-res CDN thumbnail parameters via ImageService.optimizeUrl.
   */
  public static extractImageFromElement($el: cheerio.Cheerio<any>, baseUrl: string): string | undefined {
    let rawSrc: string | undefined;

    // 1. Check img element or child img for srcset / high-res candidates
    const imgNode = $el.is('img') ? $el : $el.find('img').first();
    if (imgNode.length) {
      const srcset = imgNode.attr('srcset') || imgNode.attr('data-srcset');
      if (srcset) {
        const candidates = srcset.split(',').map((entry) => {
          const parts = entry.trim().split(/\s+/);
          const url = parts[0];
          const descriptor = parts[1] || '';
          let width = 0;
          if (descriptor.endsWith('w')) {
            width = parseInt(descriptor.replace('w', ''), 10) || 0;
          } else if (descriptor.endsWith('x')) {
            width = (parseFloat(descriptor.replace('x', '')) || 1) * 500;
          }
          return { url, width };
        });
        candidates.sort((a, b) => b.width - a.width);
        if (candidates.length > 0 && candidates[0].url) {
          rawSrc = candidates[0].url;
        }
      }

      if (!rawSrc) {
        rawSrc =
          imgNode.attr('data-src') ||
          imgNode.attr('data-original') ||
          imgNode.attr('data-lazy-src') ||
          imgNode.attr('data-image') ||
          imgNode.attr('data-img') ||
          imgNode.attr('data-photo') ||
          imgNode.attr('data-url') ||
          imgNode.attr('data-high-res') ||
          imgNode.attr('src');
      }
    }

    // 2. Check container attributes or style background-image if no img src found
    if (!rawSrc) {
      const photoContainer = $el.is('[class*="photo"], [class*="image"], [class*="img"]')
        ? $el
        : $el.find('[class*="product-photo"], [class*="photo"], [class*="image"], [class*="img"]').first();

      if (photoContainer.length) {
        rawSrc =
          photoContainer.attr('data-src') ||
          photoContainer.attr('data-bg') ||
          photoContainer.attr('data-original') ||
          photoContainer.attr('data-image') ||
          photoContainer.attr('data-img') ||
          photoContainer.attr('data-photo') ||
          photoContainer.attr('data-url');
        if (!rawSrc) {
          const style = photoContainer.attr('style') || '';
          const bgMatch = style.match(/url\((['"]?)([^'")]+)\1\)/i);
          if (bgMatch) rawSrc = bgMatch[2];
        }
      }
    }

    // 3. CSS background-image fallback on element or its children
    if (!rawSrc) {
      const style = $el.attr('style') || '';
      const bgMatch = style.match(/url\((['"]?)([^'")]+)\1\)/i);
      if (bgMatch && !bgMatch[2].includes('cover-photo') && !bgMatch[2].includes('favicon')) {
        rawSrc = bgMatch[2];
      }
    }

    if (!rawSrc || rawSrc.startsWith('data:')) return undefined;

    try {
      const absoluteUrl = new URL(rawSrc, baseUrl).toString();
      return ImageService.optimizeUrl(absoluteUrl);
    } catch {
      return undefined;
    }
  }

  /**
   * Pass 2: structural DOM parsing for menus without structured data.
   *
   * Class-name guessing is unreliable - themes name their containers anything
   * ("ct-menu-food-single", "ct-list-menu-item"), and a selector list silently
   * drops whole sections it does not happen to match. So instead of guessing:
   *
   *   1. find the innermost nodes that state a *currency* price,
   *   2. walk up from each to the smallest block that also names the item,
   *   3. attribute each item to the nearest preceding heading in document order.
   *
   * Step 3 matters: taking the first heading inside the closest wrapper merges
   * sibling subsections (7 drink sections collapsing into 3).
   */
  private static extractFromDom($: cheerio.CheerioAPI, baseUrl: string): IMenuCategory[] {
    // Upper bound on how much text one menu item may span. Beyond this the
    // block is page furniture, not a product.
    const MAX_ITEM_BLOCK_CHARS = 1200;

    // Currency-anchored: a bare "480" is a calorie count, not a price.
    const priceRe = /(?:₺|TL|TRY|€|\$|£)\s*\d[\d.,]*|\d[\d.,]*\s*(?:₺|TL|TRY|€|\$|£)/i;
    // Headings that introduce a nutrition panel rather than an item.
    const nutritionHeadingRe = /besin de[ğg]er|nutrition facts?|alerjen bilgi|allergen info/i;
    // Nutrition cell labels. Anchored on purpose: an unanchored /ya[ğg]/ also
    // matches "tereyağlı" and would discard real ingredient text, since "yağ"
    // (fat/oil) is an ordinary word in Turkish menu descriptions.
    const nutritionLabelRe =
      /^(kalori|calories?|ya[ğg]|fat|prote[iı]n|karbonhidrat|carb\w*|sodyum|sodium|tuz|salt|lif|fiber|[şs]eker|sugar|alerjen(\s*bilgisi)?|allergens?(\s*info)?)\s*:?$/i;
    const allergenRe = /^alerjen|^allergen/i;
    const actionButtonRe = /^(sepete ekle|ekle|add to cart|order now|satın al|sepet|buy now)$/i;

    // Document order lets us bind items to the heading that precedes them.
    const order = new Map<any, number>();
    $('*').each((index, el) => {
      order.set(el, index);
    });

    // --- 1. Innermost price nodes ------------------------------------------
    const priceNodes: any[] = [];
    $('*').each((_, el) => {
      const $el = $(el);
      if (!priceRe.test($el.text())) return;
      // Keep only the deepest node stating the price.
      const deeper = $el.children().toArray().some((child) => priceRe.test($(child).text()));
      if (deeper) return;
      priceNodes.push(el);
      $el.attr('data-pf-price', '1');
    });

    // --- 2. Bind each price to the item it names ---------------------------
    const priceCount = (node: cheerio.Cheerio<any>): number =>
      node.find('[data-pf-price]').length + (node.attr('data-pf-price') ? 1 : 0);

    const nameNodeIn = (node: cheerio.Cheerio<any>): any | undefined => {
      const candidates = node
        .find('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="name"],[class*="baslik"]')
        .not('button, [id*="button"], [class*="button"], [id*="basket"]')
        .toArray();
      for (const candidate of candidates) {
        const text = $(candidate).text().replace(/\s+/g, ' ').trim();
        if (!text || text.length < 2 || text.length > 120) continue;
        if (nutritionHeadingRe.test(text) || nutritionLabelRe.test(text) || actionButtonRe.test(text)) continue;
        if (priceRe.test(text)) continue;
        return candidate;
      }
      return undefined;
    };

    // Each price climbs to the nearest block that names something. Two prices
    // for the same product (base + "Büyük Boy" variant) resolve to the same
    // name element, which is what groups them back together below.
    const nameToPrices = new Map<any, any[]>();
    for (const priceNode of priceNodes) {
      let node = $(priceNode).parent();
      let nameEl: any | undefined;
      let hops = 0;

      while (node.length && hops < 8) {
        // A menu item is a small block. Once the climb reaches page-level
        // markup, the "nearest name" is no longer this item's name - it is
        // whatever heading happens to come first on the page. Stray prices
        // injected by scripts used to bind to the page title this way.
        if (node.text().replace(/\s+/g, ' ').trim().length > MAX_ITEM_BLOCK_CHARS) break;
        nameEl = nameNodeIn(node);
        if (nameEl) break;
        node = node.parent();
        hops++;
      }
      if (!nameEl) continue;

      const bucket = nameToPrices.get(nameEl);
      if (bucket) bucket.push(priceNode);
      else nameToPrices.set(nameEl, [priceNode]);
    }

    const nameElements = new Set(nameToPrices.keys());

    // Is this price stated inside a dedicated price cell, or inside prose?
    const inPriceBlock = (el: any): boolean =>
      /price|fiyat/i.test($(el).attr('class') || '') ||
      $(el).parents('[class*="price"], [class*="fiyat"]').length > 0;
    const inDescBlock = (el: any): boolean =>
      $(el).parents('[class*="desc"], [class*="aciklama"], [class*="icindekiler"]').length > 0;

    interface ICandidate {
      container: cheerio.Cheerio<any>;
      scope: cheerio.Cheerio<any>;
      name: string;
      nameEl: any;
      basePrice: any;
      variantPrices: any[];
      pos: number;
      /** Set when priced rows were folded into the product that owns them. */
      variantRows?: Array<{ name: string; price: number }>;
    }

    const candidates: ICandidate[] = [];
    const claimed = new Set<string>();

    for (const [nameEl, prices] of nameToPrices) {
      const name = $(nameEl).text().replace(/\s+/g, ' ').trim();
      if (!name) continue;

      // Grow the block outward until it would swallow a second product name.
      // This reaches the image and nutrition panel that sit beside the item,
      // without merging two neighbouring products.
      let scope = $(nameEl).parent();
      for (let up = 0; up < 8; up++) {
        const parent = scope.parent();
        if (!parent.length) break;
        if (parent.text().replace(/\s+/g, ' ').trim().length > MAX_ITEM_BLOCK_CHARS) break;
        const otherName = parent
          .find('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="name"]')
          .toArray()
          .some((el) => el !== nameEl && nameElements.has(el));
        if (otherName) break;
        scope = parent;
      }

      // Base price vs. variant. A price inside prose ("Büyük Boy Latte ₺240")
      // is an upsell; the product's own price lives in its price cell. When
      // neither signal is present, the last price in document order wins.
      const ordered = prices.slice().sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      const base =
        ordered.find((el) => inPriceBlock(el) && !inDescBlock(el)) ||
        ordered.find((el) => !inDescBlock(el)) ||
        ordered[ordered.length - 1];
      const variants = ordered.filter((el) => el !== base);

      const key = name.toLowerCase();
      if (claimed.has(key)) continue;
      claimed.add(key);

      candidates.push({
        container: $(nameEl).parent(),
        scope,
        name,
        nameEl,
        basePrice: base,
        variantPrices: variants,
        pos: order.get(nameEl) ?? 0,
      });
    }

    if (!candidates.length) return [];

    // --- 2b. Fold size rows into the product that owns them -----------------
    //
    // Drinks are the common case: one product ("Coca Cola") heads a block of
    // priced size rows ("Kutu", "1 Lt.", "2,5 Lt."). Each row states a price,
    // so each row looks like a product - and the real product name, carrying
    // no price of its own, then gets mistaken for a *category*. That misfiles
    // every following product: on a mixed page the next single-price product
    // lands under the previous product's name.
    //
    // So: priced rows that share a block headed by an unpriced heading are
    // that heading's sellable sizes, not separate products.
    const isHeading = (el: any): boolean => /^h[1-6]$/i.test(el?.tagName || el?.name || '');
    const candidateNames = new Set(candidates.map((candidate) => candidate.nameEl));

    const insideAnyCandidate = (el: any): boolean =>
      candidates.some((candidate) => candidate.scope.is(el) || candidate.scope.find(el).length > 0);

    const productHeading = (candidate: ICandidate): any | undefined => {
      let block = candidate.scope.parent();
      for (let up = 0; up < 6 && block.length; up++) {
        const heading = block
          .find('h1,h2,h3,h4,h5,h6')
          .toArray()
          .find((el) => {
            if (candidateNames.has(el) || insideAnyCandidate(el)) return false;
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            return (
              text.length >= 2 &&
              text.length <= 120 &&
              !nutritionHeadingRe.test(text) &&
              !nutritionLabelRe.test(text) &&
              !priceRe.test(text)
            );
          });
        if (heading) return heading;
        block = block.parent();
      }
      return undefined;
    };

    const groups = new Map<any, ICandidate[]>();
    for (const candidate of candidates) {
      // A product that names itself with a heading is already a product.
      if (isHeading(candidate.nameEl)) continue;
      const heading = productHeading(candidate);
      if (!heading) continue;
      const bucket = groups.get(heading);
      if (bucket) bucket.push(candidate);
      else groups.set(heading, [candidate]);
    }

    for (const [heading, rows] of groups) {
      // One priced row under a heading is ambiguous - it reads just as well as
      // a plain product. Only a repeated set is unmistakably a size list.
      if (rows.length < 2) continue;

      const ordered = rows
        .map((row) => ({ row, price: this.parsePrice($(row.basePrice).text()) }))
        .filter((entry): entry is { row: ICandidate; price: number } => entry.price !== null)
        .sort((a, b) => a.row.pos - b.row.pos);
      if (ordered.length < 2) continue;

      const priced = ordered.map((entry) => ({ name: entry.row.name, price: entry.price }));
      // "From" price: the cheapest size is the one the menu advertises.
      const cheapest = ordered.reduce((low, entry) => (entry.price < low.price ? entry : low));

      // Grow the product block the same way an item's scope grows, so the
      // product photo and description beside the size list stay attached. The
      // group's own size rows do not count as "another product" - they are
      // exactly what this block is expected to contain.
      const ownRows = new Set(rows.map((row) => row.nameEl));
      let scope = $(heading).parent();
      for (let up = 0; up < 8; up++) {
        const parent = scope.parent();
        if (!parent.length) break;
        if (parent.text().replace(/\s+/g, ' ').trim().length > MAX_ITEM_BLOCK_CHARS) break;
        const otherProduct = parent
          .find('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="name"]')
          .toArray()
          .some(
            (el) => el !== heading && !ownRows.has(el) && (groups.has(el) || candidateNames.has(el))
          );
        if (otherProduct) break;
        scope = parent;
      }

      for (const row of rows) {
        const index = candidates.indexOf(row);
        if (index >= 0) candidates.splice(index, 1);
      }

      candidates.push({
        container: $(heading).parent(),
        scope,
        name: $(heading).text().replace(/\s+/g, ' ').trim(),
        nameEl: heading,
        basePrice: cheapest.row.basePrice,
        variantPrices: [],
        pos: order.get(heading) ?? ordered[0].row.pos,
        variantRows: priced,
      });
    }

    // --- 3. Category headings = headings outside every item block -----------
    const headings: Array<{ pos: number; name: string }> = [];
    $('h1,h2,h3,h4,h5,h6').each((_, el) => {
      const $el = $(el);
      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (!text || text.length > 90) return;
      if (nutritionHeadingRe.test(text) || nutritionLabelRe.test(text)) return;
      // A heading inside an item block is that item's name, not a category.
      const insideItem = candidates.some((c) => c.scope.find(el).length > 0 || c.scope.is(el));
      if (insideItem) return;
      headings.push({ pos: order.get(el) ?? 0, name: text });
    });
    headings.sort((a, b) => a.pos - b.pos);

    const categoryFor = (pos: number): string => {
      let current = 'Menü';
      for (const heading of headings) {
        if (heading.pos > pos) break;
        current = heading.name;
      }
      return current;
    };

    // --- 4. Assemble --------------------------------------------------------
    const categories: IMenuCategory[] = [];

    for (const candidate of candidates.sort((a, b) => a.pos - b.pos)) {
      const price = this.parsePrice($(candidate.basePrice).text());
      if (price === null) continue;

      // Keep the upsell rather than discarding it: a "Büyük Boy" option is
      // sellable, and dropping it silently loses revenue from the menu.
      const variants = candidate.variantRows ?? candidate.variantPrices
        .map((el) => {
          const variantPrice = this.parsePrice($(el).text());
          if (variantPrice === null || variantPrice === price) return null;
          const label = $(el)
            .parent()
            .text()
            .replace($(el).text(), '')
            .replace(/\s+/g, ' ')
            .trim();
          return {
            name: label && label.length <= 80 ? label : 'Alternatif',
            price: variantPrice,
          };
        })
        .filter((v): v is { name: string; price: number } => v !== null);

      // Searched over the whole item block, not just the name's parent: menu
      // platforms print the ingredient line as a sibling of the *title row*
      // (title + dots + price), so a parent-only lookup finds nothing and the
      // description silently disappears from every product on the page.
      const description = candidate.scope
        .find('[class*="desc"], [class*="aciklama"], [class*="ingredient"], [class*="icindekiler"], p')
        .toArray()
        .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
        .find(
          (text) =>
            text &&
            text !== candidate.name &&
            text.length > 2 &&
            !nutritionLabelRe.test(text) &&
            !nutritionHeadingRe.test(text) &&
            // A price inside the text means we picked up a neighbouring item
            // (e.g. the large-size variant), not this item's ingredients.
            !priceRe.test(text)
        );

      // Allergen notes come as label/value pairs in the nutrition panel.
      // Calories are deliberately ignored: sites copy-paste one value onto
      // every item, so the figure is not trustworthy.
      const allergens: string[] = [];
      candidate.scope.find('[class*="label"], [class*="lable"], dt, th').each((_, labelEl) => {
        const label = $(labelEl).text().replace(/\s+/g, ' ').trim();
        if (!allergenRe.test(label)) return;
        const value = $(labelEl).next().text().replace(/\s+/g, ' ').trim();
        if (!value || value.length >= 200) return;
        // Sites mis-fill this cell with a nutrition figure ("220mg"); a bare
        // measurement carries no allergen meaning, so drop it rather than
        // exporting it as one.
        if (/^[\d.,]+\s*(mg|g|gr|kcal|kal|kj|%)?$/i.test(value)) return;
        allergens.push(value);
      });

      const image = this.extractImageFromElement(candidate.scope, baseUrl);

      const categoryName = categoryFor(candidate.pos).slice(0, 80) || 'Menü';
      let category = categories.find((c) => c.name === categoryName);
      if (!category) {
        category = { category_id: this.slug(categoryName, 'cat'), name: categoryName, items: [] };
        categories.push(category);
      }

      category.items.push({
        item_id: this.slug(`${categoryName}:${candidate.name}`, 'item'),
        name: candidate.name,
        description,
        price,
        currency: 'TRY',
        original_image_url: image,
        is_available: true,
        ...(allergens.length ? { allergens: Array.from(new Set(allergens)) } : {}),
        ...(variants.length ? { variants } : {}),
      });
    }

    return categories.filter((c) => c.items.length > 0);
  }

  /** Pass 2a: TGOMemek / Trendyol Go / Uber Eats SPA specific DOM extractor. */
  private static extractFromTgoYemek($: cheerio.CheerioAPI, baseUrl: string): IMenuCategory[] {
    const sections = $('section[id], [class*="section"]');
    if (!sections.length) return [];

    const categories: IMenuCategory[] = [];
    const actionButtonRe = /^(sepete ekle|ekle|add to cart|order now|satın al|sepet)$/i;

    sections.each((_, section) => {
      const $section = $(section);
      const headingEl = $section.find('h1, h2, h3, h4, h5, [class*="title"]').first();
      if (!headingEl.length) return;

      const categoryName = headingEl
        .text()
        .replace(/\s*\(\d+\s*[Üu]r[uü]n\)/i, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!categoryName || categoryName.length < 2 || categoryName.length > 90) return;

      const items: IMenuItem[] = [];

      $section.find('[role="button"], [class*="product"], [class*="card"]').each((_, cardEl) => {
        const $card = $(cardEl);

        const nameCandidate = $card
          .find('h6, h5, h4, h3, [class*="title"], [class*="name"]')
          .not('button, [id*="button"], [class*="button"], [id*="basket"]')
          .toArray()
          .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
          .find((text) => text && text.length >= 2 && text.length <= 120 && !actionButtonRe.test(text));

        if (!nameCandidate) return;

        let priceText = $card.find('.text-primary, [class*="price"]').not('.line-through').first().text().trim();
        if (!priceText) {
          priceText = $card.text();
        }

        const price = this.parsePrice(priceText);
        if (price === null) return;

        const descEl = $card.find('[class*="desc"], [class*="aciklama"], p').first();
        const description = descEl.length ? descEl.text().replace(/\s+/g, ' ').trim() : undefined;

        const image = this.extractImageFromElement($card, baseUrl);

        items.push({
          item_id: this.slug(`${categoryName}:${nameCandidate}`, 'item'),
          name: nameCandidate,
          description: description && description !== nameCandidate ? description : undefined,
          price,
          currency: this.detectCurrency($card.text()) || 'TRY',
          original_image_url: image,
          is_available: true,
        });
      });

      if (items.length > 0) {
        let existing = categories.find((c) => c.name === categoryName);
        if (!existing) {
          existing = {
            category_id: this.slug(categoryName, 'cat'),
            name: categoryName,
            items: [],
          };
          categories.push(existing);
        }
        for (const item of items) {
          if (!existing.items.some((i) => i.name === item.name && i.price === item.price)) {
            existing.items.push(item);
          }
        }
      }
    });

    return categories.filter((c) => c.items.length > 0);
  }

  /** Pass 2b: Akınsoft QR Menu platform specific DOM extractor. */
  private static extractFromAkinsoft($: cheerio.CheerioAPI, baseUrl: string): IMenuCategory[] {
    const productContainers = $('.product-container, [class*="product-container"]');
    if (!productContainers.length) return [];

    const categories: IMenuCategory[] = [];
    const elements: Array<{ type: 'heading' | 'item'; name: string; node: any }> = [];

    $('*').each((_, el) => {
      const $el = $(el);
      const tag = ((el as any).name || (el as any).tagName || '').toLowerCase();
      if (tag === 'h2' || tag === 'h3' || $el.hasClass('category-title')) {
        const text = $el.text().replace(/\s+/g, ' ').trim();
        if (text && text.length > 1 && text.length < 90) {
          elements.push({ type: 'heading', name: text, node: el });
        }
      } else if ($el.hasClass('product-container--name_name')) {
        const name = $el.text().replace(/\s+/g, ' ').trim();
        if (name && name.length >= 2) {
          elements.push({ type: 'item', name, node: el });
        }
      }
    });

    if (!elements.some((e) => e.type === 'item')) return [];

    let currentCategoryName = 'Menü';
    const claimedItemKeys = new Set<string>();

    for (const entry of elements) {
      if (entry.type === 'heading') {
        currentCategoryName = entry.name;
      } else if (entry.type === 'item') {
        const $itemNode = $(entry.node);
        const card = $itemNode.closest('.product-container-header, [class*="product-container-header"], .product-container');
        if (!card.length) continue;

        const nameEl = card.find('.product-container--name_name, [class*="name_name"]').first();
        const priceEl = card.find('[class*="price_price"], [class*="price--content"], [class*="price"]').first();

        const name = nameEl.length ? nameEl.text().replace(/\s+/g, ' ').trim() : entry.name;
        const priceText = priceEl.length ? priceEl.text().replace(/\s+/g, ' ').trim() : '';
        const price = this.parsePrice(priceText);

        if (!name || price === null) continue;

        const itemKey = `${currentCategoryName}:${name}`.toLowerCase();
        if (claimedItemKeys.has(itemKey)) continue;
        claimedItemKeys.add(itemKey);

        const descEl = card.find('[class*="desc"], [class*="aciklama"], p').first();
        const description = descEl.length ? descEl.text().replace(/\s+/g, ' ').trim() : undefined;

        const image = this.extractImageFromElement(card, baseUrl);

        let category = categories.find((c) => c.name === currentCategoryName);
        if (!category) {
          category = {
            category_id: this.slug(currentCategoryName, 'cat'),
            name: currentCategoryName,
            items: [],
          };
          categories.push(category);
        }

        category.items.push({
          item_id: this.slug(`${currentCategoryName}:${name}`, 'item'),
          name,
          description: description && description !== name ? description : undefined,
          price,
          currency: this.detectCurrency(priceText) || 'TRY',
          original_image_url: image,
          is_available: true,
        });
      }
    }

    return categories.filter((c) => c.items.length > 0);
  }

  /** Pass 2c: Next.js __NEXT_DATA__ & captured API JSON extractor (Yemeksepeti / Delivery Hero / SPA). */
  private static extractFromNextData($: cheerio.CheerioAPI, baseUrl: string): IMenuCategory[] {
    const jsonContents: any[] = [];

    // 1. Collect __NEXT_DATA__
    $('script#\\__NEXT_DATA__, script[id="__NEXT_DATA__"]').each((_, el) => {
      const text = $(el).contents().text().trim();
      if (!text) return;
      try {
        jsonContents.push(JSON.parse(text));
      } catch {}
    });

    // 2. Collect captured API responses from RenderService Playwright network interception
    $('script.pf-captured-api, script[class="pf-captured-api"]').each((_, el) => {
      const text = $(el).contents().text().trim();
      if (!text) return;
      try {
        jsonContents.push(JSON.parse(text));
      } catch {}
    });

    // 3. Fallback to any script containing json with categories or menu
    if (!jsonContents.length) {
      $('script[type="application/json"]').each((_, el) => {
        const id = $(el).attr('id') || '';
        if (id === '__NEXT_DATA__') return;
        const text = $(el).contents().text().trim();
        if (!text || text.length < 50) return;
        try {
          const parsed = JSON.parse(text);
          jsonContents.push(parsed);
        } catch {}
      });
    }

    const categories: IMenuCategory[] = [];
    const seenItems = new Set<string>();

    const processProduct = (prod: any, defaultCatName: string): { item: IMenuItem; catName: string } | null => {
      if (!prod || typeof prod !== 'object') return null;

      const name = String(prod.name || prod.title || prod.productName || prod.label || '').replace(/\s+/g, ' ').trim();
      if (!name || name.length < 2 || name.length > 150) return null;

      let price: number | null = null;
      if (typeof prod.price === 'number') {
        price = prod.price;
      } else if (typeof prod.unit_price === 'number') {
        price = prod.unit_price;
      } else if (typeof prod.price_after_discount === 'number') {
        price = prod.price_after_discount;
      } else if (typeof prod.priceBeforeDiscount === 'number') {
        price = prod.priceBeforeDiscount;
      } else if (prod.priceObject?.price !== undefined) {
        price = Number(prod.priceObject.price);
      } else if (prod.price && typeof prod.price === 'object') {
        price = Number(prod.price.amount || prod.price.value || prod.price.price || 0);
      } else if (typeof prod.price === 'string') {
        price = ScraperService.parsePrice(prod.price);
      }

      if (price === null || !Number.isFinite(price)) price = 0;

      const desc = String(prod.description || prod.desc || prod.short_description || '').replace(/\s+/g, ' ').trim();
      const description = desc && desc !== name ? desc : undefined;

      let rawImg = prod.fileUrl || prod.logoUrl || prod.imageUrl || prod.image || prod.avatar || prod.hero_image || prod.photo;
      if (Array.isArray(rawImg)) rawImg = rawImg[0];
      if (typeof rawImg === 'object' && rawImg) rawImg = rawImg.url || rawImg.fileUrl || rawImg.src;

      let original_image_url: string | undefined;
      if (typeof rawImg === 'string' && rawImg && !rawImg.startsWith('data:')) {
        try {
          original_image_url = ImageService.optimizeUrl(new URL(rawImg, baseUrl).toString());
        } catch {
          original_image_url = undefined;
        }
      }

      const catName = String(prod.categoryName || prod.category_name || prod.category || defaultCatName || 'Menü').replace(/\s+/g, ' ').trim();

      const itemKey = `${catName}:${name}`.toLowerCase();
      if (seenItems.has(itemKey)) return null;
      seenItems.add(itemKey);

      return {
        catName,
        item: {
          item_id: ScraperService.slug(itemKey, 'item'),
          name,
          description,
          price,
          currency: prod.currency || 'TRY',
          original_image_url,
          is_available: prod.isAvailable !== false && prod.is_available !== false,
        },
      };
    };

    const traverse = (node: any, currentCategory = 'Menü', depth = 0): void => {
      if (!node || depth > 12) return;

      if (Array.isArray(node)) {
        for (const element of node) {
          traverse(element, currentCategory, depth + 1);
        }
        return;
      }

      if (typeof node !== 'object') return;

      // Category node check
      const catName = node.name || node.title || node.categoryName || node.category_name;
      const productsArray = node.products || node.items || node.dishes || node.entities || node.menu_items || node.menuItems;

      if (typeof catName === 'string' && Array.isArray(productsArray) && productsArray.length > 0) {
        const catTitle = catName.replace(/\s+/g, ' ').trim();
        for (const prod of productsArray) {
          const res = processProduct(prod, catTitle);
          if (res) {
            let cat = categories.find((c) => c.name === res.catName);
            if (!cat) {
              cat = { category_id: ScraperService.slug(res.catName, 'cat'), name: res.catName, items: [] };
              categories.push(cat);
            }
            cat.items.push(res.item);
          }
        }
      }

      // Continue deep traversal for other keys
      for (const key of Object.keys(node)) {
        if (key === 'products' || key === 'items' || key === 'dishes' || key === 'entities') continue;
        traverse(node[key], currentCategory, depth + 1);
      }
    };

    for (const json of jsonContents) {
      traverse(json);
    }

    return categories.filter((c) => c.items.length > 0);
  }

  /** Pass 2d: Yemeksepeti / Delivery Hero DOM extractor. */
  private static extractFromYemeksepeti($: cheerio.CheerioAPI, baseUrl: string): IMenuCategory[] {
    const productCards = $('[data-qa="product-card"], [data-testid="product-card"], [class*="product-card"]');
    if (!productCards.length) return [];

    const categories: IMenuCategory[] = [];
    const claimedKeys = new Set<string>();

    productCards.each((_, el) => {
      const $card = $(el);

      const titleEl = $card.find('[data-qa="product-title"], [data-testid="product-title"], [class*="product-title"], [class*="product-name"], h3, h4').first();
      const priceEl = $card.find('[data-qa="product-price"], [data-testid="product-price"], [class*="product-price"], [class*="price"]').first();

      const name = titleEl.text().replace(/\s+/g, ' ').trim();
      const priceText = priceEl.text().replace(/\s+/g, ' ').trim();
      const price = ScraperService.parsePrice(priceText);

      if (!name || price === null) return;

      const descEl = $card.find('[data-qa="product-description"], [class*="product-description"], [class*="description"], p').first();
      const description = descEl.length ? descEl.text().replace(/\s+/g, ' ').trim() : undefined;

      const categoryContainer = $card.closest('[data-qa="menu-category"], [data-testid="vendor-menu-category"], section, [class*="category"]');
      let catName = 'Menü';
      if (categoryContainer.length) {
        const catHead = categoryContainer.find('[data-qa="category-title"], h2, h3, [class*="category-title"]').first();
        if (catHead.length) {
          catName = catHead.text().replace(/\s+/g, ' ').trim() || 'Menü';
        }
      }

      const key = `${catName}:${name}`.toLowerCase();
      if (claimedKeys.has(key)) return;
      claimedKeys.add(key);

      const image = ScraperService.extractImageFromElement($card, baseUrl);

      let category = categories.find((c) => c.name === catName);
      if (!category) {
        category = {
          category_id: ScraperService.slug(catName, 'cat'),
          name: catName,
          items: [],
        };
        categories.push(category);
      }

      category.items.push({
        item_id: ScraperService.slug(key, 'item'),
        name,
        description: description && description !== name ? description : undefined,
        price,
        currency: ScraperService.detectCurrency(priceText) || 'TRY',
        original_image_url: image,
        is_available: true,
      });
    });

    return categories.filter((c) => c.items.length > 0);
  }

  /**
   * Pass 3: catalogue pages that publish no prices at all.
   *
   * extractFromDom is anchored on prices - it starts from the currency figures
   * on the page and climbs to the product that owns each one. A patisserie or
   * bakery that lists what it sells without printing prices therefore yields
   * nothing, even though every product sits in the markup with its own photo
   * and description.
   *
   * A catalogue repeats a different structure instead: a grid of links into
   * one URL directory, each tile carrying the product's own artwork. Grouping
   * by directory rather than by class name keeps this independent of how the
   * theme names its containers, and the per-tile image is what separates a
   * product grid from a navigation list - a footer menu links into a directory
   * too, but its links carry no artwork.
   *
   * `skip` holds the pages the crawler is already fetching in their own right.
   * Without it a category grid reports its six sections as six products, each
   * duplicating a section page we scrape anyway.
   */
  private static extractCatalog(
    $: cheerio.CheerioAPI,
    baseUrl: string,
    skip: Set<string> = new Set()
  ): IMenuCategory[] {
    // Same bound as a priced item block: past this the node is page furniture.
    const MAX_TILE_CHARS = 1200;
    // Two links are a pair of buttons; three repeat a template.
    const MIN_GRID_LINKS = 3;
    // Labels that name the action rather than the product. The dotted capital
    // I is spelled out: JS case-insensitivity does not fold "İ" onto "i".
    const genericLinkRe =
      /^([iİ]ncele|detay(lar)?|devam|daha fazla|görüntüle|ürünleri gör|urunleri gor|read more|view( more)?|more|details?|see more)$/i;

    interface ILink {
      url: string;
      el: any;
      text: string;
    }

    // One normalisation pass: the tile search below asks for these repeatedly.
    const linkUrl = new Map<any, string>();
    const links: ILink[] = [];

    $('a[href]').each((_, el) => {
      const $el = $(el);
      const url = MenuCrawlerService.normalize($el.attr('href') || '', baseUrl);
      if (!url) return;
      linkUrl.set(el, url);
      if (skip.has(url)) return;

      // A link to a directory is a section of the catalogue, not a leaf in it.
      const path = new URL(url).pathname;
      if (path.endsWith('/')) return;

      links.push({ url, el, text: $el.text().replace(/\s+/g, ' ').trim() });
    });

    // --- 1. Group by the directory the links point into ---------------------
    const byDir = new Map<string, ILink[]>();
    for (const link of links) {
      const dir = new URL(link.url).pathname.replace(/[^/]*$/, '');
      const bucket = byDir.get(dir);
      if (bucket) bucket.push(link);
      else byDir.set(dir, [link]);
    }

    const order = new Map<any, number>();
    $('*').each((index, el) => {
      order.set(el, index);
    });

    /**
     * Smallest block around a link that carries its own image. Climbing stops
     * at a block that also holds a *different* product of the same grid - past
     * that point we are looking at the grid, not at one of its tiles. The
     * link's twin ("İncele" beside the title) points at the same URL and so
     * does not end the climb.
     */
    const tileFor = (link: ILink, siblings: Set<string>): cheerio.Cheerio<any> | undefined => {
      let node = $(link.el);
      if (node.find('img').length) return node;

      for (let up = 0; up < 8; up++) {
        const parent = node.parent();
        if (!parent.length) break;
        if (parent.text().replace(/\s+/g, ' ').trim().length > MAX_TILE_CHARS) break;

        const swallowsSibling = parent
          .find('a[href]')
          .toArray()
          .some((el) => {
            const url = linkUrl.get(el);
            return url !== undefined && url !== link.url && siblings.has(url);
          });
        if (swallowsSibling) break;

        node = parent;
        if (node.find('img').length) return node;
      }
      return undefined;
    };

    /** The anchor text that names the product, not the button under it. */
    const nameFor = (group: ILink[], tile: cheerio.Cheerio<any>): string | undefined => {
      const usable = (text: string): boolean =>
        text.length >= 2 && text.length <= 120 && !genericLinkRe.test(text);

      const labelled = group
        .map((link) => link.text)
        .filter(usable)
        .sort((a, b) => b.length - a.length)[0];
      if (labelled) return labelled;

      // Themes that print only artwork still label the link for screen readers.
      const titled = group
        .map((link) => ($(link.el).attr('title') || '').replace(/\s+/g, ' ').trim())
        .find(usable);
      if (titled) return titled;

      const heading = tile
        .find('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="name"],[class*="baslik"]')
        .toArray()
        .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
        .find(usable);
      if (heading) return heading;

      const alt = (tile.find('img').first().attr('alt') || '').replace(/\s+/g, ' ').trim();
      return usable(alt) ? alt : undefined;
    };

    // --- 2. Resolve each grid into products --------------------------------
    interface IProduct {
      name: string;
      tile: cheerio.Cheerio<any>;
      pos: number;
    }

    const products: IProduct[] = [];
    const tiles: cheerio.Cheerio<any>[] = [];

    for (const group of byDir.values()) {
      const siblings = new Set(group.map((link) => link.url));
      if (siblings.size < MIN_GRID_LINKS) continue;

      // Every anchor pointing at one product, so the title link and its
      // "İncele" twin resolve to a single row.
      const byUrl = new Map<string, ILink[]>();
      for (const link of group) {
        const bucket = byUrl.get(link.url);
        if (bucket) bucket.push(link);
        else byUrl.set(link.url, [link]);
      }

      const found: IProduct[] = [];
      for (const [, entries] of byUrl) {
        const tile = tileFor(entries[0], siblings);
        if (!tile) continue;
        const name = nameFor(entries, tile);
        if (!name) continue;
        found.push({ name, tile, pos: order.get(entries[0].el) ?? 0 });
      }

      // A handful of tiles is a grid; one or two are a teaser or a footer.
      if (found.length < MIN_GRID_LINKS) continue;
      products.push(...found);
      tiles.push(...found.map((product) => product.tile));
    }

    if (!products.length) return [];

    // --- 3. Category headings = headings outside every tile -----------------
    const headings: Array<{ pos: number; name: string }> = [];
    $('h1,h2,h3,h4,h5,h6').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (!text || text.length > 90) return;
      if (tiles.some((tile) => tile.is(el) || tile.find(el).length > 0)) return;
      headings.push({ pos: order.get(el) ?? 0, name: text });
    });
    headings.sort((a, b) => a.pos - b.pos);

    const categoryFor = (pos: number): string => {
      let current = 'Menü';
      for (const heading of headings) {
        if (heading.pos > pos) break;
        current = heading.name;
      }
      return current;
    };

    // --- 4. Assemble --------------------------------------------------------
    const categories: IMenuCategory[] = [];
    const claimed = new Set<string>();

    for (const product of products.sort((a, b) => a.pos - b.pos)) {
      const key = product.name.toLowerCase();
      if (claimed.has(key)) continue;
      claimed.add(key);

      const description = product.tile
        .find('[class*="desc"], [class*="aciklama"], [class*="ozet"], [class*="Ozet"], p')
        .toArray()
        .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
        .find((text) => text && text !== product.name && text.length > 2);

      const image = this.extractImageFromElement(product.tile, baseUrl);

      const categoryName = categoryFor(product.pos).slice(0, 80) || 'Menü';
      let category = categories.find((c) => c.name === categoryName);
      if (!category) {
        category = { category_id: this.slug(categoryName, 'cat'), name: categoryName, items: [] };
        categories.push(category);
      }

      category.items.push({
        item_id: this.slug(`${categoryName}:${product.name}`, 'item'),
        name: product.name,
        description,
        // The site states none. Zero is the honest reading, and the
        // `catalog` extraction method tells the dashboard why.
        price: 0,
        currency: 'TRY',
        original_image_url: image,
        is_available: true,
      });
    }

    return categories.filter((c) => c.items.length > 0);
  }

  /** Categories whose name carries no information about what is inside them. */
  private static genericCategoryRe = /^(men[uü]|menu|[uü]r[uü]nler|products|items|list[ea]?)$/i;

  private static normalizeCategoryName(name: string): string {
    return name.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Folds one page's categories into the running menu.
   *
   * Section pages overlap: a landing page's "favourites" strip repeats
   * products that also appear on their own section page, so items are keyed by
   * name+price and the first occurrence wins.
   */
  private static mergeCategories(target: IMenuCategory[], incoming: IMenuCategory[]): void {
    for (const category of incoming) {
      const key = this.normalizeCategoryName(category.name);
      let existing = target.find((c) => this.normalizeCategoryName(c.name) === key);

      if (!existing) {
        existing = { category_id: category.category_id, name: category.name, items: [] };
        target.push(existing);
      }

      for (const item of category.items) {
        const duplicate = existing.items.some(
          (other) =>
            other.name.toLowerCase() === item.name.toLowerCase() && other.price === item.price
        );
        if (!duplicate) existing.items.push(item);
      }
    }
  }

  /**
   * Names an unnamed section after the link that led to it. Section pages that
   * print no heading of their own would otherwise all merge into one bucket
   * called "Menü", losing the menu's structure.
   */
  private static applyTitleHint(categories: IMenuCategory[], hint?: string): void {
    if (!hint || categories.length !== 1) return;
    if (!this.genericCategoryRe.test(categories[0].name.trim())) return;

    categories[0].name = hint.slice(0, 80);
    categories[0].category_id = this.slug(categories[0].name, 'cat');
  }

  /** First page that actually states a currency; the grid page often states none. */
  private static currencyFromPages(htmls: string[]): string {
    for (const html of htmls) {
      for (const { symbol, code } of CURRENCY_SYMBOLS) {
        if (symbol.test(html)) return code;
      }
    }
    return 'TRY';
  }

  /**
   * Scrapes a QR menu / website, then pushes every image through the WebP
   * pipeline. Returns structured categories plus extraction telemetry.
   *
   * The entry URL is only the starting point: most QR menus put their products
   * on section pages behind a category grid, so the crawler fetches those too
   * and every page is extracted with the same two-pass strategy.
   */
  public static async scrapeAndExtractMenu(
    venueName: string,
    menuUrl?: string,
    /** Sample menus are only ever acceptable for sample venues. */
    allowSampleMenu = true,
    options: IScrapeOptions = {}
  ): Promise<IScrapeResult> {
    const categories: IMenuCategory[] = [];
    const warnings: string[] = [];
    const sourcePages: string[] = [];
    let currency = 'TRY';
    let method = 'none';
    let sourceUrl = menuUrl;
    let pagesCrawled = 0;

    if (menuUrl) {
      try {
        console.log(`[ScraperService] Scraping menu for '${venueName}' -> ${menuUrl}`);
        const crawl = await MenuCrawlerService.crawl(menuUrl, {
          crawl: options.crawl,
          maxPages: options.maxPages,
        });

        warnings.push(...crawl.warnings);
        pagesCrawled = crawl.pages.length;
        if (crawl.pages.length) sourceUrl = crawl.pages[0].url;
        currency = this.currencyFromPages(crawl.pages.map((page) => page.html));

        const methods = new Set<string>();

        // Pages the crawler already fetches on their own: a category grid must
        // not also report them as products (see extractCatalog).
        const crawledUrls = new Set(
          crawl.pages
            .map((page) => MenuCrawlerService.normalize(page.url, page.url))
            .filter((url): url is string => url !== null)
        );

        for (const page of crawl.pages) {
          const $ = cheerio.load(page.html);

          let pageCategories = this.extractFromJsonLd($);
          let pageMethod = pageCategories.length ? 'schema_org' : '';

          if (!pageCategories.length) {
            pageCategories = this.extractFromNextData($, page.url);
            pageMethod = pageCategories.length ? 'next_data_json' : '';
          }

          if (!pageCategories.length) {
            pageCategories = this.extractFromYemeksepeti($, page.url);
            pageMethod = pageCategories.length ? 'yemeksepeti_dom' : '';
          }

          if (!pageCategories.length) {
            pageCategories = this.extractFromTgoYemek($, page.url);
            pageMethod = pageCategories.length ? 'tgoyemek_dom' : '';
          }

          if (!pageCategories.length) {
            pageCategories = this.extractFromAkinsoft($, page.url);
            pageMethod = pageCategories.length ? 'akinsoft_dom' : '';
          }

          if (!pageCategories.length) {
            pageCategories = this.extractFromDom($, page.url);
            pageMethod = pageCategories.length ? page.method : '';
          }

          // Last resort: the site publishes products but no prices.
          if (!pageCategories.length) {
            pageCategories = this.extractCatalog($, page.url, crawledUrls);
            pageMethod = pageCategories.length ? 'catalog' : '';
          }

          if (!pageCategories.length) continue;

          this.applyTitleHint(pageCategories, page.title_hint);
          this.mergeCategories(categories, pageCategories);
          methods.add(pageMethod);
          sourcePages.push(page.url);
        }

        // Structured data is only claimed when every contributing page had it.
        method = methods.size
          ? methods.has('schema_org') && methods.size === 1
            ? 'schema_org'
            : Array.from(methods).find((entry) => entry !== 'schema_org') || 'schema_org'
          : 'none';

        // Price 0 is a real reading here, not a parse failure - say so, so the
        // dashboard never presents these products as free.
        if (methods.has('catalog')) {
          warnings.push('Site publishes no prices; products captured with price 0.');
        }

        if (!categories.length) {
          warnings.push(
            crawl.discovered
              ? `No menu structure could be extracted from ${crawl.pages.length} page(s).`
              : 'No menu structure could be extracted from the page.'
          );
        }
      } catch (error: any) {
        warnings.push(`Menu scrape failed: ${error.message}`);
        console.warn(`[ScraperService] Menu scrape failed for ${menuUrl}: ${error.message}`);
      }
    } else {
      warnings.push('No menu URL available for this venue.');
    }

    // A sample menu is fabricated content: attach it only to sample venues, so a
    // real scraped venue never carries an invented menu.
    if (!categories.length && config.allowMockData && allowSampleMenu) {
      categories.push(...this.getSampleMenu());
      method = 'sample';
    }

    // --- Instagram Post Photo Matcher ----------------------------------------
    const instaUrl = options.instagramUrl || (menuUrl && menuUrl.includes('instagram.com') ? menuUrl : undefined);
    if (instaUrl && categories.length) {
      try {
        console.log(`[ScraperService] Attempting Instagram photo matching via ${instaUrl}...`);
        const instaMatch = await InstagramMatcherService.matchAndEnrichMenu(categories, instaUrl);
        if (instaMatch.matched_items > 0) {
          console.log(`[ScraperService] Successfully matched ${instaMatch.matched_items} menu items with Instagram photos!`);
        }
      } catch (err: any) {
        console.warn(`[ScraperService] Instagram matcher failed: ${err.message}`);
      }
    }

    // --- WebP conversion pipeline (spec §2.2) -------------------------------
    const conversions: Array<{ url: string; prefix: string }> = [];
    const targets: IMenuItem[] = [];

    for (const category of categories) {
      for (const item of category.items) {
        if (item.original_image_url) {
          conversions.push({ url: item.original_image_url, prefix: item.item_id });
          targets.push(item);
        }
      }
    }

    const results = await ImageService.convertMany(conversions);
    let imagesConverted = 0;
    let bytesSaved = 0;

    results.forEach((result, index) => {
      targets[index].webp_image_url = result.url;
      if (result.converted) {
        imagesConverted++;
        if (result.original_bytes && result.webp_bytes) {
          bytesSaved += result.original_bytes - result.webp_bytes;
        }
      }
    });

    return {
      currency,
      categories,
      source_url: sourceUrl,
      extraction_method: method || 'none',
      images_converted: imagesConverted,
      bytes_saved: bytesSaved,
      pages_crawled: pagesCrawled,
      source_pages: sourcePages.length ? sourcePages : undefined,
      warning: warnings.length ? warnings.join(' | ') : undefined,
    };
  }

  /** Demo menu used only in mock mode so the dashboard has something to show. */
  private static getSampleMenu(): IMenuCategory[] {
    return [
      {
        category_id: 'cat_coffee',
        name: 'Sıcak & Soğuk Kahveler',
        items: [
          {
            item_id: 'item_c01',
            name: 'Iced Americano',
            description: 'Çift shot taze çekilmiş espresso ve soğuk su.',
            price: 110.0,
            currency: 'TRY',
            original_image_url: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=500',
            is_available: true,
          },
          {
            item_id: 'item_c02',
            name: 'Flat White',
            description: 'Yoğun espresso ve mikroköpüklü kadifemsi süt.',
            price: 130.0,
            currency: 'TRY',
            original_image_url: 'https://images.unsplash.com/photo-1577968897966-3d4325b36b61?w=500',
            is_available: true,
          },
        ],
      },
      {
        category_id: 'cat_dessert',
        name: 'Taze Tatlılar',
        items: [
          {
            item_id: 'item_d01',
            name: 'San Sebastian Cheesecake',
            description: 'İçi kremsi akışkan, üzeri karamelize fırınlanmış cheesecake.',
            price: 220.0,
            currency: 'TRY',
            original_image_url: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=500',
            is_available: true,
          },
        ],
      },
    ];
  }
}
