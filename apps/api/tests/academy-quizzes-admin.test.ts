/**
 * Academy Quiz administration over real HTTP and the real database (docs/ASSESSMENTS.md
 * §Academy): permissions (Admin/Super Admin only; Faculty and Students refused; academy and
 * course questions never reachable through each other's routes), settings validation, the
 * lifecycle (draft → publish → unpublish/close → reopen), the post-publication freeze, result
 * release, banner/prize images, question authoring with images and difficulty, and copying from
 * course quizzes, exams and academy quizzes with image references kept safe.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type {
  AdminAcademyQuizDetail,
  AdminAcademyQuizItem,
  CopyQuestionsResultDto,
  CopySourceItem,
  Paginated,
  QuestionDto,
} from '@asra/types';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { setClockForTests } from '../src/lib/clock.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { setImageStoreForTests } from '../src/modules/assessments/media/image-store.js';
import {
  at,
  buildWorld,
  createExam,
  createQuiz,
  mcq,
  plusMinutes,
  written,
  type World,
} from './support/assessment.js';
import { login, provision } from './support/auth.js';
import { apiAs, createAcademicBasics, expectStatus, type Api } from './support/catalog.js';
import { startServer, TestClient } from './support/http.js';
import { fakeImageStore, uploadImage, webp, type FakeImageStore } from './support/media.js';

let baseUrl: string;
let close: () => Promise<void>;
let w: World;
let store: FakeImageStore;
let admin: { api: Api; token: string; userId: string };
let superAdmin: { api: Api; token: string; userId: string };

async function signIn(role: 'ADMIN' | 'SUPER_ADMIN') {
  const user = await provision(role);
  const client = new TestClient(baseUrl);
  const session = await login(client, user.email);
  return { api: apiAs(client, session.accessToken), token: session.accessToken, userId: user.id };
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
  store = fakeImageStore();
  setImageStoreForTests(store);
  w = await buildWorld(baseUrl);
  [admin, superAdmin] = [await signIn('ADMIN'), await signIn('SUPER_ADMIN')];
});

const T0 = new Date('2026-12-01T04:30:00.000Z');
const BASE = '/admin/academy-quizzes';

const schedule = (now = T0) => ({
  startsAt: plusMinutes(now, 60).toISOString(),
  endsAt: plusMinutes(now, 180).toISOString(),
  durationMinutes: 30,
});

async function createDraft(api: Api = admin.api, extra: Record<string, unknown> = {}) {
  const response = await api<AdminAcademyQuizDetail>('POST', BASE, {
    title: 'Science Olympiad 2026',
    ...schedule(),
    ...extra,
  });
  expectStatus(response, 201);
  return response.body.data;
}

const question = (marks = 2, difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null = null) => ({
  ...mcq(marks),
  difficulty,
});

async function addQuestion(quizId: string, body: object = question()) {
  const response = await admin.api<QuestionDto>('POST', `${BASE}/${quizId}/questions`, body);
  expectStatus(response, 201);
  return response.body.data;
}

const detail = async (quizId: string) =>
  (await admin.api<AdminAcademyQuizDetail>('GET', `${BASE}/${quizId}`)).body.data;

const transition = (quizId: string, action: string) =>
  admin.api<AdminAcademyQuizDetail>('POST', `${BASE}/${quizId}/status`, { action });

async function adminUpload(token = admin.token) {
  const response = await uploadImage(baseUrl, token, webp(), { portal: 'admin' });
  assert.equal(response.status, 201, response.text);
  return response.body!.data;
}

/** An attempt row as the Step-3 engine will create it (here only to test lifecycle rules). */
async function insertAttempt(quizId: string, userId: string, startedAt: Date, deadlineAt: Date) {
  return prisma.assessmentAttempt.create({
    data: {
      academyQuizId: quizId,
      userId,
      attemptNumber: 1,
      startedAt,
      deadlineAt,
      maxScore: new Prisma.Decimal('2.00'),
      questions: {
        create: [
          {
            position: 0,
            type: 'SINGLE_CHOICE',
            snapshot: {
              prompt: 'x',
              explanation: null,
              options: [{ id: '00000000-0000-4000-8000-0000000000aa', text: 'a', isCorrect: true }],
              images: [],
            },
            marks: new Prisma.Decimal('2.00'),
            negativeMarks: new Prisma.Decimal('0.00'),
            selectedOptionIds: ['00000000-0000-4000-8000-0000000000aa'],
          },
        ],
      },
    },
  });
}

