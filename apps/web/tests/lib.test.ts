import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildApiUrl } from '@/lib/api';
import {
  formatDate,
  formatDateTime,
  formatDuration,
  isSafeExternalUrl,
  toValidDate,
} from '@/lib/format';
import { isActivePath } from '@/lib/navigation';
import { getPaginationRange, type PaginationItem } from '@/lib/pagination';
import { clampProgress, cn, getInitials, toPercent } from '@/lib/utils';

const labels = (items: PaginationItem[]) =>
  items.map((item) => (item.type === 'page' ? String(item.page) : '…')).join(' ');

describe('cn (tailwind-merge with ASRA tokens)', () => {
  it('keeps the last value of a custom spacing token', () => {
    assert.equal(cn('h-control', 'h-control-lg'), 'h-control-lg');
  });
  it('keeps the last typography role', () => {
    assert.equal(cn('type-body', 'type-h2'), 'type-h2');
  });
  it('keeps the last custom shadow', () => {
    assert.equal(cn('shadow-card', 'shadow-raised'), 'shadow-raised');
  });
  it('does not drop a type role when a text colour is added', () => {
    assert.equal(cn('type-h3', 'text-heading'), 'type-h3 text-heading');
  });
});

describe('getInitials', () => {
  it('uses first and last word', () => assert.equal(getInitials('Demo Faculty Name'), 'DN'));
  it('handles a single word', () => assert.equal(getInitials('asra'), 'A'));
  it('handles extra whitespace', () => assert.equal(getInitials('  ali   khan '), 'AK'));
  it('falls back for empty values', () => {
    assert.equal(getInitials(''), '?');
    assert.equal(getInitials(undefined), '?');
  });
});

describe('clampProgress / toPercent', () => {
  it('clamps below 0 and above max', () => {
    assert.equal(clampProgress(-5), 0);
    assert.equal(clampProgress(150), 100);
    assert.equal(clampProgress(25, 20), 20);
  });
  it('returns null for missing or non-finite values', () => {
    assert.equal(clampProgress(null), null);
    assert.equal(clampProgress(undefined), null);
    assert.equal(clampProgress(Number.NaN), null);
    assert.equal(clampProgress(Number.POSITIVE_INFINITY), null);
  });
  it('treats an invalid max as 100', () => {
    assert.equal(clampProgress(150, 0), 100);
    assert.equal(toPercent(50, -1), 50);
  });
  it('rounds percentages', () => {
    assert.equal(toPercent(12, 20), 60);
    assert.equal(toPercent(1, 3), 33);
  });
});

describe('format', () => {
  it('formats in Asia/Kolkata regardless of the machine time zone', () => {
    // 11:00 UTC = 16:30 IST
    assert.equal(formatDateTime('2026-10-14T11:00:00Z'), '14 Oct 2026, 4:30 pm');
    assert.equal(formatDate('2026-10-14T20:00:00Z'), '15 Oct 2026');
  });
  it('returns null for invalid or missing dates', () => {
    assert.equal(formatDateTime('not-a-date'), null);
    assert.equal(formatDateTime(undefined), null);
    assert.equal(toValidDate(''), null);
  });
  it('formats durations', () => {
    assert.equal(formatDuration(45), '45 min');
    assert.equal(formatDuration(60), '1 hr');
    assert.equal(formatDuration(90), '1 hr 30 min');
    assert.equal(formatDuration(0), null);
    assert.equal(formatDuration(-10), null);
    assert.equal(formatDuration(undefined), null);
  });
  it('accepts only http(s) URLs as external links', () => {
    assert.equal(isSafeExternalUrl('https://example.com/join'), true);
    assert.equal(isSafeExternalUrl('http://example.com'), true);
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalUrl('/relative'), false);
    assert.equal(isSafeExternalUrl(''), false);
    assert.equal(isSafeExternalUrl(undefined), false);
  });
});

describe('getPaginationRange', () => {
  it('lists every page when they fit', () => {
    assert.equal(labels(getPaginationRange(1, 5)), '1 2 3 4 5');
  });
  it('adds a trailing gap near the start', () => {
    assert.equal(labels(getPaginationRange(1, 12)), '1 2 3 4 5 … 12');
  });
  it('adds gaps on both sides in the middle', () => {
    assert.equal(labels(getPaginationRange(6, 12)), '1 … 5 6 7 … 12');
  });
  it('adds a leading gap near the end', () => {
    assert.equal(labels(getPaginationRange(12, 12)), '1 … 8 9 10 11 12');
  });
  it('keeps a constant item count while paging (no layout jump)', () => {
    const counts = new Set(
      Array.from({ length: 12 }, (_, i) => getPaginationRange(i + 1, 12).length),
    );
    assert.deepEqual([...counts], [7]);
  });
  it('clamps out-of-range input', () => {
    assert.equal(labels(getPaginationRange(99, 3)), '1 2 3');
    assert.equal(labels(getPaginationRange(0, 0)), '1');
    assert.equal(labels(getPaginationRange(Number.NaN, 2)), '1 2');
  });
});

describe('isActivePath', () => {
  it('matches index routes exactly', () => {
    assert.equal(isActivePath('/', '/'), true);
    assert.equal(isActivePath('/courses', '/'), false);
  });
  it('matches sub-paths for section routes', () => {
    assert.equal(isActivePath('/courses/english', '/courses'), true);
    assert.equal(isActivePath('/courses-archive', '/courses'), false);
  });
  it('respects exact and ignores trailing slashes and query strings', () => {
    assert.equal(isActivePath('/dashboard/live', '/dashboard', true), false);
    assert.equal(isActivePath('/faculty/', '/faculty'), true);
    assert.equal(isActivePath('/faculty?page=2', '/faculty'), true);
    assert.equal(isActivePath(null, '/faculty'), false);
  });
});

describe('buildApiUrl', () => {
  const prodBase = 'https://api.asraacademy.in/api/v1';

  it('joins API-relative certificate and resume paths once without duplicating /api/v1', () => {
    assert.equal(
      buildApiUrl('/admin/certificates/templates/tpl-1/preview', prodBase),
      'https://api.asraacademy.in/api/v1/admin/certificates/templates/tpl-1/preview',
    );
    assert.equal(
      buildApiUrl('/admin/certificates/templates/tpl-1/preview/png', prodBase),
      'https://api.asraacademy.in/api/v1/admin/certificates/templates/tpl-1/preview/png',
    );
    assert.equal(
      buildApiUrl('/admin/recruitment/applications/app-1/resume', prodBase),
      'https://api.asraacademy.in/api/v1/admin/recruitment/applications/app-1/resume',
    );
  });

  it('strips trailing slashes on baseUrl and deduplicates /api/v1 prefixes', () => {
    assert.equal(
      buildApiUrl('/api/v1/admin/certificates/templates/tpl-1/preview', `${prodBase}/`),
      'https://api.asraacademy.in/api/v1/admin/certificates/templates/tpl-1/preview',
    );
    assert.equal(
      buildApiUrl('student/certificates/cert-1/download/pdf', `${prodBase}///`),
      'https://api.asraacademy.in/api/v1/student/certificates/cert-1/download/pdf',
    );
  });
});
