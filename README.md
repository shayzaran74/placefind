# PlaceFind SaaS

Cafe/restoran sektörü için mekan, QR menü ve dijital varlık istihbarat platformu.
Google Places → web sitesi denetimi → menü scraping → WebP dönüşümü → MongoDB →
JSON/XML/CSV dışa aktarım.

İki giriş yolu vardır: **bölge taraması** (Maps'ten keşif) ve **adresle alım**
(`POST /api/v1/venues/ingest`) — elinizdeki QR menü/restoran adreslerinden menüyü
ve mekan künyesini çıkarır. Her iki yol da aynı zenginleştirme hattını kullanır.

Referans doküman: [`SAAS_SPECIFICATION.md`](./SAAS_SPECIFICATION.md)

## Mimari

| Servis | Görev |
| :-- | :-- |
| `app` | Express API + dashboard (port 3000) |
| `worker` | BullMQ worker'ı: Maps keşif taraması + zenginleştirme (Playwright + Chromium, WebP) |
| `mongo` | Doküman deposu, `2dsphere` coğrafi indeks |
| `redis` | Kuyruk broker'ı (BullMQ) |

Tarama isteği geldiğinde API bir **keşif işi** kuyruğa atıp anında döner. Worker
Google Maps'i tarar, bulduğu her mekan için bir **zenginleştirme işi** açar;
o işler siteyi render eder, iletişim/QR menü/sipariş sinyallerini çıkarır,
menüyü ayrıştırır ve görselleri WebP'ye çevirir. Chromium yalnızca worker
imajında bulunur ve 30 sn'lik bir scrape HTTP isteğini bloke etmemelidir —
keşif bu yüzden API'de değil worker'da çalışır.

**Redis kapalıysa API senkron moda düşer** (Chromium gerektiren maps_scraper
hariç); kuyruk bir bağımlılık değil, bir hızlandırıcıdır.

## Veri kaynakları (Google API anahtarı gerekmez)

Mekan verisi çoğullaştırılmış bir sağlayıcı zincirinden gelir
(`src/providers/`). Varsayılan zincir **ücretsizdir**:

| Sağlayıcı | Maliyet | Rol |
| :-- | :-- | :-- |
| `maps_scraper` | **$0** | Varsayılan. Playwright ile Google Maps arayüzünü tarar. |
| `outscraper` | ~$2-4 / 1.000 | Yedek. `OUTSCRAPER_API_KEY` varsa devreye girer. |
| `apify` | ~$2-4 / 1.000 | Yedek. `APIFY_API_KEY` varsa devreye girer. |
| `places_api` | ~$32 / 1.000 | Opsiyonel. `PLACES_PROVIDER=places_api` ile seçilir. |

Zincir sırayla denenir: birincil engellenirse veya hata verirse, anahtarı
tanımlı ilk yedeğe geçilir. Hiçbiri kullanılamıyorsa istek **503** ile döner ve
her sağlayıcının reddedilme gerekçesi `warnings` içinde listelenir — sessizce
boş sonuç dönmez.

### Scraper'ın sınırları

- **CAPTCHA/engel atlatılmaz.** `/sorry/` sayfası, CAPTCHA formu veya HTTP
  429/503 görüldüğünde iş durur, mekan `enrichment.status: "captcha_blocked"`
  olarak işaretlenir ve panelde rozetle gösterilir. Yeniden denenmez.
- **Hız sınırı.** İstekler arası 2-3 sn rastgele bekleme, User-Agent rotasyonu
  ve BullMQ hız sınırı (varsayılan 15 iş/dk). Tek worker ≈ 700-900 mekan/saat.
  Daha yüksek hız için `SCRAPER_CONCURRENCY` veya worker sayısı artırılır.
- **Proxy.** `SCRAPER_PROXY_URL` ile residential proxy üzerinden çalışabilir.
- Google Maps'i scrape etmek Google'ın kullanım şartlarına aykırıdır ve IP
  engeli riski taşır; kaynak seçimi `PLACES_PROVIDER` ile sizindir.

## Adresten menü ve künye çıkarma

Bir QR menünün açılış sayfası neredeyse hiç ürün içermez; kategori kartlarından
oluşur ve fiyatlar bölüm sayfalarındadır. Bu yüzden `MenuCrawlerService` giriş
sayfasındaki bölüm bağlantılarını puanlayarak bulur ve **bir tık derinliğe**
kadar gezer (ürün detay sayfaları bilerek atlanır: bölüm sayfasındaki veriyi
tekrarlarlar). Her sayfa aynı iki geçişli çıkarımdan geçer (JSON-LD → DOM) ve
sonuçlar kategori/ürün bazında birleştirilir.

`SiteProfileService` aynı sayfalardan mekanın kendi künyesini okur — Maps'in
bilmediği alanlar dâhil:

| Alan | Kaynak |
| :-- | :-- |
| Ad | JSON-LD → footer künye bloğu → `twitter:title` (platform adı ayıklanır) |
| Adres | JSON-LD `PostalAddress` → footer/`[class*=address]` bloğu |
| Konum | "Yol tarifi" bağlantıları (Google/Yandex/Apple/OSM), harita iframe'i, JSON-LD `geo` |
| Çalışma saatleri | JSON-LD `openingHoursSpecification` → basılı gün+saat satırları |
| Ödeme yöntemleri | Yemek kartı logoları (Sodexo, Multinet, SetCard, Edenred, Metropol…) |
| Diller | `hreflang`, dil değiştirici, `html[lang]` |
| Logo / kapak | `.logo img`, header arka planı, `og:image` |

Sağlayıcıdan gelen veri her zaman önceliklidir; sayfa yalnızca **boş alanları**
doldurur. Sayfanın söylemediği hiçbir alan uydurulmaz — konum bulunamazsa kayıt
`[0, 0]`'a değil, **konumsuz** yazılır (2dsphere indeksi sparse'tır).

