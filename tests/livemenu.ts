import { ScannerService } from '../src/services/scanner.service';
import { ScraperService } from '../src/services/scraper.service';
import { MenuCrawlerService } from '../src/services/menuCrawler.service';
import { RenderService } from '../src/services/render.service';

/**
 * Live probe for URL ingestion:
 *   npx ts-node tests/livemenu.ts <url> [url...]
 *
 * Runs exactly what POST /api/v1/venues/ingest runs - site audit, profile
 * extraction, menu crawl - and prints what would be stored. Not part of
 * `npm test`: it needs the third-party site to be reachable.
 */
async function main(): Promise<void> {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.log('usage: ts-node tests/livemenu.ts <url> [url...]');
    process.exit(1);
  }

  for (const url of urls) {
    console.log(`\n════ ${url}`);

    const scan = await ScannerService.scanWebsite(url);
    if (scan.error) console.log('  HATA      :', scan.error);

    const profile = scan.profile;
    console.log('  ad        :', profile?.name || '-');
    console.log('  adres     :', profile?.address || '-');
    console.log(
      '  konum     :',
      profile?.coordinates ? `${profile.coordinates.lat}, ${profile.coordinates.lng}` : '-'
    );
    console.log('  telefon   :', scan.phone_numbers.join(', ') || '-');
    console.log('  e-posta   :', scan.emails.join(', ') || '-');
    console.log('  sosyal    :', Object.values(scan.social_media).join(', ') || '-');
    console.log('  saatler   :', profile?.opening_hours?.join(' | ') || '-');
    console.log('  ödeme     :', profile?.payment_methods?.join(', ') || '-');
    console.log('  diller    :', profile?.languages?.join(', ') || '-');
    console.log('  görseller :', profile?.images.length || 0);
    console.log('  QR menü   :', scan.qr_menu_provider || '-', scan.qr_menu_url || '-');
    console.log('  sipariş   :', scan.ordering_channels.map((c) => c.name).join(', ') || '-');

    const entry = scan.qr_menu_url || url;
    const crawl = await MenuCrawlerService.crawl(entry);
    console.log(`\n  gezilen sayfa: ${crawl.pages.length} (bulunan bölüm: ${crawl.discovered})`);
    for (const warning of crawl.warnings) console.log(`    ! ${warning}`);

    const menu = await ScraperService.scrapeAndExtractMenu('live-probe', entry, false);
    const items = menu.categories.reduce((sum, category) => sum + category.items.length, 0);
    console.log(
      `  menü      : ${menu.extraction_method}, ${menu.categories.length} kategori, ` +
        `${items} ürün, ${menu.images_converted} görsel WebP, ` +
        `${(menu.bytes_saved / 1024).toFixed(1)} KB tasarruf`
    );
    if (menu.warning) console.log(`    ! ${menu.warning}`);

    for (const category of menu.categories) {
      console.log(`   ── ${category.name} (${category.items.length})`);
      for (const item of category.items.slice(0, 3)) {
        const description = item.description ? ` — ${item.description.slice(0, 50)}…` : '';
        console.log(`        ${item.name}  ${item.price} ${item.currency}${description}`);
      }
    }
  }

  await RenderService.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
