# PlaceFind SaaS - Akıllı Mekan, QR Menü & Veri Entegrasyon Platformu
## Sistem Mimarisi ve Teknik Şartname Dokümanı (PRD) - v1.1.0

---

## 1. Proje Özeti ve Vizyon

**PlaceFind SaaS**, cafe, restoran ve yeme-içme sektöründeki işletmelerin dijital varlıklarını (Google Places verileri, web siteleri, QR menü kullanımı, iletişim bilgileri, sipariş sistemleri ve menü içerikleri) coğrafi (GEO) ve bölgesel bazda tespit eden, toplayan, analiz eden ve yapılandırılmış **JSON/XML** formatlarına dönüştüren uçtan uca yüksek performanslı bir veri istihbarat platformudur.

### Güncellenmiş Mimari Prensipler (Kullanıcı İsterleri)
- **Gea Framework & Yüksek Hız:** Derleme ve çalışma zamanı performansı optimize edilmiş, ultra hızlı ve düşük gecikmeli (low-latency) mimari.
- **Docker Konteynerizasyonu:** Tüm servislerin (API, Worker, MongoDB, Redis, WebP Converter) Docker & Docker Compose ile izole ve taşınabilir mimaride çalıştırılması.
- **MongoDB Veritabanı:** Menülerin esnek, hiyerarşik (Kategori -> Ürün -> Opsiyon) ve dinamik doküman yapısına %100 uyumlu NoSQL veri katmanı.
- **WebP Görsel Dönüştürme Boru Hattı (Image Pipeline):** Çekilen tüm menü, ürün ve mekan fotoğraflarının otomatik olarak **.webp** formatına dönüştürülerek depolanması (Boyut optimizasyonu & hızlı yükleme).

---

## 2. Sistem Mimarisi ve Docker Konteyner Yapısı

```
  +-----------------------------------------------------------------------------------+
  |                                   DOCKER NETWORK                                  |
  |                                                                                   |
  |   +-------------------+       +--------------------+      +-------------------+   |
  |   |   Gea Framework   |------>|   MongoDB (NoSQL)  |----->|   Redis Queue     |   |
  |   |   App Container   |       |   Document Store   |      |   (Task Broker)   |   |
  |   +---------+---------+       +--------------------+      +---------+---------+   |
  |             |                                                       |             |
  |             v                                                       v             |
  |   +-------------------+                                   +-------------------+   |
  |   | WebP Converter    |                                   |  Scraper Workers  |   |
  |   | (Sharp / Pillow)  |                                   |  (Playwright)     |   |
  |   +-------------------+                                   +-------------------+   |
  +-----------------------------------------------------------------------------------+
```

### 2.1. MongoDB Doküman Modeli Avantajları
1. **Esnek Menü Yapısı:** Her restoranın menü yapısı farklıdır (opsiyonlar, gramajlar, porsiyonlar, alerjenler). MongoDB'nin BSON/JSON yapısı SQL tablolarındaki karmaşık `JOIN` işlemlerini ortadan kaldırarak menü okuma ve yazma hızını 10 katına çıkarır.
2. **Coğrafi Indeksleme (2dsphere Index):** MongoDB'nin yerleşik `2dsphere` indeksi sayesinde Google Places'tan gelen enlem ve boylam (lat/lng) bilgileri üzerinde instant `$near`, `$geoWithin` coğrafi alan sorguları yapılabilir.

### 2.2. WebP Görsel İşleme ve Depolama Boru Hattı
- **Otomatik Dönüştürme:** Scraper veya Google Places üzerinden çekilen tüm görseller (JPG, PNG, HEIC) işleme boru hattına sokulur.
- **WebP Sıkıştırma:** Görseller %80-85 kalite oranıyla WebP formatına çevrilir. Bu işlem görsel kalitesinden ödün vermeden **%40 ila %70 boyut tasarrufu** sağlar.
- **CDN / S3 Uyumlu Depolama:** Dönüştürülen `.webp` dosyaları benzersiz hash isimleriyle (`img_98231_item_201.webp`) depolanır.

---

## 3. Veri Şemaları (MongoDB & Dışa Aktarım Formatları)

### 3.1. MongoDB Collection Yapısı (`venues` koleksiyonu)

