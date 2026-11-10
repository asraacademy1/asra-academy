/** Pure academy-quiz timing and release rules (no database). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  academyAnswersRevealed,
  academyResultState,
  advance,
  availableMinutes,
  catchUp,
  resultsReleased,
  startTiming,
  type ReleaseRules,
} from '../src/modules/academy-quizzes/timing.js';

const t = (minutes: number) => new Date(Date.UTC(2026, 11, 1, 10, 0) + minutes * 60_000);
const overall = (endsAt: Date, durationMinutes = 30) => ({
  timerMode: 'OVERALL' as const,
  durationMinutes,
  questionTimeSeconds: null,
  endsAt,
});
const perQuestion = (endsAt: Date, seconds = 60) => ({
  timerMode: 'PER_QUESTION' as const,
  durationMinutes: null,
  questionTimeSeconds: seconds,
  endsAt,
});

describe('academy timing', () => {
  it('overall deadline is start + duration, capped at the end', () => {
    assert.deepEqual(startTiming(t(0), overall(t(120)), 5).deadlineAt, t(30));
    assert.deepEqual(startTiming(t(100), overall(t(120)), 5).deadlineAt, t(120));
    assert.equal(availableMinutes(t(100), overall(t(120)), 5), 20);
    assert.equal(startTiming(t(0), overall(t(120)), 5).currentQuestionDeadlineAt, null);
  });

  it('per-question deadline is n × T, capped at the end', () => {
    const timing = startTiming(t(0), perQuestion(t(120)), 3);
    assert.deepEqual(timing.deadlineAt, t(3));
    assert.deepEqual(timing.currentQuestionDeadlineAt, t(1));
    const late = startTiming(t(119.5), perQuestion(t(120)), 3);
    assert.deepEqual(late.deadlineAt, t(120));
    assert.deepEqual(late.currentQuestionDeadlineAt, t(120));
  });

  it('catch-up passes timed-out questions but never the last one', () => {
    const state = { position: 0, questionDeadlineAt: t(1), deadlineAt: t(3) };
    assert.deepEqual(catchUp(state, 3, 60, t(0.5)), state);
    assert.deepEqual(catchUp(state, 3, 60, t(1)), {
      position: 1,
      questionDeadlineAt: t(2),
      deadlineAt: t(3),
    });
    assert.equal(catchUp(state, 3, 60, t(10)).position, 2);
    // Without a per-question clock nothing moves.
    const free = { position: 0, questionDeadlineAt: null, deadlineAt: t(30) };
    assert.deepEqual(catchUp(free, 3, null, t(29)), free);
  });

  it('advancing early gives the next question a full T and never extends the deadline', () => {
    const state = { position: 0, questionDeadlineAt: t(1), deadlineAt: t(3) };
    const next = advance(state, 3, perQuestion(t(120)), t(0.25));
    assert.equal(next.position, 1);
    assert.deepEqual(next.questionDeadlineAt, t(1.25));
    assert.deepEqual(next.deadlineAt, t(2.25));
    const capped = advance(state, 3, perQuestion(t(1.5)), t(0.25));
    assert.deepEqual(capped.deadlineAt, t(1.5));
    assert.deepEqual(capped.questionDeadlineAt, t(1.25));
    // OVERALL + LINEAR: position only.
    const linear = advance(
      { position: 1, questionDeadlineAt: null, deadlineAt: t(30) },
      3,
      overall(t(120)),
      t(5),
    );
    assert.deepEqual(linear, { position: 2, questionDeadlineAt: null, deadlineAt: t(30) });
  });
});

describe('academy result release', () => {
  const rules = (over: Partial<ReleaseRules>): ReleaseRules => ({
    status: 'PUBLISHED',
    endsAt: t(120),
    resultRelease: 'IMMEDIATE',
    resultsAt: null,
    resultsPublishedAt: null,
    answerReveal: 'AFTER_CLOSE',
    ...over,
  });
  const evaluated = { status: 'SUBMITTED', evaluationStatus: 'EVALUATED' };

  it('applies immediate, scheduled and manual release', () => {
    assert.equal(resultsReleased(rules({}), t(0)), true);
    const scheduled = rules({ resultRelease: 'SCHEDULED', resultsAt: t(150) });
    assert.equal(resultsReleased(scheduled, t(149)), false);
    assert.equal(resultsReleased(scheduled, t(150)), true);
    const manual = rules({ resultRelease: 'MANUAL' });
    assert.equal(resultsReleased(manual, t(999)), false);
    assert.equal(resultsReleased({ ...manual, resultsPublishedAt: t(130) }, t(131)), true);
  });

  it('derives the result state and answer reveal', () => {
    const now = t(10);
    assert.equal(
      academyResultState({ status: 'IN_PROGRESS', evaluationStatus: null }, rules({}), now),
      'IN_PROGRESS',
    );
    assert.equal(academyResultState(evaluated, rules({}), now), 'RELEASED');
    assert.equal(
      academyResultState(evaluated, rules({ resultRelease: 'MANUAL' }), now),
      'AWAITING_RELEASE',
    );
    assert.equal(academyAnswersRevealed('RELEASED', rules({}), now), false);
    assert.equal(academyAnswersRevealed('RELEASED', rules({}), t(120)), true);
    assert.equal(academyAnswersRevealed('RELEASED', rules({ status: 'CLOSED' }), now), true);
    assert.equal(
      academyAnswersRevealed('RELEASED', rules({ answerReveal: 'AFTER_SUBMISSION' }), now),
      true,
    );
    assert.equal(
      academyAnswersRevealed('AWAITING_RELEASE', rules({ answerReveal: 'AFTER_SUBMISSION' }), now),
      false,
    );
    assert.equal(
      academyAnswersRevealed('RELEASED', rules({ answerReveal: 'NEVER' }), t(999)),
      false,
    );
  });
});
