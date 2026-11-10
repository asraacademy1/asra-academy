/**
 * Academy Quizzes — leaderboard, admin attempt management, student results and the full
 * lifecycle, over real HTTP and the real database. The server clock is pinned with `at()`.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type {
  AdminAcademyAttemptDetail,
  AdminAcademyAttemptItem,
  AdminAcademyLeaderboardDto,
  Paginated,
  StudentAcademyLeaderboardDto,
  StudentAcademyResultItem,
  StudentAssessmentResultItem,
} from '@asra/types';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { disconnectRedis } from '../src/lib/redis.js';
import {
  maskName,
  pickPerStudent,
  rankEntries,
} from '../src/modules/academy-quizzes/leaderboard.js';
import {
  ADMIN,
  ATTEMPTS,
  ENDS,
  STARTS,
  STUDENT,
  answerQuestion,
  publishedQuiz,
  startAttempt,
  takeQuiz,
} from './support/academy.js';
import { at, newFaculty, newStudent, plusMinutes, type Student } from './support/assessment.js';
import { login, provision, resetAuthState } from './support/auth.js';
import { apiAs, expectStatus, type Api } from './support/catalog.js';
import { startServer, TestClient } from './support/http.js';

let baseUrl: string;
let close: () => Promise<void>;
let admin: Api;
let superAdmin: Api;
let sam: Student;
let una: Student;
let tara: Student;

async function signIn(role: 'ADMIN' | 'SUPER_ADMIN') {
  const user = await provision(role);
  const client = new TestClient(baseUrl);
  return apiAs(client, (await login(client, user.email)).accessToken);
}

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
  [admin, superAdmin] = [await signIn('ADMIN'), await signIn('SUPER_ADMIN')];
  [sam, una, tara] = [
    await newStudent(baseUrl),
    await newStudent(baseUrl),
    await newStudent(baseUrl),
  ];
  await prisma.user.update({ where: { id: sam.userId }, data: { fullName: 'Sam Rivera' } });
  await prisma.user.update({ where: { id: una.userId }, data: { fullName: 'Una Kapoor' } });
  await prisma.user.update({ where: { id: tara.userId }, data: { fullName: 'Tara Singh' } });
});

/** Tied rows share a rank; their order within the tie is not meaningful. */
const byRankThenName = <T extends { rank: number }>(rows: T[], name: (row: T) => string) =>
  [...rows].sort((a, b) => a.rank - b.rank || name(a).localeCompare(name(b)));

const sec = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

const leaderboard = async (student: Student, slug: string, limit = 50) => {
  const response = await student.api<StudentAcademyLeaderboardDto>(
    'GET',
    `${STUDENT}/${slug}/leaderboard?limit=${limit}`,
  );
  expectStatus(response, 200);
  return response;
};