```bash
# Tek adres
curl -X POST http://localhost:3000/api/v1/venues/ingest \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://menu.barispide1998.com/"}'

# Toplu (en fazla 25), senkron çalıştır
curl -X POST http://localhost:3000/api/v1/venues/ingest \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://a.example/menu","b.example"],"async":false}'
```

Gövde alanları: `url` \| `urls`, `name`, `lat`+`lng` (yalnız tek adreste),
`max_pages`, `force`, `include_photos`, `async`. Kayıtlar
`data_source: "web_menu"` ile işaretlenir ve `?source=web_menu` ile filtrelenir.

Panelden de kullanılabilir: **"Adresten Menü ve Künye Çıkarma"** kutusuna
adresleri alt alta yapıştırmak yeterlidir.

Yerel bir sonda:

```bash
npx ts-node tests/livemenu.ts https://menu.barispide1998.com/
```

### Crawler'ın sınırları

- **robots.txt'e uyar** (`MENU_CRAWL_RESPECT_ROBOTS=true`); `User-agent: *`
  grubu okunur, en uzun eşleşen kural kazanır.
- Derinlik 1'dir: giriş sayfası + bölüm sayfaları. Bir bölümün içindeki ürün
  bağlantıları elenir.
- Sayfa bütçesi `MENU_CRAWL_MAX_PAGES` (varsayılan 20), sayfalar arası
  `MENU_CRAWL_DELAY_MS` (varsayılan 400 ms) beklenir.
- PDF menüler ayrıştırılmaz; sayfa erişilemezse o bölüm atlanır ve gerekçe
  `menu.warning` içinde raporlanır — eksik menü sessizce tam gösterilmez.

## Çalıştırma

```bash
cp .env.example .env          # GOOGLE_PLACES_API_KEY'i doldurun
docker compose up -d --build  # app + worker + mongo + redis
open http://localhost:3000
```

Varsayılan kurulumda **hiçbir API anahtarı gerekmez** — `maps_scraper` devreye
girer. `GOOGLE_PLACES_API_KEY` yalnızca `PLACES_PROVIDER=places_api` seçilirse
gerekir; anahtar yoksa o sağlayıcı örnek veri döndürür ve kayıtlar
`data_source: "mock"` ile işaretlenir (`ALLOW_MOCK_DATA=false` ile kapatılır).

Yerel geliştirme:

```bash
npm install
npm run dev          # API (ts-node-dev)
npm run dev:worker   # scraper worker
npm test             # doğrulama paketi (171 kontrol, ağ gerektirmez)
```

Üç opt-in canlı sonda (ağ erişimi gerektirdikleri için `npm test` dışında):

```bash
npx ts-node tests/livescan.ts https://ornek-restoran.com   # site denetimi
npx ts-node tests/livemaps.ts "Kadıköy kafe" 40.9876 29.0234 2000 5
npx ts-node tests/livemenu.ts https://menu.barispide1998.com/  # adresten alım
```

## API

| Endpoint | Açıklama |
| :-- | :-- |
| `POST /api/v1/venues/search` | GEO veya metin taraması; zenginleştirmeyi kuyruğa alır |
| `POST /api/v1/venues/ingest` | Verilen adreslerden mekan alımı; menüyü gezer, siteyi denetler |
| `GET /api/v1/venues` | Filtreli, sayfalı liste |
| `GET /api/v1/venues/nearby` | `$near` yarıçap sorgusu (2dsphere) |
| `POST /api/v1/venues/within` | `$geoWithin` bbox/polygon sorgusu |
| `GET /api/v1/venues/stats` | Pazar ve pipeline istatistikleri |
| `GET /api/v1/venues/export` | Toplu dışa aktarım (`json` \| `xml` \| `csv`) |
| `GET /api/v1/venues/jobs/:jobId` | Kuyruk işi durumu |
| `GET /api/v1/venues/:id` | Tek mekan |
| `GET /api/v1/venues/:id/export` | Tek mekan dışa aktarımı |
| `POST /api/v1/venues/:id/refresh` | Pipeline'ı yeniden çalıştır |
| `DELETE /api/v1/venues/:id` | Mekanı sil |
| `GET /health` | Mongo/Redis/Places/kuyruk/pipeline durumu |

