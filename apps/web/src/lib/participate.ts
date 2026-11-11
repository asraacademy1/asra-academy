import type {
  ApiResponse,
  Paginated,
  PublicAcademyQuizDetail,
  PublicAcademyQuizItem,
  PublicAcademyQuizPhase,
  PublicParticipateActivitiesDto,
  PublicParticipateSummaryDto,
  PublicSitemapQuiz,
} from '@asra/types';
import { PARTICIPATE_QUIZ_FILTERS, slugSchema, type ParticipateQuizFilter } from '@asra/validation';
import { unstable_rethrow } from 'next/navigation';
import { cache } from 'react';

import { ApiClientError, apiRequest } from '@/lib/api';
import { publicEnv } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import {
  STUDENT_PHASE_BADGE,
  STUDENT_PHASE_LABELS,
  timingLabel,
} from '@/lib/student/academy-quizzes';
import { SITEMAP_REVALIDATE_SECONDS } from '@/lib/sitemap';

export type ParticipateResult<T> =
  { ok: true; data: T } | { ok: false; reason: 'not-found' | 'unavailable'; message: string };

const PUBLIC_TIMEOUT_MS = 5_000;
const EMPTY_SUMMARY: PublicParticipateSummaryDto = {
  liveQuizzesCount: 0,
  upcomingQuizzesCount: 0,
  competitionsCount: 0,
  assessmentsCount: 0,
};

function failure(error: unknown, fallback: string): ParticipateResult<never> {
  unstable_rethrow(error);
  if (error instanceof ApiClientError && error.status === 404) {
    return { ok: false, reason: 'not-found', message: error.message };
  }
  return { ok: false, reason: 'unavailable', message: fallback };
}

export const publicQuizHref = (slug: string) => `/participate/quizzes/${encodeURIComponent(slug)}`;

export const PUBLIC_PHASE_LABELS: Record<PublicAcademyQuizPhase, string> = STUDENT_PHASE_LABELS;
export const PUBLIC_PHASE_BADGE = STUDENT_PHASE_BADGE;

export { timingLabel };

export function parseParticipateQuizFilter(
  raw: string | string[] | undefined,
): ParticipateQuizFilter {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const normalised = typeof first === 'string' ? first.trim().toLowerCase() : '';
  return (PARTICIPATE_QUIZ_FILTERS as readonly string[]).includes(normalised)
    ? (normalised as ParticipateQuizFilter)
    : 'all';
}

export function formatQuizWindowIst(startsAt: string, endsAt: string): string {
  const start = formatDateTime(startsAt);
  const end = formatDateTime(endsAt);
  if (!start || !end) return 'Schedule to be announced';
  return `${start} – ${end} IST`;
}

export function eligibilitySummaryText(quiz: {
  eligibleClasses: { id: string; name: string }[];
  eligibleStreams: { id: string; name: string }[];
}): string {
  const parts = [
    quiz.eligibleClasses.length
      ? `Classes: ${quiz.eligibleClasses.map((c) => c.name).join(', ')}`
      : null,
    quiz.eligibleStreams.length
      ? `Streams: ${quiz.eligibleStreams.map((s) => s.name).join(', ')}`
      : null,
  ].filter(Boolean);
  return parts.length
    ? `${parts.join(' · ')} · Verified email required`
    : 'Open to all verified students';
}

/**
 * Dynamic footer availability summary. Revalidates every 60s (matching `getPublicCareerCategories`)
 * so static public pages in `PublicLayout` remain cacheable and resilient when the API is offline.
 */
export async function getPublicParticipateSummary(): Promise<PublicParticipateSummaryDto> {
  try {
    const res = await fetch(`${publicEnv.NEXT_PUBLIC_API_URL}/participate/summary`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return EMPTY_SUMMARY;
    const body = (await res.json()) as ApiResponse<PublicParticipateSummaryDto>;
    return body.success && body.data ? body.data : EMPTY_SUMMARY;
  } catch {
    return EMPTY_SUMMARY;
  }
}

export async function getPublicParticipateActivities(): Promise<
  ParticipateResult<PublicParticipateActivitiesDto>
> {
  try {
    const data = await apiRequest<PublicParticipateActivitiesDto>('/participate/activities', {
      timeoutMs: PUBLIC_TIMEOUT_MS,
    });
    return { ok: true, data };
  } catch (error) {
    return failure(
      error,
      'Participate activities are temporarily unavailable. Please try again shortly.',
    );
  }
}

export async function getPublicParticipateQuizzes(
  query: {
    status?: ParticipateQuizFilter;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<ParticipateResult<Paginated<PublicAcademyQuizItem>>> {
  const params = new URLSearchParams({
    status: query.status ?? 'all',
    page: String(query.page ?? 1),
    pageSize: String(query.pageSize ?? 12),
  });
  try {
    const data = await apiRequest<Paginated<PublicAcademyQuizItem>>(
      `/participate/quizzes?${params.toString()}`,
      { timeoutMs: PUBLIC_TIMEOUT_MS },
    );
    return { ok: true, data };
  } catch (error) {
    return failure(error, 'Quizzes are temporarily unavailable. Please try again shortly.');
  }
}

export async function getPublicCompetitions(
  page = 1,
): Promise<ParticipateResult<Paginated<PublicAcademyQuizItem>>> {
  try {
    const data = await apiRequest<Paginated<PublicAcademyQuizItem>>(
      `/participate/competitions?page=${page}&pageSize=12`,
      { timeoutMs: PUBLIC_TIMEOUT_MS },
    );
    return { ok: true, data };
  } catch (error) {
    return failure(error, 'Competitions are temporarily unavailable. Please try again shortly.');
  }
}

export async function getPublicAssessments(
  page = 1,
): Promise<ParticipateResult<Paginated<PublicAcademyQuizItem>>> {
  try {
    const data = await apiRequest<Paginated<PublicAcademyQuizItem>>(
      `/participate/assessments?page=${page}&pageSize=12`,
      { timeoutMs: PUBLIC_TIMEOUT_MS },
    );
    return { ok: true, data };
  } catch (error) {
    return failure(error, 'Assessments are temporarily unavailable. Please try again shortly.');
  }
}

/**
 * Fetches one public quiz by slug. Rejects malformed slugs without hitting the API, and shares
 * one request per render between `generateMetadata` and the page.
 */
export const getPublicQuizDetail = cache(
  async (slug: string): Promise<ParticipateResult<PublicAcademyQuizDetail>> => {
    if (!slugSchema.safeParse(slug).success) {
      return { ok: false, reason: 'not-found', message: 'Quiz not found' };
    }
    try {
      const data = await apiRequest<PublicAcademyQuizDetail>(
        `/participate/quizzes/${encodeURIComponent(slug)}`,
        { timeoutMs: PUBLIC_TIMEOUT_MS },
      );
      return { ok: true, data };
    } catch (error) {
      return failure(error, 'Quiz details are temporarily unavailable. Please try again shortly.');
    }
  },
);

export async function getSitemapQuizzes(): Promise<PublicSitemapQuiz[]> {
  try {
    const response = await fetch(`${publicEnv.NEXT_PUBLIC_API_URL}/sitemap/academy-quizzes`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: SITEMAP_REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as ApiResponse<PublicSitemapQuiz[]>;
    return body.success && Array.isArray(body.data) ? body.data : [];
  } catch {
    return [];
  }
}
