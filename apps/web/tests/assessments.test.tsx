/**
 * PHASE 09 web: assessment helpers (server-corrected countdown, answer selection), the shared
 * request schemas the forms validate with, and server-rendered markup of attempt outcomes for
 * every result-release state.
 *
 * Deadline enforcement, scoring and release rules are tested against the API
 * (apps/api/tests/examinations.test.ts, quizzes.test.ts); the countdown here is display-only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

import type { StudentAttemptDto } from '@asra/types';
import {
  answerSaveSchema,
  attemptSubmitSchema,
  examCreateSchema,
  questionInputSchema,
  quizSettingsSchema,
  QUIZ_DEFAULT_RULES,
} from '@asra/validation';

import {
  availableTransitions,
  AssessmentStatusBadge,
} from '@/components/faculty/assessment-builder';
import { AttemptOutcome } from '@/components/student/attempt-player';
import {
  ATTEMPT_STATUS_LABELS,
  clockSkewMs,
  countdownTone,
  formatCountdown,
  formatScore,
  isAnswered,
  remainingMs,
  RESULT_STATE_BADGE,
  RESULT_STATE_LABELS,
  toggleOption,
} from '@/lib/assessments';

const router = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
} as unknown as React.ContextType<typeof AppRouterContext>;

const html = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>,
  );

describe('countdown (display only, server-corrected)', () => {
  const deadline = '2026-11-02T05:00:00.000Z';
  const serverNow = '2026-11-02T04:50:00.000Z'; // 10 minutes left

  it('uses the server clock even when the device clock is wrong', () => {
    const deviceAhead = Date.parse('2026-11-02T05:20:00.000Z'); // device 30 min fast
    const skew = clockSkewMs(serverNow, deviceAhead);
    assert.equal(remainingMs(deadline, skew, deviceAhead), 10 * 60_000);
    // one device minute later → 9 minutes left
    assert.equal(remainingMs(deadline, skew, deviceAhead + 60_000), 9 * 60_000);
    const deviceBehind = Date.parse('2026-11-02T03:00:00.000Z');
    assert.equal(
      remainingMs(deadline, clockSkewMs(serverNow, deviceBehind), deviceBehind),
      10 * 60_000,
    );
  });

  it('never goes negative and has no countdown for untimed quizzes', () => {
    assert.equal(remainingMs(deadline, 0, Date.parse(deadline) + 5_000), 0);
    assert.equal(remainingMs(null, 0, Date.now()), null);
    assert.equal(clockSkewMs('not a date', 0), 0);
  });

  it('formats and colours the remaining time', () => {
    assert.equal(formatCountdown(0), '00:00');
    assert.equal(formatCountdown(59_001), '01:00');
    assert.equal(formatCountdown(3_725_000), '1:02:05');
    assert.equal(countdownTone(10 * 60_000), 'normal');
    assert.equal(countdownTone(4 * 60_000), 'warning');
    assert.equal(countdownTone(30_000), 'critical');
    assert.equal(countdownTone(null), 'normal');
  });
});

describe('answer selection', () => {
  it('uses radio semantics for single-answer types and toggles for multiple answers', () => {
    assert.deepEqual(toggleOption('SINGLE_CHOICE', [], 'a'), ['a']);
    assert.deepEqual(toggleOption('SINGLE_CHOICE', ['a'], 'b'), ['b']);
    assert.deepEqual(
      toggleOption('TRUE_FALSE', ['a'], 'a'),
      [],
      'clicking the chosen option clears it',
    );
    assert.deepEqual(toggleOption('MULTIPLE_CHOICE', ['a'], 'b'), ['a', 'b']);
    assert.deepEqual(toggleOption('MULTIPLE_CHOICE', ['a', 'b'], 'a'), ['b']);
  });

  it('knows when a question is answered', () => {
    assert.equal(
      isAnswered({ type: 'SINGLE_CHOICE', selectedOptionIds: [], textAnswer: null }),
      false,
    );
    assert.equal(
      isAnswered({ type: 'MULTIPLE_CHOICE', selectedOptionIds: ['x'], textAnswer: null }),
      true,
    );
    assert.equal(
      isAnswered({ type: 'SHORT_ANSWER', selectedOptionIds: [], textAnswer: '  ' }),
      false,
    );
    assert.equal(
      isAnswered({ type: 'SHORT_ANSWER', selectedOptionIds: [], textAnswer: 'x' }),
      true,
    );
  });
});

describe('shared request schemas', () => {
  const option = (text: string, isCorrect = false) => ({ text, isCorrect });

  it('validates question structure per type', () => {
    const ok = (body: object) => questionInputSchema.safeParse(body).success;
    assert.equal(
      ok({
        type: 'SINGLE_CHOICE',
        prompt: 'Q',
        marks: 1,
        options: [option('a', true), option('b')],
      }),
      true,
    );
    assert.equal(
      ok({
        type: 'SINGLE_CHOICE',
        prompt: 'Q',
        marks: 1,
        options: [option('a', true), option('b', true)],
      }),
      false,
    );
    assert.equal(
      ok({
        type: 'TRUE_FALSE',
        prompt: 'Q',
        marks: 1,
        options: [option('True', true), option('False'), option('Maybe')],
      }),
      false,
    );
    assert.equal(
      ok({
        type: 'MULTIPLE_CHOICE',
        prompt: 'Q',
        marks: 1,
        options: [option('a', true), option('b', true)],
      }),
      true,
    );
    assert.equal(
      ok({ type: 'MULTIPLE_CHOICE', prompt: 'Q', marks: 1, options: [option('a'), option('b')] }),
      false,
    );
    assert.equal(ok({ type: 'SHORT_ANSWER', prompt: 'Q', marks: 5 }), true);
    assert.equal(
      ok({ type: 'SHORT_ANSWER', prompt: 'Q', marks: 5, options: [option('a', true)] }),
      false,
    );
    assert.equal(
      ok({
        type: 'SINGLE_CHOICE',
        prompt: 'Q',
        marks: 1,
        negativeMarks: 2,
        options: [option('a', true), option('b')],
      }),
      false,
    );
    assert.equal(
      ok({
        type: 'SINGLE_CHOICE',
        prompt: 'Q',
        marks: 0.333,
        options: [option('a', true), option('b')],
      }),
      false,
    );
    assert.equal(
      ok({
        type: 'SINGLE_CHOICE',
        prompt: 'Q',
        marks: 1,
        options: [option('a', true), option('A')],
      }),
      false,
      'duplicate options',
    );
  });

  it('never lets a client send times, scores or correctness with answers or submissions', () => {
    assert.equal(answerSaveSchema.safeParse({ selectedOptionIds: [], sequence: 1 }).success, true);
    assert.equal(
      answerSaveSchema.safeParse({ selectedOptionIds: [], sequence: 1, deadlineAt: 'x' }).success,
      false,
    );
    assert.equal(
      answerSaveSchema.safeParse({ selectedOptionIds: [], sequence: 1, isCorrect: true }).success,
      false,
    );
    assert.equal(
      answerSaveSchema.safeParse({ selectedOptionIds: [] }).success,
      false,
      'sequence required',
    );
    assert.equal(
      answerSaveSchema.safeParse({ textAnswer: 'a', selectedOptionIds: [], sequence: 1 }).success,
      false,
    );
    assert.equal(attemptSubmitSchema.safeParse({}).success, true);
    assert.equal(attemptSubmitSchema.safeParse({ score: 10 }).success, false);
  });

  it('bounds quiz and exam configuration', () => {
    assert.equal(quizSettingsSchema.safeParse(QUIZ_DEFAULT_RULES).success, true);
    assert.equal(
      quizSettingsSchema.safeParse({ ...QUIZ_DEFAULT_RULES, timeLimitMinutes: 0 }).success,
      false,
    );
    assert.equal(
      quizSettingsSchema.safeParse({ ...QUIZ_DEFAULT_RULES, maxAttempts: 0 }).success,
      false,
    );
    assert.equal(
      quizSettingsSchema.safeParse({ ...QUIZ_DEFAULT_RULES, passPercent: 120 }).success,
      false,
    );
    const exam = {
      title: 'Mid-term',
      opensAt: '2026-11-02T10:00:00+05:30',
      closesAt: '2026-11-02T12:00:00+05:30',
      durationMinutes: 60,
      maxAttempts: 1,
      passPercent: 40,
      negativeMarking: false,
      shuffleQuestions: false,
      shuffleOptions: false,
      answerReveal: 'NEVER',
    };
    assert.equal(examCreateSchema.safeParse(exam).success, true);
    assert.equal(examCreateSchema.safeParse({ ...exam, closesAt: exam.opensAt }).success, false);
    assert.equal(examCreateSchema.safeParse({ ...exam, durationMinutes: 0 }).success, false);
    assert.equal(examCreateSchema.safeParse({ ...exam, status: 'PUBLISHED' }).success, false);
  });
});

describe('labels and transitions', () => {
  it('labels every attempt and result state', () => {
    for (const state of [
      'IN_PROGRESS',
      'PENDING_EVALUATION',
      'AWAITING_RELEASE',
      'RELEASED',
    ] as const) {
      assert.ok(RESULT_STATE_LABELS[state]);
      assert.ok(RESULT_STATE_BADGE[state]);
    }
    assert.match(ATTEMPT_STATUS_LABELS.EXPIRED, /auto-submitted/);
    assert.equal(formatScore(7.5, 10), '7.5 / 10');
    assert.equal(formatScore(6.25, 10), '6.25 / 10');
  });

  it('offers only the lifecycle actions the API accepts', () => {
    assert.deepEqual(availableTransitions('DRAFT', 0), ['publish']);
    assert.deepEqual(availableTransitions('PUBLISHED', 0), ['close', 'unpublish']);
    assert.deepEqual(availableTransitions('PUBLISHED', 3), ['close']);
    assert.deepEqual(availableTransitions('CLOSED', 3), ['reopen']);
    assert.match(html(<AssessmentStatusBadge status="CLOSED" />), /Closed/);
  });
});

function attempt(overrides: Partial<StudentAttemptDto>): StudentAttemptDto {
  return {
    id: 'a1',
    kind: 'EXAM',
    assessment: {
      id: 'e1',
      title: 'Mid-term',
      lessonId: null,
      course: { id: 'c1', title: 'Maths' },
    },
    attemptNumber: 1,
    status: 'SUBMITTED',
    startedAt: '2026-11-02T04:30:00.000Z',
    deadlineAt: '2026-11-02T05:30:00.000Z',
    submittedAt: '2026-11-02T05:00:00.000Z',
    serverNow: '2026-11-02T05:00:00.000Z',
    negativeMarking: false,
    maxScore: 10,
    questions: [
      {
        id: 'q1',
        position: 0,
        type: 'SINGLE_CHOICE',
        prompt: '<script>alert(1)</script> What is 2 + 3?',
        marks: 4,
        negativeMarks: 0,
        options: [
          { id: 'o1', text: '4', image: null },
          { id: 'o2', text: '5', image: null },
        ],
        images: [],
        selectedOptionIds: ['o2'],
        textAnswer: null,
        answerSequence: 1,
      },
    ],
    resultState: 'AWAITING_RELEASE',
    result: null,
    review: null,
    ...overrides,
  };
}

describe('attempt outcome', () => {
  it('shows no score and no answer key before release', () => {
    const out = html(<AttemptOutcome attempt={attempt({})} />);
    assert.match(out, /Result not published yet/);
    assert.doesNotMatch(out, /correct answer/);
    assert.doesNotMatch(out, /Percentage/);
    assert.doesNotMatch(out, /<script>/, 'question text is escaped');
  });

  it('says a result is awaiting evaluation instead of showing a misleading score', () => {
    const out = html(<AttemptOutcome attempt={attempt({ resultState: 'PENDING_EVALUATION' })} />);
    assert.match(out, /Awaiting evaluation/);
    assert.doesNotMatch(out, /Passed/);
  });

  it('shows the released score, auto-submission notice and the revealed key', () => {
    const out = html(
      <AttemptOutcome
        attempt={attempt({
          status: 'EXPIRED',
          resultState: 'RELEASED',
          result: { rawScore: 4, penalty: 0, score: 4, maxScore: 10, percent: 40, passed: true },
          review: [
            {
              id: 'q1',
              position: 0,
              type: 'SINGLE_CHOICE',
              prompt: 'What is 2 + 3?',
              explanation: 'Add them.',
              marks: 4,
              negativeMarks: 0,
              options: [
                { id: 'o1', text: '4', isCorrect: false, selected: false, image: null },
                { id: 'o2', text: '5', isCorrect: true, selected: true, image: null },
              ],
              images: [],
              textAnswer: null,
              answered: true,
              awardedMarks: 4,
              penalty: 0,
              isCorrect: true,
              feedback: null,
              gradedAt: null,
            },
          ],
        })}
      />,
    );
    assert.match(out, /Submitted automatically/);
    assert.match(out, /4 \/ 10/);
    assert.match(out, /40%/);
    assert.match(out, /Passed/);
    assert.match(out, /\(correct answer\)/);
    assert.match(out, /Add them\./);
  });
});
