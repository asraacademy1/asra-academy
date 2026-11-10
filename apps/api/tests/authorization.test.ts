import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PERMISSIONS } from '@asra/types';
import express from 'express';
import { SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { authenticate } from '../src/middleware/authenticate.js';
import { requirePermission, requireRole } from '../src/middleware/authorize.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requestLogger } from '../src/middleware/request-logger.js';
import { accessPolicy } from '../src/services/access-policy.service.js';
import { sendSuccess } from '../src/utils/api-response.js';
import {
  login,
  PASSWORD,
  provision,
  registerVerifiedStudent,
  resetAuthState,
} from './support/auth.js';
import { startServer, TestClient } from './support/http.js';

/**
 * The API has no protected business endpoints yet (no dashboards/CRUD in PHASE 03), so these
 * test-only routes exercise the real middleware exactly as future routers will use it.
 */
function protectedTestApp() {
  const app = express();
  app.use(requestLogger);
  const ok = (_req: express.Request, res: express.Response) => sendSuccess(res, { ok: true });
  app.get('/authenticated', authenticate, ok);
  app.get('/admin-only', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), ok);
  app.get('/super-admin-only', authenticate, requireRole('SUPER_ADMIN'), ok);
  app.get('/manage-courses', authenticate, requirePermission(PERMISSIONS.COURSES_MANAGE), ok);
  app.get('/manage-admins', authenticate, requirePermission(PERMISSIONS.ADMINS_MANAGE), ok);
  app.get('/course/:courseId/content', authenticate, async (req, res) => {
    await accessPolicy.assertCanManageCourseContent(req.auth!, String(req.params.courseId));
    sendSuccess(res, { ok: true });
  });
  app.use(errorHandler);
  return app;
}

let apiUrl: string;
let testUrl: string;
const closers: (() => Promise<void>)[] = [];
const tokens: Record<string, string> = {};

