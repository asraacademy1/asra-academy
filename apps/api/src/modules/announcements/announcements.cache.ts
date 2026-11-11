import crypto from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';
import type { CachedPublicCandidate } from './announcements.lifecycle.js';

const CACHE_TTL_SECONDS = 60;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1_000;
const GENERATION_KEY = 'announcements:cache:gen';
const DATA_KEY_PREFIX = 'announcements:candidates:v';

interface LocalCacheEntry {
  generation: number;
  candidates: CachedPublicCandidate[];
  expiresAt: number;
}

let localGeneration = 1;
let localEntry: LocalCacheEntry | null = null;
const cacheStats = { hits: 0, misses: 0, invalidations: 0 };

async function readGeneration(): Promise<number> {
  if (redis.status !== 'ready') return localGeneration;
  try {
    const raw = await redis.get(GENERATION_KEY);
    if (!raw) return localGeneration;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : localGeneration;
  } catch (error) {
    logger.warn({ err: error }, 'Announcement cache failed to read Redis generation');
    return localGeneration;
  }
}

export async function getCachedAnnouncementCandidates(
  loader: () => Promise<CachedPublicCandidate[]>,
): Promise<CachedPublicCandidate[]> {
  const generation = await readGeneration();
  const nowMs = Date.now();

  if (localEntry && localEntry.generation === generation && nowMs < localEntry.expiresAt) {
    cacheStats.hits += 1;
    return localEntry.candidates;
  }

  if (redis.status === 'ready') {
    try {
      const raw = await redis.get(`${DATA_KEY_PREFIX}${generation}`);
      if (raw) {
        const candidates = JSON.parse(raw) as CachedPublicCandidate[];
        localEntry = { generation, candidates, expiresAt: nowMs + CACHE_TTL_MS };
        cacheStats.hits += 1;
        return candidates;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Announcement cache failed to read Redis entry');
    }
  }

  cacheStats.misses += 1;
  const candidates = await loader();
  const latestGen = await readGeneration();
  localEntry = { generation: latestGen, candidates, expiresAt: Date.now() + CACHE_TTL_MS };

  if (redis.status === 'ready') {
    try {
      await redis.set(
        `${DATA_KEY_PREFIX}${latestGen}`,
        JSON.stringify(candidates),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      logger.warn({ err: error }, 'Announcement cache failed to write Redis entry');
    }
  }

  return candidates;
}

/** Immediately drops process cache and bumps shared Redis generation on admin mutations. */
export async function invalidateAnnouncementCache(): Promise<void> {
  localEntry = null;
  localGeneration += 1;
  cacheStats.invalidations += 1;

  if (redis.status === 'ready') {
    try {
      const nextGen = await redis.incr(GENERATION_KEY);
      if (Number.isFinite(nextGen) && nextGen > localGeneration) {
        localGeneration = nextGen;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Announcement cache failed to bump Redis generation');
    }
  }
}

export function computeAnnouncementEtag(payload: unknown): string {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('base64url')
    .slice(0, 16);
  return `"ann-${hash}"`;
}

export function getAnnouncementCacheStats() {
  return { ...cacheStats, generation: localGeneration, hasLocalEntry: localEntry !== null };
}

export function resetAnnouncementCacheStatsForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetAnnouncementCacheStatsForTests is only available in tests');
  }
  localEntry = null;
  localGeneration += 1;
  cacheStats.hits = 0;
  cacheStats.misses = 0;
  cacheStats.invalidations = 0;
}
