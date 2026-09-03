import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import { ScraperService } from '../src/services/scraper.service';

/**
 * Ad-hoc extraction probe against a saved menu page:
 *   npx ts-node tests/extract.ts [path-to-html] [base-url]
 */
const file = process.argv[2] || path.join(__dirname, 'fixtures/archa-menu.html');
const baseUrl = process.argv[3] || 'https://www.archacoffee.com/menu/';

const $ = cheerio.load(fs.readFileSync(file, 'utf8'));
const cats: any[] = (ScraperService as any).extractFromDom($, baseUrl);

let total = 0;
console.log(`KATEGORİ: ${cats.length}\n`);
for (const c of cats) {
  total += c.items.length;
  console.log(`── ${c.name}  (${c.items.length})`);
  for (const it of c.items.slice(0, 2)) {
    console.log(`     ${it.name}  ₺${it.price}`);
    if (it.description) console.log(`        içindekiler: ${it.description.slice(0, 60)}…`);
    if (it.allergens?.length) console.log(`        alerjen    : ${it.allergens.join(' | ')}`);
    if (it.original_image_url) console.log(`        görsel     : ${it.original_image_url.split('/').pop()}`);
  }
  if (c.items.length > 2) console.log(`     … +${c.items.length - 2} ürün daha`);
}

let d = 0, a = 0, i = 0;
for (const c of cats) for (const it of c.items) {
  if (it.description) d++;
  if (it.allergens?.length) a++;
  if (it.original_image_url) i++;
}
console.log(`\nTOPLAM ÜRÜN: ${total}   içindekiler: ${d}   alerjen: ${a}   görsel: ${i}`);

console.log('\nKategori bazında içindekiler/alerjen kapsamı:');
for (const c of cats) {
  const d = c.items.filter((i: any) => i.description).length;
  const a = c.items.filter((i: any) => i.allergens?.length).length;
  const g = c.items.filter((i: any) => i.original_image_url).length;
  console.log(`  ${c.name.padEnd(20)} ürün=${String(c.items.length).padStart(2)}  içindekiler=${String(d).padStart(2)}  alerjen=${String(a).padStart(2)}  görsel=${String(g).padStart(2)}`);
}
