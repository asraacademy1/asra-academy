import type {
  AnnouncementAudience,
  AnnouncementDisplayType,
  AnnouncementFrequency,
  AnnouncementStatus,
} from '@asra/types';
import type { PublicActiveAnnouncementsQuery } from '@asra/validation';

export interface AnnouncementScheduleState {
  status: AnnouncementStatus;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
}

export interface AnnouncementSortTarget {
  id: string;
  priority: number;
  publishedAt: Date | string | null;
  createdAt: Date | string;
}

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * Resolves the authoritative effective status of a campaign at server instant `now`,
 * handling scheduled activation (`startsAt <= now`) and automatic expiration (`endsAt <= now`)
 * without needing a background worker.
 */
export function resolveEffectiveAnnouncementStatus(
  row: AnnouncementScheduleState,
  now: Date,
): AnnouncementStatus {
  if (
    row.status === 'DRAFT' ||
    row.status === 'PAUSED' ||
    row.status === 'ARCHIVED' ||
    row.status === 'EXPIRED'
  ) {
    return row.status;
  }

  const nowMs = now.getTime();
  const startsMs = toTimestamp(row.startsAt);
  const endsMs = toTimestamp(row.endsAt);

  if (endsMs !== null && endsMs <= nowMs) {
    return 'EXPIRED';
  }
  if (startsMs !== null && startsMs > nowMs) {
    return 'SCHEDULED';
  }
  return 'PUBLISHED';
}

/**
 * True iff a campaign is eligible to appear publicly at server instant `now`.
 * Half-open schedule window `[startsAt, endsAt)`: active from `startsAt` (inclusive) until
 * `endsAt` (exclusive). Draft, paused, expired and archived campaigns never qualify.
 */
export function isAnnouncementPubliclyEligible(row: AnnouncementScheduleState, now: Date): boolean {
  if (row.status !== 'PUBLISHED' && row.status !== 'SCHEDULED') {
    return false;
  }
  const nowMs = now.getTime();
  const startsMs = toTimestamp(row.startsAt);
  const endsMs = toTimestamp(row.endsAt);

  if (startsMs !== null && startsMs > nowMs) return false;
  if (endsMs !== null && endsMs <= nowMs) return false;
  return true;
}

/**
 * Resolves the audience segments that qualify for a public active-announcements request.
 * Campaigns targeted at `ALL` always match; any requested audience(s) are included additively.
 */
export function resolveTargetAudiences(
  query: PublicActiveAnnouncementsQuery,
): AnnouncementAudience[] {
  const targets = new Set<AnnouncementAudience>(['ALL']);
  if (query.audiences?.length) {
    for (const audience of query.audiences) targets.add(audience);
  } else if (query.audience) {
    targets.add(query.audience);
  } else {
    targets.add('PUBLIC_VISITORS');
  }
  return [...targets];
}

/**
 * Orders eligible campaigns deterministically: highest priority first, then newest published/created
 * timestamp, then id ascending.
 */
export function sortAnnouncementsByPriority<T extends AnnouncementSortTarget>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const pubA = toTimestamp(a.publishedAt) ?? toTimestamp(a.createdAt) ?? 0;
    const pubB = toTimestamp(b.publishedAt) ?? toTimestamp(b.createdAt) ?? 0;
    if (pubB !== pubA) return pubB - pubA;
    return a.id.localeCompare(b.id);
  });
}

export interface CachedPublicCandidate {
  id: string;
  title: string;
  description: string | null;
  image: { url: string; width: number; height: number } | null;
  displayType: AnnouncementDisplayType;
  ctaText: string | null;
  redirectUrl: string | null;
  displayDelaySeconds: number;
  frequency: AnnouncementFrequency;
  priority: number;
  audience: AnnouncementAudience;
  status: AnnouncementStatus;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  createdAt: string;
}
