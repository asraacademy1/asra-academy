/**
 * PHASE 14 — SEO, security and performance hardening (web): security headers and CSP, the
 * indexing guard, certificate verification (API URL, privacy of metadata, outage vs not-found),
 * Course structured data, share images and the database-backed sitemap.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PublicCourseDetail, PublicCertificateVerificationDto } from '@asra/types';

import { generateMetadata as verifyMetadata } from '@/app/(public)/verify/[certificateId]/page';
import sitemap from '@/app/sitemap';
import { CertificateVerificationView } from '@/components/public/certificate-verification';
import { ProgrammePage } from '@/components/public/programme-page';
import { PublicCoursePage } from '@/components/public/public-course-page';
import {
  assertIndexableSiteUrl,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
} from '@/config/deployment';
import { programmes } from '@/content/programmes';
import { lookupCertificate } from '@/lib/certificates';
import { publicEnv } from '@/lib/env';
import { absoluteUrl, buildPageMetadata, courseJsonLd } from '@/lib/seo';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces global fetch; returns the list of requested URLs. */
function mockFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Every `<script type="application/ld+json">` payload in the markup, parsed. */
function jsonLdBlocks(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map(
    (match) => JSON.parse(match[1]!) as Record<string, unknown>,
  );
}

const CSP_OPTIONS = {
  apiUrl: 'https://api.asra.example/api/v1',
  appUrl: 'https://www.asra.example',
  isDev: false,
};

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split('; ').map((part) => {
      const [name, ...values] = part.split(' ');
      return [name!, values];
    }),
  );
}

describe('security headers (next.config.ts)', () => {
  it('sends a CSP that forbids framing, plugins, base hijacking and foreign scripts', () => {
    const csp = directives(buildContentSecurityPolicy(CSP_OPTIONS));
    assert.deepEqual(csp.get('frame-ancestors'), ["'none'"]);
    assert.deepEqual(csp.get('object-src'), ["'none'"]);
    assert.deepEqual(csp.get('base-uri'), ["'self'"]);
    assert.deepEqual(csp.get('default-src'), ["'self'"]);
    // Only our own scripts and the Razorpay Checkout loader; no eval in production.
    assert.deepEqual(csp.get('script-src'), [
      "'self'",
      "'unsafe-inline'",
      'https://checkout.razorpay.com',
    ]);
    assert.ok(csp.has('upgrade-insecure-requests'));
  });

  it('allows exactly the integrations the app uses: the API origin, Razorpay and video embeds', () => {
    const csp = directives(buildContentSecurityPolicy(CSP_OPTIONS));
    assert.deepEqual(csp.get('connect-src'), [
      "'self'",
      'https://api.asra.example',
      'https://*.razorpay.com',
    ]);
    assert.deepEqual(csp.get('frame-src'), [
      'https://www.youtube-nocookie.com',
      'https://player.vimeo.com',
      'https://*.razorpay.com',
    ]);
  });

  it('keeps local http builds and the dev server working', () => {
    const local = directives(
      buildContentSecurityPolicy({
        apiUrl: 'http://localhost:4000/api/v1',
        appUrl: 'http://localhost:3000',
        isDev: false,
      }),
    );
    assert.ok(!local.has('upgrade-insecure-requests'), 'would upgrade http://localhost API calls');
    assert.ok(local.get('connect-src')?.includes('http://localhost:4000'));
    const dev = directives(
      buildContentSecurityPolicy({
        apiUrl: 'http://localhost:4000/api/v1',
        appUrl: 'http://localhost:3000',
        isDev: true,
      }),
    );
    assert.ok(dev.get('script-src')?.includes("'unsafe-eval'"), 'React dev tooling needs eval');
    assert.ok(dev.get('connect-src')?.includes('ws:'), 'hot reload uses a websocket');
  });

  it('adds nosniff, frame, referrer and permissions headers, and HSTS on https only', () => {
    const names = (options: typeof CSP_OPTIONS) =>
      Object.fromEntries(buildSecurityHeaders(options).map((h) => [h.key, h.value]));
    const production = names(CSP_OPTIONS);
    assert.equal(production['X-Content-Type-Options'], 'nosniff');
    assert.equal(production['X-Frame-Options'], 'DENY');
    assert.equal(production['Referrer-Policy'], 'strict-origin-when-cross-origin');
    assert.match(production['Permissions-Policy']!, /camera=\(\)/);
    assert.equal(production['Strict-Transport-Security'], 'max-age=63072000');
    const local = names({ ...CSP_OPTIONS, appUrl: 'http://localhost:3000' });
    assert.equal(local['Strict-Transport-Security'], undefined);
  });
});