describe('permissions', () => {
  it('Admin and Super Admin manage academy quizzes; Faculty and Students are refused', async () => {
    at(T0);
    assert.equal((await createDraft(admin.api)).status, 'DRAFT');
    await createDraft(superAdmin.api, { title: 'Second' });
    for (const outsider of [w.alice.api, w.sam.api]) {
      assert.equal((await outsider('GET', BASE)).status, 403);
      assert.equal((await outsider('POST', BASE, { title: 'x', ...schedule() })).status, 403);
    }
    const list = await admin.api<Paginated<AdminAcademyQuizItem>>('GET', BASE);
    expectStatus(list, 200);
    assert.equal(list.body.data.items.length, 2);
  });

  it('academy and course questions are never reachable through each other’s routes', async () => {
    at(T0);
    const quiz = await createDraft();
    const academyQuestion = await addQuestion(quiz.id);
    const courseQuiz = await createQuiz(w.alice, w.courseA.chapterId, { publish: false });
    const courseQuestion = courseQuiz.questions[0]!;

    // Faculty (even the course's own teacher) cannot touch an academy question…
    assert.equal(
      (await w.alice.api('PATCH', `/faculty/questions/${academyQuestion.id}`, mcq())).status,
      404,
    );
    assert.equal(
      (await w.alice.api('DELETE', `/faculty/questions/${academyQuestion.id}`)).status,
      404,
    );
    // …and the academy admin routes cannot touch a course question.
    assert.equal(
      (await admin.api('PATCH', `/admin/academy-quiz-questions/${courseQuestion.id}`, mcq()))
        .status,
      404,
    );
    assert.equal(
      (await admin.api('DELETE', `/admin/academy-quiz-questions/${courseQuestion.id}`)).status,
      404,
    );
  });
});

describe('settings and validation', () => {
  it('applies defaults, derives a unique slug and keeps a requested one exact', async () => {
    at(T0);
    const first = await createDraft();
    assert.equal(first.slug, 'science-olympiad-2026');
    assert.equal(first.settings.timeZone, 'Asia/Kolkata');
    assert.equal(first.settings.timerMode, 'OVERALL');
    assert.equal(first.settings.resultRelease, 'IMMEDIATE');
    assert.equal(first.settings.leaderboardVisibility, 'SIGNED_IN');
    assert.equal(first.phase, 'DRAFT');
    assert.equal((await createDraft()).slug, 'science-olympiad-2026-2');
    const taken = await admin.api('POST', BASE, {
      title: 'Other',
      slug: 'science-olympiad-2026',
      ...schedule(),
    });
    assert.equal(taken.status, 409);
  });

  it('rejects inconsistent settings field by field', async () => {
    at(T0);
    const s = schedule();
    const cases: [Record<string, unknown>, string][] = [
      [{ endsAt: s.startsAt }, 'endsAt'],
      [{ timerMode: 'PER_QUESTION', durationMinutes: null, questionTimeSeconds: 30 }, 'navigation'],
      [{ durationMinutes: null }, 'durationMinutes'],
      [{ resultRelease: 'SCHEDULED' }, 'resultsAt'],
      [{ resultRelease: 'SCHEDULED', resultsAt: s.startsAt }, 'resultsAt'],
      [{ selection: 'RANDOM' }, 'questionsPerAttempt'],
      [{ selection: 'BY_DIFFICULTY', easyCount: 0, mediumCount: 0, hardCount: 0 }, 'easyCount'],
      [{ requireAnswerToAdvance: true }, 'requireAnswerToAdvance'],
      [{ timeZone: 'Mars/Olympus' }, 'timeZone'],
      [{ maxAttempts: 6 }, 'maxAttempts'],
      [
        {
          prizes: [
            { position: 1, title: 'Gold' },
            { position: 1, title: 'Also gold' },
          ],
        },
        'prizes',
      ],
      [{ status: 'PUBLISHED' }, ''],
    ];
    for (const [extra, field] of cases) {
      const response = await admin.api('POST', BASE, { title: 'Bad', ...s, ...extra });
      assert.equal(response.status, 422, `${JSON.stringify(extra)}: ${response.text}`);
      if (field) assert.match(response.text, new RegExp(`"${field}"`), JSON.stringify(extra));
    }
    // A valid per-question quiz: linear navigation, no overall duration.
    const perQuestion = await createDraft(admin.api, {
      durationMinutes: null,
      timerMode: 'PER_QUESTION',
      questionTimeSeconds: 45,
      navigation: 'LINEAR',
      requireAnswerToAdvance: true,
    });
    assert.equal(perQuestion.settings.questionTimeSeconds, 45);
  });

  it('restricts eligibility to existing classes and streams', async () => {
    at(T0);
    const basics = await createAcademicBasics(admin.api);
    const ok = await createDraft(admin.api, { eligibleClassIds: [basics.classId] });
    assert.deepEqual(
      ok.eligibleClasses.map((c) => c.id),
      [basics.classId],
    );
    const unknown = await admin.api('POST', BASE, {
      title: 'x',
      ...schedule(),
      eligibleClassIds: ['00000000-0000-4000-8000-00000000c1a5'],
    });
    assert.equal(unknown.status, 422);
    assert.match(unknown.text, /eligibleClassIds/);
  });
});

