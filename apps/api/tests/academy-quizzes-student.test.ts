/**
 * Academy Quizzes for students over real HTTP and the real database (docs/ASSESSMENTS.md
 * §Academy): who may take part (STUDENT + academy_quizzes.participate, verified email,
 * class/stream restrictions, no enrolment), listing tabs, start/resume, server deadlines (late
 * starters get only the time left), finalize-on-access without any scheduler, idempotent submit,
 * LINEAR navigation and per-question timing enforced by the server, question selection, and
 * result/answer release (immediate, scheduled, manual). The server clock is pinned with `at()`.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  PERMISSIONS,
  type AdminAcademyQuizDetail,
  type Paginated,
  type QuestionDto,
  type StudentAcademyAttemptDto,
  type StudentAcademyAttemptStartDto,
  type StudentAcademyQuizDetail,
  type StudentAcademyQuizItem,
} from '@asra/types';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { disconnectRedis } from '../src/lib/redis.js';
import {
  at,
  mcq,
  newFaculty,
  newStudent,
  plusMinutes,
  type Student,
} from './support/assessment.js';
import { login, provision, resetAuthState } from './support/auth.js';
import { apiAs, createAcademicBasics, expectStatus, type Api } from './support/catalog.js';
import { startServer, TestClient } from './support/http.js';

let baseUrl: string;
let close: () => Promise<void>;
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
  const user = await provision('ADMIN');
  const client = new TestClient(baseUrl);
  admin = apiAs(client, (await login(client, user.email)).accessToken);
  [sam, una] = [await newStudent(baseUrl), await newStudent(baseUrl)];
});

const T0 = new Date('2026-12-01T04:30:00.000Z');
const STARTS = plusMinutes(T0, 60);
const ENDS = plusMinutes(T0, 180);
const ADMIN = '/admin/academy-quizzes';
const STUDENT = '/student/academy-quizzes';
const ATTEMPTS = '/student/academy-attempts';
const accept = { acceptedInstructions: true };

const question = (marks = 2, difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null = null) => ({
  ...mcq(marks),
  difficulty,
});

/** Creates, fills and publishes a quiz (at T0), then moves the clock to `now`. */
async function publishedQuiz(
  settings: Record<string, unknown> = {},
  questions: object[] = [question(), question(), question()],
  now: Date = plusMinutes(STARTS, 1),
) {
  at(T0);
  const created = await admin<AdminAcademyQuizDetail>('POST', ADMIN, {
    title: `Olympiad ${Math.random().toString(36).slice(2, 8)}`,
    startsAt: STARTS.toISOString(),
    endsAt: ENDS.toISOString(),
    ...('timerMode' in settings ? {} : { durationMinutes: 30 }),
    ...settings,
  });
  expectStatus(created, 201);
  const quiz = created.body.data;
  const added: QuestionDto[] = [];
  for (const body of questions) {
    const response = await admin<QuestionDto>('POST', `${ADMIN}/${quiz.id}/questions`, body);
    expectStatus(response, 201);
    added.push(response.body.data);
  }
  expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'publish' }), 200);
  at(now);
  return { ...quiz, questions: added };
}

async function start(student: Student, slug: string, status = 201) {
  const response = await student.api<StudentAcademyAttemptStartDto>(
    'POST',
    `${STUDENT}/${slug}/attempts`,
    accept,
  );
  expectStatus(response, status);
  return response.body.data?.attempt;
}

const getAttempt = async (student: Student, id: string) => {
  const response = await student.api<StudentAcademyAttemptDto>('GET', `${ATTEMPTS}/${id}`);
  expectStatus(response, 200);
  return response.body.data;
};

/** The id of the correct option of an attempt question (from the database: the key is secret). */
async function correctOption(attemptQuestionId: string) {
  const row = await prisma.attemptQuestion.findUniqueOrThrow({ where: { id: attemptQuestionId } });
  const options = (row.snapshot as { options: { id: string; isCorrect: boolean }[] }).options;
  return options.find((option) => option.isCorrect)!.id;
}

async function answer(student: Student, attemptId: string, questionId: string, sequence = 1) {
  return student.api('PUT', `${ATTEMPTS}/${attemptId}/answers/${questionId}`, {
    selectedOptionIds: [await correctOption(questionId)],
    sequence,
  });
}

