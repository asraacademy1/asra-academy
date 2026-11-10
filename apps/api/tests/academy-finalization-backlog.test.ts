/**
 * Academy Quizzes — the expired-attempt backlog: bounded, resumable finalize-on-access (no
 * scheduler). Large backlogs, partial processing, retries, concurrent requests, a submit racing
 * the sweep, failure recovery, and the "being finalized" responses over real HTTP.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type {
  AdminAcademyAttemptPage,
  AdminAcademyLeaderboardDto,
  StudentAcademyAttemptDto,
  StudentAcademyLeaderboardDto,
} from '@asra/types';
import { createApp } from '../src/app.js';
import { ACADEMY_FINALIZE_LIMITS } from '../src/config/constants.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { setClockForTests } from '../src/lib/clock.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { finalizeExpiredBounded } from '../src/modules/assessments/attempts.core.js';
import {
  ADMIN,
  ATTEMPTS,
  ENDS,
  STARTS,
  STUDENT,
  answerQuestion,
  publishedQuiz,
  startAttempt,
} from './support/academy.js';
import { at, newStudent, plusMinutes, type Student } from './support/assessment.js';
import { login, provision, resetAuthState } from './support/auth.js';
import { apiAs, expectStatus, type Api } from './support/catalog.js';
import { startServer, TestClient } from './support/http.js';

let baseUrl: string;
let close: () => Promise<void>;
let admin: Api;
let sam: Student;

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
  const user = await provision('ADMIN');
  const client = new TestClient(baseUrl);
  admin = apiAs(client, (await login(client, user.email)).accessToken);
  sam = await newStudent(baseUrl);
});

const OPTION_RIGHT = '00000000-0000-4000-8000-000000000001';
const OPTION_WRONG = '00000000-0000-4000-8000-000000000002';
const snapshot = {
  prompt: 'p',
  explanation: null,
  options: [
    { id: OPTION_RIGHT, text: 'right', isCorrect: true },
    { id: OPTION_WRONG, text: 'wrong', isCorrect: false },
  ],
  images: [],
};

/**
 * Inserts `count` attempts that expired unattended (IN_PROGRESS, deadline passed), 2 questions of
 * 2 marks each; attempt i answers (i % 3) === 0 ? one : both questions correctly. Deadlines are
 * spaced 1 s apart so batches take them in a known order.
 */
async function seedBacklog(quizId: string, count: number, firstDeadline = plusMinutes(STARTS, 30)) {
  const stamp = randomUUID().slice(0, 8);
  const users = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    email: `backlog-${stamp}-${i}@example.test`,
    fullName: `Backlog Student ${i}`,
  }));
  await prisma.user.createMany({ data: users });
  const attempts = users.map((user, i) => ({
    id: randomUUID(),
    academyQuizId: quizId,
    userId: user.id,
    attemptNumber: 1,
    startedAt: STARTS,
    deadlineAt: new Date(firstDeadline.getTime() + i * 1000),
    maxScore: new Prisma.Decimal(4),
  }));
  await prisma.assessmentAttempt.createMany({ data: attempts });
  await prisma.attemptQuestion.createMany({
    data: attempts.flatMap((attempt, i) =>
      [0, 1].map((position) => ({
        attemptId: attempt.id,
        position,
        type: 'SINGLE_CHOICE' as const,
        snapshot,
        marks: new Prisma.Decimal(2),
        negativeMarks: new Prisma.Decimal(0),
        selectedOptionIds: [i % 3 === 0 && position === 1 ? OPTION_WRONG : OPTION_RIGHT],
        answerSequence: 1,
        answeredAt: STARTS,
      })),
    ),
  });
  return attempts.map((attempt) => attempt.id);
}

const forQuiz = (quizId: string) => Prisma.sql`AND "academy_quiz_id" = ${quizId}::uuid`;

async function finalizationAudits(ids: string[]) {
  const rows = await prisma.assessmentAuditLog.groupBy({
    by: ['entityId'],
    where: { action: 'attempt.finalized', entityId: { in: ids } },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.entityId, row._count._all]));
}