describe('leaderboard rules (pure)', () => {
  const base = new Date('2026-12-01T05:00:00.000Z');
  const row = (
    attemptId: string,
    userId: string,
    scoreCents: number,
    seconds: number,
    attemptNumber = 1,
    startOffset = 0,
  ) => ({
    attemptId,
    userId,
    fullName: userId,
    attemptNumber,
    scoreCents,
    maxScoreCents: 600,
    percent: scoreCents / 6,
    startedAt: sec(base, startOffset),
    submittedAt: sec(base, startOffset + seconds),
  });

  it('ranks by score, then time taken; equal score and time share a rank (1, 2, 2, 4)', () => {
    const ranked = rankEntries(
      [
        row('a', 'u1', 400, 100),
        row('b', 'u2', 600, 300),
        row('c', 'u3', 400, 100),
        row('d', 'u4', 400, 50),
      ],
      'TIME_TAKEN',
    );
    assert.deepEqual(
      ranked.map((entry) => [entry.attemptId, entry.rank]),
      [
        ['b', 1],
        ['d', 2],
        ['a', 3],
        ['c', 3],
      ],
    );
    const four = rankEntries(
      [
        row('a', 'u1', 600, 10),
        row('b', 'u2', 400, 10),
        row('c', 'u3', 400, 10),
        row('d', 'u4', 200, 10),
      ],
      'TIME_TAKEN',
    );
    assert.deepEqual(
      four.map((entry) => entry.rank),
      [1, 2, 2, 4],
    );
  });

  it('SUBMITTED_AT breaks ties by the earlier submission, not the time taken', () => {
    // "slowFirst" took 300 s but submitted at +300 s; "fastLater" took 10 s, submitted at +110 s.
    const rows = [row('slowFirst', 'u1', 400, 300, 1, 0), row('fastLater', 'u2', 400, 10, 1, 100)];
    assert.deepEqual(
      rankEntries(rows, 'SUBMITTED_AT').map((entry) => entry.attemptId),
      ['fastLater', 'slowFirst'],
    );
    assert.deepEqual(
      rankEntries(rows, 'TIME_TAKEN').map((entry) => entry.attemptId),
      ['fastLater', 'slowFirst'],
    );
    const later = [row('a', 'u1', 400, 50, 1, 0), row('b', 'u2', 400, 10, 1, 100)];
    assert.deepEqual(
      rankEntries(later, 'SUBMITTED_AT').map((entry) => entry.attemptId),
      ['a', 'b'],
    );
    assert.deepEqual(
      rankEntries(later, 'TIME_TAKEN').map((entry) => entry.attemptId),
      ['b', 'a'],
    );
  });

  it('compares times in whole seconds, as displayed (sub-second differences tie)', () => {
    const a = { ...row('a', 'u1', 400, 0), submittedAt: new Date(base.getTime() + 120) };
    const b = { ...row('b', 'u2', 400, 0), submittedAt: new Date(base.getTime() + 380) };
    assert.deepEqual(
      rankEntries([a, b], 'TIME_TAKEN').map((entry) => [entry.rank, entry.timeTakenSeconds]),
      [
        [1, 0],
        [1, 0],
      ],
    );
    assert.deepEqual(
      rankEntries([a, b], 'SUBMITTED_AT').map((entry) => entry.rank),
      [1, 1],
    );
  });

  it('counts the BEST or the FIRST attempt of each student', () => {
    const rows = [
      row('a1', 'u1', 200, 50, 1),
      row('a2', 'u1', 600, 80, 2),
      row('b1', 'u2', 400, 60, 1),
    ];
    const best = pickPerStudent(rows, 'BEST', 'TIME_TAKEN')
      .map((entry) => entry.attemptId)
      .sort();
    assert.deepEqual(best, ['a2', 'b1']);
    const first = pickPerStudent(rows, 'FIRST', 'TIME_TAKEN')
      .map((entry) => entry.attemptId)
      .sort();
    assert.deepEqual(first, ['a1', 'b1']);
    // BEST with equal scores keeps the faster attempt.
    const tie = pickPerStudent(
      [row('x1', 'u1', 400, 90, 1), row('x2', 'u1', 400, 30, 2)],
      'BEST',
      'TIME_TAKEN',
    );
    assert.equal(tie[0]!.attemptId, 'x2');
  });

  it('masks names to initials', () => {
    assert.equal(maskName('Riya Sharma'), 'R. S.');
    assert.equal(maskName('  aarav  '), 'A.');
    assert.equal(maskName(''), 'Student');
  });
});