async function get(path: string, token?: string) {
  const response = await fetch(`${testUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: (await response.json()) as { error?: { code: string } } };
}

before(async () => {
  const api = await startServer(createApp());
  const test = await startServer(protectedTestApp());
  apiUrl = api.baseUrl;
  testUrl = test.baseUrl;
  closers.push(api.close, test.close);
});
after(async () => {
  await Promise.all(closers.map((close) => close()));
  await Promise.all([disconnectPrisma(), disconnectRedis()]);
});

beforeEach(async () => {
  await resetAuthState();
  const client = new TestClient(apiUrl);
  tokens.STUDENT = (await login(client, await registerVerifiedStudent(client))).accessToken;
  for (const role of ['FACULTY', 'ADMIN', 'SUPER_ADMIN'] as const) {
    tokens[role] = (await login(new TestClient(apiUrl), (await provision(role)).email)).accessToken;
  }
});

const signWith = (
  secret: string,
  claims: { aud?: string; exp?: number; sub?: string; sid?: string } = {},
) =>
  new SignJWT({ sid: claims.sid ?? '00000000-0000-4000-8000-000000000000' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub ?? '00000000-0000-4000-8000-000000000000')
    .setIssuer(env.JWT_ISSUER)
    .setAudience(claims.aud ?? env.JWT_AUDIENCE)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(new TextEncoder().encode(secret));

describe('authentication middleware → 401', () => {
  it('missing credentials', async () => {
    const response = await get('/authenticated');
    assert.equal(response.status, 401);
    assert.equal(response.body.error?.code, 'UNAUTHORIZED');
  });

  it('malformed header and garbage token', async () => {
    assert.equal(
      (await fetch(`${testUrl}/authenticated`, { headers: { authorization: 'Basic abc' } })).status,
      401,
    );
    assert.equal((await get('/authenticated', 'not.a.jwt')).status, 401);
  });

  it('token signed with a different secret', async () => {
    assert.equal((await get('/authenticated', await signWith('x'.repeat(48)))).status, 401);
  });

  it('expired token', async () => {
    const { sub, sid } = decode(tokens.STUDENT!);
    const expired = await signWith(env.JWT_SECRET, {
      sub,
      sid,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    assert.equal((await get('/authenticated', expired)).status, 401);
  });

  it('wrong audience', async () => {
    const { sub, sid } = decode(tokens.STUDENT!);
    assert.equal(
      (await get('/authenticated', await signWith(env.JWT_SECRET, { sub, sid, aud: 'other-app' })))
        .status,
      401,
    );
  });

  it('valid signature but a session id that belongs to someone else', async () => {
    const student = decode(tokens.STUDENT!);
    const admin = decode(tokens.ADMIN!);
    const forged = await signWith(env.JWT_SECRET, { sub: student.sub, sid: admin.sid });
    assert.equal((await get('/authenticated', forged)).status, 401);
  });

  it('account disabled after the token was issued', async () => {
    const { sub } = decode(tokens.FACULTY!);
    await prisma.user.update({ where: { id: sub }, data: { status: 'SUSPENDED' } });
    assert.equal((await get('/authenticated', tokens.FACULTY)).status, 401);
  });

  it('a valid token passes', async () => {
    assert.equal((await get('/authenticated', tokens.STUDENT)).status, 200);
  });
});

describe('role middleware', () => {
  it('student → admin-only route: 403', async () => {
    const response = await get('/admin-only', tokens.STUDENT);
    assert.equal(response.status, 403);
    assert.equal(response.body.error?.code, 'FORBIDDEN');
  });

  it('faculty → super-admin-only route: 403', async () => {
    assert.equal((await get('/super-admin-only', tokens.FACULTY)).status, 403);
  });

  it('admin → super-admin-only route: 403', async () => {
    assert.equal((await get('/super-admin-only', tokens.ADMIN)).status, 403);
  });

  it('admin and super admin → admin-only route: 200; super admin → super-admin-only: 200', async () => {
    assert.equal((await get('/admin-only', tokens.ADMIN)).status, 200);
    assert.equal((await get('/admin-only', tokens.SUPER_ADMIN)).status, 200);
    assert.equal((await get('/super-admin-only', tokens.SUPER_ADMIN)).status, 200);
  });

  it('uses current database roles, not the roles at login time', async () => {
    const { sub } = decode(tokens.ADMIN!);
    await prisma.userRole.deleteMany({ where: { userId: sub } });
    assert.equal((await get('/admin-only', tokens.ADMIN)).status, 403);
  });
});

describe('permission middleware', () => {
  it('missing permission → 403; granted permission → 200', async () => {
    assert.equal((await get('/manage-courses', tokens.STUDENT)).status, 403);
    assert.equal((await get('/manage-courses', tokens.FACULTY)).status, 403);
    assert.equal((await get('/manage-courses', tokens.ADMIN)).status, 200);
    // admins.manage is SUPER_ADMIN-only (least privilege).
    assert.equal((await get('/manage-admins', tokens.ADMIN)).status, 403);
    assert.equal((await get('/manage-admins', tokens.SUPER_ADMIN)).status, 200);
  });

  it('a permission granted to a role at runtime takes effect on the next request', async () => {
    const [role, permission] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { key: 'STUDENT' } }),
      prisma.permission.findUniqueOrThrow({ where: { key: PERMISSIONS.COURSES_MANAGE } }),
    ]);
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    assert.equal((await get('/manage-courses', tokens.STUDENT)).status, 200);
  });
});

describe('resource ownership policy (faculty ↔ assigned course)', () => {
  it('faculty may manage content only of courses they are assigned to; admins of any', async () => {
    const assigned = await prisma.course.create({
      data: { title: 'Assigned', slug: `assigned-${Date.now()}` },
    });
    const other = await prisma.course.create({
      data: { title: 'Other', slug: `other-${Date.now()}` },
    });
    const faculty = await prisma.facultyProfile.findFirstOrThrow({
      where: { userId: decode(tokens.FACULTY!).sub },
    });
    await prisma.courseInstructor.create({
      data: { courseId: assigned.id, facultyProfileId: faculty.id },
    });

    assert.equal((await get(`/course/${assigned.id}/content`, tokens.FACULTY)).status, 200);
    assert.equal((await get(`/course/${other.id}/content`, tokens.FACULTY)).status, 403);
    assert.equal((await get(`/course/${other.id}/content`, tokens.ADMIN)).status, 200);
    assert.equal((await get(`/course/${assigned.id}/content`, tokens.STUDENT)).status, 403);
  });
});

describe('GET /auth/me', () => {
  it('returns the current user with roles and permissions and no secrets', async () => {
    const client = new TestClient(apiUrl);
    const response = await client.request<{
      email: string;
      roles: string[];
      permissions: string[];
    }>('GET', '/auth/me', { token: tokens.ADMIN });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.roles, ['ADMIN']);
    assert.ok(response.body.data.permissions.includes(PERMISSIONS.COURSES_MANAGE));
    assert.ok(!response.body.data.permissions.includes(PERMISSIONS.ADMINS_MANAGE));
    // The admin UI builds its navigation from this list, so Super Admin-only areas must be absent.
    for (const key of [
      PERMISSIONS.ROLES_MANAGE,
      PERMISSIONS.AUDIT_LOGS_VIEW,
      PERMISSIONS.SYSTEM_MANAGE,
    ]) {
      assert.ok(!response.body.data.permissions.includes(key), key);
    }
    assert.doesNotMatch(response.text, /passwordHash|argon2|tokenHash/);
    assert.equal(
      Object.keys(response.body.data).sort().join(','),
      'email,emailVerified,fullName,id,permissions,roles',
    );
  });

  it('a Super Admin receives every permission (the full Administration section)', async () => {
    const client = new TestClient(apiUrl);
    const response = await client.request<{ permissions: string[] }>('GET', '/auth/me', {
      token: tokens.SUPER_ADMIN,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      [...response.body.data.permissions].sort(),
      [...Object.values(PERMISSIONS)].sort(),
    );
  });

  it('identity comes from the token, not from client input', async () => {
    const client = new TestClient(apiUrl);
    const student = await client.request<{ roles: string[] }>(
      'GET',
      '/auth/me?userId=someone-else',
      {
        token: tokens.STUDENT,
        headers: { 'x-user-id': decode(tokens.SUPER_ADMIN!).sub },
      },
    );
    assert.deepEqual(student.body.data.roles, ['STUDENT']);
  });
});

describe('provisioned accounts', () => {
  it('provisioned users get the right profile and a pre-verified email', async () => {
    const faculty = await provision('FACULTY');
    const admin = await provision('ADMIN');
    assert.ok(await prisma.facultyProfile.findUnique({ where: { userId: faculty.id } }));
    assert.equal(await prisma.studentProfile.count({ where: { userId: admin.id } }), 0);
    assert.ok(faculty.emailVerifiedAt);
    assert.ok(PASSWORD);
  });
});

function decode(token: string): { sub: string; sid: string } {
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  // Claims are minimal: no roles, email or profile data in the token.
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
  return { sub: String(payload.sub), sid: String(payload.sid) };
}