const list = async (student: Student, tab: string) => {
  const response = await student.api<Paginated<StudentAcademyQuizItem>>(
    'GET',
    `${STUDENT}?tab=${tab}`,
  );
  expectStatus(response, 200);
  return response.body.data.items;
};

describe('Academy Quizzes (student) — access', () => {
  it('needs the STUDENT role and academy_quizzes.participate, but no enrolment', async () => {
    const quiz = await publishedQuiz();
    // Sam has no enrolment at all.
    assert.equal(await prisma.enrollment.count({ where: { userId: sam.userId } }), 0);
    expectStatus(await sam.api('GET', STUDENT), 200);
    expectStatus(await sam.api('GET', `${STUDENT}/${quiz.slug}`), 200);

    const faculty = await newFaculty(baseUrl);
    expectStatus(await faculty.api('GET', STUDENT), 403);
    expectStatus(await admin('GET', STUDENT), 403);
    expectStatus(await admin('POST', `${STUDENT}/${quiz.slug}/attempts`, accept), 403);

    // Without the permission, a student is refused (the grant is checked, not the role name).
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: PERMISSIONS.ACADEMY_QUIZZES_PARTICIPATE },
    });
    await prisma.rolePermission.deleteMany({ where: { permissionId: permission.id } });
    const again = await newStudent(baseUrl);
    expectStatus(await again.api('GET', STUDENT), 403);
    expectStatus(await again.api('POST', `${STUDENT}/${quiz.slug}/attempts`, accept), 403);
  });

  it('keeps attempts private and separate from course attempt routes', async () => {
    const quiz = await publishedQuiz();
    const attempt = (await start(sam, quiz.slug))!;
    expectStatus(await una.api('GET', `${ATTEMPTS}/${attempt.id}`), 404);
    expectStatus(await una.api('POST', `${ATTEMPTS}/${attempt.id}/submit`), 404);
    expectStatus(
      await una.api('PUT', `${ATTEMPTS}/${attempt.id}/answers/${attempt.questions[0]!.id}`, {
        selectedOptionIds: [],
        sequence: 1,
      }),
      404,
    );
    // The course attempt routes never serve academy attempts.
    expectStatus(await sam.api('GET', `/student/attempts/${attempt.id}`), 404);
    expectStatus(await sam.api('POST', `/student/attempts/${attempt.id}/submit`), 404);
  });

  it('never sends the answer key while the attempt runs', async () => {
    const quiz = await publishedQuiz();
    const response = await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, accept);
    expectStatus(response, 201);
    assert.ok(!response.text.includes('isCorrect'));
    assert.ok(!response.text.includes('explanation'));
  });

  it('accepts only the instruction confirmation as a start body', async () => {
    const quiz = await publishedQuiz();
    expectStatus(await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`), 422);
    expectStatus(
      await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, { acceptedInstructions: false }),
      422,
    );
    expectStatus(
      await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, {
        ...accept,
        deadlineAt: ENDS.toISOString(),
      }),
      422,
    );
    expectStatus(
      await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, { ...accept, fullscreen: true }),
      422,
    );
  });
});

describe('Academy Quizzes (student) — eligibility and listing', () => {
  it('requires a verified email to start (read from the database)', async () => {
    const quiz = await publishedQuiz();
    await prisma.user.update({ where: { id: sam.userId }, data: { emailVerifiedAt: null } });
    const detail = (await sam.api<StudentAcademyQuizDetail>('GET', `${STUDENT}/${quiz.slug}`)).body
      .data;
    assert.equal(detail.eligibility.eligible, false);
    assert.deepEqual(detail.eligibility.reasons, ['EMAIL_NOT_VERIFIED']);
    assert.match(detail.cannotStartReason!, /Verify your email/);
    const refused = await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, accept);
    expectStatus(refused, 409);
    assert.equal(await prisma.assessmentAttempt.count(), 0);
  });

  it('applies class and stream restrictions, and hides other classes’ quizzes', async () => {
    const basics = await createAcademicBasics(admin);
    const stream = await prisma.stream.create({
      data: { academicLevelId: basics.levelId, name: 'Science', slug: `science-${Date.now()}` },
    });
    const quiz = await publishedQuiz({
      eligibleClassIds: [basics.classId],
      eligibleStreamIds: [stream.id],
    });
    assert.equal((await list(sam, 'LIVE')).length, 0);
    const detail = (await sam.api<StudentAcademyQuizDetail>('GET', `${STUDENT}/${quiz.slug}`)).body
      .data;
    assert.deepEqual(detail.eligibility.reasons, ['CLASS', 'STREAM']);
    assert.equal(detail.eligibility.eligibleClasses[0]!.id, basics.classId);
    expectStatus(await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, accept), 409);

    await prisma.studentProfile.upsert({
      where: { userId: sam.userId },
      create: { userId: sam.userId, classId: basics.classId },
      update: { classId: basics.classId },
    });
    const classOnly = (await sam.api<StudentAcademyQuizDetail>('GET', `${STUDENT}/${quiz.slug}`))
      .body.data;
    assert.deepEqual(classOnly.eligibility.reasons, ['STREAM']);

    await prisma.studentProfile.update({
      where: { userId: sam.userId },
      data: { streamId: stream.id },
    });
    assert.equal((await list(sam, 'LIVE')).length, 1);
    await start(sam, quiz.slug);
  });

  it('lists upcoming, live and completed quizzes; drafts never appear', async () => {
    at(T0);
    const draft = await admin<AdminAcademyQuizDetail>('POST', ADMIN, {
      title: 'Hidden draft',
      startsAt: STARTS.toISOString(),
      endsAt: ENDS.toISOString(),
      durationMinutes: 30,
    });
    expectStatus(draft, 201);
    const quiz = await publishedQuiz({}, undefined, T0);
    assert.deepEqual(
      (await list(sam, 'UPCOMING')).map((item) => item.slug),
      [quiz.slug],
    );
    assert.equal((await list(sam, 'LIVE')).length, 0);
    expectStatus(await sam.api('GET', `${STUDENT}/${draft.body.data.slug}`), 404);
    expectStatus(await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, accept), 409);

    at(plusMinutes(STARTS, 5));
    const [live] = await list(sam, 'LIVE');
    assert.equal(live!.slug, quiz.slug);
    assert.equal(live!.questionsPerAttempt, 3);
    assert.equal(live!.participation.attemptsUsed, 0);

    at(ENDS);
    assert.equal((await list(sam, 'COMPLETED'))[0]!.slug, quiz.slug);
    const detail = (await sam.api<StudentAcademyQuizDetail>('GET', `${STUDENT}/${quiz.slug}`)).body
      .data;
    assert.equal(detail.phase, 'ENDED');
    assert.match(detail.cannotStartReason!, /ended/);
    expectStatus(await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, accept), 409);
  });
});

describe('Academy Quizzes (student) — timing', () => {
  it('gives late starters only the time left before the end', async () => {
    const quiz = await publishedQuiz({ durationMinutes: 30 }, undefined, plusMinutes(ENDS, -10));
    const detail = (await sam.api<StudentAcademyQuizDetail>('GET', `${STUDENT}/${quiz.slug}`)).body
      .data;
    assert.equal(detail.availableMinutesIfStartedNow, 10);
    const attempt = (await start(sam, quiz.slug))!;
    assert.equal(attempt.deadlineAt, ENDS.toISOString());
  });

  it('refuses a start with under a minute left, and after closure', async () => {
    const quiz = await publishedQuiz({}, undefined, new Date(ENDS.getTime() - 30_000));
    expectStatus(await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, accept), 409);
    const other = await publishedQuiz();
    expectStatus(await admin('POST', `${ADMIN}/${other.id}/status`, { action: 'close' }), 200);
    expectStatus(await sam.api('POST', `${STUDENT}/${other.slug}/attempts`, accept), 409);
  });

  it('resumes the running attempt instead of starting another', async () => {
    const quiz = await publishedQuiz();
    const first = (await start(sam, quiz.slug))!;
    at(plusMinutes(STARTS, 5));
    const resumed = await sam.api<StudentAcademyAttemptStartDto>(
      'POST',
      `${STUDENT}/${quiz.slug}/attempts`,
      accept,
    );
    expectStatus(resumed, 200);
    assert.equal(resumed.body.data.resumed, true);
    assert.equal(resumed.body.data.attempt.id, first.id);
    assert.equal(resumed.body.data.attempt.deadlineAt, first.deadlineAt);
    assert.equal(await prisma.assessmentAttempt.count(), 1);
  });

  it('finalizes an expired attempt when it is next accessed (no scheduler)', async () => {
    const quiz = await publishedQuiz({ durationMinutes: 10 });
    const attempt = (await start(sam, quiz.slug))!;
    expectStatus(await answer(sam, attempt.id, attempt.questions[0]!.id), 200);
    at(plusMinutes(STARTS, 12));
    // Nothing ran in between: the row is still IN_PROGRESS in the database...
    assert.equal(
      (await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      'IN_PROGRESS',
    );
    // ...and a late answer is refused and finalizes it.
    const late = await answer(sam, attempt.id, attempt.questions[1]!.id, 2);
    expectStatus(late, 409);
    const final = await getAttempt(sam, attempt.id);
    assert.equal(final.status, 'EXPIRED');
    assert.equal(final.submittedAt, attempt.deadlineAt);
    assert.equal(final.result!.score, 2); // only the answer saved before the deadline
    // Submitting afterwards is a no-op returning the same final attempt.
    const again = await sam.api<StudentAcademyAttemptDto>(
      'POST',
      `${ATTEMPTS}/${attempt.id}/submit`,
    );
    expectStatus(again, 200);
    assert.equal(again.body.data.status, 'EXPIRED');
  });

  it('finalizes expired attempts when the student opens the quiz list', async () => {
    const quiz = await publishedQuiz({ durationMinutes: 10 });
    const attempt = (await start(sam, quiz.slug))!;
    at(plusMinutes(STARTS, 30));
    await list(sam, 'LIVE');
    assert.equal(
      (await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      'EXPIRED',
    );
  });
});

describe('Academy Quizzes (student) — submission', () => {
  it('submits once, idempotently, and then refuses changes', async () => {
    const quiz = await publishedQuiz({ maxAttempts: 2 });
    const attempt = (await start(sam, quiz.slug))!;
    for (const [index, q] of attempt.questions.entries()) {
      expectStatus(await answer(sam, attempt.id, q.id, index + 1), 200);
    }
    // An older sequence (a late retry) never overwrites the newer answer.
    const stale = await sam.api<{ applied: boolean }>(
      'PUT',
      `${ATTEMPTS}/${attempt.id}/answers/${attempt.questions[0]!.id}`,
      { selectedOptionIds: [], sequence: 1 },
    );
    expectStatus(stale, 200);
    assert.equal(stale.body.data.applied, false);

    const [first, second] = await Promise.all([
      sam.api<StudentAcademyAttemptDto>('POST', `${ATTEMPTS}/${attempt.id}/submit`),
      sam.api<StudentAcademyAttemptDto>('POST', `${ATTEMPTS}/${attempt.id}/submit`),
    ]);
    expectStatus(first, 200);
    expectStatus(second, 200);
    assert.equal(first.body.data.status, 'SUBMITTED');
    assert.equal(first.body.data.result!.score, 6);
    assert.equal(
      await prisma.assessmentAuditLog.count({
        where: { action: 'attempt.finalized', entityId: attempt.id },
      }),
      1,
    );
    expectStatus(await answer(sam, attempt.id, attempt.questions[0]!.id, 9), 409);

    // maxAttempts 2 → one more attempt, then no more.
    const next = (await start(sam, quiz.slug))!;
    assert.equal(next.attemptNumber, 2);
    expectStatus(await sam.api('POST', `${ATTEMPTS}/${next.id}/submit`), 200);
    expectStatus(await sam.api('POST', `${STUDENT}/${quiz.slug}/attempts`, accept), 409);
  });

  it('closing the quiz finalizes running attempts with the saved answers', async () => {
    const quiz = await publishedQuiz();
    const attempt = (await start(sam, quiz.slug))!;
    expectStatus(await answer(sam, attempt.id, attempt.questions[0]!.id), 200);
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'close' }), 200);
    const final = await getAttempt(sam, attempt.id);
    assert.equal(final.status, 'EXPIRED');
    assert.equal(final.result!.score, 2);
  });
});

describe('Academy Quizzes (student) — selection', () => {
  it('draws a random subset of the configured size', async () => {
    const quiz = await publishedQuiz({ selection: 'RANDOM', questionsPerAttempt: 2 }, [
      question(),
      question(),
      question(),
      question(),
    ]);
    const attempt = (await start(sam, quiz.slug))!;
    assert.equal(attempt.questionCount, 2);
    assert.equal(attempt.maxScore, 4);
  });

  it('draws the configured number of questions per difficulty', async () => {
    const quiz = await publishedQuiz(
      { selection: 'BY_DIFFICULTY', easyCount: 2, mediumCount: 0, hardCount: 1 },
      [
        question(1, 'EASY'),
        question(1, 'EASY'),
        question(1, 'EASY'),
        question(3, 'HARD'),
        question(3, 'HARD'),
        question(2, 'MEDIUM'),
      ],
    );
    const attempt = (await start(sam, quiz.slug))!;
    const rows = await prisma.attemptQuestion.findMany({
      where: { attemptId: attempt.id },
      select: { question: { select: { difficulty: true } } },
    });
    const levels = rows.map((row) => row.question!.difficulty).sort();
    assert.deepEqual(levels, ['EASY', 'EASY', 'HARD']);
    assert.equal(attempt.maxScore, 5);
  });
});

describe('Academy Quizzes (student) — linear navigation', () => {
  it('shows only the current question and accepts answers for it alone', async () => {
    const quiz = await publishedQuiz({ navigation: 'LINEAR', requireAnswerToAdvance: true });
    const attempt = (await start(sam, quiz.slug))!;
    assert.equal(attempt.currentPosition, 0);
    assert.equal(attempt.questionCount, 3);
    assert.equal(attempt.questions.length, 1);
    const first = attempt.questions[0]!;

    // Answer required before moving on.
    const blocked = await sam.api('POST', `${ATTEMPTS}/${attempt.id}/advance`, { fromPosition: 0 });
    expectStatus(blocked, 409);
    expectStatus(await answer(sam, attempt.id, first.id), 200);

    const moved = await sam.api<StudentAcademyAttemptDto>(
      'POST',
      `${ATTEMPTS}/${attempt.id}/advance`,
      { fromPosition: 0 },
    );
    expectStatus(moved, 200);
    assert.equal(moved.body.data.currentPosition, 1);
    // A retry of the same advance does not skip a second question.
    const retry = await sam.api<StudentAcademyAttemptDto>(
      'POST',
      `${ATTEMPTS}/${attempt.id}/advance`,
      { fromPosition: 0 },
    );
    assert.equal(retry.body.data.currentPosition, 1);
    // Skipping ahead is refused.
    expectStatus(
      await sam.api('POST', `${ATTEMPTS}/${attempt.id}/advance`, { fromPosition: 2 }),
      409,
    );
    // The passed question is locked.
    const locked = await answer(sam, attempt.id, first.id, 5);
    expectStatus(locked, 409);
    assert.match(locked.text, /QUESTION_LOCKED/);

    const second = moved.body.data.questions[0]!;
    assert.notEqual(second.id, first.id);
    expectStatus(await answer(sam, attempt.id, second.id), 200);
    const third = await sam.api<StudentAcademyAttemptDto>(
      'POST',
      `${ATTEMPTS}/${attempt.id}/advance`,
      { fromPosition: 1 },
    );
    expectStatus(await answer(sam, attempt.id, third.body.data.questions[0]!.id), 200);
    // No "next" after the last question: submit instead.
    expectStatus(
      await sam.api('POST', `${ATTEMPTS}/${attempt.id}/advance`, { fromPosition: 2 }),
      409,
    );
    const final = await sam.api<StudentAcademyAttemptDto>(
      'POST',
      `${ATTEMPTS}/${attempt.id}/submit`,
    );
    assert.equal(final.body.data.result!.score, 6);
    assert.equal(final.body.data.questions.length, 3);
  });

  it('per-question timing: time-outs move on, early moves shrink the deadline', async () => {
    const quiz = await publishedQuiz({
      timerMode: 'PER_QUESTION',
      questionTimeSeconds: 60,
      navigation: 'LINEAR',
    });
    const now = plusMinutes(STARTS, 1);
    const attempt = (await start(sam, quiz.slug))!;
    assert.equal(attempt.deadlineAt, new Date(now.getTime() + 180_000).toISOString());
    assert.equal(attempt.currentQuestionDeadlineAt, new Date(now.getTime() + 60_000).toISOString());
    const first = attempt.questions[0]!;

    // 61 s later the first question's time is over: it is passed and locked.
    at(new Date(now.getTime() + 61_000));
    expectStatus(await answer(sam, attempt.id, first.id), 409);
    const caughtUp = await getAttempt(sam, attempt.id);
    assert.equal(caughtUp.currentPosition, 1);
    assert.equal(
      caughtUp.currentQuestionDeadlineAt,
      new Date(now.getTime() + 120_000).toISOString(),
    );

    // Moving on early: the last question gets a full 60 s from now, and the attempt ends then.
    const t = new Date(now.getTime() + 70_000);
    at(t);
    const moved = await sam.api<StudentAcademyAttemptDto>(
      'POST',
      `${ATTEMPTS}/${attempt.id}/advance`,
      { fromPosition: 1 },
    );
    expectStatus(moved, 200);
    assert.equal(moved.body.data.currentPosition, 2);
    assert.equal(moved.body.data.deadlineAt, new Date(t.getTime() + 60_000).toISOString());

    at(new Date(t.getTime() + 61_000));
    const final = await getAttempt(sam, attempt.id);
    assert.equal(final.status, 'EXPIRED');
    assert.equal(final.result!.score, 0);
  });

  it('per-question timing never runs past the quiz end', async () => {
    const quiz = await publishedQuiz(
      { timerMode: 'PER_QUESTION', questionTimeSeconds: 600, navigation: 'LINEAR' },
      undefined,
      plusMinutes(ENDS, -15),
    );
    const attempt = (await start(sam, quiz.slug))!;
    assert.equal(attempt.deadlineAt, ENDS.toISOString());
    // Q1 runs out at ENDS − 5 min; Q2's 10 minutes are cut to the quiz end.
    at(plusMinutes(ENDS, -2));
    const late = await getAttempt(sam, attempt.id);
    assert.equal(late.currentPosition, 1);
    assert.equal(late.currentQuestionDeadlineAt, ENDS.toISOString());
  });

  it('free navigation has no advance step', async () => {
    const quiz = await publishedQuiz();
    const attempt = (await start(sam, quiz.slug))!;
    assert.equal(attempt.questions.length, 3);
    assert.equal(attempt.currentPosition, null);
    expectStatus(
      await sam.api('POST', `${ATTEMPTS}/${attempt.id}/advance`, { fromPosition: 0 }),
      409,
    );
  });
});

describe('Academy Quizzes (student) — results', () => {
  async function finished(settings: Record<string, unknown>) {
    const quiz = await publishedQuiz(settings);
    const attempt = (await start(sam, quiz.slug))!;
    expectStatus(await answer(sam, attempt.id, attempt.questions[0]!.id), 200);
    const final = await sam.api<StudentAcademyAttemptDto>(
      'POST',
      `${ATTEMPTS}/${attempt.id}/submit`,
    );
    expectStatus(final, 200);
    return { quiz, attempt: final.body.data };
  }

  it('immediate release shows the score; answers wait for the end (AFTER_CLOSE)', async () => {
    const { quiz, attempt } = await finished({});
    assert.equal(attempt.resultState, 'RELEASED');
    assert.equal(attempt.result!.score, 2);
    assert.equal(attempt.review, null);
    at(ENDS);
    const later = await getAttempt(sam, attempt.id);
    assert.ok(later.review);
    assert.equal(later.review!.length, 3);
    const detail = (await sam.api<StudentAcademyQuizDetail>('GET', `${STUDENT}/${quiz.slug}`)).body
      .data;
    assert.equal(detail.participation.bestResult!.score, 2);
  });

  it('scheduled release shows the score from the scheduled time on', async () => {
    const resultsAt = plusMinutes(ENDS, 60);
    const { attempt } = await finished({
      resultRelease: 'SCHEDULED',
      resultsAt: resultsAt.toISOString(),
      answerReveal: 'AFTER_SUBMISSION',
    });
    assert.equal(attempt.resultState, 'AWAITING_RELEASE');
    assert.equal(attempt.result, null);
    assert.equal(attempt.review, null);
    assert.equal(attempt.resultsAt, resultsAt.toISOString());
    at(resultsAt);
    const released = await getAttempt(sam, attempt.id);
    assert.equal(released.resultState, 'RELEASED');
    assert.equal(released.result!.score, 2);
    assert.ok(released.review);
  });

  it('manual release waits for the administrator', async () => {
    const { quiz, attempt } = await finished({ resultRelease: 'MANUAL', answerReveal: 'NEVER' });
    assert.equal(attempt.resultState, 'AWAITING_RELEASE');
    at(ENDS);
    assert.equal((await getAttempt(sam, attempt.id)).result, null);
    expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/publish-results`), 200);
    const released = await getAttempt(sam, attempt.id);
    assert.equal(released.result!.score, 2);
    assert.equal(released.review, null); // answerReveal NEVER
  });
});
