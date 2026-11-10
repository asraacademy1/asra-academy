/**
 * Admin portal RBAC in the UI: navigation and page access come ONLY from the user's effective
 * permissions (`AuthUser.permissions`, from `/auth/me`) — never from role names. The API is the
 * security boundary (apps/api/tests/admin-dashboard-phase12.test.ts asserts the 403s; the
 * permission sets per role are pinned in apps/api/tests/authorization.test.ts).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PERMISSIONS, type AuthUser } from '@asra/types';

import {
  ADMIN_ROUTE_RULES,
  buildNavigation,
  canAccessAdminPath,
} from '@/components/admin/admin-shell';
import { canUseAdminPortal, hasPermission } from '@/components/admin/use-admin';

/** The ADMIN role's grants as seeded (apps/api/src/database/seed/access-control.data.ts). */
const ADMIN_GRANTS = [
  PERMISSIONS.STUDENTS_MANAGE,
  PERMISSIONS.FACULTY_MANAGE,
  PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE,
  PERMISSIONS.COURSES_MANAGE,
  PERMISSIONS.CONTENT_MANAGE,
  PERMISSIONS.ENROLLMENTS_MANAGE,
  PERMISSIONS.LIVE_CLASSES_MANAGE,
  PERMISSIONS.PAYMENTS_VIEW,
  PERMISSIONS.ANALYTICS_VIEW,
  PERMISSIONS.NOTIFICATIONS_VIEW,
  PERMISSIONS.CERTIFICATES_VIEW,
  PERMISSIONS.CERTIFICATES_MANAGE,
  PERMISSIONS.RECRUITMENT_MANAGE,
  PERMISSIONS.ACADEMY_QUIZZES_MANAGE,
  PERMISSIONS.PROFILE_MANAGE_OWN,
];
const ALL_GRANTS = Object.values(PERMISSIONS);

const account = (roles: string[], permissions: readonly string[]): AuthUser => ({
  id: 'u',
  email: 'a@example.test',
  fullName: 'A',
  emailVerified: true,
  roles,
  permissions: [...permissions],
});

const admin = account(['ADMIN'], ADMIN_GRANTS);
const superAdmin = account(['SUPER_ADMIN'], ALL_GRANTS);

const navHrefs = (user: AuthUser) =>
  buildNavigation((p) => hasPermission(user, p)).flatMap((group) =>
    group.items.map((item) => item.href),
  );
const pathAllowed = (user: AuthUser, path: string) =>
  canAccessAdminPath(path, (p) => hasPermission(user, p));

const SUPER_ADMIN_ONLY = ['/admin/admins', '/admin/roles', '/admin/audit-logs'];

describe('hasPermission', () => {
  it('uses effective permissions, not role names', () => {
    assert.equal(hasPermission(admin, PERMISSIONS.COURSES_MANAGE), true);
    for (const key of [
      PERMISSIONS.ADMINS_MANAGE,
      PERMISSIONS.ROLES_MANAGE,
      PERMISSIONS.AUDIT_LOGS_VIEW,
      PERMISSIONS.SYSTEM_MANAGE,
      PERMISSIONS.PAYMENTS_REFUND,
    ]) {
      assert.equal(hasPermission(admin, key), false, key);
    }
    // A role name alone grants nothing; a permission without the role name does.
    assert.equal(hasPermission(account(['SUPER_ADMIN'], []), PERMISSIONS.ROLES_MANAGE), false);
    assert.equal(
      hasPermission(account([], [PERMISSIONS.ROLES_MANAGE]), PERMISSIONS.ROLES_MANAGE),
      true,
    );
    assert.equal(hasPermission(null, PERMISSIONS.COURSES_MANAGE), false);
  });

  it('portal access follows admin permissions, not role names', () => {
    assert.equal(canUseAdminPortal(admin), true);
    assert.equal(canUseAdminPortal(superAdmin), true);
    assert.equal(canUseAdminPortal(account(['ADMIN'], [PERMISSIONS.PROFILE_MANAGE_OWN])), false);
  });
});

describe('admin navigation', () => {
  it('hides Super Admin-only items from an Admin', () => {
    const hrefs = navHrefs(admin);
    for (const href of SUPER_ADMIN_ONLY) assert.ok(!hrefs.includes(href), href);
    for (const href of ['/admin/students', '/admin/faculty', '/admin/courses', '/admin/payments']) {
      assert.ok(hrefs.includes(href), href);
    }
    const nav = buildNavigation((p) => hasPermission(admin, p));
    assert.equal(
      nav.find((group) => group.label === 'Settings'),
      undefined,
      'an Admin has no Settings group at all',
    );
  });

  it('shows the complete Administration section to a Super Admin', () => {
    const hrefs = navHrefs(superAdmin);
    for (const href of SUPER_ADMIN_ONLY) assert.ok(hrefs.includes(href), href);
  });

  it('never links to a page the same permissions cannot open', () => {
    for (const user of [admin, superAdmin, account([], [PERMISSIONS.ANALYTICS_VIEW])]) {
      for (const href of navHrefs(user)) assert.ok(pathAllowed(user, href), href);
    }
  });
});

describe('direct URL access', () => {
  it('blocks an Admin from Super Admin-only pages, including nested paths', () => {
    for (const path of [...SUPER_ADMIN_ONLY, '/admin/roles/', '/admin/audit-logs/anything']) {
      assert.equal(pathAllowed(admin, path), false, path);
      assert.equal(pathAllowed(superAdmin, path), true, path);
    }
  });

  it('allows an Admin into the areas the role grants', () => {
    for (const path of [
      '/admin',
      '/admin/notifications',
      '/admin/students',
      '/admin/users/3f0c',
      '/admin/courses/new',
      '/admin/courses/3f0c',
      '/admin/payments/orders/3f0c',
      '/admin/recruitment/jobs/3f0c/edit',
      '/admin/analytics/revenue',
    ]) {
      assert.equal(pathAllowed(admin, path), true, path);
    }
  });

  it('applies the most specific rule and matches whole path segments', () => {
    const analyst = account([], [PERMISSIONS.ANALYTICS_VIEW]);
    assert.equal(pathAllowed(analyst, '/admin/analytics'), true);
    assert.equal(pathAllowed(analyst, '/admin/analytics/revenue'), false);
    assert.equal(pathAllowed(analyst, '/admin/courses'), false);
    // `/admin/rolesX` is not under `/admin/roles`.
    assert.equal(pathAllowed(admin, '/admin/rolesX'), true);
  });

  it('every rule names known permission keys', () => {
    const known = new Set<string>(ALL_GRANTS);
    for (const rule of ADMIN_ROUTE_RULES) {
      for (const key of [...(rule.allOf ?? []), ...(rule.anyOf ?? [])]) {
        assert.ok(known.has(key), `${rule.prefix}: ${key}`);
      }
    }
  });
});