describe('leaderboard over HTTP', () => {
  /** Sam 3/3 in 5 min, Una 2/3 in 4 min, Tara 2/3 in 4 min (tie with Una). */
  async function contest(settings: Record<string, unknown> = {}) {
    const quiz = await publishedQuiz(admin, settings);
    await takeQuiz(sam, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 1),
      submitAt: plusMinutes(STARTS, 6),
    });
    await takeQuiz(una, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 2),
      submitAt: plusMinutes(STARTS, 6),
    });
    await takeQuiz(tara, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 3),
      submitAt: plusMinutes(STARTS, 7),
    });
    return quiz;
  }

  it('appears only after the quiz ends, ranks with ties, and leaks no ids or emails', async () => {
    const quiz = await contest();
    const early = await leaderboard(sam, quiz.slug);
    assert.equal(early.body.data.available, false);
    assert.match(early.body.data.unavailableReason!, /after the quiz ends/);
    assert.equal(early.body.data.entries.length, 0);

    at(ENDS);
    const response = await leaderboard(una, quiz.slug);
    const board = response.body.data;
    assert.equal(board.available, true);
    assert.equal(board.totalRanked, 3);
    assert.deepEqual(
      byRankThenName(board.entries, (e) => e.displayName).map((entry) => [
        entry.displayName,
        entry.rank,
        entry.score,
      ]),
      [
        ['Sam Rivera', 1, 6],
        ['Tara Singh', 2, 4],
        ['Una Kapoor', 2, 4],
      ],
    );
    assert.equal(board.me!.displayName, 'Una Kapoor');
    assert.equal(board.entries.filter((entry) => entry.isMe).length, 1);
    for (const secret of [sam.userId, tara.userId, sam.email, tara.email, 'userId', 'email']) {
      assert.ok(!response.text.includes(secret), `leaderboard must not contain ${secret}`);
    }

    // "me" is returned even when beyond the requested page.
    const top1 = (await leaderboard(tara, quiz.slug, 1)).body.data;
    assert.equal(top1.entries.length, 1);
    assert.equal(top1.me!.rank, 2);
  });

  it('masks names when configured', async () => {
    const quiz = await contest({ maskNames: true });
    at(ENDS);
    const board = (await leaderboard(sam, quiz.slug)).body.data;
    assert.deepEqual(
      byRankThenName(board.entries, (e) => e.displayName).map((entry) => entry.displayName),
      ['S. R.', 'T. S.', 'U. K.'],
    );
  });

  it('respects HIDDEN visibility and manual result release', async () => {
    const hidden = await contest({ leaderboardVisibility: 'HIDDEN' });
    at(ENDS);
    const none = (await leaderboard(sam, hidden.slug)).body.data;
    assert.equal(none.available, false);
    assert.match(none.unavailableReason!, /does not show a leaderboard/);

    const manual = await contest({ resultRelease: 'MANUAL' });
    at(ENDS);
    assert.equal((await leaderboard(sam, manual.slug)).body.data.available, false);
    expectStatus(await admin('POST', `${ADMIN}/${manual.id}/publish-results`), 200);
    assert.equal((await leaderboard(sam, manual.slug)).body.data.available, true);
  });

  it('scheduled release unlocks the leaderboard at the release time', async () => {
    const resultsAt = plusMinutes(ENDS, 30);
    const quiz = await contest({ resultRelease: 'SCHEDULED', resultsAt: resultsAt.toISOString() });
    at(ENDS);
    assert.equal((await leaderboard(sam, quiz.slug)).body.data.available, false);
    at(resultsAt);
    assert.equal((await leaderboard(sam, quiz.slug)).body.data.available, true);
  });

  it('counts BEST or FIRST attempts as configured', async () => {
    for (const counting of ['BEST', 'FIRST'] as const) {
      const quiz = await publishedQuiz(admin, { maxAttempts: 2, attemptCounting: counting });
      await takeQuiz(sam, quiz.slug, {
        correctCount: 1,
        startAt: plusMinutes(STARTS, 1),
        submitAt: plusMinutes(STARTS, 2),
      });
      await takeQuiz(sam, quiz.slug, {
        correctCount: 3,
        startAt: plusMinutes(STARTS, 3),
        submitAt: plusMinutes(STARTS, 4),
      });
      at(ENDS);
      const board = (await leaderboard(sam, quiz.slug)).body.data;
      assert.equal(board.totalRanked, 1);
      assert.equal(board.entries[0]!.score, counting === 'BEST' ? 6 : 2);
    }
  });

  it('is for students only; drafts do not exist', async () => {
    const quiz = await contest();
    at(ENDS);
    const faculty = await newFaculty(baseUrl);
    expectStatus(await faculty.api('GET', `${STUDENT}/${quiz.slug}/leaderboard`), 403);
    expectStatus(await admin('GET', `${STUDENT}/${quiz.slug}/leaderboard`), 403);
    at(new Date(ENDS.getTime() - 1));
    const draft = await admin<{ slug: string }>('POST', ADMIN, {
      title: 'Draft only',
      startsAt: plusMinutes(ENDS, 60).toISOString(),
      endsAt: plusMinutes(ENDS, 120).toISOString(),
      durationMinutes: 10,
    });
    expectStatus(await sam.api('GET', `${STUDENT}/${draft.body.data.slug}/leaderboard`), 404);
  });

  it('managers see the ranking any time, unmasked, with release status', async () => {
    const quiz = await contest({ maskNames: true });
    const preview = await admin<AdminAcademyLeaderboardDto>(
      'GET',
      `${ADMIN}/${quiz.id}/leaderboard`,
    );
    expectStatus(preview, 200);
    assert.equal(preview.body.data.releasedToStudents, false);
    assert.deepEqual(
      byRankThenName(preview.body.data.entries, (e) => e.fullName).map((entry) => [
        entry.fullName,
        entry.rank,
      ]),
      [
        ['Sam Rivera', 1],
        ['Tara Singh', 2],
        ['Una Kapoor', 2],
      ],
    );
    expectStatus(await sam.api('GET', `${ADMIN}/${quiz.id}/leaderboard`), 403);
  });
});