describe('indexing guard (SITE_INDEXING_ENABLED)', () => {
  it('accepts only an https production origin', () => {
    assert.doesNotThrow(() => assertIndexableSiteUrl('https://www.asraacademy.in'));
    for (const bad of [
      undefined,
      'not a url',
      'http://www.asraacademy.in',
      'https://localhost:3000',
      'https://127.0.0.1',
      'https://asra-academy-git-main.vercel.app',
      'https://www.asraacademy.in/app',
    ]) {
      assert.throws(() => assertIndexableSiteUrl(bad), /SITE_INDEXING_ENABLED/, String(bad));
    }
  });
});

const VERIFIED: PublicCertificateVerificationDto = {
  valid: true,
  certificateNumber: 'ASRA-2026-F9KC-M28V',
  status: 'ISSUED',
  sourceType: 'COURSE',
  sourceLabel: 'Course',
  certificateTitle: 'Certificate of Completion',
  recipientName: 'Amina Student',
  courseTitle: 'Arabic Level 1',
  description: 'has successfully completed',
  achievementDetails: null,
  academyName: 'ASRA Academy',
  completedAt: '2026-10-01T00:00:00.000Z',
  issuedAt: '2026-10-02T00:00:00.000Z',
  revokedAt: null,
  revokedReason: null,
  signatories: [],
};

describe('certificate verification (PHASE 13 regression)', () => {
  it('calls the API once under NEXT_PUBLIC_API_URL (which already ends in /api/v1)', async () => {
    const calls = mockFetch(() => json(200, { success: true, message: 'ok', data: VERIFIED }));
    const result = await lookupCertificate(' asra-2026-f9kc-m28v ');
    assert.deepEqual(result, { status: 'found', data: VERIFIED });
    assert.deepEqual(calls, [
      `${publicEnv.NEXT_PUBLIC_API_URL}/certificates/verify/ASRA-2026-F9KC-M28V`,
    ]);
    assert.ok(!calls[0]!.includes('/api/v1/api/v1'));
  });

  it('distinguishes "not found" from "service unavailable"', async () => {
    mockFetch(() => json(404, { success: false, message: 'nope', error: { code: 'NOT_FOUND' } }));
    assert.deepEqual(await lookupCertificate('ASRA-2026-AAAA-BBBB'), { status: 'not-found' });
    mockFetch(() =>
      json(503, { success: false, message: 'down', error: { code: 'SERVICE_UNAVAILABLE' } }),
    );
    assert.deepEqual(await lookupCertificate('ASRA-2026-AAAA-BBBB'), { status: 'unavailable' });
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    assert.deepEqual(await lookupCertificate('ASRA-2026-AAAA-BBBB'), { status: 'unavailable' });
  });

  // PHASE 15 (QA-DEF-04): the search field had only a placeholder (no accessible name).
  it('gives the certificate search field an accessible name', () => {
    const html = renderToStaticMarkup(<CertificateVerificationView />);
    assert.match(html, /<input[^>]*aria-label="Certificate ID"/);
  });

  it('never sends malformed input to the API', async () => {
    const calls = mockFetch(() => json(500, {}));
    assert.deepEqual(await lookupCertificate('../../admin'), { status: 'not-found' });
    assert.deepEqual(calls, []);
  });

  it('keeps certificate pages out of search results and their metadata free of names', async () => {
    mockFetch(() => json(200, { success: true, message: 'ok', data: VERIFIED }));
    const meta = await verifyMetadata({
      params: Promise.resolve({ certificateId: 'ASRA-2026-F9KC-M28V' }),
    });
    assert.deepEqual(meta.robots, { index: false, follow: true });
    const text = JSON.stringify(meta);
    assert.ok(!text.includes('Amina'), 'recipient name leaked into metadata');
    assert.ok(!text.includes('Arabic Level 1'), 'course title leaked into metadata');
    const hostile = await verifyMetadata({
      params: Promise.resolve({ certificateId: '<script>alert(1)</script>' }),
    });
    assert.ok(!/<script|alert/.test(JSON.stringify(hostile)), 'raw input reflected in metadata');
    assert.deepEqual(hostile.alternates, { canonical: '/verify' });
  });
});

const COURSE: PublicCourseDetail = {
  slug: 'arabic-level-1',
  title: 'Arabic Level 1',
  summary: 'Read and write Arabic script.',
  thumbnailUrl: 'https://cdn.example/arabic.jpg',
  category: null,
  class: null,
  stream: null,
  subject: null,
  durationMinutes: null,
  instructors: [],
  publishedAt: '2026-10-01T00:00:00.000Z',
  description: 'First paragraph.\n\nSecond paragraph.',
  visibility: 'PUBLIC',
  lessonCount: 0,
  curriculum: [],
};

