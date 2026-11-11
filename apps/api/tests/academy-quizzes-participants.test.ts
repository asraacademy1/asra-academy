/**
 * Admin Academic Quiz Participants Management over real HTTP and PostgreSQL:
 *   - Source of truth is AcademyQuizRegistration (registered students without attempts still appear)
 *   - Strict quiz scoping (no cross-quiz participant leakage)
 *   - Search (name & email), verification filter, sort (newest/oldest), and backend pagination
 *   - CSV export with RFC 4180 escaping & spreadsheet formula injection protection
 *   - Strict admin authorization (`academy_quizzes.manage`) and clean empty/404/422 states
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  PERMISSIONS,
  type AdminAcademyParticipantsPage,
  type AdminAcademyQuizDetail,
} from '@asra/types';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { sanitizeCsvCell } from '../src/modules/academy-quizzes/participants.service.js';
import {
  at,
  mcq,
  newFaculty,
  newStudent,
  plusMinutes,
  type Faculty,
  type Student,
} from './support/assessment.js';
import { login, provision, resetAuthState } from './support/auth.js';
import { apiAs, expectStatus, type Api } from './support/catalog.js';
import { startServer, TestClient } from './support/http.js';

let baseUrl: string;
let close: () => Promise<void>;
let anon: TestClient;
let admin: Api;
let adminToken: string;
let faculty: Faculty;
let sam: Student;
let una: Student;
let bob: Student;

before(async () => {
  ({ baseUrl, close } = await startServer(createApp()));
});

after(async () => {
  setClockForTests(null);
  await close();
  await Promise.all([disconnectPrisma(), disconnectRedis()]);
});

beforeEach(async () => {
  setClockForTests(null);
  await resetAuthState();
  anon = new TestClient(baseUrl);
  const adminUser = await provision('ADMIN');
  const client = new TestClient(baseUrl);
  adminToken = (await login(client, adminUser.email)).accessToken;
  admin = apiAs(client, adminToken);
  faculty = await newFaculty(baseUrl);
  [sam, una, bob] = await Promise.all([
    newStudent(baseUrl),
    newStudent(baseUrl),
    newStudent(baseUrl),
  ]);
});

const T0 = new Date('2026-12-01T04:30:00.000Z');
const ADMIN = '/admin/academy-quizzes';

async function createPublishedQuiz(slug: string) {
  at(T0);
  const created = await admin<AdminAcademyQuizDetail>('POST', ADMIN, {
    title: `Quiz ${slug}`,
    slug,
    startsAt: plusMinutes(T0, 60).toISOString(),
    endsAt: plusMinutes(T0, 180).toISOString(),
    durationMinutes: 30,
  });
  expectStatus(created, 201);
  const quiz = created.body.data;
  expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/questions`, mcq(2)), 201);
  expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'publish' }), 200);
  return quiz;
}

describe('Admin Quiz Participants endpoint & CSV export', () => {
  it('enforces academy_quizzes.manage permission and validates quiz id', async () => {
    const quiz = await createPublishedQuiz('auth-participants-quiz');

    expectStatus(await anon.request('GET', `${ADMIN}/${quiz.id}/participants`), 401);
    expectStatus(await anon.request('GET', `${ADMIN}/${quiz.id}/participants/export`), 401);
    expectStatus(await sam.api('GET', `${ADMIN}/${quiz.id}/participants`), 403);
    expectStatus(await faculty.api('GET', `${ADMIN}/${quiz.id}/participants`), 403);
    expectStatus(await faculty.api('GET', `${ADMIN}/${quiz.id}/participants/export`), 403);

    // An admin without academy_quizzes.manage is refused
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: PERMISSIONS.ACADEMY_QUIZZES_MANAGE },
    });
    const limitedUser = await provision('ADMIN');
    await prisma.rolePermission.deleteMany({ where: { permissionId: permission.id } });
    const limitedClient = new TestClient(baseUrl);
    const limitedAdmin = apiAs(
      limitedClient,
      (await login(limitedClient, limitedUser.email)).accessToken,
    );
    expectStatus(await limitedAdmin('GET', `${ADMIN}/${quiz.id}/participants`), 403);
    expectStatus(await limitedAdmin('GET', `${ADMIN}/${quiz.id}/participants/export`), 403);

    // Restore permission for remaining checks
    const adminUser = await provision('ADMIN');
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'ADMIN' } });
    await prisma.rolePermission.createMany({
      data: [{ roleId: adminRole.id, permissionId: permission.id }],
      skipDuplicates: true,
    });
    const restoredClient = new TestClient(baseUrl);
    const restoredAdmin = apiAs(
      restoredClient,
      (await login(restoredClient, adminUser.email)).accessToken,
    );
    expectStatus(
      await restoredAdmin('GET', `${ADMIN}/00000000-0000-0000-0000-000000000000/participants`),
      404,
    );
    expectStatus(await restoredAdmin('GET', `${ADMIN}/not-a-uuid/participants`), 422);
  });

  it('returns empty state cleanly when no students are registered', async () => {
    const quiz = await createPublishedQuiz('empty-participants-quiz');
    const res = await admin<AdminAcademyParticipantsPage>(
      'GET',
      `${ADMIN}/${quiz.id}/participants`,
    );
    expectStatus(res, 200);
    assert.deepEqual(res.body.data, {
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
      totalRegistered: 0,
    });
  });

  it('lists registered students without attempts, prevents cross-quiz leakage, and supports search/filter/sort/pagination', async () => {
    const quizA = await createPublishedQuiz('quiz-alpha');
    const quizB = await createPublishedQuiz('quiz-beta');

    // Update profile metadata so search/phone/verification cases are realistic
    await prisma.user.update({
      where: { id: sam.userId },
      data: { fullName: 'Aarav Khan', phone: '+919876543210' },
    });
    await prisma.user.update({
      where: { id: una.userId },
      data: { fullName: 'Zoya Fatima', phone: null },
    });
    await prisma.user.update({
      where: { id: bob.userId },
      data: { fullName: 'Other Quiz Student' },
    });

    at(plusMinutes(T0, 10));
    expectStatus(await sam.api('POST', `/participate/quizzes/${quizA.slug}/register`, {}), 201);
    at(plusMinutes(T0, 20));
    expectStatus(await una.api('POST', `/participate/quizzes/${quizA.slug}/register`, {}), 201);
    at(plusMinutes(T0, 25));
    expectStatus(await bob.api('POST', `/participate/quizzes/${quizB.slug}/register`, {}), 201);

    // Zero attempts created: registrations must still appear!
    assert.equal(await prisma.assessmentAttempt.count({ where: { academyQuizId: quizA.id } }), 0);

    // Simulate one unverified user in DB post-registration for verification filtering
    await prisma.user.update({
      where: { id: una.userId },
      data: { emailVerifiedAt: null },
    });

    // Default sort (newest first) + quiz isolation (bob from quizB never appears)
    const listNewest = await admin<AdminAcademyParticipantsPage>(
      'GET',
      `${ADMIN}/${quizA.id}/participants`,
    );
    expectStatus(listNewest, 200);
    assert.equal(listNewest.body.data.totalRegistered, 2);
    assert.equal(listNewest.body.data.total, 2);
    assert.equal(listNewest.body.data.totalPages, 1);
    assert.deepEqual(
      listNewest.body.data.items.map((i) => i.studentName),
      ['Zoya Fatima', 'Aarav Khan'],
    );
    assert.equal(listNewest.body.data.items[1]?.phone, '+919876543210');
    assert.equal(listNewest.body.data.items[1]?.emailVerified, true);
    assert.equal(listNewest.body.data.items[1]?.status, 'REGISTERED');
    assert.equal(listNewest.body.data.items[0]?.emailVerified, false);
    assert.ok(!listNewest.text.includes('passwordHash'));

    // Sort oldest first
    const listOldest = await admin<AdminAcademyParticipantsPage>(
      'GET',
      `${ADMIN}/${quizA.id}/participants?sort=oldest`,
    );
    expectStatus(listOldest, 200);
    assert.deepEqual(
      listOldest.body.data.items.map((i) => i.studentName),
      ['Aarav Khan', 'Zoya Fatima'],
    );

    // Pagination (page=2, limit=1)
    const page2 = await admin<AdminAcademyParticipantsPage>(
      'GET',
      `${ADMIN}/${quizA.id}/participants?sort=oldest&page=2&limit=1`,
    );
    expectStatus(page2, 200);
    assert.equal(page2.body.data.page, 2);
    assert.equal(page2.body.data.limit, 1);
    assert.equal(page2.body.data.totalPages, 2);
    assert.equal(page2.body.data.totalRegistered, 2);
    assert.deepEqual(
      page2.body.data.items.map((i) => i.studentName),
      ['Zoya Fatima'],
    );

    // Search by name & by email
    const searchName = await admin<AdminAcademyParticipantsPage>(
      'GET',
      `${ADMIN}/${quizA.id}/participants?search=aarav`,
    );
    expectStatus(searchName, 200);
    assert.deepEqual(
      searchName.body.data.items.map((i) => i.studentName),
      ['Aarav Khan'],
    );
    assert.equal(searchName.body.data.total, 1);
    assert.equal(searchName.body.data.totalRegistered, 2);

    const searchEmail = await admin<AdminAcademyParticipantsPage>(
      'GET',
      `${ADMIN}/${quizA.id}/participants?search=${encodeURIComponent(una.email.split('@')[0]!)}`,
    );
    expectStatus(searchEmail, 200);
    assert.deepEqual(
      searchEmail.body.data.items.map((i) => i.studentName),
      ['Zoya Fatima'],
    );

    // Filter by verificationStatus
    const verifiedOnly = await admin<AdminAcademyParticipantsPage>(
      'GET',
      `${ADMIN}/${quizA.id}/participants?verificationStatus=VERIFIED`,
    );
    expectStatus(verifiedOnly, 200);
    assert.deepEqual(
      verifiedOnly.body.data.items.map((i) => i.studentName),
      ['Aarav Khan'],
    );

    const unverifiedOnly = await admin<AdminAcademyParticipantsPage>(
      'GET',
      `${ADMIN}/${quizA.id}/participants?verificationStatus=UNVERIFIED`,
    );
    expectStatus(unverifiedOnly, 200);
    assert.deepEqual(
      unverifiedOnly.body.data.items.map((i) => i.studentName),
      ['Zoya Fatima'],
    );

    // Quiz B contains only Bob
    const quizBList = await admin<AdminAcademyParticipantsPage>(
      'GET',
      `${ADMIN}/${quizB.id}/participants`,
    );
    expectStatus(quizBList, 200);
    assert.deepEqual(
      quizBList.body.data.items.map((i) => i.studentName),
      ['Other Quiz Student'],
    );
  });

  it('exports quiz participants as CSV with formula-injection protection', async () => {
    const quiz = await createPublishedQuiz('csv-export-quiz');
    const evilName = '=HYPERLINK("https://evil.test","Click")';
    await prisma.user.update({
      where: { id: sam.userId },
      data: { fullName: evilName, phone: '+919876543210' },
    });
    at(plusMinutes(T0, 10));
    expectStatus(await sam.api('POST', `/participate/quizzes/${quiz.slug}/register`, {}), 201);

    // Bob registers on another quiz and must never appear in this quiz's export
    const other = await createPublishedQuiz('csv-other-quiz');
    await prisma.user.update({ where: { id: bob.userId }, data: { fullName: 'Bob Other' } });
    expectStatus(await bob.api('POST', `/participate/quizzes/${other.slug}/register`, {}), 201);

    const exported = await fetch(`${baseUrl}/api/v1${ADMIN}/${quiz.id}/participants/export`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const csvText = await exported.text();
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type') ?? '', /^text\/csv/);
    assert.match(
      exported.headers.get('content-disposition') ?? '',
      /attachment; filename="participants-csv-export-quiz\.csv"/,
    );
    assert.equal(exported.headers.get('cache-control'), 'no-store');
    assert.ok(csvText.includes('Student Name,Email,Phone,Registration Date,Verification Status'));
    assert.ok(csvText.includes('"\'=HYPERLINK(""https://evil.test"",""Click"")"'));
    assert.ok(csvText.includes('"\'+919876543210"'));
    assert.ok(csvText.includes('Verified'));
    assert.ok(!csvText.includes('Bob Other'));
  });

  it('neutralizes CSV formula triggers and escapes quotes/commas/newlines safely', () => {
    assert.equal(sanitizeCsvCell(null), '');
    assert.equal(sanitizeCsvCell('Rahul Sharma'), 'Rahul Sharma');
    assert.equal(sanitizeCsvCell('=1+1'), '"\'=1+1"');
    assert.equal(sanitizeCsvCell('+cmd|"/C calc"!A0'), '"\'+cmd|""/C calc""!A0"');
    assert.equal(sanitizeCsvCell('-2+3'), '"\'-2+3"');
    assert.equal(sanitizeCsvCell('@SUM(1,2)'), '"\'@SUM(1,2)"');
    assert.equal(sanitizeCsvCell('\t=1'), '"\'\t=1"');
    assert.equal(sanitizeCsvCell('  =1'), '"\'  =1"');
    assert.equal(sanitizeCsvCell('Sharma, Priya'), '"Sharma, Priya"');
  });
});
