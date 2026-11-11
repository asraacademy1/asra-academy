/**
 * Website Announcement & Popup Management Module tests:
 * unit helpers, URL/input validation, RBAC authorization, CRUD/pagination/filtering,
 * Cloudinary image attach/release, scheduling boundaries without background workers,
 * priority ordering, audience targeting, public cache + prompt invalidation, and DB CHECKs.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  PERMISSIONS,
  type AdminAnnouncementDetail,
  type Paginated,
  type PublicAnnouncementDto,
} from '@asra/types';
import { isSafeAnnouncementRedirectUrl } from '@asra/validation';
import { createApp } from '../src/app.js';
import { PUBLIC_ANNOUNCEMENT_CACHE_CONTROL } from '../src/config/constants.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { disconnectRedis } from '../src/lib/redis.js';
import {
  getAnnouncementCacheStats,
  resetAnnouncementCacheStatsForTests,
} from '../src/modules/announcements/announcements.cache.js';
import {
  isAnnouncementPubliclyEligible,
  resolveEffectiveAnnouncementStatus,
  sortAnnouncementsByPriority,
} from '../src/modules/announcements/announcements.lifecycle.js';
import { setImageStoreForTests } from '../src/modules/assessments/media/image-store.js';
import { login, provision, resetAuthState, uniqueEmail } from './support/auth.js';
import { apiAs, expectStatus, type Api } from './support/catalog.js';
import { uniqueSuffix } from './support/fixtures.js';
import { startServer, TestClient } from './support/http.js';
import { fakeImageStore, uploadImage, webp, type FakeImageStore } from './support/media.js';

let baseUrl: string;
let close: () => Promise<void>;
let store: FakeImageStore;
let admin: { api: Api; token: string; userId: string };
let superAdmin: { api: Api; token: string; userId: string };
let student: { api: Api; token: string; userId: string };
let faculty: { api: Api; token: string; userId: string };

const BASE = '/admin/announcements';
const PUBLIC_ACTIVE = '/announcements/active';
const T0 = new Date('2026-12-01T10:00:00.000Z');

async function signIn(role: 'ADMIN' | 'SUPER_ADMIN' | 'STUDENT' | 'FACULTY') {
  const user = await provision(role);
  const client = new TestClient(baseUrl);
  const session = await login(client, user.email);
  return { api: apiAs(client, session.accessToken), token: session.accessToken, userId: user.id };
}

async function createDraft(api: Api = admin.api, extra: Record<string, unknown> = {}) {
  const res = await api<AdminAnnouncementDetail>('POST', BASE, {
    title: 'Admissions Open 2027',
    description: 'Apply now for Classes 6–12 and special batches.',
    ctaText: 'Apply Now',
    redirectUrl: '/admission',
    displayType: 'MODAL',
    frequency: 'ONCE_PER_SESSION',
    displayDelaySeconds: 3,
    priority: 10,
    audience: 'ALL',
    ...extra,
  });
  expectStatus(res, 201);
  return res.body.data;
}

before(async () => {
  ({ baseUrl, close } = await startServer(createApp()));
});

after(async () => {
  setClockForTests(null);
  setImageStoreForTests(null);
  await close();
  await Promise.all([disconnectPrisma(), disconnectRedis()]);
});

beforeEach(async () => {
  setClockForTests(T0);
  store = fakeImageStore();
  setImageStoreForTests(store);
  await resetAuthState();
  resetAnnouncementCacheStatsForTests();
  [admin, superAdmin, student, faculty] = await Promise.all([
    signIn('ADMIN'),
    signIn('SUPER_ADMIN'),
    signIn('STUDENT'),
    signIn('FACULTY'),
  ]);
});

describe('unit: URL safety, lifecycle status, eligibility and priority sorting', () => {
  it('accepts safe internal paths and public https URLs while rejecting unsafe schemes', () => {
    for (const valid of [
      '/',
      '/admission',
      '/courses/english?ref=popup#enroll',
      'https://www.asraacademy.in/admission',
      'https://forms.example.org/quiz-2026?utm_source=web',
    ]) {
      assert.equal(isSafeAnnouncementRedirectUrl(valid), true, valid);
    }

    for (const unsafe of [
      '',
      '   ',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'http://example.com/insecure',
      '//evil.example.com/phish',
      '/\\evil.example.com',
      '/path\n//evil.com',
      'https://user:pass@example.com/login',
      'https://localhost:3000/admin',
      'https://127.0.0.1/secret',
      'not-a-url',
    ]) {
      assert.equal(isSafeAnnouncementRedirectUrl(unsafe), false, unsafe);
    }
  });

  it('computes effective status and half-open [startsAt, endsAt) eligibility boundaries', () => {
    const start = new Date('2026-12-01T12:00:00.000Z');
    const end = new Date('2026-12-02T12:00:00.000Z');

    const scheduled = { status: 'SCHEDULED' as const, startsAt: start, endsAt: end };
    assert.equal(
      resolveEffectiveAnnouncementStatus(scheduled, new Date(start.getTime() - 1)),
      'SCHEDULED',
    );
    assert.equal(isAnnouncementPubliclyEligible(scheduled, new Date(start.getTime() - 1)), false);

    assert.equal(resolveEffectiveAnnouncementStatus(scheduled, start), 'PUBLISHED');
    assert.equal(isAnnouncementPubliclyEligible(scheduled, start), true);

    assert.equal(
      resolveEffectiveAnnouncementStatus(scheduled, new Date(end.getTime() - 1)),
      'PUBLISHED',
    );
    assert.equal(isAnnouncementPubliclyEligible(scheduled, new Date(end.getTime() - 1)), true);

    assert.equal(resolveEffectiveAnnouncementStatus(scheduled, end), 'EXPIRED');
    assert.equal(isAnnouncementPubliclyEligible(scheduled, end), false);

    assert.equal(
      isAnnouncementPubliclyEligible({ status: 'PAUSED', startsAt: null, endsAt: null }, start),
      false,
    );
    assert.equal(
      isAnnouncementPubliclyEligible({ status: 'DRAFT', startsAt: null, endsAt: null }, start),
      false,
    );
    assert.equal(
      isAnnouncementPubliclyEligible({ status: 'ARCHIVED', startsAt: null, endsAt: null }, start),
      false,
    );
  });

  it('sorts by priority descending with deterministic published/created tie-break', () => {
    const sorted = sortAnnouncementsByPriority([
      {
        id: 'b',
        priority: 10,
        publishedAt: '2026-12-01T08:00:00Z',
        createdAt: '2026-12-01T08:00:00Z',
      },
      {
        id: 'a',
        priority: 50,
        publishedAt: '2026-12-01T07:00:00Z',
        createdAt: '2026-12-01T07:00:00Z',
      },
      {
        id: 'c',
        priority: 50,
        publishedAt: '2026-12-01T09:00:00Z',
        createdAt: '2026-12-01T09:00:00Z',
      },
    ]);
    assert.deepEqual(
      sorted.map((x) => x.id),
      ['c', 'a', 'b'],
    );
  });
});

describe('authorization & role permissions', () => {
  it('blocks anonymous callers (401) and non-admin roles (403)', async () => {
    const anon = new TestClient(baseUrl);
    expectStatus(await anon.request('GET', BASE), 401);
    expectStatus(await anon.request('POST', BASE, { body: { title: 'Hi' } }), 401);

    for (const actor of [student.api, faculty.api]) {
      expectStatus(await actor('GET', BASE), 403);
      expectStatus(await actor('POST', BASE, { title: 'Nope' }), 403);
    }
  });

  it('requires announcements.manage permission specifically', async () => {
    // Custom role without announcements.manage is denied; adding the permission grants access.
    const roleKey = `ANN_EDITOR_${uniqueSuffix().toUpperCase()}`;
    const role = await prisma.role.create({
      data: { key: roleKey, name: 'Announcement Editor', isSystem: false },
    });
    try {
      const user = await provision('STUDENT', uniqueEmail('custom'));
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const client = new TestClient(baseUrl);
      const session = await login(client, user.email);
      const customApi = apiAs(client, session.accessToken);

      expectStatus(await customApi('GET', BASE), 403);

      const perm = await prisma.permission.findUniqueOrThrow({
        where: { key: PERMISSIONS.ANNOUNCEMENTS_MANAGE },
      });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });

      expectStatus(await customApi('GET', BASE), 200);
      const upload = await uploadImage(baseUrl, session.accessToken, webp(), { portal: 'admin' });
      assert.equal(upload.status, 201);
    } finally {
      await prisma.userRole.deleteMany({ where: { roleId: role.id } });
      await prisma.role.deleteMany({ where: { id: role.id } });
    }
  });
});

describe('admin CRUD, validation, pagination, filtering & Cloudinary images', () => {
  it('validates redirect URLs, dates, CTA dependency, priority/delay bounds and strict fields', async () => {
    expectStatus(
      await admin.api('POST', BASE, { title: 'Bad JS', redirectUrl: 'javascript:alert(1)' }),
      422,
    );
    expectStatus(
      await admin.api('POST', BASE, { title: 'Protocol Rel', redirectUrl: '//evil.com' }),
      422,
    );
    expectStatus(
      await admin.api('POST', BASE, { title: 'CTA without URL', ctaText: 'Click me' }),
      422,
    );
    expectStatus(
      await admin.api('POST', BASE, {
        title: 'Bad window',
        startsAt: '2026-12-05T10:00:00Z',
        endsAt: '2026-12-05T09:00:00Z',
      }),
      422,
    );
    expectStatus(await admin.api('POST', BASE, { title: 'Bad priority', priority: 1001 }), 422);
    expectStatus(
      await admin.api('POST', BASE, { title: 'Bad delay', displayDelaySeconds: 301 }),
      422,
    );
    expectStatus(await admin.api('POST', BASE, { title: 'Overpost', status: 'PUBLISHED' }), 422);
  });

  it('creates, paginates, filters, updates, manages priority, audits, and deletes safely', async () => {
    const a1 = await createDraft(admin.api, {
      title: 'Quiz Competition 2026',
      displayType: 'MODAL',
      audience: 'STUDENTS',
      priority: 50,
    });
    const a2 = await createDraft(superAdmin.api, {
      title: 'Admission Banner',
      displayType: 'TOP_BANNER',
      audience: 'PUBLIC_VISITORS',
      priority: 80,
    });
    await superAdmin.api('POST', `${BASE}/${a2.id}/publish`, {});

    const listAll = await admin.api<Paginated<AdminAnnouncementDetail>>(
      'GET',
      `${BASE}?page=1&pageSize=1`,
    );
    expectStatus(listAll, 200);
    assert.equal(listAll.body.data.pagination.total, 2);
    assert.equal(listAll.body.data.pagination.pageCount, 2);
    assert.equal(listAll.body.data.items[0]!.id, a2.id, 'highest priority first');

    const byType = await admin.api<Paginated<AdminAnnouncementDetail>>(
      'GET',
      `${BASE}?displayType=MODAL&audience=STUDENTS&q=Competition`,
    );
    expectStatus(byType, 200);
    assert.deepEqual(
      byType.body.data.items.map((i) => i.id),
      [a1.id],
    );

    const priorityRes = await admin.api<AdminAnnouncementDetail>(
      'PATCH',
      `${BASE}/${a1.id}/priority`,
      { priority: 900 },
    );
    expectStatus(priorityRes, 200);
    assert.equal(priorityRes.body.data.priority, 900);

    // Live campaigns cannot be deleted until paused or archived
    expectStatus(await admin.api('DELETE', `${BASE}/${a2.id}`), 409);
    expectStatus(await admin.api('POST', `${BASE}/${a2.id}/archive`), 200);
    expectStatus(await admin.api('DELETE', `${BASE}/${a2.id}`), 200);

    const audits = await prisma.adminAuditLog.findMany({
      where: { entityType: 'announcement' },
      orderBy: { createdAt: 'asc' },
    });
    assert.ok(audits.some((log) => log.action === 'announcement.created'));
    assert.ok(audits.some((log) => log.action === 'announcement.priority_updated'));
    assert.ok(audits.some((log) => log.action === 'announcement.archived'));
    assert.ok(audits.some((log) => log.action === 'announcement.deleted'));
  });

  it('attaches, validates, replaces and cleans up Cloudinary images', async () => {
    const oversized = await uploadImage(baseUrl, admin.token, webp(800, 600, { bytes: 102_401 }), {
      portal: 'admin',
    });
    assert.equal(oversized.status, 413);

    const img1 = await uploadImage(baseUrl, admin.token, webp(), { portal: 'admin' });
    const img2 = await uploadImage(baseUrl, admin.token, webp(), { portal: 'admin' });
    assert.equal(img1.status, 201);
    assert.equal(img2.status, 201);

    const created = await createDraft(admin.api, { imageMediaId: img1.body!.data.id });
    assert.equal(created.image?.id, img1.body!.data.id);

    // Replacing img1 with img2 deletes unreferenced img1 from Cloudinary
    const updated = await admin.api<AdminAnnouncementDetail>('PATCH', `${BASE}/${created.id}`, {
      imageMediaId: img2.body!.data.id,
    });
    expectStatus(updated, 200);
    assert.equal(updated.body.data.image?.id, img2.body!.data.id);
    assert.equal(
      await prisma.assessmentMedia.findUnique({ where: { id: img1.body!.data.id } }),
      null,
    );
    assert.equal(store.destroyed.length, 1);

    // Deleting draft releases img2
    expectStatus(await admin.api('DELETE', `${BASE}/${created.id}`), 200);
    assert.equal(
      await prisma.assessmentMedia.findUnique({ where: { id: img2.body!.data.id } }),
      null,
    );
    assert.equal(store.destroyed.length, 2);
  });
});

describe('scheduling boundaries, lifecycle, priority, audience & public safety', () => {
  it('enforces scenarios 1–4, 7, and 9 without a background worker', async () => {
    const anon = new TestClient(baseUrl);
    const start = new Date('2026-12-01T12:00:00.000Z');
    const end = new Date('2026-12-02T12:00:00.000Z');

    // Scenario 9: draft is never publicly visible
    const draftOnly = await createDraft(admin.api, { title: 'Secret Draft', priority: 999 });

    // Scenario 1 & 2 & 3: scheduled campaign
    const scheduled = await createDraft(admin.api, {
      title: 'Exam Form Window',
      priority: 50,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
    });
    const schedRes = await admin.api<AdminAnnouncementDetail>(
      'POST',
      `${BASE}/${scheduled.id}/schedule`,
    );
    expectStatus(schedRes, 200);
    assert.equal(schedRes.body.data.status, 'SCHEDULED');

    // Before start time (start - 1ms): nothing appears
    setClockForTests(new Date(start.getTime() - 1));
    const beforeStart = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    expectStatus(beforeStart, 200);
    assert.deepEqual(beforeStart.body.data, []);

    // At start time: scheduled campaign becomes active automatically
    setClockForTests(start);
    const atStart = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    expectStatus(atStart, 200);
    assert.deepEqual(
      atStart.body.data.map((a) => a.title),
      ['Exam Form Window'],
    );

    // Scenario 7: higher-priority eligible campaign wins ordering
    const higher = await createDraft(admin.api, {
      title: 'Urgent Result Out',
      priority: 200,
    });
    expectStatus(await admin.api('POST', `${BASE}/${higher.id}/publish`), 200);

    const both = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    expectStatus(both, 200);
    assert.deepEqual(
      both.body.data.map((a) => a.title),
      ['Urgent Result Out', 'Exam Form Window'],
    );

    // Ensure internal metadata and draft id are never exposed publicly
    for (const item of both.body.data) {
      assert.ok(!item.id.includes(draftOnly.id));
      assert.equal('createdBy' in item, false);
      assert.equal('updatedBy' in item, false);
      assert.equal('status' in item, false);
      assert.equal('storedStatus' in item, false);
      assert.equal('pausedAt' in item, false);
    }

    // Scenario 4: paused campaign never appears
    expectStatus(await admin.api('POST', `${BASE}/${higher.id}/pause`), 200);
    const afterPause = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    assert.deepEqual(
      afterPause.body.data.map((a) => a.title),
      ['Exam Form Window'],
    );

    // Resume restores it
    expectStatus(await admin.api('POST', `${BASE}/${higher.id}/resume`), 200);
    const afterResume = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    assert.deepEqual(
      afterResume.body.data.map((a) => a.title),
      ['Urgent Result Out', 'Exam Form Window'],
    );

    // Scenario 3: stops automatically at endsAt without a background worker
    setClockForTests(end);
    const atEnd = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    assert.deepEqual(
      atEnd.body.data.map((a) => a.title),
      ['Urgent Result Out'],
    );
    const adminCheck = await admin.api<AdminAnnouncementDetail>('GET', `${BASE}/${scheduled.id}`);
    assert.equal(adminCheck.body.data.status, 'EXPIRED');
  });

  it('filters public active campaigns by audience targeting', async () => {
    const anon = new TestClient(baseUrl);
    const allCamp = await createDraft(admin.api, {
      title: 'For All',
      audience: 'ALL',
      priority: 10,
    });
    const stuCamp = await createDraft(admin.api, {
      title: 'For Students',
      audience: 'STUDENTS',
      priority: 20,
    });
    const parCamp = await createDraft(admin.api, {
      title: 'For Parents',
      audience: 'PARENTS',
      priority: 30,
    });
    for (const c of [allCamp, stuCamp, parCamp]) {
      expectStatus(await admin.api('POST', `${BASE}/${c.id}/publish`), 200);
    }

    const defaultPub = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    assert.deepEqual(
      defaultPub.body.data.map((x) => x.title),
      ['For All'],
    );

    const webVisitors = await anon.request<PublicAnnouncementDto[]>(
      'GET',
      `${PUBLIC_ACTIVE}?audiences=PUBLIC_VISITORS,PARENTS`,
    );
    assert.deepEqual(
      webVisitors.body.data.map((x) => x.title),
      ['For Parents', 'For All'],
    );

    const studentsRes = await anon.request<PublicAnnouncementDto[]>(
      'GET',
      `${PUBLIC_ACTIVE}?audience=STUDENTS`,
    );
    assert.deepEqual(
      studentsRes.body.data.map((x) => x.title),
      ['For Students', 'For All'],
    );
  });

  it('caches public responses, supports ETag 304, and invalidates promptly on admin edits/pauses/publishes', async () => {
    const anon = new TestClient(baseUrl);
    const draft = await createDraft(admin.api, { title: 'Initial Title', priority: 10 });
    expectStatus(await admin.api('POST', `${BASE}/${draft.id}/publish`), 200);

    const first = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), PUBLIC_ANNOUNCEMENT_CACHE_CONTROL);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const statsAfterFirst = getAnnouncementCacheStats();
    assert.equal(statsAfterFirst.misses, 1);

    // Second request hits cache without touching DB
    const second = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    assert.equal(second.status, 200);
    assert.equal(getAnnouncementCacheStats().hits, 1);
    assert.equal(getAnnouncementCacheStats().misses, 1);

    // Conditional request returns 304 Not Modified
    const notModified = await fetch(`${baseUrl}/api/v1${PUBLIC_ACTIVE}`, {
      headers: { 'if-none-match': etag },
    });
    assert.equal(notModified.status, 304);

    // Admin edits title -> prompt invalidation
    expectStatus(
      await admin.api('PATCH', `${BASE}/${draft.id}`, { title: 'Updated Immediately' }),
      200,
    );
    const afterEdit = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    assert.equal(afterEdit.body.data[0]!.title, 'Updated Immediately');
    assert.notEqual(afterEdit.headers.get('etag'), etag);

    // Admin pauses -> prompt invalidation
    expectStatus(await admin.api('POST', `${BASE}/${draft.id}/pause`), 200);
    const afterPause = await anon.request<PublicAnnouncementDto[]>('GET', PUBLIC_ACTIVE);
    assert.deepEqual(afterPause.body.data, []);
  });
});

describe('database CHECK constraints (last line of defense)', () => {
  it('enforces title, priority, delay, window, CTA dependency, and redirect URL safety in PostgreSQL', async () => {
    await assert.rejects(
      prisma.$executeRaw`INSERT INTO "announcements" ("title") VALUES ('   ')`,
      /announcements_title_not_blank/,
    );
    await assert.rejects(
      prisma.$executeRaw`INSERT INTO "announcements" ("title", "priority") VALUES ('Ok', 1001)`,
      /announcements_priority_range/,
    );
    await assert.rejects(
      prisma.$executeRaw`INSERT INTO "announcements" ("title", "display_delay_seconds") VALUES ('Ok', -1)`,
      /announcements_delay_range/,
    );
    await assert.rejects(
      prisma.$executeRaw`
        INSERT INTO "announcements" ("title", "starts_at", "ends_at")
        VALUES ('Ok', '2026-12-02T00:00:00Z', '2026-12-01T00:00:00Z')
      `,
      /announcements_window/,
    );
    await assert.rejects(
      prisma.$executeRaw`
        INSERT INTO "announcements" ("title", "cta_text") VALUES ('Ok', 'Click')
      `,
      /announcements_cta_requires_redirect/,
    );
    await assert.rejects(
      prisma.$executeRaw`
        INSERT INTO "announcements" ("title", "redirect_url") VALUES ('Ok', 'javascript:alert(1)')
      `,
      /announcements_redirect_url_safe/,
    );
  });
});
