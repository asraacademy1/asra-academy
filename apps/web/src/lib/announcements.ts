import type { ApiResponse, AnnouncementAudience, PublicAnnouncementDto } from '@asra/types';
import { isSafeAnnouncementRedirectUrl } from '@asra/validation';
import { buildApiUrl } from '@/lib/api';

const VISITOR_STORAGE_PREFIX = 'asra:ann:v1:visitor:';
const SESSION_STORAGE_PREFIX = 'asra:ann:v1:session:';

export interface CampaignTracker {
  isModalSuppressed: (campaign: Pick<PublicAnnouncementDto, 'id' | 'frequency'>) => boolean;
  isBannerSuppressed: (campaign: Pick<PublicAnnouncementDto, 'id' | 'frequency'>) => boolean;
  markModalImpression: (campaign: Pick<PublicAnnouncementDto, 'id' | 'frequency'>) => void;
  markDismissed: (campaign: Pick<PublicAnnouncementDto, 'id' | 'frequency'>) => void;
}

function safeStorageGet(storage: Storage | null | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(storage: Storage | null | undefined, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore private-mode / quota errors; in-memory state still prevents duplicate impressions.
  }
}

function defaultStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

/**
 * Campaign-ID-specific impression & dismissal tracker supporting EVERY_VISIT, ONCE_PER_SESSION,
 * and ONCE_PER_VISITOR. Dismissing an older campaign never suppresses a newly created campaign.
 */
export function createCampaignTracker(options?: {
  localStorage?: Storage | null;
  sessionStorage?: Storage | null;
  memoryDismissed?: Set<string>;
  memoryShown?: Set<string>;
}): CampaignTracker {
  const local =
    options && 'localStorage' in options ? options.localStorage : defaultStorage('localStorage');
  const session =
    options && 'sessionStorage' in options
      ? options.sessionStorage
      : defaultStorage('sessionStorage');
  const memoryDismissed = options?.memoryDismissed ?? new Set<string>();
  const memoryShown = options?.memoryShown ?? new Set<string>();

  const hasPersistentFlag = (
    campaign: Pick<PublicAnnouncementDto, 'id' | 'frequency'>,
  ): boolean => {
    if (campaign.frequency === 'ONCE_PER_VISITOR') {
      return safeStorageGet(local, `${VISITOR_STORAGE_PREFIX}${campaign.id}`) === '1';
    }
    if (campaign.frequency === 'ONCE_PER_SESSION') {
      return safeStorageGet(session, `${SESSION_STORAGE_PREFIX}${campaign.id}`) === '1';
    }
    return false;
  };

  const persistFlag = (campaign: Pick<PublicAnnouncementDto, 'id' | 'frequency'>): void => {
    if (campaign.frequency === 'ONCE_PER_VISITOR') {
      safeStorageSet(local, `${VISITOR_STORAGE_PREFIX}${campaign.id}`, '1');
    } else if (campaign.frequency === 'ONCE_PER_SESSION') {
      safeStorageSet(session, `${SESSION_STORAGE_PREFIX}${campaign.id}`, '1');
    }
  };

  return {
    isModalSuppressed(campaign) {
      if (memoryDismissed.has(campaign.id) || memoryShown.has(campaign.id)) return true;
      return hasPersistentFlag(campaign);
    },
    isBannerSuppressed(campaign) {
      if (memoryDismissed.has(campaign.id)) return true;
      return hasPersistentFlag(campaign);
    },
    markModalImpression(campaign) {
      memoryShown.add(campaign.id);
      if (campaign.frequency !== 'EVERY_VISIT') {
        persistFlag(campaign);
      }
    },
    markDismissed(campaign) {
      memoryDismissed.add(campaign.id);
      memoryShown.add(campaign.id);
      persistFlag(campaign);
    },
  };
}

export function isSafeRedirectUrl(url: string | null | undefined): url is string {
  if (typeof url !== 'string') return false;
  return isSafeAnnouncementRedirectUrl(url);
}

export function isExternalRedirectUrl(url: string): boolean {
  return /^https:\/\//i.test(url.trim());
}

export function isCampaignWithinWindow(
  campaign: Pick<PublicAnnouncementDto, 'startsAt' | 'endsAt'>,
  nowMs = Date.now(),
): boolean {
  if (campaign.startsAt) {
    const startsMs = Date.parse(campaign.startsAt);
    if (Number.isNaN(startsMs) || startsMs > nowMs) return false;
  }
  if (campaign.endsAt) {
    const endsMs = Date.parse(campaign.endsAt);
    if (Number.isNaN(endsMs) || endsMs <= nowMs) return false;
  }
  return true;
}

/**
 * Selects the single highest-priority eligible TOP_BANNER and single highest-priority eligible
 * MODAL from server-provided active campaigns, respecting schedule window, frequency tracking,
 * and single-modal-at-a-time constraints.
 */
export function selectActiveCampaigns(
  campaigns: readonly PublicAnnouncementDto[],
  options: {
    nowMs?: number;
    tracker?: CampaignTracker;
    modalAlreadyShownThisVisit?: boolean;
  } = {},
): { banner: PublicAnnouncementDto | null; modal: PublicAnnouncementDto | null } {
  const nowMs = options.nowMs ?? Date.now();
  const tracker = options.tracker ?? createCampaignTracker();
  const eligible = [...campaigns]
    .filter((campaign) => isCampaignWithinWindow(campaign, nowMs))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });

  const banner =
    eligible.find(
      (campaign) => campaign.displayType === 'TOP_BANNER' && !tracker.isBannerSuppressed(campaign),
    ) ?? null;

  const modal = options.modalAlreadyShownThisVisit
    ? null
    : (eligible.find(
        (campaign) => campaign.displayType === 'MODAL' && !tracker.isModalSuppressed(campaign),
      ) ?? null);

  return { banner, modal };
}

const CLIENT_CACHE_TTL_MS = 60_000;
const clientCache = new Map<string, { items: PublicAnnouncementDto[]; expiresAt: number }>();
const inFlightRequests = new Map<string, Promise<PublicAnnouncementDto[]>>();

function normalizeAudienceKey(audiences: readonly AnnouncementAudience[]): string {
  return [...new Set(audiences)].sort().join(',');
}

/**
 * Fetches active campaigns for `audiences` with in-memory request deduplication across SPA
 * navigations and graceful fallback (never throws or blocks website rendering).
 */
export async function fetchActiveAnnouncements(
  audiences: readonly AnnouncementAudience[] = ['PUBLIC_VISITORS'],
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<PublicAnnouncementDto[]> {
  const key = normalizeAudienceKey(audiences);
  const now = Date.now();

  if (!options.forceRefresh) {
    const cached = clientCache.get(key);
    if (cached && now < cached.expiresAt) {
      return cached.items;
    }
    const existing = inFlightRequests.get(key);
    if (existing) {
      return existing;
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const query = key ? `?audiences=${encodeURIComponent(key)}` : '';
  const url = buildApiUrl(`/announcements/active${query}`);

  const request = (async () => {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-cache',
        signal: options.signal ?? AbortSignal.timeout(4_000),
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as ApiResponse<PublicAnnouncementDto[]>;
      const items = payload.success && Array.isArray(payload.data) ? payload.data : [];
      clientCache.set(key, { items, expiresAt: Date.now() + CLIENT_CACHE_TTL_MS });
      return items;
    } catch {
      return [];
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, request);
  return request;
}

export function resetPublicAnnouncementClientCacheForTests(): void {
  clientCache.clear();
  inFlightRequests.clear();
}