/** Every attempt finalized exactly once, with the score its answers deserve. */
async function assertFinalizedOnce(ids: string[]) {
  const rows = await prisma.assessmentAttempt.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      score: true,
      submittedAt: true,
      deadlineAt: true,
      evaluationStatus: true,
    },
  });
  assert.equal(rows.length, ids.length);
  const audits = await finalizationAudits(ids);
  for (const row of rows) {
    assert.equal(row.status, 'EXPIRED');
    assert.equal(row.evaluationStatus, 'EVALUATED');
    assert.equal(row.submittedAt?.getTime(), row.deadlineAt?.getTime());
    assert.equal(audits.get(row.id), 1, `attempt ${row.id} audited once`);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  ids.forEach((id, i) => assert.equal(Number(byId.get(id)!.score), i % 3 === 0 ? 2 : 4));
}

async function quizAfterEnd(settings: Record<string, unknown> = {}) {
  const quiz = await publishedQuiz(admin, settings);
  at(plusMinutes(ENDS, 5));
  return quiz;
}

describe('Academy backlog — bounded finalization', () => {
  it('a large backlog is finalized in bounded, resumable steps, each attempt once', async () => {
    const quiz = await quizAfterEnd();
    const ids = await seedBacklog(quiz.id, 130);

    const first = await finalizeExpiredBounded({
      where: forQuiz(quiz.id),
      batchSize: 20,
      maxAttempts: 50,
    });
    assert.deepEqual(first, { finalized: 50, remaining: 80 });
    // The oldest deadlines go first, and what was finalized is complete (not half-scored).
    const done = await prisma.assessmentAttempt.findMany({
      where: { id: { in: ids }, status: 'EXPIRED' },
      select: { id: true },
    });
    assert.deepEqual(new Set(done.map((row) => row.id)), new Set(ids.slice(0, 50)));
    await assertFinalizedOnce(ids.slice(0, 50));
    const untouched = await prisma.attemptQuestion.count({
      where: { attemptId: { in: ids.slice(50) }, NOT: { awardedMarks: null } },
    });
    assert.equal(untouched, 0, 'pending attempts have no partial outcomes');

    // Retries continue where the previous request stopped.
    assert.deepEqual(
      await finalizeExpiredBounded({ where: forQuiz(quiz.id), batchSize: 20, maxAttempts: 50 }),
      { finalized: 50, remaining: 30 },
    );
    assert.deepEqual(
      await finalizeExpiredBounded({ where: forQuiz(quiz.id), batchSize: 20, maxAttempts: 50 }),
      { finalized: 30, remaining: 0 },
    );
    // Nothing left: a further retry is a no-op.
    assert.deepEqual(await finalizeExpiredBounded({ where: forQuiz(quiz.id) }), {
      finalized: 0,
      remaining: 0,
    });
    await assertFinalizedOnce(ids);
  });

  it('the time budget stops new batches; the rest stays pending', async () => {
    const quiz = await quizAfterEnd();
    await seedBacklog(quiz.id, 30);
    const result = await finalizeExpiredBounded({
      where: forQuiz(quiz.id),
      batchSize: 10,
      maxAttempts: 1000,
      budgetMs: 0,
    });
    assert.deepEqual(result, { finalized: 0, remaining: 30 });
  });

  it('only expired attempts of the scoped quiz are touched', async () => {
    const quiz = await quizAfterEnd();
    const other = await publishedQuiz(admin);
    at(plusMinutes(ENDS, 5));
    const mine = await seedBacklog(quiz.id, 5);
    const theirs = await seedBacklog(other.id, 5);
    const running = await seedBacklog(quiz.id, 3, plusMinutes(ENDS, 60)); // not expired yet
    assert.deepEqual(await finalizeExpiredBounded({ where: forQuiz(quiz.id) }), {
      finalized: 5,
      remaining: 0,
    });
    await assertFinalizedOnce(mine);
    assert.equal(
      await prisma.assessmentAttempt.count({
        where: { id: { in: [...theirs, ...running] }, status: 'IN_PROGRESS' },
      }),
      8,
    );
  });

  it('concurrent requests share the work without finalizing anything twice', async () => {
    const quiz = await quizAfterEnd();
    const ids = await seedBacklog(quiz.id, 160);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        finalizeExpiredBounded({ where: forQuiz(quiz.id), batchSize: 10, maxAttempts: 40 }),
      ),
    );
    const total = results.reduce((sum, result) => sum + result.finalized, 0);
    assert.ok(total <= 160 && total > 0);
    // Keep retrying (as later requests would) until done.
    for (let guard = 0; guard < 20; guard++) {
      const next = await finalizeExpiredBounded({ where: forQuiz(quiz.id) });
      if (next.remaining === 0) break;
    }
    await assertFinalizedOnce(ids);
    assert.equal(
      await prisma.assessmentAuditLog.count({
        where: { action: 'attempt.finalized', entityId: { in: ids } },
      }),
      160,
    );
  });

  it('a submit racing the sweep finalizes the attempt exactly once', async () => {
    const quiz = await publishedQuiz(admin);
    const attempt = (await startAttempt(sam, quiz.slug))!;
    for (const question of attempt.questions) {
      expectStatus(await answerQuestion(sam, attempt.id, question.id), 200);
    }
    at(plusMinutes(new Date(attempt.deadlineAt!), 1));
    const [submit, sweep] = await Promise.all([
      sam.api<StudentAcademyAttemptDto>('POST', `${ATTEMPTS}/${attempt.id}/submit`),
      finalizeExpiredBounded({ where: forQuiz(quiz.id) }),
      sam.api<StudentAcademyAttemptDto>('POST', `${ATTEMPTS}/${attempt.id}/submit`),
    ]);
    expectStatus(submit, 200);
    assert.equal(submit.body.data.status, 'EXPIRED');
    assert.equal(sweep.remaining, 0);
    assert.equal((await finalizationAudits([attempt.id])).get(attempt.id), 1);
    const row = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    assert.equal(row.submittedAt?.toISOString(), attempt.deadlineAt);
    assert.equal(Number(row.score), 6);
  });

  it('a failed batch rolls back completely; earlier batches stay; a retry recovers', async () => {
    const quiz = await quizAfterEnd();
    const ids = await seedBacklog(quiz.id, 30);
    const poisoned = ids[25]!; // in the third batch of 10
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_finalize() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${poisoned}'::uuid AND NEW.status <> 'IN_PROGRESS' THEN
          RAISE EXCEPTION 'injected failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_fail_finalize BEFORE UPDATE ON assessment_attempts
      FOR EACH ROW EXECUTE FUNCTION test_fail_finalize()`);
    try {
      await assert.rejects(
        finalizeExpiredBounded({ where: forQuiz(quiz.id), batchSize: 10, maxAttempts: 100 }),
      );
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_fail_finalize ON assessment_attempts',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_finalize()');
    }
    // Batches 1–2 committed; batch 3 left no status, outcome or audit behind.
    await assertFinalizedOnce(ids.slice(0, 20));
    const failed = ids.slice(20);
    assert.equal(
      await prisma.assessmentAttempt.count({
        where: { id: { in: failed }, status: 'IN_PROGRESS' },
      }),
      10,
    );
    assert.equal(
      await prisma.attemptQuestion.count({
        where: { attemptId: { in: failed }, NOT: { awardedMarks: null } },
      }),
      0,
    );
    assert.equal((await finalizationAudits(failed)).size, 0);

    assert.deepEqual(await finalizeExpiredBounded({ where: forQuiz(quiz.id) }), {
      finalized: 10,
      remaining: 0,
    });
    await assertFinalizedOnce(ids);
  });
});

describe('Academy backlog — what users see', () => {
  const backlogSize = ACADEMY_FINALIZE_LIMITS.maxPerRequest + 20;

  it('no partial leaderboard while finalizing; the next request completes it', async () => {
    const quiz = await quizAfterEnd();
    const ids = await seedBacklog(quiz.id, backlogSize);

    const first = await sam.api<StudentAcademyLeaderboardDto>(
      'GET',
      `${STUDENT}/${quiz.slug}/leaderboard`,
    );
    expectStatus(first, 200);
    assert.equal(first.body.data.available, false);
    assert.equal(first.body.data.finalizing, true);
    assert.match(first.body.data.unavailableReason!, /being finalized/);
    assert.equal(first.body.data.entries.length, 0);
    assert.equal(first.body.data.totalRanked, 0);
    assert.equal(first.body.data.me, null);

    const retry = await sam.api<StudentAcademyLeaderboardDto>(
      'GET',
      `${STUDENT}/${quiz.slug}/leaderboard`,
    );
    expectStatus(retry, 200);
    assert.equal(retry.body.data.available, true);
    assert.equal(retry.body.data.finalizing, false);
    assert.equal(retry.body.data.totalRanked, backlogSize);
    await assertFinalizedOnce(ids);
  });

  it('a leaderboard that is not released yet does no finalization work at all', async () => {
    const quiz = await publishedQuiz(admin); // still running
    await seedBacklog(quiz.id, 5);
    const board = await sam.api<StudentAcademyLeaderboardDto>(
      'GET',
      `${STUDENT}/${quiz.slug}/leaderboard`,
    );
    assert.equal(board.body.data.finalizing, false);
    assert.match(board.body.data.unavailableReason!, /after the quiz ends/);
    assert.equal(
      await prisma.assessmentAttempt.count({
        where: { academyQuizId: quiz.id, status: 'IN_PROGRESS' },
      }),
      5,
    );
  });

  it('admin views report the pending count and hide the ranking until done', async () => {
    const quiz = await quizAfterEnd();
    await seedBacklog(quiz.id, backlogSize);

    const board = await admin<AdminAcademyLeaderboardDto>('GET', `${ADMIN}/${quiz.id}/leaderboard`);
    expectStatus(board, 200);
    assert.equal(board.body.data.pendingFinalization, 20);
    assert.deepEqual(board.body.data.entries, []);

    const page = await admin<AdminAcademyAttemptPage>('GET', `${ADMIN}/${quiz.id}/attempts`);
    expectStatus(page, 200);
    assert.equal(page.body.data.pendingFinalization, 0);
    assert.equal(page.body.data.pagination.total, backlogSize);

    const done = await admin<AdminAcademyLeaderboardDto>('GET', `${ADMIN}/${quiz.id}/leaderboard`);
    assert.equal(done.body.data.pendingFinalization, 0);
    assert.equal(done.body.data.totalRanked, backlogSize);
  });

  it('manual result publication waits for the backlog and is safe to retry', async () => {
    const quiz = await quizAfterEnd({ resultRelease: 'MANUAL' });
    const ids = await seedBacklog(quiz.id, backlogSize);

    const refused = await admin('POST', `${ADMIN}/${quiz.id}/publish-results`);
    expectStatus(refused, 409);
    assert.equal(refused.body.error?.code, 'CONFLICT');
    assert.match(refused.body.message, /20 expired attempts are still being finalized/);
    assert.deepEqual(refused.body.error?.details, { finalizing: true, pendingAttempts: 20 });
    const quizRow = await prisma.academyQuiz.findUniqueOrThrow({ where: { id: quiz.id } });
    assert.equal(quizRow.resultsPublishedAt, null, 'nothing published while finalizing');

    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/publish-results`), 200);
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/publish-results`), 200); // idempotent
    await assertFinalizedOnce(ids);
    assert.equal(
      await prisma.adminAuditLog.count({
        where: { action: 'academy_quiz.results_published', entityId: quiz.id },
      }),
      1,
    );
  });

  it('closing a per-question quiz ends running attempts (question deadline clamped)', async () => {
    const quiz = await publishedQuiz(admin, {
      timerMode: 'PER_QUESTION',
      questionTimeSeconds: 600,
      navigation: 'LINEAR',
    });
    const attempt = (await startAttempt(sam, quiz.slug))!;
    expectStatus(await answerQuestion(sam, attempt.id, attempt.questions[0]!.id), 200);
    const closedAt = plusMinutes(STARTS, 3);
    at(closedAt);
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'close' }), 200);
    const row = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    assert.equal(row.status, 'EXPIRED');
    assert.equal(row.deadlineAt?.toISOString(), closedAt.toISOString());
    assert.equal(row.submittedAt?.toISOString(), closedAt.toISOString());
    assert.ok(row.currentQuestionDeadlineAt! <= row.deadlineAt!);
    assert.equal(Number(row.score), 2);
    assert.equal((await finalizationAudits([attempt.id])).get(attempt.id), 1);
  });

  it('closing a quiz with many running attempts finalizes them all in one go', async () => {
    const quiz = await publishedQuiz(admin);
    const ids = await seedBacklog(quiz.id, 450, plusMinutes(ENDS, 60)); // all still running
    const closedAt = plusMinutes(STARTS, 10);
    at(closedAt);
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'close' }), 200);
    const rows = await prisma.assessmentAttempt.findMany({ where: { id: { in: ids } } });
    assert.ok(rows.every((row) => row.status === 'EXPIRED'));
    assert.ok(rows.every((row) => row.deadlineAt?.getTime() === closedAt.getTime()));
    const audits = await finalizationAudits(ids);
    assert.ok(ids.every((id) => audits.get(id) === 1));
  });
});
