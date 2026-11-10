/**
 * PHASE 09 — pure scoring and timing rules (docs/ASSESSMENTS.md §6–§7). No database: these are
 * the functions every persisted score and deadline comes from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasPassed,
  percentOfMax,
  scoreAttempt,
  scoreQuestion,
  toCents,
  type ScoringQuestion,
} from '../src/modules/assessments/scoring.js';
import { examAttemptDeadline, examAvailability } from '../src/modules/assessments/exams.service.js';
import { selectQuestions, shuffled } from '../src/modules/assessments/attempts.core.js';
import { submissionPolicy } from '../src/modules/assignments/assignments.service.js';

const q = (overrides: Partial<ScoringQuestion>): ScoringQuestion => ({
  type: 'SINGLE_CHOICE',
  marks: 200,
  negativeMarks: 50,
  correctOptionIds: ['b'],
  selectedOptionIds: [],
  textAnswer: null,
  manualMarks: null,
  ...overrides,
});

describe('question scoring', () => {
  it('MCQ: correct earns the marks; wrong earns 0 and the penalty only with negative marking', () => {
    assert.deepEqual(scoreQuestion(q({ selectedOptionIds: ['b'] }), true), {
      answered: true,
      isCorrect: true,
      awarded: 200,
      penalty: 0,
      pendingManual: false,
    });
    assert.equal(scoreQuestion(q({ selectedOptionIds: ['a'] }), true).penalty, 50);
    assert.equal(scoreQuestion(q({ selectedOptionIds: ['a'] }), false).penalty, 0);
    assert.equal(scoreQuestion(q({ selectedOptionIds: ['a'] }), true).awarded, 0);
  });

  it('MCQ/True-False: selecting two options is never correct', () => {
    const outcome = scoreQuestion(q({ selectedOptionIds: ['a', 'b'] }), true);
    assert.equal(outcome.isCorrect, false);
    assert.equal(outcome.penalty, 50);
    const tf = q({ type: 'TRUE_FALSE', correctOptionIds: ['t'], selectedOptionIds: ['t'] });
    assert.equal(scoreQuestion(tf, false).awarded, 200);
  });

  it('unanswered questions score 0 with no penalty', () => {
    const outcome = scoreQuestion(q({ selectedOptionIds: [] }), true);
    assert.deepEqual([outcome.answered, outcome.awarded, outcome.penalty], [false, 0, 0]);
  });

  it('multiple answers are all-or-nothing and never exceed the question maximum', () => {
    const base = { type: 'MULTIPLE_CHOICE' as const, marks: 300, correctOptionIds: ['a', 'b'] };
    assert.equal(scoreQuestion(q({ ...base, selectedOptionIds: ['b', 'a'] }), true).awarded, 300);
    // a subset, a superset and a different set are all wrong
    for (const selection of [['a'], ['a', 'b', 'c'], ['c', 'd']]) {
      const outcome = scoreQuestion(q({ ...base, selectedOptionIds: selection }), true);
      assert.equal(outcome.isCorrect, false, selection.join());
      assert.equal(outcome.awarded, 0);
      assert.equal(outcome.penalty, 50);
    }
  });

  it('written answers: blank = 0, answered = pending until graded, marks clamped to the maximum', () => {
    const written = { type: 'SHORT_ANSWER' as const, marks: 500, negativeMarks: 0 };
    assert.equal(scoreQuestion(q({ ...written, textAnswer: '   ' }), true).awarded, 0);
    assert.equal(scoreQuestion(q({ ...written, textAnswer: 'x' }), true).pendingManual, true);
    assert.equal(
      scoreQuestion(q({ ...written, textAnswer: 'x', manualMarks: 350 }), true).awarded,
      350,
    );
    assert.equal(
      scoreQuestion(q({ ...written, textAnswer: 'x', manualMarks: 999 }), true).awarded,
      500,
    );
  });

  it('a penalty can never exceed the question marks', () => {
    assert.equal(
      scoreQuestion(q({ negativeMarks: 900, selectedOptionIds: ['a'] }), true).penalty,
      200,
    );
  });
});

describe('attempt scoring', () => {
  it('keeps raw, penalty, final, max and percent consistent and the total non-negative', () => {
    const result = scoreAttempt(
      [
        q({ selectedOptionIds: ['b'] }), // +2
        q({ selectedOptionIds: ['a'] }), // −0.5
        q({ selectedOptionIds: [] }), // 0
      ],
      { negativeMarking: true, passPercent: 30 },
    );
    assert.deepEqual(result.score, {
      rawScore: 200,
      penalty: 50,
      score: 150,
      maxScore: 600,
      percent: 2500,
      passed: false,
    });

    const allWrong = scoreAttempt(
      [q({ selectedOptionIds: ['a'] }), q({ selectedOptionIds: ['c'] })],
      {
        negativeMarking: true,
        passPercent: 0,
      },
    );
    assert.equal(allWrong.score!.penalty, 100);
    assert.equal(allWrong.score!.score, 0, 'clamped at zero');
  });

  it('withholds the score while a written answer awaits grading', () => {
    const result = scoreAttempt(
      [
        q({ selectedOptionIds: ['b'] }),
        q({ type: 'SHORT_ANSWER', negativeMarks: 0, textAnswer: 'essay' }),
      ],
      { negativeMarking: false, passPercent: 40 },
    );
    assert.equal(result.pendingManual, true);
    assert.equal(result.score, null);
  });

  it('rounds the percentage half-up to two decimals and passes inclusively at the threshold', () => {
    assert.equal(percentOfMax(200, 300), 6667); // 66.666… → 66.67
    assert.equal(percentOfMax(100, 300), 3333); // 33.333… → 33.33
    assert.equal(percentOfMax(1, 8), 1250);
    assert.equal(percentOfMax(0, 0), 0);
    assert.equal(hasPassed(400, 1000, 40), true, 'exactly the threshold passes');
    assert.equal(hasPassed(399, 1000, 40), false);
    assert.equal(hasPassed(0, 1000, 0), true);
  });

  it('converts marks to integer hundredths without floating-point drift', () => {
    assert.equal(toCents(0.25), 25);
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.equal(toCents({ toString: () => '12.75' }), 1275);
  });
});

describe('examination timing rules', () => {
  const closesAt = new Date('2026-11-02T06:00:00.000Z');

  it('deadline = start + duration when the window allows it', () => {
    const start = new Date('2026-11-02T04:00:00.000Z');
    assert.equal(
      examAttemptDeadline(start, { durationMinutes: 60, closesAt }).toISOString(),
      '2026-11-02T05:00:00.000Z',
    );
  });

  it('deadline is capped at the exam closing time', () => {
    const late = new Date('2026-11-02T05:40:00.000Z');
    assert.equal(
      examAttemptDeadline(late, { durationMinutes: 60, closesAt }).toISOString(),
      closesAt.toISOString(),
    );
  });

  it('availability: upcoming before opensAt, open in [opensAt, closesAt), closed at closesAt or when closed', () => {
    const exam = { status: 'PUBLISHED', opensAt: new Date('2026-11-02T04:00:00Z'), closesAt };
    assert.equal(examAvailability(exam, new Date('2026-11-02T03:59:59.999Z')), 'UPCOMING');
    assert.equal(examAvailability(exam, new Date('2026-11-02T04:00:00Z')), 'OPEN');
    assert.equal(examAvailability(exam, closesAt), 'CLOSED');
    assert.equal(
      examAvailability({ ...exam, status: 'CLOSED' }, new Date('2026-11-02T04:30:00Z')),
      'CLOSED',
    );
  });
});

describe('question selection', () => {
  const source = Array.from({ length: 10 }, (_, i) => ({
    id: `q${i}`,
    type: i === 0 ? ('TRUE_FALSE' as const) : ('SINGLE_CHOICE' as const),
    prompt: `Q${i}`,
    explanation: null,
    marks: { toString: () => '1' },
    negativeMarks: { toString: () => '0' },
    position: i,
    imageIds: [] as string[],
    options: [
      { id: `q${i}a`, text: 'a', isCorrect: true, position: 0, image: null },
      { id: `q${i}b`, text: 'b', isCorrect: false, position: 1, image: null },
      { id: `q${i}c`, text: 'c', isCorrect: false, position: 2, image: null },
    ],
  }));

  it('draws a random subset of the requested size, each question at most once', () => {
    const chosen = selectQuestions(source as never, {
      shuffleQuestions: true,
      shuffleOptions: true,
      take: 4,
    });
    assert.equal(chosen.length, 4);
    assert.equal(new Set(chosen.map((c) => c.questionId)).size, 4);
    assert.deepEqual(
      chosen.map((c) => c.position),
      [0, 1, 2, 3],
    );
  });

  it('keeps authoring order without shuffling, and never shuffles True/False options', () => {
    const chosen = selectQuestions(source as never, {
      shuffleQuestions: false,
      shuffleOptions: true,
      take: null,
    });
    assert.deepEqual(
      chosen.map((c) => c.questionId),
      source.map((s) => s.id),
    );
    const tf = chosen[0]!.snapshot as { options: { id: string }[] };
    assert.deepEqual(
      tf.options.map((o) => o.id),
      ['q0a', 'q0b', 'q0c'],
    );
  });

  it('shuffles with every permutation reachable (sanity)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(shuffled([1, 2, 3]).join());
    assert.equal(seen.size, 6);
  });
});

describe('assignment submission policy (server time)', () => {
  const dueAt = new Date('2026-11-10T12:00:00Z');
  const before = new Date('2026-11-10T11:59:59Z');
  const after = new Date('2026-11-10T12:00:01Z');
  const settings = (
    o: Partial<{ allowLateSubmissions: boolean; allowResubmission: boolean }> = {},
  ) => ({
    id: 'a',
    maxMarks: 10,
    dueAt,
    allowLateSubmissions: true,
    allowResubmission: false,
    ...o,
  });

  it('accepts on time, flags late work, or refuses it when late work is not allowed', () => {
    assert.deepEqual(submissionPolicy(settings(), null, before), {
      allowed: true,
      reason: null,
      late: false,
    });
    assert.deepEqual(submissionPolicy(settings(), null, after), {
      allowed: true,
      reason: null,
      late: true,
    });
    assert.equal(
      submissionPolicy(settings({ allowLateSubmissions: false }), null, after).allowed,
      false,
    );
  });

  it('allows resubmission only when enabled and only before grading', () => {
    assert.equal(submissionPolicy(settings(), { status: 'SUBMITTED' }, before).allowed, false);
    assert.equal(
      submissionPolicy(settings({ allowResubmission: true }), { status: 'SUBMITTED' }, before)
        .allowed,
      true,
    );
    assert.equal(
      submissionPolicy(settings({ allowResubmission: true }), { status: 'GRADED' }, before).allowed,
      false,
    );
    assert.equal(
      submissionPolicy(
        settings({ allowResubmission: true, allowLateSubmissions: false }),
        { status: 'SUBMITTED' },
        after,
      ).allowed,
      false,
    );
  });

  it('is closed when online submission was never set up', () => {
    assert.equal(submissionPolicy(null, null, before).allowed, false);
  });
});
