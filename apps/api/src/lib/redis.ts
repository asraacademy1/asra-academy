import { once } from 'node:events';
import { Redis } from 'ioredis';
import { DEPENDENCY_CHECK_TIMEOUT_MS } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/** Builds a client with the application's options. Tests use it to get an unconnected client. */
export function createRedisClient(url: string = env.REDIS_URL): Redis {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
  });
}

/**
 * Shared Redis connection. PHASE 01 only verifies connectivity; BullMQ queues, caching and
 * rate-limit stores build on this in later phases.
 *
 * `lazyConnect` keeps the API bootable when Redis is unavailable — Redis is not yet on the
 * critical path, and readiness is reported through `GET /api/v1/health/ready`.
 */
export const redis = createRedisClient();

let lastErrorLoggedAt = 0;
redis.on('error', (error) => {
  // Avoid flooding logs while Redis is down and ioredis keeps retrying.
  const now = Date.now();
  if (now - lastErrorLoggedAt > 30_000) {
    lastErrorLoggedAt = now;
    logger.warn({ err: error }, 'Redis connection error');
  }
});

export async function connectRedis(): Promise<void> {
  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }

    if (redis.status !== 'ready') {
      await once(redis, 'ready', {
        signal: AbortSignal.timeout(DEPENDENCY_CHECK_TIMEOUT_MS),
      });
    }

    logger.info('Redis connected');
  } catch (error) {
    logger.warn(
      { err: error, status: redis.status },
      'Redis unavailable at startup; will keep retrying',
    );
  }
}
/**
 * Proves Redis is reachable, waiting for the connection first if it is not open yet. With the
 * offline queue disabled a command sent before then is refused at once; on Vercel `server.ts`
 * never runs, so a new function instance has no connection when its first request arrives.
 * Rejects if the connection fails or is not ready in time.
 */
export async function pingRedis(client: Redis = redis): Promise<void> {
  if (client.status !== 'ready') {
    const ready = once(client, 'ready', {
      signal: AbortSignal.timeout(DEPENDENCY_CHECK_TIMEOUT_MS),
    });
    if (client.status === 'wait') client.connect().catch(() => undefined);
    await ready;
  }
  await client.ping();
}

export async function disconnectRedis(): Promise<void> {
  if (redis.status === 'end') return;
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