describe('questions (shared authoring, images, difficulty)', () => {
  it('stores difficulty and images; refuses written answers', async () => {
    at(T0);
    const quiz = await createDraft();
    const image = await adminUpload();
    const created = await addQuestion(quiz.id, { ...question(2, 'HARD'), imageIds: [image.id] });
    assert.equal(created.difficulty, 'HARD');
    assert.equal(created.images[0]!.id, image.id);
    const writtenAnswer = await admin.api('POST', `${BASE}/${quiz.id}/questions`, written());
    assert.equal(writtenAnswer.status, 422);

    const edited = await admin.api<QuestionDto>(
      'PATCH',
      `/admin/academy-quiz-questions/${created.id}`,
      { ...question(2, 'EASY'), imageIds: [] },
    );
    expectStatus(edited, 200);
    assert.equal(edited.body.data.difficulty, 'EASY');
    assert.equal(store.destroyed.length, 1, 'the removed image is released');
  });

  it('course quizzes never store a difficulty (unchanged behaviour)', async () => {
    const courseQuiz = await createQuiz(w.alice, w.courseA.chapterId, {
      questions: [],
      publish: false,
    });
    const created = await w.alice.api<QuestionDto>(
      'POST',
      `/faculty/quizzes/${courseQuiz.lessonId}/questions`,
      { ...mcq(), difficulty: 'HARD' },
    );
    expectStatus(created, 201);
    assert.equal(created.body.data.difficulty, null);
  });

  it('reports the selection plan and what blocks publication', async () => {
    at(T0);
    const quiz = await createDraft(admin.api, { selection: 'RANDOM', questionsPerAttempt: 2 });
    let d = await detail(quiz.id);
    assert.deepEqual(d.publishProblems, ['Add at least one question.']);
    await addQuestion(quiz.id, question(2));
    await addQuestion(quiz.id, question(3));
    d = await detail(quiz.id);
    assert.equal(d.totalMarksPerAttempt, null);
    assert.match(d.publishProblems.join(' '), /same marks/);
    const blocked = await transition(quiz.id, 'publish');
    assert.equal(blocked.status, 422);
    assert.match(blocked.text, /same marks/);

    const byLevel = await createDraft(admin.api, {
      title: 'Levels',
      selection: 'BY_DIFFICULTY',
      easyCount: 2,
      mediumCount: 0,
      hardCount: 1,
    });
    await addQuestion(byLevel.id, question(1, 'EASY'));
    await addQuestion(byLevel.id, question(1, 'EASY'));
    await addQuestion(byLevel.id, question(4, 'MEDIUM'));
    d = await detail(byLevel.id);
    assert.deepEqual(d.pool, { total: 3, EASY: 2, MEDIUM: 1, HARD: 0, unrated: 0 });
    assert.match(d.publishProblems.join(' '), /1 hard question, but only 0/);
    await addQuestion(byLevel.id, question(5, 'HARD'));
    d = await detail(byLevel.id);
    assert.deepEqual(d.publishProblems, []);
    assert.equal(d.questionsPerAttempt, 3);
    assert.equal(d.totalMarksPerAttempt, 7, '2 × 1 (easy) + 1 × 5 (hard)');
  });
});

