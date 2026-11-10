/**
 * Academy Quiz admin screens: the form ↔ request mapping (IST inputs, mode-dependent fields),
 * which settings are locked after publication, the lifecycle actions offered, the readiness
 * panel and the access rules (navigation + direct URLs). Network behaviour of every endpoint is
 * covered by apps/api/tests/academy-quizzes-admin.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PERMISSIONS, type AdminAcademyQuizDetail, type AuthUser } from '@asra/types';
import { ACADEMY_QUIZ_DEFAULTS, academyQuizSettingsSchema } from '@asra/validation';

import { copyKindsFor } from '@/components/admin/academy-quizzes/copy-questions-dialog';
import { Readiness, historyLabel } from '@/components/admin/academy-quizzes/quiz-detail';
import { buildNavigation, canAccessAdminPath } from '@/components/admin/admin-shell';
import { canUseAdminPortal, hasPermission } from '@/components/admin/use-admin';
import {
  availableActions,
  emptyForm,
  formFromDetail,
  formToBody,
  isLockedAfterPublish,
  publishedPatch,
  timingSummary,
} from '@/lib/admin/academy-quizzes';

const settings = {
  title: 'Science Olympiad',
  slug: 'science-olympiad',
  summary: null,
  description: 'Big day',
  instructions: 'Read carefully',
  startsAt: '2026-12-01T04:30:00.000Z',
  endsAt: '2026-12-01T06:30:00.000Z',
  resultsAt: null,
  timeZone: 'Asia/Kolkata',
  timerMode: 'OVERALL' as const,
  durationMinutes: 45,
  questionTimeSeconds: null,
  navigation: 'FREE' as const,
  requireAnswerToAdvance: false,
  selection: 'ALL' as const,
  questionsPerAttempt: null,
  easyCount: null,
  mediumCount: null,
  hardCount: null,
  shuffleQuestions: true,
  shuffleOptions: false,
  negativeMarking: true,
  passPercent: 40,
  maxAttempts: 2,
  eligibleClassIds: [],
  eligibleStreamIds: [],
  resultRelease: 'IMMEDIATE' as const,
  answerReveal: 'AFTER_CLOSE' as const,
  leaderboardVisibility: 'SIGNED_IN' as const,
  maskNames: false,
  attemptCounting: 'BEST' as const,
  tieBreak: 'TIME_TAKEN' as const,
};

function quiz(overrides: Partial<AdminAcademyQuizDetail> = {}): AdminAcademyQuizDetail {
  return {
    id: 'q1',
    slug: settings.slug,
    title: settings.title,
    status: 'DRAFT',
    phase: 'DRAFT',
    startsAt: settings.startsAt,
    endsAt: settings.endsAt,
    questionCount: 2,
    attempts: { total: 0, inProgress: 0, pendingEvaluation: 0, evaluated: 0 },
    publishedAt: null,
    updatedAt: '2026-11-20T00:00:00.000Z',
    settings,
    banner: null,
    prizes: [],
    eligibleClasses: [],
    eligibleStreams: [],
    questions: [],
    pool: { total: 2, EASY: 1, MEDIUM: 1, HARD: 0, unrated: 0 },
    questionsPerAttempt: 2,
    totalMarksPerAttempt: 4,
    publishProblems: [],
    resultsPublishedAt: null,
    closedAt: null,
    serverNow: '2026-11-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('settings form mapping', () => {
  it('round-trips a stored quiz (IST inputs back to the same instants)', () => {
    const form = formFromDetail(quiz());
    assert.equal(form.startsAt, '2026-12-01T10:00', '04:30 UTC is 10:00 IST');
    const body = formToBody(form);
    // Sent with the IST offset (same format as exams); the same instant as stored.
    assert.equal(body.startsAt, '2026-12-01T10:00:00+05:30');
    assert.equal(Date.parse(body.startsAt!), Date.parse(settings.startsAt));
    assert.equal(Date.parse(body.endsAt!), Date.parse(settings.endsAt));
    for (const key of Object.keys(settings) as (keyof typeof settings)[]) {
      if (key === 'slug' || key === 'startsAt' || key === 'endsAt') continue;
      assert.deepEqual(body[key], settings[key], key);
    }
    assert.equal(academyQuizSettingsSchema.safeParse(body).success, true);
  });

  it('a per-question timer forces forward-only navigation and drops the overall duration', () => {
    const body = formToBody({
      ...formFromDetail(quiz()),
      timerMode: 'PER_QUESTION',
      questionTimeSeconds: '45',
      navigation: 'FREE',
      requireAnswerToAdvance: true,
    });
    assert.equal(body.navigation, 'LINEAR');
    assert.equal(body.durationMinutes, null);
    assert.equal(body.questionTimeSeconds, 45);
    assert.equal(body.requireAnswerToAdvance, true);
    assert.equal(academyQuizSettingsSchema.safeParse(body).success, true);
  });

  it('sends only the fields of the chosen selection and result modes', () => {
    const base = formFromDetail(quiz());
    const random = formToBody({
      ...base,
      selection: 'RANDOM',
      questionsPerAttempt: '5',
      easyCount: '3',
    });
    assert.deepEqual(
      [random.questionsPerAttempt, random.easyCount, random.mediumCount, random.hardCount],
      [5, null, null, null],
    );
    const levels = formToBody({
      ...base,
      selection: 'BY_DIFFICULTY',
      easyCount: '2',
      hardCount: '1',
    });
    assert.deepEqual([levels.easyCount, levels.mediumCount, levels.hardCount], [2, 0, 1]);
    assert.equal(levels.questionsPerAttempt, null);
    const free = formToBody({ ...base, navigation: 'FREE', requireAnswerToAdvance: true });
    assert.equal(free.requireAnswerToAdvance, false, 'only forward-only navigation can require it');
    const scheduled = formToBody({
      ...base,
      resultRelease: 'SCHEDULED',
      resultsAt: '2026-12-01T13:00',
    });
    assert.equal(Date.parse(scheduled.resultsAt!), Date.parse('2026-12-01T07:30:00.000Z'));
    assert.equal(formToBody({ ...base, resultsAt: '2026-12-01T13:00' }).resultsAt, null);
  });

  it('a new form needs a title and schedule; invalid times are reported, not guessed', () => {
    const body = formToBody({ ...emptyForm(), title: 'x', startsAt: 'not a date' });
    assert.equal(body.startsAt, undefined);
    const result = academyQuizSettingsSchema.safeParse({ ...ACADEMY_QUIZ_DEFAULTS, ...body });
    assert.equal(result.success, false);
    const fields = result.error!.issues.map((issue) => issue.path[0]);
    assert.ok(fields.includes('startsAt') && fields.includes('endsAt'));
  });

  it('after publication only content, prizes and result display are sent', () => {
    const patch = publishedPatch(formToBody(formFromDetail(quiz())));
    assert.ok('title' in patch && 'prizes' in patch && 'endsAt' in patch && 'maskNames' in patch);
    for (const frozen of [
      'durationMinutes',
      'negativeMarking',
      'selection',
      'eligibleClassIds',
      'tieBreak',
      'slug',
    ]) {
      assert.ok(!(frozen in patch), frozen);
    }
    assert.equal(isLockedAfterPublish('negativeMarking'), true);
    assert.equal(isLockedAfterPublish('banner'), false);
    assert.equal(isLockedAfterPublish('endsAt'), false);
  });
});

describe('lifecycle actions offered', () => {
  const now = new Date('2026-12-01T05:00:00.000Z'); // during the quiz
  const after = new Date('2026-12-01T07:00:00.000Z');
  const attempted = { total: 3, inProgress: 0, pendingEvaluation: 0, evaluated: 3 };

  it('mirror the API rules', () => {
    assert.deepEqual(availableActions(quiz(), now), ['publish', 'delete']);
    assert.deepEqual(availableActions(quiz({ attempts: attempted }), now), ['publish']);
    const published = quiz({ status: 'PUBLISHED', phase: 'LIVE' });
    assert.deepEqual(availableActions(published, now), ['unpublish', 'close']);
    assert.deepEqual(availableActions({ ...published, attempts: attempted }, now), ['close']);
    const closed = quiz({ status: 'CLOSED', phase: 'CLOSED' });
    assert.deepEqual(availableActions(closed, now), ['reopen']);
    assert.deepEqual(availableActions(closed, after), [], 'no reopening after the end');
  });

  it('offers manual result release only after the end, once', () => {
    const manual = quiz({
      status: 'PUBLISHED',
      settings: { ...settings, resultRelease: 'MANUAL' },
      attempts: attempted,
    });
    assert.ok(!availableActions(manual, now).includes('publishResults'));
    assert.ok(availableActions(manual, after).includes('publishResults'));
    assert.ok(
      !availableActions({ ...manual, resultsPublishedAt: after.toISOString() }, after).includes(
        'publishResults',
      ),
    );
    assert.ok(!availableActions({ ...manual, settings }, after).includes('publishResults'));
  });

  it('summarises the timer', () => {
    assert.equal(timingSummary(quiz()), '45 min overall');
    assert.equal(
      timingSummary(
        quiz({
          settings: {
            ...settings,
            timerMode: 'PER_QUESTION',
            durationMinutes: null,
            questionTimeSeconds: 30,
          },
        }),
      ),
      '30 s per question',
    );
  });
});

describe('readiness panel', () => {
  it('shows availability per difficulty and every blocker', () => {
    const html = renderToStaticMarkup(
      <Readiness
        quiz={quiz({
          settings: {
            ...settings,
            selection: 'BY_DIFFICULTY',
            easyCount: 2,
            mediumCount: 1,
            hardCount: 1,
          },
          questionsPerAttempt: null,
          totalMarksPerAttempt: null,
          publishProblems: ['Each student gets 1 hard question, but only 0 are marked hard.'],
        })}
      />,
    );
    assert.match(html, /Each student gets/);
    assert.match(html, /only 0 are marked hard/);
    assert.match(html, /Before publishing/);
    assert.match(html, /never drawn/);
    assert.match(html, /negative marking on/);
  });

  it('says when a draft is ready', () => {
    const html = renderToStaticMarkup(<Readiness quiz={quiz()} />);
    assert.match(html, /Ready to publish/);
    assert.match(html, /out of.*4.*marks/s);
  });

  it('labels history entries and copy sources', () => {
    assert.equal(historyLabel('academy_quiz.closed'), 'Closed');
    assert.equal(historyLabel('something.else'), 'something.else');
    assert.deepEqual(
      copyKindsFor(() => true),
      ['ACADEMY', 'QUIZ', 'EXAM'],
    );
    assert.deepEqual(
      copyKindsFor(() => false),
      ['ACADEMY'],
      'course answer keys need content.manage',
    );
  });
});

describe('access to Academy Quiz administration', () => {
  const account = (permissions: string[]): AuthUser => ({
    id: 'u',
    email: 'a@example.test',
    fullName: 'A',
    emailVerified: true,
    roles: [],
    permissions,
  });
  const admin = account([PERMISSIONS.ACADEMY_QUIZZES_MANAGE, PERMISSIONS.CONTENT_MANAGE]);
  const faculty = account([
    PERMISSIONS.CONTENT_MANAGE_ASSIGNED,
    PERMISSIONS.STUDENTS_VIEW_ASSIGNED,
    PERMISSIONS.SUBMISSIONS_GRADE_ASSIGNED,
    PERMISSIONS.PROFILE_MANAGE_OWN,
  ]);
  const student = account([
    PERMISSIONS.CONTENT_VIEW_ENROLLED,
    PERMISSIONS.PROFILE_MANAGE_OWN,
    PERMISSIONS.ACADEMY_QUIZZES_PARTICIPATE,
  ]);
  const hrefs = (user: AuthUser) =>
    buildNavigation((p) => hasPermission(user, p)).flatMap((g) => g.items.map((i) => i.href));
  const allowed = (user: AuthUser, path: string) =>
    canAccessAdminPath(path, (p) => hasPermission(user, p));

  it('appears in the navigation only with academy_quizzes.manage', () => {
    assert.ok(hrefs(admin).includes('/admin/academy-quizzes'));
    assert.ok(!hrefs(account([PERMISSIONS.COURSES_MANAGE])).includes('/admin/academy-quizzes'));
  });

  it('every page is blocked by direct URL without the permission', () => {
    for (const path of [
      '/admin/academy-quizzes',
      '/admin/academy-quizzes/new',
      '/admin/academy-quizzes/3f0c',
      '/admin/academy-quizzes/3f0c/edit',
    ]) {
      assert.equal(allowed(admin, path), true, path);
      assert.equal(allowed(faculty, path), false, path);
      assert.equal(allowed(account([PERMISSIONS.COURSES_MANAGE]), path), false, path);
    }
  });

  it('Faculty and Students never get into the admin portal at all', () => {
    assert.equal(canUseAdminPortal(faculty), false);
    assert.equal(
      canUseAdminPortal(student),
      false,
      'participating in quizzes is not administration',
    );
    assert.equal(canUseAdminPortal(admin), true);
  });
});
