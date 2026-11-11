import type { ApiResponse, PublicSitemapCourse } from '@asra/types';

import { publishedBlogPosts } from '@/content/blog';
import { legalDocuments } from '@/content/legal';
import { programmes } from '@/content/programmes';
import { publicEnv } from '@/lib/env';

/**
 * Public, indexable site paths. Excluded on purpose: account pages (/login, /register, password
 * and verification flows — `noindex`), the internal /design-system showcase, portals, individual
 * certificate pages (`noindex`, personal data), and /blog while it has no published posts. Blog
 * article URLs are added only when real posts exist (none yet, so none are listed).
 */
export function getIndexablePaths(): string[] {
  return [
    '/',
    '/about',
    '/courses',
    ...programmes.map((programme) => programme.href),
    '/faculty',
    '/admission',
    '/contact',
    '/participate',
    '/participate/quizzes',
    '/participate/competitions',
    '/participate/assessments',
    '/verify',
    ...(publishedBlogPosts.length > 0 ? ['/blog'] : []),
    ...Object.values(legalDocuments).map((document) => document.path),
  ];
}

/** How often the generated sitemap.xml re-reads the course list (seconds). */
export const SITEMAP_REVALIDATE_SECONDS = 3600;
const SITEMAP_FETCH_TIMEOUT_MS = 5_000;

/**
 * Published PUBLIC courses (PHASE 14) from `GET /api/v1/sitemap/courses` — never unlisted,
 * private or draft ones (the API applies the public listing rule). Cached with the sitemap
 * (`next.revalidate`), not per request. When the API is unreachable (e.g. during a build) the
 * sitemap falls back to the static pages and is regenerated on the next revalidation.
 */
export async function getSitemapCourses(): Promise<PublicSitemapCourse[]> {
  try {
    const response = await fetch(`${publicEnv.NEXT_PUBLIC_API_URL}/sitemap/courses`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: SITEMAP_REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(SITEMAP_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as ApiResponse<PublicSitemapCourse[]>;
    return body.success && Array.isArray(body.data) ? body.data : [];
  } catch {
    return [];
  }
}
