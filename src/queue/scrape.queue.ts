import { Queue, QueueEvents, JobsOptions } from 'bullmq';
import { getRedisConnection, isRedisAvailable } from './connection';
import { IGooglePlaceRaw } from '../services/googlePlaces.service';
import { DataSource } from '../models/Venue';

// BullMQ v6 rejects ':' in queue names; the namespace goes in `prefix`.
export const SCRAPE_QUEUE_NAME = 'scrape';
export const QUEUE_PREFIX = 'placefind';

export const JOB_ENRICH = 'enrich-venue';
export const JOB_DISCOVER = 'discover-venues';

export interface IEnrichJobData {
  place: IGooglePlaceRaw;
  source: DataSource;
  /** Provider that produced the row; drives details/photo handling downstream. */
  provider?: string;
  force?: boolean;
  includePhotos?: boolean;
  maxPhotos?: number;
  /** URL ingestion: let the scanned page name the venue. */
  preferScannedName?: boolean;
  /** Page budget for the menu crawler. */
  maxMenuPages?: number;
}

/**
 * Discovery runs in the worker rather than the API: only the worker image ships
 * Chromium, and a 30s Maps scrape must never block an HTTP request.
 */
export interface IDiscoverJobData {
  lat: number;
  lng: number;
  radius: number;
  keyword?: string;
  query?: string;
  maxResults?: number;
  provider?: string;
  force?: boolean;
  includePhotos?: boolean;
}

export type IScrapeJobData = IEnrichJobData | IDiscoverJobData;

export function isDiscoverJob(data: IScrapeJobData): data is IDiscoverJobData {
  return !('place' in data);
}

let queue: Queue<IScrapeJobData> | null = null;
let queueEvents: QueueEvents | null = null;

export function getScrapeQueue(): Queue<IScrapeJobData> {
  if (!queue) {
    queue = new Queue<IScrapeJobData>(SCRAPE_QUEUE_NAME, {
      connection: getRedisConnection(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86400, count: 500 },
      },
    });
  }
  return queue;
}

export function getScrapeQueueEvents(): QueueEvents {
  if (!queueEvents) {
    queueEvents = new QueueEvents(SCRAPE_QUEUE_NAME, {
      connection: getRedisConnection(),
      prefix: QUEUE_PREFIX,
    });
  }
  return queueEvents;
}

/** Enqueues one venue enrichment job, de-duplicated by place_id. */
export async function enqueueScrape(
  data: IEnrichJobData,
  options: JobsOptions = {}
): Promise<string | null> {
  if (!(await isRedisAvailable())) return null;

  // BullMQ forbids ':' in custom job ids, so sanitise the place id.
  const safeId = data.place.place_id.replace(/[^A-Za-z0-9_-]/g, '_');
  const job = await getScrapeQueue().add(JOB_ENRICH, data, {
    jobId: data.force ? `${safeId}-${Date.now()}` : safeId,
    ...options,
  });
  return job.id ?? null;
}

/** Enqueues a Maps discovery scan; the worker fans out enrichment jobs itself. */
export async function enqueueDiscovery(
  data: IDiscoverJobData,
  options: JobsOptions = {}
): Promise<string | null> {
  if (!(await isRedisAvailable())) return null;

  const job = await getScrapeQueue().add(JOB_DISCOVER, data, {
    jobId: `discover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    // Discovery is a browser session, not a retryable HTTP call.
    attempts: 1,
    ...options,
  });
  return job.id ?? null;
}

export async function getQueueStats(): Promise<{
  available: boolean;
  waiting?: number;
  active?: number;
  completed?: number;
  failed?: number;
  delayed?: number;
}> {
  if (!(await isRedisAvailable())) return { available: false };

  const counts = await getScrapeQueue().getJobCounts(
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed'
  );
  return { available: true, ...counts };
}

export async function closeQueue(): Promise<void> {
  await queueEvents?.close().catch(() => undefined);
  await queue?.close().catch(() => undefined);
  queue = null;
  queueEvents = null;
}