Filtre parametreleri (`list` ve `export` ortak): `q`, `city`, `district`, `type`,
`provider` (QR menü platformu), `provider_name` (veri sağlayıcı), `source`
(`web_menu` = adresten alınan),
`status`, `has_qr_menu`, `has_website`, `has_email`,
`supports_online_ordering`, `min_rating`, `sort`, `order`, `page`, `limit`.

`POST /search` gövdesi: `lat`, `lng`, `radius`, `keyword`, `query`, `city`,
`provider`, `max_results`, `async`, `force`, `include_photos`.

Örnekler:

```bash
# 3 km yarıçapta QR menüsü olan mekanlar
curl "http://localhost:3000/api/v1/venues/nearby?lat=40.9876&lng=29.0234&radius=3000&has_qr_menu=true"

# Poligon içindeki mekanlar
curl -X POST http://localhost:3000/api/v1/venues/within \
  -H 'Content-Type: application/json' \
  -d '{"polygon":[[29.0,40.97],[29.05,40.97],[29.05,41.0],[29.0,41.0]]}'

# E-postası olan İstanbul mekanlarını CSV olarak dışa aktar
curl "http://localhost:3000/api/v1/venues/export?format=csv&city=İstanbul&has_email=true" -o leads.csv
```

## Veri sağlayıcılığı (provenance)

Platform bir veri istihbarat ürünü olduğu için **veri uydurmaz**:

- Her kayıt `data_source` (`google_places` \| `maps_scraper` \| `web_menu` \|
  `mock` \| `manual`) taşır.
- Erişilemeyen siteler `enrichment.error` ile raporlanır; sahte e-posta/telefon üretilmez.
- Menü çıkarım yöntemi `menu.extraction_method` alanında saklanır
  (`schema_org` \| `playwright` \| `static_html` \| `sample` \| `none`).
- Örnek menü **yalnızca örnek mekanlara** eklenir; gerçek bir sağlayıcıdan gelen
  mekan menüsü bulunamazsa `none` kalır, uydurulmaz.
- Sağlayıcı zinciri engellendiğinde 503 döner; sessizce boş sonuç dönmez.
- Telefonlar E.164'e normalize edilir; geçersiz rakam dizileri atılır.

## Ortam değişkenleri

Tam liste için `.env.example`. Öne çıkanlar:

| Değişken | Varsayılan | Açıklama |
| :-- | :-- | :-- |
| `WEBP_QUALITY` | `85` | WebP sıkıştırma kalitesi |
| `WEBP_MAX_WIDTH` | `1200` | Kodlamadan önce küçültme genişliği |
| `CDN_BASE_URL` | — | `.webp` yollarına eklenen genel origin |
| `ALLOW_MOCK_DATA` | `true` | API anahtarı yokken örnek veri döndür |
| `SCRAPER_CONCURRENCY` | `2` | Worker başına eşzamanlı iş |
| `PLAYWRIGHT_ENABLED` | `true` | JS render; kapalıysa statik fetch |
| `PLAYWRIGHT_WS_ENDPOINT` | — | Uzak tarayıcı (ör. browserless) |
| `RATE_LIMIT_MAX` | `120` | `/api` için dakikalık istek limiti |
| `PLACES_PROVIDER` | `maps_scraper` | Birincil veri kaynağı |
| `PLACES_FALLBACK_PROVIDERS` | `outscraper,apify` | Engel durumunda sırayla denenir |
| `MAPS_LOCALE` | `en` | Maps arayüz dili; `en` ayrıştırmayı stabil tutar |
| `SCRAPER_MIN/MAX_DELAY_MS` | `2000`/`3000` | İstekler arası rastgele bekleme |
| `SCRAPER_MAX_SCROLLS` | `15` | Sonuç listesinde maksimum kaydırma |
| `SCRAPER_PROXY_URL` | — | Residential proxy (IP rotasyonu) |
| `SCRAPER_RATE_LIMIT_MAX` | `15` | Worker'ın dakikalık iş limiti |
| `MENU_CRAWL_ENABLED` | `true` | Menü bölüm sayfalarını da gez |
| `MENU_CRAWL_MAX_PAGES` | `20` | Mekan başına sayfa bütçesi |
| `MENU_CRAWL_DELAY_MS` | `400` | Aynı site içinde sayfalar arası bekleme |
| `MENU_CRAWL_RESPECT_ROBOTS` | `true` | Hedef sitenin robots.txt'ine uy |

## Zenginleştirilmiş alanlar (şartname üstü, opsiyonel)

`SAAS_SPECIFICATION.md` şeması korunur; scraper'ın getirdiği ek veriler
opsiyonel alanlar olarak eklenir ve JSON/XML/CSV çıktılarına yansır:
`categories`, `opening_hours.weekday_text`, `plus_code`, `address.postal_code`,
`source_ids` (Maps CID / entity id), `provider`, `payment_methods`, `languages`,
`menu.pages_crawled`, `menu.source_pages`.

`location` opsiyoneldir: hiçbir kaynak konumu belirtmiyorsa alan yazılmaz.
