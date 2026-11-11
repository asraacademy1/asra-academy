/**
 * Public Participate access and verified quiz registration over real HTTP and PostgreSQL:
 *   - Public listings return ONLY PUBLISHED + PUBLIC quizzes split accurately into live vs upcoming
 *   - DRAFT, PRIVATE, CLOSED, and ENDED quizzes are excluded from open quiz listings
 *   - Public detail `/participate/quizzes/:slug` allows anonymous viewing of safe public data
 *     while blocking DRAFT and PRIVATE quizzes (404) and never leaking questions/keys/attempts
 *   - Admin can toggle `visibility` (`PUBLIC` <-> `PRIVATE`) even after publication
 *   - Registration strictly enforces auth (401), DB email verification (403), student permission
 *     (403), quiz status/deadline/eligibility (409), hidden/draft rejection (404), strict payload,
 *     and duplicate/concurrent registration safety (DB unique constraint + 409)
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type {
  AdminAcademyQuizDetail,
  Paginated,
  PublicAcademyQuizDetail,
  PublicAcademyQuizItem,
  PublicParticipateActivitiesDto,
  PublicParticipateSummaryDto,
  PublicSitemapQuiz,
  QuizRegistrationResultDto,
  QuizRegistrationStatusDto,
} from '@asra/types';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { at, mcq, newStudent, plusMinutes, type Student } from './support/assessment.js';
import { login, provision, resetAuthState } from './support/auth.js';
import { apiAs, createAcademicBasics, expectStatus, type Api } from './support/catalog.js';
import { startServer, TestClient } from './support/http.js';

let baseUrl: string;
let close: () => Promise<void>;
let anon: TestClient;
let admin: Api;
let sam: Student;
let una: Student;

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
  admin = apiAs(client, (await login(client, adminUser.email)).accessToken);
  [sam, una] = [await newStudent(baseUrl), await newStudent(baseUrl)];
});

const T0 = new Date('2026-12-01T04:30:00.000Z');
const ADMIN = '/admin/academy-quizzes';
const PUBLIC = '/participate';

async function createQuiz(
  overrides: Record<string, unknown> = {},
  options: { publish?: boolean } = {},
) {
  at(T0);
  const startsAt = plusMinutes(T0, 60);
  const endsAt = plusMinutes(T0, 180);
  const created = await admin<AdminAcademyQuizDetail>('POST', ADMIN, {
    title: `Quiz ${Math.random().toString(36).slice(2, 8)}`,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    durationMinutes: 30,
    summary: 'Open academic quiz summary',
    description: 'Detailed public announcement for students.',
    instructions: 'Read all instructions carefully.',
    prizes: [{ position: 1, title: 'Gold Medal & Certificate', description: 'Top scorer' }],
    ...overrides,
  });
  expectStatus(created, 201);
  const quiz = created.body.data;
  expectStatus(
    await admin('POST', `${ADMIN}/${quiz.id}/questions`, {
      ...mcq(2),
      prompt: 'Secret question stem that must never leak',
      explanation: 'Secret solution explanation',
    }),
    201,
  );
  if (options.publish !== false) {
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'publish' }), 200);
  }
  return quiz;
}

describe('Public Participate access & visibility', () => {
  it('lists only published PUBLIC quizzes partitioned into live and upcoming', async () => {
    const liveQuiz = await createQuiz({
      title: 'Live Science Quiz',
      slug: 'live-science-quiz',
      startsAt: plusMinutes(T0, 10).toISOString(),
      endsAt: plusMinutes(T0, 120).toISOString(),
    });
    const upcomingQuiz = await createQuiz({
      title: 'Upcoming Math Olympiad',
      slug: 'upcoming-math-olympiad',
      startsAt: plusMinutes(T0, 180).toISOString(),
      endsAt: plusMinutes(T0, 300).toISOString(),
    });
    await createQuiz({
      title: 'Hidden Private Quiz',
      slug: 'hidden-private-quiz',
      visibility: 'PRIVATE',
      startsAt: plusMinutes(T0, 10).toISOString(),
      endsAt: plusMinutes(T0, 120).toISOString(),
    });
    await createQuiz(
      {
        title: 'Unpublished Draft Quiz',
        slug: 'unpublished-draft-quiz',
        startsAt: plusMinutes(T0, 10).toISOString(),
        endsAt: plusMinutes(T0, 120).toISOString(),
      },
      { publish: false },
    );

    // Move clock into [10m, 120m): liveQuiz is LIVE, upcomingQuiz is UPCOMING
    at(plusMinutes(T0, 30));

    const summary = await anon.request<PublicParticipateSummaryDto>('GET', `${PUBLIC}/summary`);
    expectStatus(summary, 200);
    assert.deepEqual(summary.body.data, {
      liveQuizzesCount: 1,
      upcomingQuizzesCount: 1,
      competitionsCount: 0,
      assessmentsCount: 0,
    });

    const activities = await anon.request<PublicParticipateActivitiesDto>(
      'GET',
      `${PUBLIC}/activities`,
    );
    expectStatus(activities, 200);
    assert.deepEqual(
      activities.body.data.liveQuizzes.map((q) => q.slug),
      [liveQuiz.slug],
    );
    assert.deepEqual(
      activities.body.data.upcomingQuizzes.map((q) => q.slug),
      [upcomingQuiz.slug],
    );
    assert.equal(activities.body.data.competitions.length, 0);
    assert.equal(activities.body.data.assessments.length, 0);

    const liveRes = await anon.request<Paginated<PublicAcademyQuizItem>>(
      'GET',
      `${PUBLIC}/quizzes?status=live`,
    );
    expectStatus(liveRes, 200);
    assert.deepEqual(
      liveRes.body.data.items.map((q) => q.slug),
      [liveQuiz.slug],
    );

    const upcomingRes = await anon.request<Paginated<PublicAcademyQuizItem>>(
      'GET',
      `${PUBLIC}/quizzes?status=upcoming`,
    );
    expectStatus(upcomingRes, 200);
    assert.deepEqual(
      upcomingRes.body.data.items.map((q) => q.slug),
      [upcomingQuiz.slug],
    );

    const sitemap = await anon.request<PublicSitemapQuiz[]>('GET', '/sitemap/academy-quizzes');
    expectStatus(sitemap, 200);
    assert.deepEqual(
      sitemap.body.data.map((s) => s.slug).sort(),
      [liveQuiz.slug, upcomingQuiz.slug].sort(),
    );
  });

  it('serves safe public quiz detail without auth and blocks draft, private, and secret fields', async () => {
    const pub = await createQuiz({
      title: 'Quizora 2026',
      slug: 'quizora-2026',
      startsAt: plusMinutes(T0, 60).toISOString(),
      endsAt: plusMinutes(T0, 180).toISOString(),
    });
    const priv = await createQuiz({
      title: 'Private Test',
      slug: 'private-test',
      visibility: 'PRIVATE',
    });
    const draft = await createQuiz({ title: 'Draft Test', slug: 'draft-test' }, { publish: false });

    at(plusMinutes(T0, 10));
    const detail = await anon.request<PublicAcademyQuizDetail>(
      'GET',
      `${PUBLIC}/quizzes/${pub.slug}`,
    );
    expectStatus(detail, 200);
    assert.equal(detail.body.data.title, 'Quizora 2026');
    assert.equal(detail.body.data.phase, 'UPCOMING');
    assert.equal(detail.body.data.registrationOpen, true);
    assert.equal(detail.body.data.prizes[0]?.title, 'Gold Medal & Certificate');
    assert.equal(detail.body.data.questionsPerAttempt, 1);
    // Must never leak question text, answer keys, explanations, or admin fields
    assert.ok(!detail.text.includes('Secret question stem'));
    assert.ok(!detail.text.includes('Secret solution explanation'));
    assert.ok(!detail.text.includes('isCorrect'));
    assert.ok(!detail.text.includes('publishProblems'));

    // Draft and private return 404
    expectStatus(await anon.request('GET', `${PUBLIC}/quizzes/${priv.slug}`), 404);
    expectStatus(await anon.request('GET', `${PUBLIC}/quizzes/${draft.slug}`), 404);
    expectStatus(await anon.request('GET', `${PUBLIC}/quizzes/nonexistent-slug`), 404);

    // Admin can toggle published quiz from PUBLIC -> PRIVATE and hide it immediately
    const toggled = await admin<AdminAcademyQuizDetail>('PATCH', `${ADMIN}/${pub.id}`, {
      visibility: 'PRIVATE',
    });
    expectStatus(toggled, 200);
    assert.equal(toggled.body.data.settings.visibility, 'PRIVATE');
    expectStatus(await anon.request('GET', `${PUBLIC}/quizzes/${pub.slug}`), 404);
  });

  it('keeps closed public quiz viewable with registration disabled, while excluding it from open listings', async () => {
    const pub = await createQuiz({
      title: 'Closable Quiz',
      slug: 'closable-quiz',
      startsAt: plusMinutes(T0, 10).toISOString(),
      endsAt: plusMinutes(T0, 120).toISOString(),
    });
    at(plusMinutes(T0, 20));
    expectStatus(await admin('POST', `${ADMIN}/${pub.id}/status`, { action: 'close' }), 200);

    const openList = await anon.request<Paginated<PublicAcademyQuizItem>>(
      'GET',
      `${PUBLIC}/quizzes?status=all`,
    );
    expectStatus(openList, 200);
    assert.equal(openList.body.data.items.length, 0);

    const detail = await anon.request<PublicAcademyQuizDetail>(
      'GET',
      `${PUBLIC}/quizzes/${pub.slug}`,
    );
    expectStatus(detail, 200);
    assert.equal(detail.body.data.phase, 'CLOSED');
    assert.equal(detail.body.data.registrationOpen, false);
    assert.ok(detail.body.data.registrationClosedReason);
  });
});

describe('Verified quiz registration enforcement', () => {
  it('enforces auth (401), verified email (403), student role (403), and hidden quizzes (404)', async () => {
    const pub = await createQuiz({ slug: 'auth-check-quiz' });
    const priv = await createQuiz({ slug: 'auth-private-quiz', visibility: 'PRIVATE' });
    const draft = await createQuiz({ slug: 'auth-draft-quiz' }, { publish: false });
    at(plusMinutes(T0, 10));

    // Unauthenticated
    expectStatus(await anon.request('GET', `${PUBLIC}/quizzes/${pub.slug}/registration`), 401);
    expectStatus(
      await anon.request('POST', `${PUBLIC}/quizzes/${pub.slug}/register`, { body: {} }),
      401,
    );

    // Extra fields rejected strictly
    expectStatus(
      await sam.api('POST', `${PUBLIC}/quizzes/${pub.slug}/register`, { userId: una.userId }),
      422,
    );

    // Admin account rejected as non-student
    const adminReg = await admin('POST', `${PUBLIC}/quizzes/${pub.slug}/register`, {});
    expectStatus(adminReg, 403);

    // Unverified student account rejected with 403 EMAIL_NOT_VERIFIED (fresh DB check)
    await prisma.user.update({ where: { id: sam.userId }, data: { emailVerifiedAt: null } });
    const unverifiedStatus = await sam.api<QuizRegistrationStatusDto>(
      'GET',
      `${PUBLIC}/quizzes/${pub.slug}/registration`,
    );
    expectStatus(unverifiedStatus, 200);
    assert.equal(unverifiedStatus.body.data.emailVerified, false);
    assert.equal(unverifiedStatus.body.data.canRegister, false);
    assert.equal(unverifiedStatus.body.data.blockedCode, 'EMAIL_NOT_VERIFIED');

    const unverifiedPost = await sam.api('POST', `${PUBLIC}/quizzes/${pub.slug}/register`, {});
    expectStatus(unverifiedPost, 403);
    assert.equal(unverifiedPost.body.error?.code, 'EMAIL_NOT_VERIFIED');

    // Private and draft return 404 even for verified student
    expectStatus(await una.api('GET', `${PUBLIC}/quizzes/${priv.slug}/registration`), 404);
    expectStatus(await una.api('POST', `${PUBLIC}/quizzes/${priv.slug}/register`, {}), 404);
    expectStatus(await una.api('GET', `${PUBLIC}/quizzes/${draft.slug}/registration`), 404);
    expectStatus(await una.api('POST', `${PUBLIC}/quizzes/${draft.slug}/register`, {}), 404);
  });

  it('registers eligible verified students once, blocks concurrent duplicates, and updates admin count', async () => {
    const pub = await createQuiz({ slug: 'concurrent-reg-quiz' });
    at(plusMinutes(T0, 10));

    const beforeStatus = await sam.api<QuizRegistrationStatusDto>(
      'GET',
      `${PUBLIC}/quizzes/${pub.slug}/registration`,
    );
    expectStatus(beforeStatus, 200);
    assert.equal(beforeStatus.body.data.registered, false);
    assert.equal(beforeStatus.body.data.canRegister, true);

    // Concurrent registration attempts -> strictly 1 succeeds (201) and 1 gets 409 CONFLICT
    const [r1, r2] = await Promise.all([
      sam.api<QuizRegistrationResultDto>('POST', `${PUBLIC}/quizzes/${pub.slug}/register`, {}),
      sam.api<QuizRegistrationResultDto>('POST', `${PUBLIC}/quizzes/${pub.slug}/register`, {}),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409]);

    const afterStatus = await sam.api<QuizRegistrationStatusDto>(
      'GET',
      `${PUBLIC}/quizzes/${pub.slug}/registration`,
    );
    expectStatus(afterStatus, 200);
    assert.equal(afterStatus.body.data.registered, true);
    assert.equal(afterStatus.body.data.blockedCode, 'ALREADY_REGISTERED');
    assert.equal(afterStatus.body.data.canRegister, false);

    // Registration must NOT create an assessment attempt
    assert.equal(
      await prisma.academyQuizRegistration.count({ where: { quizId: pub.id, userId: sam.userId } }),
      1,
    );
    assert.equal(
      await prisma.assessmentAttempt.count({
        where: { academyQuizId: pub.id, userId: sam.userId },
      }),
      0,
    );

    const adminDetail = await admin<AdminAcademyQuizDetail>('GET', `${ADMIN}/${pub.id}`);
    expectStatus(adminDetail, 200);
    assert.equal(adminDetail.body.data.registrationsCount, 1);

    // Existing attempt flow still works once the quiz goes LIVE
    at(plusMinutes(T0, 70));
    const started = await sam.api('POST', `/student/academy-quizzes/${pub.slug}/attempts`, {
      acceptedInstructions: true,
    });
    expectStatus(started, 201);
  });

  it('rejects registrations when quiz is closed, past deadline, or student is ineligible', async () => {
    const basics = await createAcademicBasics(admin);
    const restricted = await createQuiz({
      slug: 'class-restricted-quiz',
      eligibleClassIds: [basics.classId],
      startsAt: plusMinutes(T0, 10).toISOString(),
      endsAt: plusMinutes(T0, 60).toISOString(),
    });
    at(plusMinutes(T0, 20));

    // Ineligible class
    const ineligStatus = await sam.api<QuizRegistrationStatusDto>(
      'GET',
      `${PUBLIC}/quizzes/${restricted.slug}/registration`,
    );
    expectStatus(ineligStatus, 200);
    assert.equal(ineligStatus.body.data.blockedCode, 'NOT_ELIGIBLE');
    expectStatus(await sam.api('POST', `${PUBLIC}/quizzes/${restricted.slug}/register`, {}), 409);

    // Assign eligible class to Sam, then verify open quiz registration succeeds for Una -> test ended
    await prisma.studentProfile.upsert({
      where: { userId: sam.userId },
      create: { userId: sam.userId, classId: basics.classId },
      update: { classId: basics.classId },
    });

    // Advance past endsAt -> past deadline rejected (409)
    at(plusMinutes(T0, 65));
    const endedStatus = await sam.api<QuizRegistrationStatusDto>(
      'GET',
      `${PUBLIC}/quizzes/${restricted.slug}/registration`,
    );
    expectStatus(endedStatus, 200);
    assert.equal(endedStatus.body.data.blockedCode, 'QUIZ_ENDED');
    expectStatus(await sam.api('POST', `${PUBLIC}/quizzes/${restricted.slug}/register`, {}), 409);

    // Closed quiz rejected (409)
    const closable = await createQuiz({
      slug: 'closed-reg-quiz',
      startsAt: plusMinutes(T0, 10).toISOString(),
      endsAt: plusMinutes(T0, 120).toISOString(),
    });
    at(plusMinutes(T0, 20));
    expectStatus(await admin('POST', `${ADMIN}/${closable.id}/status`, { action: 'close' }), 200);
    expectStatus(await una.api('POST', `${PUBLIC}/quizzes/${closable.slug}/register`, {}), 409);
  });
});