describe('lifecycle', () => {
  it('draft → publish → frozen rules, editable content, extension only → unpublish', async () => {
    at(T0);
    const quiz = await createDraft();
    await addQuestion(quiz.id);
    const published = await transition(quiz.id, 'publish');
    expectStatus(published, 200);
    assert.equal(published.body.data.status, 'PUBLISHED');
    assert.equal(published.body.data.phase, 'UPCOMING');

    const frozen = await admin.api('PATCH', `${BASE}/${quiz.id}`, {
      durationMinutes: 45,
      negativeMarking: true,
    });
    assert.equal(frozen.status, 409);
    assert.match(frozen.text, /durationMinutes/);
    assert.match(frozen.text, /negativeMarking/);
    // The same value (even written differently) is not a change.
    const sameStart = new Date(schedule().startsAt).toISOString().replace('Z', '+00:00');
    expectStatus(await admin.api('PATCH', `${BASE}/${quiz.id}`, { startsAt: sameStart }), 200);
    const renamed = await admin.api<AdminAcademyQuizDetail>('PATCH', `${BASE}/${quiz.id}`, {
      title: 'Science Olympiad — Final',
      maskNames: true,
    });
    expectStatus(renamed, 200);
    assert.equal(renamed.body.data.settings.maskNames, true);
    assert.equal(renamed.body.data.slug, quiz.slug, 'the public URL stays the same');

    const later = plusMinutes(T0, 240).toISOString();
    expectStatus(await admin.api('PATCH', `${BASE}/${quiz.id}`, { endsAt: later }), 200);
    const earlier = await admin.api('PATCH', `${BASE}/${quiz.id}`, {
      endsAt: plusMinutes(T0, 200).toISOString(),
    });
    assert.equal(earlier.status, 409, 'never shortened');
    assert.equal(
      (await admin.api('POST', `${BASE}/${quiz.id}/questions`, question())).status,
      409,
      'questions are frozen too',
    );

    at(plusMinutes(T0, 90));
    assert.equal((await detail(quiz.id)).phase, 'LIVE');
    const back = await transition(quiz.id, 'unpublish');
    expectStatus(back, 200);
    assert.equal(back.body.data.status, 'DRAFT');
  });

  it('cannot unpublish once attempted; close finalizes running attempts; reopen only before the end', async () => {
    at(T0);
    const quiz = await createDraft();
    await addQuestion(quiz.id);
    expectStatus(await transition(quiz.id, 'publish'), 200);
    const now = at(plusMinutes(T0, 70));
    const attempt = await insertAttempt(quiz.id, w.sam.userId, now, plusMinutes(now, 30));

    const refused = await transition(quiz.id, 'unpublish');
    assert.equal(refused.status, 409);
    assert.equal(
      (await admin.api('DELETE', `${BASE}/${quiz.id}`)).status,
      409,
      'a published quiz is never deleted',
    );

    at(plusMinutes(T0, 75));
    const closed = await transition(quiz.id, 'close');
    expectStatus(closed, 200);
    assert.equal(closed.body.data.status, 'CLOSED');
    const finalized = await prisma.assessmentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    assert.equal(finalized.status, 'EXPIRED');
    assert.equal(finalized.evaluationStatus, 'EVALUATED');
    assert.equal(finalized.score?.toString(), '2', 'scored with the academy quiz’s rules');

    const reopened = await transition(quiz.id, 'reopen');
    expectStatus(reopened, 200);
    expectStatus(await transition(quiz.id, 'close'), 200);
    at(plusMinutes(T0, 181));
    const tooLate = await transition(quiz.id, 'reopen');
    assert.equal(tooLate.status, 409);
    assert.match(tooLate.text, /end time has passed/);
  });

  it('refuses to publish a quiz whose end has passed', async () => {
    at(T0);
    const quiz = await createDraft();
    await addQuestion(quiz.id);
    at(plusMinutes(T0, 200));
    const response = await transition(quiz.id, 'publish');
    assert.equal(response.status, 422);
    assert.match(response.text, /end time has already passed/);
  });

  it('deletes a draft with its questions and releases its images', async () => {
    at(T0);
    const banner = await adminUpload();
    const quiz = await createDraft(admin.api, { bannerMediaId: banner.id });
    const image = await adminUpload();
    await addQuestion(quiz.id, { ...question(), imageIds: [image.id] });
    expectStatus(await admin.api('DELETE', `${BASE}/${quiz.id}`), 200);
    assert.equal(await prisma.academyQuiz.count({ where: { id: quiz.id } }), 0);
    assert.equal(await prisma.assessmentQuestion.count({ where: { academyQuizId: quiz.id } }), 0);
    assert.equal(store.destroyed.length, 2);
    assert.equal(await prisma.assessmentMedia.count(), 0);
  });
});

