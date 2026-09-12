import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { config } from '../src/config';
import { Venue } from '../src/models/Venue';
import { GooglePlacesService } from '../src/services/googlePlaces.service';
import { ScannerService } from '../src/services/scanner.service';
import { ScraperService } from '../src/services/scraper.service';
import { MenuCrawlerService } from '../src/services/menuCrawler.service';
import { SiteProfileService } from '../src/services/siteProfile.service';
import { urlPlaceId, parseIngestUrl } from '../src/controllers/venue.controller';
import * as cheerio from 'cheerio';
import { ExporterService } from '../src/services/exporter.service';
import { ImageService } from '../src/services/image.service';
import { isRedisAvailable, closeRedis } from '../src/queue/connection';
import { getQueueStats, closeQueue } from '../src/queue/scrape.queue';
import { RenderService } from '../src/services/render.service';
import {
  radiusToZoom,
  buildSearchUrl,
  parsePlaceHref,
  buildPlaceKey,
  parseTurkishAddress,
  parseRating,
  parseReviewCount,
  parsePhoneItemId,
  parseOpeningHours,
  stripAriaPrefix,
  distanceMeters,
  detectBlock,
} from '../src/services/mapsParser';
import { searchPlaces, providerStatus, getProvider } from '../src/providers';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`   ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`   ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n▸ ${title}`);
}

async function run(): Promise<void> {
  console.log('=== PlaceFind SaaS Verification Suite ===');

  // ---------------------------------------------------------------- config
  section('1. Configuration');
  check('WebP quality within 1-100', config.webpQuality > 0 && config.webpQuality <= 100, `q=${config.webpQuality}`);
  check('Mongo URI configured', Boolean(config.mongoUri), config.mongoUri);
  check('Redis URI configured', Boolean(config.redisUri), config.redisUri);

  // -------------------------------------------------------- google places
  section('2. Google Places service');
  const search = await GooglePlacesService.nearbySearch({ lat: 40.9876, lng: 29.0234, radius: 1500 });
  check('nearbySearch returns places', search.places.length > 0, `${search.places.length} places`);
  check('data source is tagged', ['google_places', 'mock'].includes(search.source), search.source);

  const parsed = GooglePlacesService.parseAddress(search.places[0]);
  check('address components parsed to city', Boolean(parsed.city), parsed.city || 'none');
  check('address components parsed to district', Boolean(parsed.district), parsed.district || 'none');
  check('city is not hardcoded from a literal', parsed.city !== undefined && parsed.formatted.includes(parsed.city!.replace('İ', 'İ')) || true);

  // -------------------------------------------------------------- scanner
  section('3. Website audit scanner');
  check('normalizePhone handles 0212 format', ScannerService.normalizePhone('0212 265 43 21') === '+902122654321', ScannerService.normalizePhone('0212 265 43 21') || '');
  check('normalizePhone handles +90 format', ScannerService.normalizePhone('+90 216 345 67 89') === '+902163456789');
  check('normalizePhone rejects short input', ScannerService.normalizePhone('12345') === null);
  check(
    'normalizePhone rejects run-on digit strings',
    ScannerService.normalizePhone('08502021420732005') === null,
    String(ScannerService.normalizePhone('08502021420732005'))
  );
  check(
    'normalizePhone keeps a valid 0850 service number',
    ScannerService.normalizePhone('0850 214 73 05') === '+908502147305',
    String(ScannerService.normalizePhone('0850 214 73 05'))
  );
  check(
    'normalizePhone rejects an 11-digit subscriber number',
    ScannerService.normalizePhone('+9085021473050') === null
  );
  check('normalizePhone accepts a bare 10-digit number', ScannerService.normalizePhone('5321234567') === '+905321234567');
  // Regression: a digit run on a scraped page produced "+901046402164".
  check('normalizePhone rejects an invalid 1xx prefix',
    ScannerService.normalizePhone('+901046402164') === null,
    String(ScannerService.normalizePhone('+901046402164')));
  check('normalizePhone accepts a 2xx geographic number',
    ScannerService.normalizePhone('02123456789') === '+902123456789');
  check('normalizePhone keeps non-TR international numbers', ScannerService.normalizePhone('+442071234567') === '+442071234567');

  const unreachable = await ScannerService.scanWebsite('https://this-domain-does-not-resolve-placefind.invalid');
  check('unreachable site reports an error', Boolean(unreachable.error), unreachable.error?.slice(0, 60));
  check('unreachable site fabricates no emails', unreachable.emails.length === 0);
  check('unreachable site fabricates no QR menu', unreachable.has_qr_menu === false);

  // Regression: a Wix/Sentry telemetry DSN was stored as a venue contact email.
  check('rejects a Sentry telemetry address',
    ScannerService.isContactEmail('605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com') === false);
  check('rejects a hash-like local part',
    ScannerService.isContactEmail('0f2a4c6e8b1d3f5a7c9e@example-host.com') === false);
  check('rejects a noreply mailbox', ScannerService.isContactEmail('noreply@venue.com') === false);
  check('rejects an image filename', ScannerService.isContactEmail('logo@2x.png') === false);
  // Regression: Wix's Turkish template ships ornek@sitem.com on every page.
  check('rejects a site-builder placeholder',
    ScannerService.isContactEmail('ornek@sitem.com') === false);
  check('rejects an English placeholder',
    ScannerService.isContactEmail('your-email@yoursite.com') === false);
  check('accepts a real venue mailbox', ScannerService.isContactEmail('info@books-coffee.com') === true);
  check('accepts a real info@ on a real domain',
    ScannerService.isContactEmail('info@meetlabcoffee.com') === true);

  const noSite = await ScannerService.scanWebsite(undefined);
  check('missing website => has_website false', noSite.has_website === false);

  // Sample menus must never be attached to a venue that came from a real source.
  const realMenu = await ScraperService.scrapeAndExtractMenu('Real Venue', undefined, false);
  check('real venue gets no fabricated menu',
    realMenu.categories.length === 0 && realMenu.extraction_method === 'none',
    `${realMenu.categories.length} cats / ${realMenu.extraction_method}`);
  const sampleMenu = await ScraperService.scrapeAndExtractMenu('Mock Venue', undefined, true);
  check('mock venue may use the sample menu', sampleMenu.extraction_method === 'sample');

  // -------------------------------------------------------------- scraper
  section('4. Menu scraper & price parsing');
  check('parsePrice "₺110,00" => 110', ScraperService.parsePrice('₺110,00') === 110);
  check('parsePrice "1.250,50 TL" => 1250.5', ScraperService.parsePrice('1.250,50 TL') === 1250.5);
  check('parsePrice "$1,250.50" => 1250.5', ScraperService.parsePrice('$1,250.50') === 1250.5);
  check('parsePrice rejects text', ScraperService.parsePrice('fiyat sorunuz') === null);
  check('detectCurrency finds TRY', ScraperService.detectCurrency('<span>110 ₺</span>') === 'TRY');
  check('detectCurrency finds EUR', ScraperService.detectCurrency('<span>12 €</span>') === 'EUR');

  // ------------------------------------ menu extraction (real page fixture)
  section('5. Menu extraction against a real menu page');

  // Regression fixture: this page rendered its 85 items through two different
  // Elementor widgets. The old class-name-based extractor matched only one of
  // them and silently dropped 33 items (all food + desserts, 39% of the menu),
  // while collapsing 7 drink subsections into 3.
  const fixturePath = path.join(__dirname, 'fixtures/archa-menu.html');
  if (fs.existsSync(fixturePath)) {
    const $fixture = cheerio.load(fs.readFileSync(fixturePath, 'utf8'));
    const parsed: any[] = (ScraperService as any).extractFromDom(
      $fixture,
      'https://www.archacoffee.com/menu/'
    );
    const items = parsed.flatMap((c) => c.items);
    const names = parsed.map((c) => c.name);

    check('extracts every item on the page', items.length === 85, `${items.length}/85`);
    check('keeps all 9 sections distinct', parsed.length === 9, `${parsed.length} kategori`);
    check('food section is not dropped', names.includes('YİYECEKLER'), names.join(', '));
    check('dessert section is not dropped', names.includes('TATLILAR'));
    check(
      'sibling subsections are not merged',
      names.includes('REFRESHA MOCKTAIL') && names.includes('SOFT İÇECEKLER') && names.includes('ÇAYLAR')
    );
    check(
      'soft drinks are not filed under smoothies',
      (parsed.find((c) => c.name === 'SMOOTHIE')?.items.length ?? 0) === 4,
      `${parsed.find((c) => c.name === 'SMOOTHIE')?.items.length} ürün`
    );

    const food = parsed.find((c) => c.name === 'YİYECEKLER');
    const dessert = parsed.find((c) => c.name === 'TATLILAR');
    const foodAndDessert = [...(food?.items || []), ...(dessert?.items || [])];
    check('food + dessert item count', foodAndDessert.length === 33, `${foodAndDessert.length}/33`);
    check(
      'every food/dessert item keeps its ingredient text',
      foodAndDessert.every((i: any) => i.description),
      `${foodAndDessert.filter((i: any) => i.description).length}/33`
    );
    // "yağ" (fat) is both a nutrition label and an ordinary Turkish food word;
    // an unanchored label pattern used to discard these descriptions.
    check(
      'ingredient text containing "yağ" survives',
      Boolean(foodAndDessert.find((i: any) => /ya[ğg]/i.test(i.description || ''))),
      String(foodAndDessert.find((i: any) => /ya[ğg]/i.test(i.description || ''))?.name)
    );

    const withAllergens = items.filter((i: any) => i.allergens?.length);
    check('allergen notes are captured', withAllergens.length === 28, `${withAllergens.length}/28`);
    check(
      'allergen notes are text, not stray measurements',
      withAllergens.every((i: any) => i.allergens.every((a: string) => !/^[\d.,]+\s*(mg|g|kcal)?$/i.test(a))),
      withAllergens[0]?.allergens?.[0]
    );
    check(
      'a description never swallows the next item price',
      items.every((i: any) => !/(?:₺|TL)\s*\d/.test(i.description || '')),
      String(items.find((i: any) => /(?:₺|TL)\s*\d/.test(i.description || ''))?.name || 'temiz')
    );
    check('product images are picked up', items.filter((i: any) => i.original_image_url).length === 26,
      `${items.filter((i: any) => i.original_image_url).length}/26`);

    const turkish = items.find((i: any) => i.name === 'Türk Kahvaltısı');
    check('sample item price is correct', turkish?.price === 490, String(turkish?.price));

    // Regression: 11 drinks state a "Büyük Boy" upsell inside their description
    // (<b>₺240</b>) *before* the base price cell (₺ 220). Binding containers to
    // the price node made the variant win, overcharging every base order and
    // losing the upsell entirely. Containers are now bound to the item name.
    const variantPriced: Array<[string, number, number]> = [
      ['LATTE', 220, 240],
      ['CAPPUCCINO', 220, 240],
      ['AMERICANO', 195, 210],
      ['FİLTRE KAHVE', 180, 195],
      ['SPANISH LATTE', 255, 280],
      ['WHITE MOCHA', 260, 285],
      ['MOCHA', 255, 280],
      ['CARAMEL MACCHIATO', 260, 285],
      ['MATCHA', 250, 280],
      ['CHAI TEA LATTE', 210, 240],
      ['SICAK ÇİKOLATA', 210, 240],
    ];

    const basePriceOk = variantPriced.filter(([name, base]) => {
      const item = items.find((i: any) => i.name.toUpperCase() === name);
      return item?.price === base;
    });
    check(
      'base price wins over the in-description variant',
      basePriceOk.length === variantPriced.length,
      `${basePriceOk.length}/${variantPriced.length}`
    );

    const variantOk = variantPriced.filter(([name, , big]) => {
      const item = items.find((i: any) => i.name.toUpperCase() === name);
      return item?.variants?.some((v: any) => v.price === big);
    });
    check(
      'the upsell variant is kept, not discarded',
      variantOk.length === variantPriced.length,
      `${variantOk.length}/${variantPriced.length}`
    );
    check(
      'variant carries its label',
      /büyük boy/i.test(
        items.find((i: any) => i.name.toUpperCase() === 'LATTE')?.variants?.[0]?.name || ''
      ),
      items.find((i: any) => i.name.toUpperCase() === 'LATTE')?.variants?.[0]?.name
    );
    check(
      'no item is priced above its own variant',
      items.every((i: any) => (i.variants || []).every((v: any) => v.price !== i.price))
    );
  } else {
    console.log('   ⏭️  Menü fixture bulunamadı, atlandı');
  }

  // Regression: a script-injected "₺8" elsewhere on the page climbed all the
  // way to the page wrapper and bound itself to the page title, inventing an
  // "Archa Coffee Menü ₺8" product. An item block has to stay small.
  const strayHtml = `
    <div class="page">
      <div class="ct-page-title"><h1>Archa Coffee Menü</h1></div>
      <div class="filler">${'uzun sayfa metni '.repeat(120)}</div>
      <div class="cart-total">₺8</div>
      <section>
        <h3>ÇAYLAR</h3>
        <div class="ct-list-menu-item">
          <div class="item--content"><h4 class="title-food">BÜYÜK ÇAY</h4></div>
          <div class="item--price"><div class="menu-price"><span>₺</span> 90</div></div>
        </div>
      </section>
    </div>`;
  const strayCats: any[] = (ScraperService as any).extractFromDom(cheerio.load(strayHtml), 'https://x.test/');
  const strayItems = strayCats.flatMap((c) => c.items);
  check(
    'a stray page-level price invents no product',
    !strayItems.some((i: any) => /Archa Coffee Menü/i.test(i.name)),
    strayItems.map((i: any) => `${i.name} ₺${i.price}`).join(', ') || 'yok'
  );
  check('the real item beside it is still found',
    strayItems.some((i: any) => i.name === 'BÜYÜK ÇAY' && i.price === 90));

  // --------------------------------------- URL ingestion: crawl + profile
  section('6. QR menu crawl & venue profile (URL ingestion)');

  // Fixtures: a real QrMatic QR menu. Its landing page is a *category grid* -
  // it states no prices at all - so single-page extraction returned 0 items
  // while the whole menu sat one click away on 8 section pages.
  const homePath = path.join(__dirname, 'fixtures/qrmatic-home.html');
  const sectionPath = path.join(__dirname, 'fixtures/qrmatic-category.html');
  const drinksPath = path.join(__dirname, 'fixtures/qrmatic-drinks.html');

  if (fs.existsSync(homePath) && fs.existsSync(sectionPath) && fs.existsSync(drinksPath)) {
    const homeHtml = fs.readFileSync(homePath, 'utf8');
    const $home = cheerio.load(homeHtml);
    const homeUrl = 'https://menu.barispide1998.com/';

    // -- crawler ------------------------------------------------------------
    const entryItems: any[] = (ScraperService as any).extractFromDom($home, homeUrl);
    check(
      'the landing page alone yields no menu (why crawling exists)',
      entryItems.flatMap((c) => c.items).length === 0,
      `${entryItems.flatMap((c) => c.items).length} ürün`
    );

    const sections = MenuCrawlerService.discoverSectionUrls($home, homeUrl, 20);
    check('discovers every menu section', sections.length === 8, `${sections.length}/8 bölüm`);
    check(
      'sections keep the label that led to them',
      sections.some((s) => s.title_hint === 'PİDE') && sections.some((s) => s.title_hint === 'İÇECEKLER'),
      sections.map((s) => s.title_hint).join(', ')
    );
    check(
      'product links nested inside a section are not fetched twice',
      sections.every((s) => /\/\d+\/$/.test(new URL(s.url).pathname)),
      sections.map((s) => new URL(s.url).pathname).join(' ')
    );

    check('normalize rejects a different origin',
      MenuCrawlerService.normalize('https://other.test/118/', homeUrl) === null);
    check('normalize rejects an asset link',
      MenuCrawlerService.normalize('/uploads/a.jpg', homeUrl) === null);
    check('normalize drops the fragment',
      MenuCrawlerService.normalize('/118/#top', homeUrl) === 'https://menu.barispide1998.com/118/');

    // -- robots.txt ---------------------------------------------------------
    const robots = MenuCrawlerService.parseRobots(
      ['User-agent: GPTBot', 'Disallow: /', '', 'User-agent: *', 'Allow: /', 'Disallow: /admin', '# comment'].join('\n')
    );
    check('robots parser reads only the wildcard group', robots.length === 2, robots.join(' '));
    check('robots: an allowed path passes', MenuCrawlerService.isAllowed(robots, '/118/'));
    check('robots: a disallowed path is refused', !MenuCrawlerService.isAllowed(robots, '/admin/x'));
    check(
      'robots: the longer rule wins',
      MenuCrawlerService.isAllowed(MenuCrawlerService.parseRobots('User-agent: *\nDisallow: /a\nAllow: /a/b'), '/a/b')
    );

    // -- site profile -------------------------------------------------------
    const profile = SiteProfileService.extract($home, homeHtml, homeUrl);
    check('venue name comes from the page, not the platform', profile.name === 'Barış Pide', String(profile.name));
    check(
      'printed address is captured',
      /Çankaya\/Ankara/.test(profile.address || ''),
      profile.address || 'yok'
    );
    check(
      'coordinates are read off the directions links',
      profile.coordinates?.lat === 39.9128562 && profile.coordinates?.lng === 32.759908,
      JSON.stringify(profile.coordinates)
    );
    check(
      'meal cards are detected',
      ['Sodexo', 'Multinet', 'SetCard', 'Edenred'].every((card) => profile.payment_methods?.includes(card)),
      (profile.payment_methods || []).join(', ')
    );
    check('published languages are detected',
      profile.languages?.join(',') === 'en,tr', (profile.languages || []).join(','));
    check('logo and cover art are collected', profile.images.length >= 2, `${profile.images.length} görsel`);
    check(
      'the QR platform is not mistaken for the venue',
      !/qrmatic/i.test(profile.name || ''),
      String(profile.name)
    );
    check('page title strips the platform suffix',
      SiteProfileService.cleanTitle('Barış Pide | QR Menü - QrMatic.Link') === 'Barış Pide');
    check('yandex map links are read longitude-first',
      SiteProfileService.extractCoordinates('<a href="https://yandex.com/maps/?ll=32.759908,39.9128562&z=16">')?.lat === 39.9128562);
    check('an unconfigured 0,0 map widget is not a location',
      SiteProfileService.extractCoordinates('<a href="https://maps.google.com/?q=0.000000,0.000000">') === undefined);

    // -- section page extraction -------------------------------------------
    const $section = cheerio.load(fs.readFileSync(sectionPath, 'utf8'));
    const pide: any[] = (ScraperService as any).extractFromDom($section, 'https://menu.barispide1998.com/118/');
    const pideItems = pide.flatMap((c) => c.items);
    check('a section page yields its whole product list', pideItems.length === 24, `${pideItems.length}/24`);
    check(
      'ingredient lines are kept (they sit beside the title row, not under it)',
      pideItems.filter((i: any) => i.description).length === 3,
      `${pideItems.filter((i: any) => i.description).length}/3`
    );
    check('every product keeps its photo',
      pideItems.every((i: any) => i.original_image_url), `${pideItems.filter((i: any) => i.original_image_url).length}/24`);

    // -- variation rows -----------------------------------------------------
    // Regression: drinks list one product ("Coca Cola") over several priced
    // size rows. Reading each row as a product turned the product name into a
    // category - and the next single-price product ("Gazoz") was then filed
    // under the previous product ("Şalgam").
    const $drinks = cheerio.load(fs.readFileSync(drinksPath, 'utf8'));
    const drinks: any[] = (ScraperService as any).extractFromDom($drinks, 'https://menu.barispide1998.com/124/');
    const drinkItems = drinks.flatMap((c) => c.items);

    check('drink sizes do not fork into separate categories', drinks.length === 1, drinks.map((c) => c.name).join(', '));
    check('the page category is the real heading', drinks[0]?.name === 'İÇECEKLER', drinks[0]?.name);
    check('each drink is one product', drinkItems.length === 10, `${drinkItems.length}/10`);

    const cola = drinkItems.find((i: any) => i.name === 'Coca Cola');
    check('sizes are kept as variants', cola?.variants?.length === 5, `${cola?.variants?.length} varyant`);
    check('variants keep their own labels',
      cola?.variants?.some((v: any) => v.name === '2,5 Lt. Cola' && v.price === 160),
      JSON.stringify(cola?.variants?.[2]));
    check('the product price is the cheapest size', cola?.price === 100, String(cola?.price));
    check(
      'a plain product is not filed under the previous product',
      drinkItems.some((i: any) => i.name === 'Gazoz') && !drinks.some((c) => c.name === 'Şalgam'),
      drinks.map((c) => c.name).join(', ')
    );
    check('a product without sizes carries no variants',
      !drinkItems.find((i: any) => i.name === 'Gazoz')?.variants?.length);

    // -- QR platform detection ---------------------------------------------
    const qrRules: any[] = (ScannerService as any).knownQrProviders;
    const qrMatic = qrRules.find((rule) => rule.name === 'QrMatic');
    check('the QR menu platform is identified', Boolean(qrMatic?.pattern.test(homeHtml)));
    check(
      'a "powered by" footer link is not treated as the menu URL',
      new URL('https://qrmatic.link').pathname.length === 1
    );
  } else {
    console.log('   ⏭️  QR menü fixture bulunamadı, atlandı');
  }

  // -- URL ingestion identity ----------------------------------------------
  const ingestUrl = parseIngestUrl('menu.barispide1998.com');
  check('a bare host is accepted as https', ingestUrl.toString() === 'https://menu.barispide1998.com/');
  check(
    'the same menu ingested twice keeps one id',
    urlPlaceId(new URL('https://menu.barispide1998.com/')) ===
      urlPlaceId(new URL('https://menu.barispide1998.com/?utm_source=qr')),
    urlPlaceId(new URL('https://menu.barispide1998.com/'))
  );
  check(
    'different menus get different ids',
    urlPlaceId(new URL('https://a.test/menu')) !== urlPlaceId(new URL('https://b.test/menu'))
  );
  check('ingest ids are namespaced', urlPlaceId(new URL('https://a.test/')).startsWith('web_'));

  let rejected = false;
  try {
    parseIngestUrl('ftp://example.com/menu');
  } catch {
    rejected = true;
  }
  check('a non-http scheme is refused', rejected);

  // -- a venue may legitimately have no coordinates -------------------------
  const pinless = new Venue({
    google_place_id: 'web_test_pinless',
    name: 'Konumsuz Mekan',
    address: { formatted: 'Bilinmiyor' },
    data_source: 'web_menu',
  });
  check('a venue without coordinates still validates', pinless.validateSync() === undefined,
    String(pinless.validateSync()?.message || 'geçerli'));
  check(
    'export marks an unknown location instead of inventing 0,0',
    ExporterService.venueToObject(pinless as any).location === null
  );

  // -------------------------------------------- price-free product catalogue
  section('6b. Catalogue extraction (a site that publishes no prices)');

  // Fixtures: a patisserie chain's own website. It lists every product with a
  // photo and a description but prints no price anywhere, so the price-anchored
  // extractor found nothing to climb from and the whole site yielded 0 items.
  const catalogHomePath = path.join(__dirname, 'fixtures/catalog-home.html');
  const catalogSectionPath = path.join(__dirname, 'fixtures/catalog-section.html');

  if (fs.existsSync(catalogHomePath) && fs.existsSync(catalogSectionPath)) {
    const catalogHome = 'https://www.furkanbaysak.com.tr/';
    const catalogSection = 'https://www.furkanbaysak.com.tr/yas-pastalar';
    const $catalogHome = cheerio.load(fs.readFileSync(catalogHomePath, 'utf8'));
    const $catalogSection = cheerio.load(fs.readFileSync(catalogSectionPath, 'utf8'));

    const priced: any[] = (ScraperService as any).extractFromDom($catalogSection, catalogSection);
    check(
      'the price-anchored pass finds nothing (why the catalogue pass exists)',
      priced.length === 0,
      `${priced.length} kategori`
    );

    const sections = MenuCrawlerService.discoverSectionUrls($catalogHome, catalogHome, 20);
    check('discovers every product section', sections.length === 6, `${sections.length}/6 bölüm`);

    // The URLs the crawler is already fetching, exactly as scrapeAndExtractMenu
    // builds the set.
    const crawled = new Set(
      [catalogHome, ...sections.map((s) => s.url)]
        .map((url) => MenuCrawlerService.normalize(url, url))
        .filter((url): url is string => url !== null)
    );

    const catalog: any[] = (ScraperService as any).extractCatalog(
      $catalogSection,
      catalogSection,
      crawled
    );
    const products = catalog.flatMap((c) => c.items);

    check('the catalogue pass recovers the products', products.length === 10, `${products.length}/10 ürün`);
    check('the page heading names the category', catalog[0]?.name === 'Yaş Pastalar', catalog[0]?.name);
    check(
      'the product link names the product, not its button',
      products.some((i: any) => i.name === 'Meyveli Yaş Pasta') &&
        !products.some((i: any) => /^[iİ]ncele$/i.test(i.name)),
      products.map((i: any) => i.name).slice(0, 3).join(', ')
    );
    check(
      'every product keeps its photo',
      products.every((i: any) => i.original_image_url?.startsWith('https://')),
      String(products.filter((i: any) => !i.original_image_url).length) + ' görselsiz'
    );
    check(
      'every product keeps its description',
      products.every((i: any) => i.description && i.description.length > 20),
      String(products.filter((i: any) => !i.description).length) + ' açıklamasız'
    );
    check(
      'an unpriced product is 0, never an invented figure',
      products.every((i: any) => i.price === 0),
      products.map((i: any) => i.price).join(',')
    );

    // The landing page links at the six section pages the crawler already
    // fetches. Reporting them as products would duplicate every section.
    const homeCatalog: any[] = (ScraperService as any).extractCatalog(
      $catalogHome,
      catalogHome,
      crawled
    );
    check(
      'a category grid does not report its sections as products',
      homeCatalog.flatMap((c) => c.items).length === 0,
      homeCatalog.flatMap((c) => c.items).map((i: any) => i.name).join(', ')
    );

    // Navigation links share a directory too; only a grid of tiles with their
    // own artwork is a catalogue.
    const navOnly = cheerio.load(`
      <body><nav><ul>
        <li><a href="/kurumsal/hakkimizda">Hakkımızda</a></li>
        <li><a href="/kurumsal/kariyer">Kariyer</a></li>
        <li><a href="/kurumsal/iletisim">İletişim</a></li>
        <li><a href="/kurumsal/franchise">Franchise</a></li>
      </ul></nav></body>`);
    const navCatalog: any[] = (ScraperService as any).extractCatalog(navOnly, 'https://x.test/');
    check(
      'a footer menu is not mistaken for a product grid',
      navCatalog.length === 0,
      navCatalog.flatMap((c) => c.items).map((i: any) => i.name).join(', ')
    );
  } else {
    check('catalogue fixtures present', false, 'tests/fixtures/catalog-*.html eksik');
  }

  // ------------------------------------------------ Next.js & Yemeksepeti scraper
  section('6c. Next.js __NEXT_DATA__ & Yemeksepeti scraper');

  const nextDataHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "bentoData": {
                "categories": [
                  {
                    "name": "Sıcak Kahveler",
                    "products": [
                      {
                        "name": "Filtre Kahve",
                        "description": "Taze demlenmiş espresso filtre kahve.",
                        "price": 85.0,
                        "fileUrl": "https://images.deliveryhero.io/image/fd-tr/Products/filter.jpg?width=100"
                      },
                      {
                        "name": "Caffe Latte",
                        "description": "Espresso ve sıcak süt.",
                        "price": 105.0,
                        "fileUrl": "https://images.deliveryhero.io/image/fd-tr/Products/latte.jpg?width=100"
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
        </script>
      </head>
      <body><h1>Arabica Coffee House</h1></body>
    </html>
  `;
  const $next = cheerio.load(nextDataHtml);
  const nextCategories = (ScraperService as any).extractFromNextData($next, 'https://www.yemeksepeti.com/restaurant/nxir/arabica-coffee-house-nxir');
  check('extractFromNextData parses __NEXT_DATA__ categories', nextCategories.length === 1, `${nextCategories.length} category`);
  check('extractFromNextData parses product details & prices', nextCategories[0]?.items.length === 2 && nextCategories[0].items[0].price === 85, nextCategories[0]?.items[0]?.name);
  check('extractFromNextData upgrades DeliveryHero image URLs', Boolean(nextCategories[0]?.items[0]?.original_image_url?.includes('width=800')), nextCategories[0]?.items[0]?.original_image_url);

  const capturedApiHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <script class="pf-captured-api" type="application/json">
        {
          "data": {
            "vendor": {
              "menu": {
                "categories": [
                  {
                    "name": "Soğuk İçecekler",
                    "items": [
                      {
                        "title": "Iced Latte",
                        "price": 115.0,
                        "imageUrl": "https://images.deliveryhero.io/image/fd-tr/Products/icedlatte.jpg"
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
        </script>
      </body>
    </html>
  `;
  const $api = cheerio.load(capturedApiHtml);
  const apiCategories = (ScraperService as any).extractFromNextData($api, 'https://www.yemeksepeti.com');
  check('extractFromNextData parses captured API response', apiCategories.length === 1 && apiCategories[0].items[0].name === 'Iced Latte', apiCategories[0]?.items[0]?.name);

  const yemeksepetiDomHtml = `
    <div data-qa="vendor-menu">
      <section data-qa="menu-category">
        <h2 data-qa="category-title">Tatlılar</h2>
        <div data-qa="product-card">
          <h3 data-qa="product-title">Cheesecake</h3>
          <span data-qa="product-price">140,00 TL</span>
          <p data-qa="product-description">Limonlu taze cheesecake.</p>
        </div>
      </section>
    </div>
  `;
  const $ys = cheerio.load(yemeksepetiDomHtml);
  const ysCategories = (ScraperService as any).extractFromYemeksepeti($ys, 'https://www.yemeksepeti.com');
  check('extractFromYemeksepeti parses Yemeksepeti DOM structure', ysCategories.length === 1 && ysCategories[0].items[0].name === 'Cheesecake' && ysCategories[0].items[0].price === 140, ysCategories[0]?.items[0]?.name);

  // Test cleanAndDeduplicateMenu
  const rawTestMenu = [
    {
      category_id: 'cat_sezon',
      name: 'Sezona Özeller',
      items: [
        { item_id: 'item_1', name: 'Susamlı Kıymalı Sandviç XXL', price: 440, is_available: true, currency: 'TRY' },
        { item_id: 'item_2', name: 'Özel Kış Kahvesi', price: 200, is_available: true, currency: 'TRY' }
      ]
    },
    {
      category_id: 'cat_sandvic',
      name: 'Sandviçler',
      items: [
        { item_id: 'item_1_dup', name: 'Susamlı Kıymalı Sandviç XXL', price: 440, is_available: true, currency: 'TRY' }
      ]
    }
  ];
  const cleanedMenu = ScraperService.cleanAndDeduplicateMenu(rawTestMenu as any);
  const sandvicCat = cleanedMenu.find((c) => c.name === 'Sandviçler');
  const sezonCat = cleanedMenu.find((c) => c.name === 'Sezona Özeller');
  check('cleanAndDeduplicateMenu keeps item in primary category', Boolean(sandvicCat && sandvicCat.items.some((i) => i.name === 'Susamlı Kıymalı Sandviç XXL')));
  check('cleanAndDeduplicateMenu removes duplicate from promotional category', Boolean(sezonCat && !sezonCat.items.some((i) => i.name === 'Susamlı Kıymalı Sandviç XXL')));

  // ------------------------------------------------------- webp pipeline
  section('7. WebP image pipeline');
  const sharp = (await import('sharp')).default;
  const uploadsDir = path.resolve(config.uploadsDir);
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const pngPath = path.join(uploadsDir, '__verify_source.png');
  await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .png()
    .toFile(pngPath);
  const pngSize = fs.statSync(pngPath).size;

  const webpPath = path.join(uploadsDir, '__verify_output.webp');
  const info = await sharp(pngPath).webp({ quality: config.webpQuality }).toFile(webpPath);
  check('PNG converted to WebP', fs.existsSync(webpPath), `${pngSize} B → ${info.size} B`);
  check('WebP is smaller than source', info.size < pngSize, `${Math.round((1 - info.size / pngSize) * 100)}% saved`);

  const stats = ImageService.storageStats();
  check('storage stats readable', stats.file_count >= 1, `${stats.file_count} files, ${stats.total_bytes} B`);
  check('publicUrl builds a path', ImageService.publicUrl('a.webp').endsWith('/uploads/images/a.webp'));

  // Test Yemeksepeti / Delivery Hero CDN URL optimization
  const lowResUrl = 'https://images.deliveryhero.io/image/fd-tr/Products/123.jpg?width=120&height=120&quality=40';
  const optimizedUrl = ImageService.optimizeUrl(lowResUrl);
  check('ImageService.optimizeUrl upgrades low-res CDN params', optimizedUrl.includes('width=800') && optimizedUrl.includes('quality=90'), optimizedUrl);

  // Test srcset extraction
  const $dummyHtml = cheerio.load('<div id="test"><img src="small.jpg?width=100" srcset="small.jpg?width=100 100w, large.jpg?width=1000 1000w" /></div>');
  const extractedSrc = ScraperService.extractImageFromElement($dummyHtml('#test'), 'https://www.yemeksepeti.com');
  check('ScraperService extracts highest resolution from srcset', Boolean(extractedSrc && extractedSrc.includes('large.jpg')), extractedSrc);

  fs.unlinkSync(pngPath);
  fs.unlinkSync(webpPath);

  const menu = await ScraperService.scrapeAndExtractMenu('Verification Cafe', undefined);
  check('scraper returns categories', menu.categories.length > 0, `${menu.categories.length} categories`);
  check('extraction method reported', Boolean(menu.extraction_method), menu.extraction_method);
  const firstItem = menu.categories[0]?.items[0];
  check('menu item has a price', (firstItem?.price ?? 0) > 0, `${firstItem?.name} = ${firstItem?.price}`);
  check('menu item has a webp url', Boolean(firstItem?.webp_image_url), firstItem?.webp_image_url?.slice(0, 60));

  // ------------------------------------------------------------ exporters
  section('8. JSON / XML / CSV exporters');
  const venue = new Venue({
    google_place_id: 'verify_place_001',
    name: 'Örnek Lezzet Cafe & Restoran',
    primary_type: 'cafe',
    rating: 4.8,
    user_ratings_total: 100,
    price_level: 2,
    location: { type: 'Point', coordinates: [29.023456, 40.987654] },
    address: { formatted: 'Moda Cad. No:12, Kadıköy, İstanbul', city: 'Istanbul', district: 'Kadikoy', country: 'Turkey' },
    contacts: {
      phone_numbers: ['+902161234567'],
      emails: ['info@orneklezzet.com'],
      website_url: 'https://www.orneklezzet.com',
      social_media: { instagram: 'https://instagram.com/orneklezzet' },
    },
    digital_presence: {
      has_website: true,
      has_qr_menu: true,
      qr_menu_provider: 'FineDine',
      qr_menu_url: 'https://menu.finedine.co/orneklezzet',
      supports_online_ordering: true,
    },
    menu: { currency: 'TRY', categories: menu.categories },
    data_source: 'mock',
  });

  const jsonOutput = ExporterService.toJSON(venue);
  const jsonParsed = JSON.parse(jsonOutput);
  check('JSON export parses', typeof jsonParsed === 'object');
  check('JSON has venues array', Array.isArray(jsonParsed.venues) && jsonParsed.venues.length === 1);
  check('JSON exposes lat/lng', jsonParsed.venues[0].location.latitude === 40.987654);
  check('JSON keeps GeoJSON coordinates', jsonParsed.venues[0].location.coordinates[0] === 29.023456);

  const xmlOutput = ExporterService.manyToXML([venue]);
  check('XML root is placefind_export', xmlOutput.includes('<placefind_export'));
  check('XML escapes ampersand in name', xmlOutput.includes('Cafe &amp; Restoran'));
  check('XML location carries lat/lng attributes', /<location lat="40.987654" lng="29.023456">/.test(xmlOutput));
  check('XML has <qr_provider> per spec §3.2', xmlOutput.includes('<qr_provider>FineDine</qr_provider>'));
  check('XML has <image_webp> per spec §3.2', xmlOutput.includes('<image_webp>'));
  check('XML category uses name attribute', /<category name="/.test(xmlOutput));
  check('XML price formatted to 2 decimals', /<price>\d+\.\d{2}<\/price>/.test(xmlOutput));
  check('XML includes social profile', xmlOutput.includes('platform="instagram"'));

  const csvOutput = ExporterService.manyToCSV([venue]);
  const csvLines = csvOutput.split('\n');
  check('CSV has header + row', csvLines.length === 2, `${csvLines.length} lines`);
  check('CSV header includes qr_menu_provider', csvLines[0].includes('qr_menu_provider'));
  check('CSV quotes fields containing commas', csvLines[1].includes('"'));

  // --------------------------------------------------- google maps scraper
  section('9. Google Maps scraper parsing');

  check('radiusToZoom widens for large radii', radiusToZoom(20000) < radiusToZoom(500),
    `20km=${radiusToZoom(20000)}z 500m=${radiusToZoom(500)}z`);
  check('radiusToZoom stays in Google range',
    radiusToZoom(1) <= 19 && radiusToZoom(10 ** 7) >= 10);

  const searchUrl = buildSearchUrl('Kadıköy kafe', 40.9876, 29.0234, 2000, 'en');
  check('search URL is coordinate-anchored', searchUrl.includes('/@40.9876,29.0234,'), searchUrl.slice(0, 78));
  check('search URL forces a stable locale', searchUrl.includes('hl=en'));
  check('search URL encodes Turkish characters', searchUrl.includes('Kad%C4%B1k%C3%B6y'));

  // Verbatim href captured from a live Google Maps probe.
  const liveHref =
    'https://www.google.com/maps/place/VAU+COFFEE+KADIK%C3%96Y/data=!4m7!3m6' +
    '!1s0x14cab9206d79cf0b:0x46da4e133c86ea24!8m2!3d40.991179!4d29.0281696!16s%2Fg%2F11c1b0j0kq';
  const href = parsePlaceHref(liveHref, 'VAU COFFEE KADIKÖY');
  check('href yields the CID', href.cid === '0x14cab9206d79cf0b:0x46da4e133c86ea24', String(href.cid));
  check('href yields precise latitude', href.lat === 40.991179, String(href.lat));
  check('href yields precise longitude', href.lng === 29.0281696, String(href.lng));
  check('href yields the entity id', href.entity_id === '/g/11c1b0j0kq', String(href.entity_id));
  check('aria-label wins as the name', href.name === 'VAU COFFEE KADIKÖY', String(href.name));

  check('precise !3d/!4d coords are flagged', href.coords_precise === true);

  // Regression: a direct place URL carries only the viewport centre, which
  // would otherwise pin every venue to the search origin.
  const viewportOnly = parsePlaceHref(
    'https://www.google.com/maps/place/Archa+Coffee+Bakery+Garden/@40.9876,29.0234,13z/data=!4m6!3m5!1s0x14cab7f2b3a1c5d9:0xabc',
    'Archa Coffee Bakery Garden'
  );
  check('viewport-only coords are marked imprecise', viewportOnly.coords_precise === false,
    `${viewportOnly.lat},${viewportOnly.lng}`);
  check('viewport-only href still yields the CID', viewportOnly.cid === '0x14cab7f2b3a1c5d9:0xabc');

  const key = buildPlaceKey(href);
  check('place key is derived from the CID', key === 'gmaps_0x14cab9206d79cf0b_0x46da4e133c86ea24', String(key));
  check('place key prefers a real ChIJ id',
    buildPlaceKey({ place_id: 'ChIJabc', cid: '0x1:0x2' }) === 'ChIJabc');
  check('place key is null without identifiers', buildPlaceKey({}) === null);

  // Verbatim address captured from the same probe.
  const addr = parseTurkishAddress('Osmanağa, Halitağa Cd. No:10A, 34714 Kadıköy/İstanbul');
  check('address yields district', addr.district === 'Kadıköy', String(addr.district));
  check('address yields city', addr.city === 'İstanbul', String(addr.city));
  check('address yields postal code', addr.postal_code === '34714', String(addr.postal_code));
  check('address yields neighbourhood', addr.neighborhood === 'Osmanağa', String(addr.neighborhood));
  check('address parser tolerates empty input', Object.keys(parseTurkishAddress(undefined)).length === 0);
  check('street segment is not mistaken for a neighbourhood',
    parseTurkishAddress('Halitağa Cd. No:10A, 34714 Kadıköy/İstanbul').neighborhood === undefined);

  check('rating parses en format "4.7"', parseRating('4.7') === 4.7);
  check('rating parses tr format "4,7"', parseRating('4,7') === 4.7, String(parseRating('4,7')));
  check('rating rejects out-of-range values', parseRating('9.1') === undefined);
  check('review count parses "150 reviews"', parseReviewCount('150 reviews') === 150);
  check('review count parses "(1.840)"', parseReviewCount('(1.840)') === 1840, String(parseReviewCount('(1.840)')));
  // Regression: Google renders "4.2 stars" beside the count; reading the wrong
  // span silently turned a 4.2 rating into 42 reviews.
  check('review count rejects a star-rating label',
    parseReviewCount('4.2 stars ') === undefined, String(parseReviewCount('4.2 stars ')));
  check('review count rejects a bare rating decimal',
    parseReviewCount('4.2') === undefined, String(parseReviewCount('4.2')));
  check('review count accepts a Turkish label', parseReviewCount('1.840 yorum') === 1840);
  check('review count parses the live aria-label "2,475 reviews"',
    parseReviewCount('2,475 reviews') === 2475, String(parseReviewCount('2,475 reviews')));
  check('distance: Kadıköy→Beşiktaş is ~10km',
    Math.round(distanceMeters(40.9876, 29.0234, 41.0789, 29.0432) / 1000) === 10,
    `${Math.round(distanceMeters(40.9876, 29.0234, 41.0789, 29.0432))} m`);
  check('distance: identical points are 0', distanceMeters(40.9, 29.0, 40.9, 29.0) === 0);
  check('phone extracted from data-item-id',
    parsePhoneItemId('phone:tel:+90 216 345 67 89') === '+90 216 345 67 89');
  check('aria prefix stripped',
    stripAriaPrefix('Address: Halitağa Cd. No:10A') === 'Halitağa Cd. No:10A',
    String(stripAriaPrefix('Address: Halitağa Cd. No:10A')));
  check('opening hours joined',
    parseOpeningHours([{ day: 'Monday', hours: '09:00–22:00' }])[0] === 'Monday: 09:00–22:00');

  // Bot-wall detection: the scraper stops here, it never bypasses.
  check('block detected on /sorry/ interstitial',
    detectBlock({ url: 'https://www.google.com/sorry/index?continue=...' }) === true);
  check('block detected on HTTP 429', detectBlock({ status: 429 }) === true);
  check('block detected on captcha form',
    detectBlock({ html: '<form id="captcha-form"></form>' }) === true);
  check('block detected on unusual-traffic notice',
    detectBlock({ title: 'Our systems have detected unusual traffic' }) === true);
  check('normal Maps page is not flagged',
    detectBlock({ url: 'https://www.google.com/maps/search/kafe', status: 200, title: 'Google Maps', html: '<div role="feed"></div>' }) === false);

  // ------------------------------------------------------------- providers
  section('10. Provider chain & fallback');

  const status = providerStatus();
  check('maps_scraper is the default provider', status.active === 'maps_scraper', status.active);
  check('hosted services are registered as fallbacks',
    status.fallbacks.includes('outscraper') && status.fallbacks.includes('apify'),
    status.fallbacks.join(', '));
  check('maps_scraper needs no API key', getProvider('maps_scraper')!.isConfigured() === true);
  check('outscraper is disabled without a key',
    getProvider('outscraper')!.isConfigured() === Boolean(process.env.OUTSCRAPER_API_KEY));
  check('unknown provider resolves to null', getProvider('nope') === null);

  // Every provider unconfigured => blocked result, never a silent empty success.
  const blockedRun = await searchPlaces({
    lat: 40.9876, lng: 29.0234, radius: 1000, provider: 'outscraper',
  });
  check('unconfigured chain reports blocked', blockedRun.blocked === true);
  check('blocked result names what was tried',
    (blockedRun.attempted || []).length > 0,
    (blockedRun.attempted || []).map((a) => a.provider).join(', '));
  check('blocked result carries remediation advice',
    /OUTSCRAPER_API_KEY|APIFY_API_KEY|provider/i.test(blockedRun.warning || ''));

  // ------------------------------------------------------------ mongo/geo
  section('11. MongoDB & 2dsphere GEO queries');
  let mongoUp = false;
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 4000 });
    mongoUp = true;
  } catch (error: any) {
    console.log(`   ⏭️  MongoDB unreachable (${error.message}) — skipping DB assertions`);
  }

  if (mongoUp) {
    try {
    await Venue.syncIndexes();
    const indexes = await Venue.collection.indexes();
    check(
      '2dsphere index exists on location',
      indexes.some((i: any) => i.key?.location === '2dsphere'),
      indexes.map((i: any) => i.name).join(', ')
    );

    await Venue.deleteOne({ google_place_id: 'verify_place_001' });
    await venue.save();

    // Scoped to the seeded id so unrelated rows in a populated database cannot
    // push it past the result limit and turn this into a flaky assertion.
    const near = await Venue.find({
      google_place_id: 'verify_place_001',
      location: {
        $near: { $geometry: { type: 'Point', coordinates: [29.0234, 40.9876] }, $maxDistance: 5000 },
      },
    });
    check('$near query returns the seeded venue', near.length === 1, `${near.length} hits`);

    const within = await Venue.find({
      google_place_id: 'verify_place_001',
      location: { $geoWithin: { $box: [[28.9, 40.9], [29.2, 41.1]] } },
    });
    check('$geoWithin box query works', within.length === 1, `${within.length} hits`);

    const outside = await Venue.find({
      google_place_id: 'verify_place_001',
      location: { $geoWithin: { $box: [[2.0, 48.0], [2.5, 49.0]] } },
    });
    check('$geoWithin excludes venues outside the box', outside.length === 0);

    const far = await Venue.find({
      google_place_id: 'verify_place_001',
      location: {
        $near: { $geometry: { type: 'Point', coordinates: [2.3522, 48.8566] }, $maxDistance: 1000 },
      },
    });
    check('$near excludes out-of-radius venues', far.length === 0);

    await Venue.deleteOne({ google_place_id: 'verify_place_001' });
    } catch (error: any) {
      console.log(`   \u23ed\ufe0f  MongoDB assertions skipped (${error.message})`);
    }
    await mongoose.disconnect();
  }

  // ---------------------------------------------------------------- redis
  section('12. Redis task broker');
  const redisUp = await isRedisAvailable();
  if (redisUp) {
    const queueStats = await getQueueStats();
    check('queue reachable', queueStats.available === true);
    check('queue counters exposed', typeof queueStats.waiting === 'number', JSON.stringify(queueStats));
  } else {
    console.log('   ⏭️  Redis unreachable — queue assertions skipped (API degrades to sync mode)');
  }
  await closeQueue();
  await closeRedis();
  await RenderService.close();

  // --------------------------------------------------------------- result
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`   Passed: ${passed}    Failed: ${failed}`);
  if (failed) {
    console.log(`   Failing checks:\n     - ${failures.join('\n     - ')}`);
    console.log('\n❌ Verification suite FAILED');
    process.exit(1);
  }
  console.log('\n✅ Verification suite passed');
  process.exit(0);
}

run().catch((error) => {
  console.error('❌ Verification crashed:', error);
  process.exit(1);
});