```json
{
  "_id": { "$oid": "66d24a1b9e8a7f123456789a" },
  "google_place_id": "ChIJN1tL-r8zxokR0GJgptSuGQw",
  "name": "Örnek Lezzet Cafe & Restoran",
  "primary_type": "cafe_restaurant",
  "location": {
    "type": "Point",
    "coordinates": [29.023456, 40.987654]
  },
  "address": {
    "formatted": "Caferağa Mah. Moda Cad. No:12, Kadıköy, İstanbul",
    "country": "Turkey",
    "city": "Istanbul",
    "district": "Kadikoy"
  },
  "contacts": {
    "phone_numbers": ["+902161234567"],
    "emails": ["info@orneklezzet.com"],
    "website_url": "https://www.orneklezzet.com",
    "social_media": {
      "instagram": "https://instagram.com/orneklezzet"
    }
  },
  "digital_presence": {
    "has_website": true,
    "has_qr_menu": true,
    "qr_menu_provider": "FineDine",
    "qr_menu_url": "https://menu.finedine.co/orneklezzet",
    "supports_online_ordering": true
  },
  "menu": {
    "currency": "TRY",
    "updated_at": { "$date": "2026-08-31T00:20:00Z" },
    "categories": [
      {
        "category_id": "cat_01",
        "name": "Kahveler",
        "items": [
          {
            "item_id": "item_201",
            "name": "Iced Americano",
            "description": "Çift shot espresso ve soğuk su.",
            "price": 110.00,
            "original_image_url": "https://images.orneklezzet.com/americano.jpg",
            "webp_image_url": "https://cdn.placefind.io/images/venues/98231/item_201.webp",
            "is_available": true
          }
        ]
      }
    ]
  }
}
```

### 3.2. Standart XML Çıktı Şeması (`venue_export.xml`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<placefind_export generated_at="2026-08-31T00:20:00Z">
  <venue id="66d24a1b9e8a7f123456789a">
    <google_place_id>ChIJN1tL-r8zxokR0GJgptSuGQw</google_place_id>
    <name>Örnek Lezzet Cafe &amp; Restoran</name>
    <location lat="40.987654" lng="29.023456">
      <city>Istanbul</city>
      <district>Kadikoy</district>
    </location>
    <contacts>
      <email>info@orneklezzet.com</email>
      <phone>+902161234567</phone>
      <website>https://www.orneklezzet.com</website>
    </contacts>
    <digital_presence>
      <has_qr_menu>true</has_qr_menu>
      <qr_provider>FineDine</qr_provider>
    </digital_presence>
    <menu currency="TRY">
      <category name="Kahveler">
        <item id="item_201">
          <name>Iced Americano</name>
          <price>110.00</price>
          <image_webp>https://cdn.placefind.io/images/venues/98231/item_201.webp</image_webp>
        </item>
      </category>
    </menu>
  </venue>
</placefind_export>
```

---

## 4. Docker & Ortam Yapılandırması (`docker-compose.yml` Örneği Şablonu)

```yaml
version: '3.8'

services:
  app:
    build: .
    container_name: placefind_app
    ports:
      - "3000:3000"
    environment:
      - MONGO_URI=mongodb://mongo:27017/placefind_db
      - REDIS_URI=redis://redis:6379
      - WEBP_QUALITY=85
    depends_on:
      - mongo
      - redis

  mongo:
    image: mongo:7.0
    container_name: placefind_mongo
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db

  redis:
    image: redis:7.2-alpine
    container_name: placefind_redis
    ports:
      - "6379:6379"

volumes:
  mongo_data:
```

---

## 5. Değerlendirme & Sonuç

| İster / Özellik | Uygunluk | Açıklama |
| :--- | :---: | :--- |
| **Gea Framework** | ✅ Mükemmel | Derleme odaklı, ultra hızlı ve düşük kaynak tüketimli mikroservis mimarisi sağlar. |
| **MongoDB Kullanımı** | ✅ Mükemmel | Esnek NoSQL yapısı sayesinde dinamik menüler ve `2dsphere` ile coğrafi GEO aramaları için en ideal veritabanıdır. |
| **Docker Yapısı** | ✅ Mükemmel | Veritabanı, scraper worker'ları ve imaj dönüştürücü servislerin tek komutla (`docker compose up`) canlıya alınmasını sağlar. |
| **WebP Görsel Formatı** | ✅ Mükemmel | Sayfa yükleme sürelerini hızlandırır, bant genişliği maliyetlerini %60'a varan oranda düşürür. |

---
*Doküman Güncellenme Tarihi: 31 Ağustos 2026*
*Versiyon: v1.1.0-PRD*