describe('Course structured data', () => {
  it('describes a course only with facts the page shows — no prices, ratings or outcomes', () => {
    const data = courseJsonLd({ name: 'Urdu', description: 'D', path: '/courses/urdu' });
    assert.equal(data['@type'], 'Course');
    assert.equal(data.url, absoluteUrl('/courses/urdu'));
    assert.equal(data.provider.name, 'ASRA Academy');
    for (const key of ['offers', 'aggregateRating', 'review', 'hasCourseInstance', 'image']) {
      assert.ok(!(key in data), `${key} must not be claimed`);
    }
  });

  // Rendered without a thumbnail: next/image cannot render under the plain-Node test runner.
  const imageless = { ...COURSE, thumbnailUrl: null };

  it('is emitted on published course pages and escaped', () => {
    const html = renderToStaticMarkup(
      <PublicCoursePage course={{ ...imageless, title: 'Arabic </script><b>x</b>' }} />,
    );
    assert.ok(!html.includes('</script><b>'), 'title closed the JSON-LD script element');
    const course = jsonLdBlocks(html).find((block) => block['@type'] === 'Course');
    assert.ok(course, 'Course JSON-LD missing');
    assert.equal(course.name, 'Arabic </script><b>x</b>');
    assert.equal(course.description, COURSE.summary);
    assert.ok(!('image' in course));
  });

  it('includes the course thumbnail only when there is one', () => {
    const data = courseJsonLd({
      name: 'A',
      description: 'D',
      path: '/c',
      image: 'https://x/y.jpg',
    });
    assert.equal(data.image, 'https://x/y.jpg');
    assert.ok(!('image' in courseJsonLd({ name: 'A', description: 'D', path: '/c', image: null })));
  });

  it('is skipped when a course has no description to state', () => {
    const html = renderToStaticMarkup(
      <PublicCoursePage course={{ ...imageless, summary: null, description: null }} />,
    );
    assert.ok(!jsonLdBlocks(html).some((block) => block['@type'] === 'Course'));
  });

  it('marks up special courses but not class bands', () => {
    for (const programme of programmes) {
      const html = renderToStaticMarkup(<ProgrammePage programme={programme} />);
      const hasCourse = jsonLdBlocks(html).some((block) => block['@type'] === 'Course');
      assert.equal(hasCourse, programme.kind === 'special-course', programme.slug);
    }
  });

  it('uses a page-specific share image when one is given', () => {
    const meta = buildPageMetadata({
      title: 'Arabic',
      description: 'D',
      path: '/courses/arabic-level-1',
      image: { url: COURSE.thumbnailUrl!, alt: 'Arabic cover image' },
    });
    assert.deepEqual((meta.openGraph as { images: unknown[] }).images, [
      { url: COURSE.thumbnailUrl, alt: 'Arabic cover image' },
    ]);
    assert.deepEqual((meta.twitter as { images: unknown[] }).images, [
      { url: COURSE.thumbnailUrl, alt: 'Arabic cover image' },
    ]);
  });
});

describe('sitemap with published courses', () => {
  it('adds published course URLs from the API feed with their last-modified time', async () => {
    const calls = mockFetch(() =>
      json(200, {
        success: true,
        message: 'ok',
        data: [{ slug: 'arabic-level-1', updatedAt: '2026-10-20T10:00:00.000Z' }],
      }),
    );
    const entries = await sitemap();
    assert.deepEqual(calls, [`${publicEnv.NEXT_PUBLIC_API_URL}/sitemap/courses`]);
    const course = entries.find((entry) => entry.url === absoluteUrl('/courses/arabic-level-1'));
    assert.ok(course);
    assert.equal(course.lastModified, '2026-10-20T10:00:00.000Z');
    assert.ok(entries.some((entry) => entry.url === absoluteUrl('/verify')));
    // `/faculty` (public directory) is fine; the faculty PORTAL lives under `/faculty/…`.
    assert.ok(
      !entries.some((entry) =>
        /\/(student|admin|login|register|design-system)\b|\/faculty\//.test(entry.url),
      ),
    );
    assert.equal(new Set(entries.map((entry) => entry.url)).size, entries.length);
  });

  it('falls back to the static pages when the API fails', async () => {
    mockFetch(() => json(503, { success: false, message: 'down', error: { code: 'X' } }));
    const entries = await sitemap();
    assert.ok(entries.length > 0);
    assert.ok(!entries.some((entry) => entry.lastModified));
  });
});