describe('admin attempt management', () => {
  it('lists attempts with student, status, score, duration and progress', async () => {
    const quiz = await publishedQuiz(admin, { durationMinutes: 10 });
    await takeQuiz(sam, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 1),
      submitAt: plusMinutes(STARTS, 5),
    });
    at(plusMinutes(STARTS, 2));
    const running = (await startAttempt(una, quiz.slug))!;
    expectStatus(await answerQuestion(una, running.id, running.questions[0]!.id), 200);

    at(plusMinutes(STARTS, 6));
    const list = await admin<Paginated<AdminAcademyAttemptItem>>(
      'GET',
      `${ADMIN}/${quiz.id}/attempts`,
    );
    expectStatus(list, 200);
    const bySam = list.body.data.items.find((item) => item.student.userId === sam.userId)!;
    assert.equal(bySam.status, 'SUBMITTED');
    assert.equal(bySam.student.email, sam.email);
    assert.equal(bySam.durationSeconds, 240);
    assert.equal(bySam.result!.score, 4);
    assert.equal(bySam.answeredCount, 3);
    assert.equal(bySam.questionCount, 3);
    const byUna = list.body.data.items.find((item) => item.student.userId === una.userId)!;
    assert.equal(byUna.status, 'IN_PROGRESS');
    assert.equal(byUna.answeredCount, 1);
    assert.equal(byUna.result, null);

    // Filters.
    const search = await admin<Paginated<AdminAcademyAttemptItem>>(
      'GET',
      `${ADMIN}/${quiz.id}/attempts?q=kapoor`,
    );
    assert.deepEqual(
      search.body.data.items.map((item) => item.student.fullName),
      ['Una Kapoor'],
    );
    const done = await admin<Paginated<AdminAcademyAttemptItem>>(
      'GET',
      `${ADMIN}/${quiz.id}/attempts?status=SUBMITTED`,
    );
    assert.equal(done.body.data.items.length, 1);

    // Una's deadline passes: the list itself finalizes her attempt (no scheduler).
    at(plusMinutes(STARTS, 13));
    const later = await admin<Paginated<AdminAcademyAttemptItem>>(
      'GET',
      `${ADMIN}/${quiz.id}/attempts`,
    );
    const expired = later.body.data.items.find((item) => item.student.userId === una.userId)!;
    assert.equal(expired.status, 'EXPIRED');
    assert.equal(expired.result!.score, 2);
  });

  it('attempt detail: progress only while running, full review once final', async () => {
    const quiz = await publishedQuiz(admin, { resultRelease: 'MANUAL' });
    at(plusMinutes(STARTS, 1));
    const attempt = (await startAttempt(sam, quiz.slug))!;
    expectStatus(await answerQuestion(sam, attempt.id, attempt.questions[0]!.id), 200);

    const live = await admin<AdminAcademyAttemptDetail>(
      'GET',
      `/admin/academy-attempts/${attempt.id}`,
    );
    expectStatus(live, 200);
    assert.equal(live.body.data.status, 'IN_PROGRESS');
    assert.deepEqual(live.body.data.questions, []);
    assert.ok(!live.text.includes('isCorrect'));
    assert.equal(live.body.data.answeredCount, 1);

    at(plusMinutes(STARTS, 3));
    expectStatus(await sam.api('POST', `${ATTEMPTS}/${attempt.id}/submit`), 200);
    const final = await superAdmin<AdminAcademyAttemptDetail>(
      'GET',
      `/admin/academy-attempts/${attempt.id}`,
    );
    expectStatus(final, 200);
    assert.equal(final.body.data.questions.length, 3);
    assert.ok(final.body.data.questions[0]!.options.some((option) => option.isCorrect));
    assert.equal(final.body.data.resultVisibleToStudent, false);
    // The student still sees no score and no key (manual release, not yet published).
    const own = await sam.api<{ result: unknown; review: unknown }>(
      'GET',
      `${ATTEMPTS}/${attempt.id}`,
    );
    assert.equal(own.body.data.result, null);
    assert.equal(own.body.data.review, null);
    assert.ok(!own.text.includes('isCorrect'));
  });

  it('is for managers only, and never serves course attempts', async () => {
    const quiz = await publishedQuiz(admin);
    at(plusMinutes(STARTS, 1));
    const attempt = (await startAttempt(sam, quiz.slug))!;
    const faculty = await newFaculty(baseUrl);
    for (const api of [faculty.api, sam.api]) {
      expectStatus(await api('GET', `${ADMIN}/${quiz.id}/attempts`), 403);
      expectStatus(await api('GET', `/admin/academy-attempts/${attempt.id}`), 403);
    }
    expectStatus(
      await admin('GET', '/admin/academy-attempts/00000000-0000-4000-8000-000000000000'),
      404,
    );
    // A course attempt id is not an academy attempt.
    const courseAttempt = await prisma.assessmentAttempt.findFirst({
      where: { academyQuizId: null },
    });
    if (courseAttempt) {
      expectStatus(await admin('GET', `/admin/academy-attempts/${courseAttempt.id}`), 404);
    }
  });
});

