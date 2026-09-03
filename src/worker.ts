import mongoose from 'mongoose';
import { Worker, Job } from 'bullmq';
import { config } from './config';
import { getRedisConnection } from './queue/connection';
import {
  SCRAPE_QUEUE_NAME,
  QUEUE_PREFIX,
  IScrapeJobData,
  IEnrichJobData,
  IDiscoverJobData,
  isDiscoverJob,
  enqueueScrape,
} from './queue/scrape.queue';
import { searchPlaces } from './providers';
import { EnrichmentService } from './services/enrichment.service';
import { RenderService } from './services/render.service';
import { ProviderBlockedError } from './providers/types';
import { UnrecoverableError } from 'bullmq';
import { Venue } from './models/Venue';

/**
 * Scraper worker process (spec §2 - "Scraper Workers / Playwright").
 * Runs as its own container so scraping never blocks the API event loop.
 */
async function bootstrap(): Promise<void> {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  console.log(`[Worker] MongoDB connected (${config.mongoUri})`);

  /**
   * Discovery: scrape the provider chain for places, then fan out one
   * enrichment job per venue. Runs here because only this image ships Chromium.
   */
  async function runDiscovery(job: Job, data: IDiscoverJobData): Promise<unknown> {
    console.log(
      `[Worker] Job ${job.id}: discovering places near ${data.lat},${data.lng} (r=${data.radius}m)`
    );

    const result = await searchPlaces({
      lat: data.lat,
      lng: data.lng,
      radius: data.radius,
      keyword: data.keyword,
      query: data.query,
      maxResults: data.maxResults,
      provider: data.provider,
    });

    if (result.blocked) {
      // No provider could serve the scan; surface it instead of retrying blindly.
      throw new UnrecoverableError(result.warning || 'All place providers were unavailable.');
    }

    const jobIds: string[] = [];
    for (const place of result.places) {
      const id = await enqueueScrape({
        place,
        source: result.source,
        provider: result.provider,
        force: data.force,
        includePhotos: data.includePhotos,
      });
      if (id) jobIds.push(id);
    }

    console.log(
      `[Worker] Job ${job.id} discovered ${result.places.length} places via ${result.provider}, ` +
        `queued ${jobIds.length} enrichment jobs.`
    );

    return {
      provider: result.provider,
      source: result.source,
      discovered: result.places.length,
      queued: jobIds.length,
      job_ids: jobIds,
      warning: result.warning,
    };
  }

  async function runEnrichment(job: Job, data: IEnrichJobData): Promise<unknown> {
      const { place, source, provider, force, includePhotos, maxPhotos, preferScannedName, maxMenuPages } =
        data;
      console.log(`[Worker] Job ${job.id}: enriching "${place.name}"`);

      await Venue.updateOne(
        { google_place_id: place.place_id },
        { $set: { 'enrichment.status': 'processing', 'enrichment.last_job_id': job.id } }
      );

      let report;
      try {
        report = await EnrichmentService.enrichPlace(place, source, {
          provider,
          force,
          includePhotos,
          maxPhotos,
          preferScannedName,
          maxMenuPages,
        });
      } catch (error: any) {
        if (error instanceof ProviderBlockedError) {
          // A bot wall will not clear on retry - record it and stop.
          await Venue.updateOne(
            { google_place_id: place.place_id },
            {
              $set: {
                'enrichment.status': 'captcha_blocked',
                'enrichment.error': error.message,
                'enrichment.last_run_at': new Date(),
              },
            }
          );
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }

      console.log(
        `[Worker] Job ${job.id} done: ${report.name} ` +
          `(${report.extraction_method}, ${report.pages_crawled ?? 1} page(s), ` +
          `${report.images_converted} images, ${(report.bytes_saved / 1024).toFixed(1)} KB saved)`
      );
      return report;
  }

  const worker = new Worker<IScrapeJobData>(
    SCRAPE_QUEUE_NAME,
    async (job: Job<IScrapeJobData>) =>
      isDiscoverJob(job.data) ? runDiscovery(job, job.data) : runEnrichment(job, job.data),
    {
      connection: getRedisConnection(),
      prefix: QUEUE_PREFIX,
      concurrency: config.scraperConcurrency,
      // Throughput cap keeps scraping paced enough to avoid IP bans.
      limiter: {
        max: config.scraperRateLimitMax,
        duration: config.scraperRateLimitDurationMs,
      },
    }
  );

  worker.on('failed', async (job, error) => {
    console.error(`[Worker] Job ${job?.id} failed: ${error.message}`);
    if (job?.data && !isDiscoverJob(job.data) && job.data.place?.place_id) {
      await Venue.updateOne(
        // Preserve a captcha_blocked verdict already written by the handler.
        {
          google_place_id: (job.data as IEnrichJobData).place.place_id,
          'enrichment.status': { $ne: 'captcha_blocked' },
        },
        { $set: { 'enrichment.status': 'failed', 'enrichment.error': error.message } }
      ).catch(() => undefined);
    }
  });

  console.log(
    `[Worker] Listening on "${SCRAPE_QUEUE_NAME}" (concurrency=${config.scraperConcurrency}, ` +
      `provider=${config.placesProvider}, rate=${config.scraperRateLimitMax}/${
        config.scraperRateLimitDurationMs / 1000
      }s, playwright=${config.playwrightEnabled ? 'enabled' : 'disabled'})`
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[Worker] ${signal} received, draining...`);
    await worker.close();
    await RenderService.close();
    await mongoose.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error(`[Worker] Bootstrap failed: ${error.message}`);
  process.exit(1);
});