describe('result publication', () => {
  it('manual release only after the end; idempotent; automatic modes refuse', async () => {
    at(T0);
    const manual = await createDraft(admin.api, { resultRelease: 'MANUAL' });
    await addQuestion(manual.id);
    expectStatus(await transition(manual.id, 'publish'), 200);
    const early = await admin.api('POST', `${BASE}/${manual.id}/publish-results`);
    assert.equal(early.status, 409);
    at(plusMinutes(T0, 181));
    const first = await admin.api<AdminAcademyQuizDetail>(
      'POST',
      `${BASE}/${manual.id}/publish-results`,
    );
    expectStatus(first, 200);
    assert.ok(first.body.data.resultsPublishedAt);
    const again = await admin.api('POST', `${BASE}/${manual.id}/publish-results`);
    expectStatus(again, 200);
    assert.match(again.text, /already published/);

    at(T0);
    const immediate = await createDraft(admin.api, { title: 'Immediate' });
    await addQuestion(immediate.id);
    expectStatus(await transition(immediate.id, 'publish'), 200);
    at(plusMinutes(T0, 181));
    assert.equal((await admin.api('POST', `${BASE}/${immediate.id}/publish-results`)).status, 409);
  });
});

describe('banner and prize images', () => {
  it('attaches the admin’s own uploads, replaces and releases, refuses others’ uploads', async () => {
    at(T0);
    const [banner, gold, silver] = [await adminUpload(), await adminUpload(), await adminUpload()];
    const quiz = await createDraft(admin.api, {
      bannerMediaId: banner.id,
      prizes: [
        { position: 2, title: 'Silver', imageMediaId: silver.id },
        { position: 1, title: 'Gold', description: 'Tablet', imageMediaId: gold.id },
      ],
    });
    assert.equal(quiz.banner?.id, banner.id);
    assert.deepEqual(
      quiz.prizes.map((p) => [p.position, p.image?.id]),
      [
        [1, gold.id],
        [2, silver.id],
      ],
    );

    const newBanner = await adminUpload();
    const bannerPublicId = (
      await prisma.assessmentMedia.findUniqueOrThrow({ where: { id: banner.id } })
    ).publicId;
    expectStatus(
      await admin.api('PATCH', `${BASE}/${quiz.id}`, {
        bannerMediaId: newBanner.id,
        prizes: [{ position: 1, title: 'Gold', imageMediaId: gold.id }],
      }),
      200,
    );
    assert.ok(store.destroyed.includes(bannerPublicId), 'old banner released');
    assert.equal(
      await prisma.assessmentMedia.count({ where: { id: silver.id } }),
      0,
      'removed prize image released',
    );
    assert.equal(
      await prisma.assessmentMedia.count({ where: { id: gold.id } }),
      1,
      'kept prize image kept',
    );

    const othersUpload = await adminUpload(superAdmin.token);
    const stolen = await admin.api('PATCH', `${BASE}/${quiz.id}`, {
      bannerMediaId: othersUpload.id,
    });
    assert.equal(stolen.status, 422);
  });
});

