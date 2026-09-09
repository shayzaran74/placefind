import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import sharp from 'sharp';
import { config } from '../config';

export interface IWebPResult {
  /** Public URL of the stored .webp (CDN-prefixed when CDN_BASE_URL is set). */
  url: string;
  /** Absent when conversion failed and the original URL was passed through. */
  filename?: string;
  original_bytes?: number;
  webp_bytes?: number;
  /** Percentage saved by the WebP conversion, e.g. 63.4 */
  savings_percent?: number;
  width?: number;
  height?: number;
  converted: boolean;
}

/**
 * WebP image pipeline (spec §2.2): download -> resize -> WebP -> hashed storage.
 */
export class ImageService {
  private static ensureUploadsDirExists(): void {
    if (!fs.existsSync(config.uploadsDir)) {
      fs.mkdirSync(config.uploadsDir, { recursive: true });
    }
  }

  /** Builds the public URL for a stored file, honouring CDN_BASE_URL. */
  public static publicUrl(filename: string): string {
    const relative = `/uploads/images/${filename}`;
    return config.cdnBaseUrl ? `${config.cdnBaseUrl}${relative}` : relative;
  }

  /**
   * Optimizes CDN image URLs (Yemeksepeti / Delivery Hero, Cloudinary, Next.js, etc.)
   * by removing or upgrading low-resolution / thumbnail transformation parameters.
   */
  public static optimizeUrl(imageUrl: string): string {
    if (!imageUrl || typeof imageUrl !== 'string') return imageUrl;

    let optimized = imageUrl.trim();

    // Next.js _next/image wrapper: extract original target URL if present
    if (optimized.includes('_next/image') && optimized.includes('url=')) {
      try {
        const parsed = new URL(optimized);
        const innerUrl = parsed.searchParams.get('url');
        if (innerUrl) {
          optimized = decodeURIComponent(innerUrl);
        }
      } catch {
        // Fall back to original URL
      }
    }

    // Delivery Hero / Yemeksepeti CDN (images.deliveryhero.io, fd-tr, etc.)
    // Upgrade query parameters: width -> 800, height -> 800, quality -> 90
    if (/deliveryhero|yemeksepeti|foodpanda|pedidosya/i.test(optimized) || optimized.includes('images.deliveryhero.io')) {
      optimized = optimized
        .replace(/([?&])width=\d+/gi, '$1width=800')
        .replace(/([?&])height=\d+/gi, '$1height=800')
        .replace(/([?&])quality=\d+/gi, '$1quality=90');
    } else {
      // General width/height/quality query param upgrades for common CDNs (Cloudinary, Imgix, etc.)
      optimized = optimized
        .replace(/([?&])(w|width)=\d+/gi, '$1$2=800')
        .replace(/([?&])(h|height)=\d+/gi, '$1$2=800')
        .replace(/([?&])(q|quality)=\d+/gi, '$1$2=90');
    }

    // Cloudinary / Delivery Hero path transformations e.g. /w_100,h_100,q_30/ or /w_150/
    optimized = optimized.replace(/\/w_\d+(?:,h_\d+)?(?:,q_\d+)?\//gi, '/w_800,h_800,q_90/');

    return optimized;
  }

  /**
   * Downloads an image, converts it to WebP and stores it under a unique hash
   * name (`img_<hash>.webp`). Returns conversion telemetry alongside the URL.
   */
  public static async convert(imageUrl: string, prefix = 'img'): Promise<IWebPResult> {
    this.ensureUploadsDirExists();

    const targetUrl = this.optimizeUrl(imageUrl);
    const urlHash = crypto.createHash('md5').update(targetUrl).digest('hex');
    const filename = `${prefix}_${urlHash}.webp`;
    const outputPath = path.join(config.uploadsDir, filename);

    try {
      // Idempotent: reuse an already-converted file.
      if (fs.existsSync(outputPath)) {
        const stat = fs.statSync(outputPath);
        const meta = await sharp(outputPath).metadata();
        return {
          url: this.publicUrl(filename),
          filename,
          webp_bytes: stat.size,
          width: meta.width,
          height: meta.height,
          converted: true,
        };
      }

      const response = await axios.get(targetUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 25 * 1024 * 1024,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      const buffer = Buffer.from(response.data);
      const pipeline = sharp(buffer).rotate();
      const metadata = await pipeline.metadata();

      // Downscale oversized source images before encoding (bandwidth win).
      if (metadata.width && metadata.width > config.webpMaxWidth) {
        pipeline.resize({ width: config.webpMaxWidth, withoutEnlargement: true });
      }

      const info = await pipeline.webp({ quality: config.webpQuality, effort: 4 }).toFile(outputPath);

      const savings = buffer.length > 0 ? ((buffer.length - info.size) / buffer.length) * 100 : 0;

      return {
        url: this.publicUrl(filename),
        filename,
        original_bytes: buffer.length,
        webp_bytes: info.size,
        savings_percent: Math.round(savings * 10) / 10,
        width: info.width,
        height: info.height,
        converted: true,
      };
    } catch (error: any) {
      console.warn(`[ImageService] Failed to convert ${imageUrl}: ${error.message}`);
      // Pass the original URL through so the record stays usable.
      return { url: imageUrl, converted: false };
    }
  }

  /** Backwards-compatible helper returning just the URL. */
  public static async processAndConvertToWebP(imageUrl: string, prefix = 'img'): Promise<string> {
    const result = await this.convert(imageUrl, prefix);
    return result.url;
  }

  /** Converts a batch with bounded parallelism (keeps the worker responsive). */
  public static async convertMany(
    images: Array<{ url: string; prefix: string }>,
    concurrency = 4
  ): Promise<IWebPResult[]> {
    const results: IWebPResult[] = new Array(images.length);
    let cursor = 0;

    const workers = Array.from({ length: Math.min(concurrency, images.length) }, async () => {
      while (cursor < images.length) {
        const index = cursor++;
        results[index] = await this.convert(images[index].url, images[index].prefix);
      }
    });

    await Promise.all(workers);
    return results;
  }

  /** Aggregate storage statistics for the pipeline dashboard. */
  public static storageStats(): {
    file_count: number;
    total_bytes: number;
    directory: string;
    writable: boolean;
  } {
    this.ensureUploadsDirExists();
    const files = fs.readdirSync(config.uploadsDir).filter((f) => f.endsWith('.webp'));
    const totalBytes = files.reduce(
      (sum, f) => sum + fs.statSync(path.join(config.uploadsDir, f)).size,
      0
    );

    // A read-only mount makes every conversion fall back to the source URL,
    // which is easy to miss - report it rather than degrading in silence.
    let writable = true;
    try {
      fs.accessSync(config.uploadsDir, fs.constants.W_OK);
    } catch {
      writable = false;
    }

    return { file_count: files.length, total_bytes: totalBytes, directory: config.uploadsDir, writable };
  }
}
