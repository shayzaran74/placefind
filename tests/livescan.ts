import { ScannerService } from '../src/services/scanner.service';
import { ScraperService } from '../src/services/scraper.service';
import { RenderService } from '../src/services/render.service';

/**
 * Ad-hoc live probe: `npx ts-node tests/livescan.ts <url> [...]`
 * Not part of `npm test` - it depends on third-party sites being reachable.
 */
async function main(): Promise<void> {
  const sites = process.argv.slice(2);
  if (!sites.length) {
    console.log('usage: ts-node tests/livescan.ts <url> [url...]');
    process.exit(1);
  }

  for (const site of sites) {
    console.log(`\n──── ${site}`);
    const scan = await ScannerService.scanWebsite(site);
    console.log('  reachable :', scan.website_reachable, scan.error ? `(${scan.error.slice(0, 70)})` : '');
    console.log('  emails    :', scan.emails.slice(0, 4));
    console.log('  phones    :', scan.phone_numbers.slice(0, 4));
    console.log('  socials   :', scan.social_media);
    console.log('  qr menu   :', scan.has_qr_menu, scan.qr_menu_provider || '-', scan.qr_menu_url || '-');
    console.log('  ordering  :', scan.supports_online_ordering, scan.ordering_channels.map((c) => c.name));

    const menu = await ScraperService.scrapeAndExtractMenu('live-probe', scan.qr_menu_url || site);
    console.log('  menu      :', menu.extraction_method, `${menu.categories.length} categories`,
      `${menu.categories.reduce((s, c) => s + c.items.length, 0)} items`,
      `${menu.images_converted} images`, `${(menu.bytes_saved / 1024).toFixed(1)} KB saved`);
    for (const category of menu.categories.slice(0, 3)) {
      console.log(`     · ${category.name}: ${category.items.slice(0, 3).map((i) => `${i.name} (${i.price})`).join(', ')}`);
    }
  }

  await RenderService.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