describe('copying questions', () => {
  it('copies from a course quiz with the same image references; the source edit cannot delete them', async () => {
    at(T0);
    const facultyImage = await uploadImage(baseUrl, w.alice.token, webp());
    const imageId = facultyImage.body!.data.id;
    const courseQuiz = await createQuiz(w.alice, w.courseA.chapterId, {
      questions: [{ ...mcq(), imageIds: [imageId] } as ReturnType<typeof mcq>, mcq(3)],
      publish: false,
    });
    const target = await createDraft();

    const sources = await admin.api<Paginated<CopySourceItem>>(
      'GET',
      `${BASE}/${target.id}/copy-sources?kind=QUIZ`,
    );
    expectStatus(sources, 200);
    assert.deepEqual(
      sources.body.data.items.map((s) => [s.kind, s.id, s.questionCount]),
      [['QUIZ', courseQuiz.quizId, 2]],
    );
    const sourceQuestions = await admin.api<QuestionDto[]>(
      'GET',
      `${BASE}/${target.id}/copy-sources/QUIZ/${courseQuiz.quizId}/questions`,
    );
    expectStatus(sourceQuestions, 200);

    const copied = await admin.api<CopyQuestionsResultDto>(
      'POST',
      `${BASE}/${target.id}/questions/copy`,
      {
        source: { kind: 'QUIZ', id: courseQuiz.quizId },
        questionIds: courseQuiz.questions.map((q) => q.id),
      },
    );
    expectStatus(copied, 201);
    assert.equal(copied.body.data.copied, 2);
    const [first] = copied.body.data.questions;
    assert.equal(first!.images[0]!.id, imageId, 'same media referenced, no duplicate file');
    assert.equal(first!.difficulty, null);
    assert.notEqual(first!.id, courseQuiz.questions[0]!.id, 'a new, independent question');
    assert.equal(store.uploaded.size, 1);

    // The faculty removes the image from THEIR question: the copy still uses it, so it stays.
    expectStatus(
      await w.alice.api('PATCH', `/faculty/questions/${courseQuiz.questions[0]!.id}`, mcq()),
      200,
    );
    assert.equal(store.destroyed.length, 0);
    assert.equal(await prisma.assessmentMedia.count({ where: { id: imageId } }), 1);
    // Removing the copy's image as well finally releases it.
    expectStatus(
      await admin.api('PATCH', `/admin/academy-quiz-questions/${first!.id}`, question()),
      200,
    );
    assert.equal(store.destroyed.length, 1);
  });

  it('skips written answers, keeps academy difficulty, validates the source and the target', async () => {
    at(T0);
    const exam = await createExam(
      w.alice,
      w.courseA.courseId,
      { opensAt: plusMinutes(T0, 10), closesAt: plusMinutes(T0, 120) },
      { questions: [mcq(4), written()], publish: false },
    );
    const target = await createDraft();
    const fromExam = await admin.api<CopyQuestionsResultDto>(
      'POST',
      `${BASE}/${target.id}/questions/copy`,
      {
        source: { kind: 'EXAM', id: exam.examId },
        questionIds: exam.questions.map((q) => q.id),
      },
    );
    expectStatus(fromExam, 201);
    assert.deepEqual([fromExam.body.data.copied, fromExam.body.data.skippedWritten], [1, 1]);

    const other = await createDraft(admin.api, { title: 'Earlier quiz' });
    const hard = await addQuestion(other.id, question(2, 'HARD'));
    const fromAcademy = await admin.api<CopyQuestionsResultDto>(
      'POST',
      `${BASE}/${target.id}/questions/copy`,
      { source: { kind: 'ACADEMY', id: other.id }, questionIds: [hard.id] },
    );
    expectStatus(fromAcademy, 201);
    assert.equal(fromAcademy.body.data.questions.at(-1)!.difficulty, 'HARD');

    const foreign = await admin.api('POST', `${BASE}/${target.id}/questions/copy`, {
      source: { kind: 'ACADEMY', id: other.id },
      questionIds: [exam.questions[0]!.id],
    });
    assert.equal(foreign.status, 422, 'questions must belong to the source');

    await transition(target.id, 'publish');
    const intoPublished = await admin.api('POST', `${BASE}/${target.id}/questions/copy`, {
      source: { kind: 'ACADEMY', id: other.id },
      questionIds: [hard.id],
    });
    assert.equal(intoPublished.status, 409);
  });
});

describe('audit trail', () => {
  it('records every administrative change', async () => {
    at(T0);
    const quiz = await createDraft();
    await addQuestion(quiz.id);
    await admin.api('PATCH', `${BASE}/${quiz.id}`, { title: 'Renamed' });
    await transition(quiz.id, 'publish');
    await transition(quiz.id, 'close');
    const actions = (
      await prisma.adminAuditLog.findMany({
        where: { entityType: 'academy_quiz', entityId: quiz.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.action);
    assert.deepEqual(actions, [
      'academy_quiz.created',
      'academy_quiz.updated',
      'academy_quiz.published',
      'academy_quiz.closed',
    ]);
  });
});
