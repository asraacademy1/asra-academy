/**
 * PHASE 15 (QA) — route-guard matrix. Enumerates every route registered on the protected
 * routers (instead of a hand-written list, so a route added later without a guard is caught)
 * and checks the RBAC boundary for each one:
 *
 *   - no token                → 401 on /admin, /student, /faculty, /notifications
 *   - STUDENT                 → 403 on every /admin and /faculty route
 *   - FACULTY                 → 403 on every /admin and /student route
 *   - ADMIN                   → 403 on /student, /faculty and exactly the Super-Admin-only routes;
 *                               every other admin GET is reachable (not 401/403)
 *
 * Guards run before validation and handlers, so placeholder ids are enough: a request that is
 * not refused never reaches business logic with real data.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Router } from 'express';
import type { UserRole } from '@asra/types';
import { createApp } from '../src/app.js';
import { disconnectPrisma } from '../src/database/prisma.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { PERMISSIONS } from '@asra/types';
import { requirePermission } from '../src/middleware/authorize.js';
import { academicsAdminRouter } from '../src/modules/academics/academics.routes.js';
import { academyQuizzesAdminRouter } from '../src/modules/academy-quizzes/academy-quizzes.routes.js';
import { assessmentMediaRouter } from '../src/modules/assessments/media/media.routes.js';
import { adminPortalRouter } from '../src/modules/admin/admin.routes.js';
import { certificatesAdminRouter } from '../src/modules/certificates/certificates.routes.js';
import { coursesAdminRouter } from '../src/modules/courses/courses.routes.js';
import { curriculumAdminRouter } from '../src/modules/curriculum/curriculum.routes.js';
import { enrollmentsAdminRouter } from '../src/modules/enrollments/enrollments.routes.js';
import { facultyRouter } from '../src/modules/faculty/faculty.routes.js';
import { liveClassesAdminRouter } from '../src/modules/live-classes/live-classes.routes.js';
import { notificationsRouter } from '../src/modules/notifications/notifications.routes.js';
import { paymentsAdminRouter } from '../src/modules/payments/payments.routes.js';
import { studentRouter } from '../src/modules/student/student.routes.js';
import { resetAuthState } from './support/auth.js';
import { tokenFor } from './support/catalog.js';
import { startServer, TestClient } from './support/http.js';

interface RouteEntry {
  method: string;
  path: string;
}

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}

/** Every nested router in this API is mounted at its parent's root (see routes/index.ts). */
function routesOf(router: Router, prefix: string): RouteEntry[] {
  const entries: RouteEntry[] = [];
  const walk = (stack: Layer[]) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const path of paths) {
          for (const [method, enabled] of Object.entries(layer.route.methods)) {
            if (enabled && method !== '_all') {
              entries.push({ method: method.toUpperCase(), path: `${prefix}${path}` });
            }
          }
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((router as unknown as { stack: Layer[] }).stack);
  return entries;
}

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';
const concrete = (path: string) =>
  path.replace(/:role\b/g, 'ADMIN').replace(/:[A-Za-z]+/g, PLACEHOLDER_ID);
const key = (route: RouteEntry) => `${route.method} ${route.path}`;

const ADMIN_ROUTES = [
  academicsAdminRouter,
  coursesAdminRouter,
  curriculumAdminRouter,
  enrollmentsAdminRouter,
  paymentsAdminRouter,
  liveClassesAdminRouter,
  adminPortalRouter,
  certificatesAdminRouter,
  // Academy Quizzes (academy_quizzes.manage) and their image uploads.
  academyQuizzesAdminRouter,
  assessmentMediaRouter(requirePermission(PERMISSIONS.ACADEMY_QUIZZES_MANAGE)),
].flatMap((router) => routesOf(router, '/admin'));
const STUDENT_ROUTES = routesOf(studentRouter, '/student');
const FACULTY_ROUTES = routesOf(facultyRouter, '/faculty');
const NOTIFICATION_ROUTES = routesOf(notificationsRouter, '/notifications');

/**
 * Routes whose permission only SUPER_ADMIN holds (roles.manage, audit_logs.view,
 * payments.refund — see database/seed/access-control.data.ts). A change here is an RBAC change
 * and must be deliberate.
 */
const SUPER_ADMIN_ONLY = new Set([
  'POST /admin/users/:id/roles',
  'DELETE /admin/users/:id/roles/:role',
  'GET /admin/roles',
  'GET /admin/audit-logs',
  'POST /admin/payments/transactions/:id/refunds',
]);