describe('student results', () => {
  it('lists own academy results with release applied; course results unchanged', async () => {
    const resultsAt = plusMinutes(ENDS, 60);
    const scheduled = await publishedQuiz(admin, {
      resultRelease: 'SCHEDULED',
      resultsAt: resultsAt.toISOString(),
    });
    await takeQuiz(sam, scheduled.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 1),
      submitAt: plusMinutes(STARTS, 4),
    });
    const immediate = await publishedQuiz(admin);
    await takeQuiz(sam, immediate.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 5),
      submitAt: plusMinutes(STARTS, 8),
    });
    await takeQuiz(una, immediate.slug, {
      correctCount: 1,
      startAt: plusMinutes(STARTS, 5),
      submitAt: plusMinutes(STARTS, 8),
    });

    const list = await sam.api<Paginated<StudentAcademyResultItem>>(
      'GET',
      '/student/academy-results',
    );
    expectStatus(list, 200);
    const items = list.body.data.items;
    assert.equal(items.length, 2); // Una's attempt is not Sam's
    const bySlug = new Map(items.map((item) => [item.quiz.slug, item]));
    assert.equal(bySlug.get(immediate.slug)!.result!.score, 6);
    const waiting = bySlug.get(scheduled.slug)!;
    assert.equal(waiting.resultState, 'AWAITING_RELEASE');
    assert.equal(waiting.result, null);
    assert.equal(waiting.resultsAt, resultsAt.toISOString());

    at(resultsAt);
    const released = await sam.api<Paginated<StudentAcademyResultItem>>(
      'GET',
      '/student/academy-results',
    );
    assert.equal(
      released.body.data.items.find((item) => item.quiz.slug === scheduled.slug)!.result!.score,
      4,
    );

    // The course quiz/exam results endpoint is untouched (no academy rows in it).
    const course = await sam.api<Paginated<StudentAssessmentResultItem>>(
      'GET',
      '/student/assessment-results',
    );
    expectStatus(course, 200);
    assert.equal(course.body.data.items.length, 0);
  });
});

describe('lifecycle', () => {
  it('draft → publish → live → close → reopen → end', async () => {
    const quiz = await publishedQuiz(
      admin,
      { maxAttempts: 2 },
      undefined,
      plusMinutes(STARTS, -10),
    );
    // Published but not started yet.
    expectStatus(
      await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, { acceptedInstructions: true }),
      409,
    );
    // Live.
    at(plusMinutes(STARTS, 1));
    const first = (await startAttempt(sam, quiz.slug))!;
    // Close finalizes the running attempt; no new starts.
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'close' }), 200);
    assert.equal(
      (await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: first.id } })).status,
      'EXPIRED',
    );
    expectStatus(
      await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, { acceptedInstructions: true }),
      409,
    );
    // Back to draft is refused once attempts exist; reopen works before the end.
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'reopen' }), 200);
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'unpublish' }), 409);
    const second = (await startAttempt(sam, quiz.slug))!;
    assert.equal(second.attemptNumber, 2);
    // Attempt limit reached.
    expectStatus(await sam.api('POST', `${ATTEMPTS}/${second.id}/submit`), 200);
    expectStatus(
      await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, { acceptedInstructions: true }),
      409,
    );
    // After the end time: closed for starts, cannot be reopened once closed.
    at(ENDS);
    expectStatus(
      await una.api('POST', `${STUDENT}/${quiz.slug}/attempts`, { acceptedInstructions: true }),
      409,
    );
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'close' }), 200);
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'reopen' }), 409);
  });
});
