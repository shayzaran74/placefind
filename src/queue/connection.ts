import IORedis from 'ioredis';
import { config } from '../config';

let connection: IORedis | null = null;
let available: boolean | null = null;

/**
 * Shared Redis connection for the BullMQ task broker (spec §2).
 * BullMQ requires maxRetriesPerRequest: null on the shared connection.
 */
export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(config.redisUri, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });

    connection.on('error', (error) => {
      // Logged once per state change; ioredis retries on its own.
      if (available !== false) {
        console.warn(`[Redis] ${error.message}`);
        available = false;
      }
    });

    connection.on('ready', () => {
      if (available !== true) {
        console.log(`[Redis] Connected to ${config.redisUri}`);
        available = true;
      }
    });
  }

  return connection;
}

/** Probes Redis so the API can degrade to synchronous processing if it is down. */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const redis = getRedisConnection();
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
    await redis.ping();
    available = true;
    return true;
  } catch {
    available = false;
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    await connection.quit().catch(() => undefined);
    connection = null;
  }
}