let baseUrl: string;
let close: () => Promise<void>;
let client: TestClient;
const tokens = {} as Record<Exclude<UserRole, 'SUPER_ADMIN'>, string>;

before(async () => {
  ({ baseUrl, close } = await startServer(createApp()));
  await resetAuthState();
  client = new TestClient(baseUrl);
  for (const role of ['STUDENT', 'FACULTY', 'ADMIN'] as const) {
    tokens[role] = await tokenFor(client, role);
  }
});
after(async () => {
  await close();
  await Promise.all([disconnectPrisma(), disconnectRedis()]);
});

async function statuses(routes: RouteEntry[], token?: string) {
  const result: { route: string; status: number; cacheControl: string | null }[] = [];
  for (const route of routes) {
    const response = await client.request(route.method, concrete(route.path), {
      token,
      // Mutating routes get an (invalid) empty body so a missing guard would still fail safely.
      body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
      withCookies: false,
    });
    result.push({
      route: key(route),
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
    });
  }
  return result;
}

function expectAll(
  results: { route: string; status: number }[],
  predicate: (status: number) => boolean,
) {
  const failures = results.filter((r) => !predicate(r.status));
  assert.deepEqual(failures, [], 'routes outside the expected RBAC outcome');
}

describe('route inventory', () => {
  it('discovers the protected route surface', () => {
    // Guards against the walker silently finding nothing (e.g. after an Express upgrade).
    assert.ok(ADMIN_ROUTES.length > 50, `admin routes: ${ADMIN_ROUTES.length}`);
    assert.ok(STUDENT_ROUTES.length > 20, `student routes: ${STUDENT_ROUTES.length}`);
    assert.ok(FACULTY_ROUTES.length > 20, `faculty routes: ${FACULTY_ROUTES.length}`);
    assert.ok(NOTIFICATION_ROUTES.length > 0);
    for (const route of SUPER_ADMIN_ONLY) {
      assert.ok(
        ADMIN_ROUTES.some((r) => key(r) === route),
        `${route} no longer exists`,
      );
    }
  });
});

describe('unauthenticated access', () => {
  it('returns 401 and no-store on every protected route', async () => {
    const results = await statuses([
      ...ADMIN_ROUTES,
      ...STUDENT_ROUTES,
      ...FACULTY_ROUTES,
      ...NOTIFICATION_ROUTES,
    ]);
    expectAll(results, (status) => status === 401);
    assert.deepEqual(
      results.filter((r) => !r.cacheControl?.includes('no-store')),
      [],
      'protected responses must never be cacheable',
    );
  });

  it('rejects a forged token signed with another key', async () => {
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4Iiwic2lkIjoieCJ9.' + 'A'.repeat(43);
    const results = await statuses(
      [ADMIN_ROUTES[0]!, STUDENT_ROUTES[0]!, FACULTY_ROUTES[0]!],
      forged,
    );
    expectAll(results, (status) => status === 401);
  });
});

describe('vertical access control', () => {
  it('STUDENT is refused on every admin and faculty route', async () => {
    const results = await statuses([...ADMIN_ROUTES, ...FACULTY_ROUTES], tokens.STUDENT);
    expectAll(results, (status) => status === 403);
  });

  it('FACULTY is refused on every admin and student route', async () => {
    const results = await statuses([...ADMIN_ROUTES, ...STUDENT_ROUTES], tokens.FACULTY);
    expectAll(results, (status) => status === 403);
  });

  it('ADMIN is refused on student and faculty portals', async () => {
    const results = await statuses([...STUDENT_ROUTES, ...FACULTY_ROUTES], tokens.ADMIN);
    expectAll(results, (status) => status === 403);
  });

  it('ADMIN is refused exactly on the Super-Admin-only routes', async () => {
    const superOnly = ADMIN_ROUTES.filter((r) => SUPER_ADMIN_ONLY.has(key(r)));
    expectAll(await statuses(superOnly, tokens.ADMIN), (status) => status === 403);

    // Reads only: probing every admin mutation as a real admin would exercise business logic.
    const reads = ADMIN_ROUTES.filter((r) => r.method === 'GET' && !SUPER_ADMIN_ONLY.has(key(r)));
    expectAll(await statuses(reads, tokens.ADMIN), (status) => status !== 401 && status !== 403);
  });

  it('every role can reach its own notifications', async () => {
    for (const token of Object.values(tokens)) {
      const response = await client.request('GET', '/notifications', { token });
      assert.equal(response.status, 200);
    }
  });
});
