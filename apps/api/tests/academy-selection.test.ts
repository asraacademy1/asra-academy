/** Pure academy-quiz selection, publication and phase rules (no database). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  phaseOf,
  planSelection,
  poolOf,
  publishProblems,
  type PoolQuestion,
} from '../src/modules/academy-quizzes/selection.js';

const q = (marksCents: number, difficulty: PoolQuestion['difficulty'] = null): PoolQuestion => ({
  marksCents,
  difficulty,
});
const rules = (overrides: Partial<Parameters<typeof planSelection>[0]> = {}) => ({
  selection: 'ALL' as const,
  questionsPerAttempt: null,
  easyCount: null,
  mediumCount: null,
  hardCount: null,
  ...overrides,
});

describe('academy question selection', () => {
  it('ALL: every question, any marks', () => {
    assert.deepEqual(planSelection(rules(), [q(100), q(250)]), {
      perAttempt: 2,
      totalMarksCents: 350,
      problems: [],
    });
  });

  it('RANDOM: needs enough questions and equal marks', () => {
    const random = rules({ selection: 'RANDOM', questionsPerAttempt: 2 });
    assert.deepEqual(planSelection(random, [q(200), q(200), q(200)]), {
      perAttempt: 2,
      totalMarksCents: 400,
      problems: [],
    });
    assert.equal(planSelection(random, [q(200)]).problems.length, 1);
    const unequal = planSelection(random, [q(200), q(300)]);
    assert.equal(unequal.totalMarksCents, null);
    assert.match(unequal.problems[0]!, /same marks/);
  });

  it('BY_DIFFICULTY: per-level counts and equal marks within each level drawn from', () => {
    const levels = rules({
      selection: 'BY_DIFFICULTY',
      easyCount: 2,
      mediumCount: 1,
      hardCount: 0,
    });
    const pool = [q(100, 'EASY'), q(100, 'EASY'), q(100, 'EASY'), q(300, 'MEDIUM'), q(999, 'HARD')];
    assert.deepEqual(planSelection(levels, pool), {
      perAttempt: 3,
      totalMarksCents: 500,
      problems: [],
    });
    // Hard questions are not drawn, so their marks do not matter; unrated ones are never drawn.
    assert.deepEqual(planSelection(levels, [...pool, q(1), q(777, 'HARD')]).problems, []);
    const short = planSelection(levels, [q(100, 'EASY'), q(300, 'MEDIUM')]);
    assert.match(short.problems[0]!, /2 easy questions, but only 1 is marked easy/);
    const mixed = planSelection(levels, [q(100, 'EASY'), q(200, 'EASY'), q(300, 'MEDIUM')]);
    assert.match(mixed.problems.join(' '), /easy questions must carry the same marks/);
    assert.deepEqual(poolOf([...pool, q(1)]), {
      total: 6,
      EASY: 3,
      MEDIUM: 1,
      HARD: 1,
      unrated: 1,
    });
  });

  it('publication needs questions, a satisfiable plan and a future end', () => {
    const now = new Date('2026-12-01T00:00:00Z');
    const future = new Date('2026-12-02T00:00:00Z');
    assert.deepEqual(publishProblems({ ...rules(), endsAt: future }, [], now), [
      'Add at least one question.',
    ]);
    assert.deepEqual(publishProblems({ ...rules(), endsAt: future }, [q(100)], now), []);
    assert.match(publishProblems({ ...rules(), endsAt: now }, [q(100)], now)[0]!, /already passed/);
  });

  it('phase follows status and server time', () => {
    const startsAt = new Date('2026-12-01T10:00:00Z');
    const endsAt = new Date('2026-12-01T12:00:00Z');
    const at = (iso: string) => new Date(iso);
    const quiz = { status: 'PUBLISHED' as const, startsAt, endsAt };
    assert.equal(phaseOf({ ...quiz, status: 'DRAFT' }, at('2026-12-01T11:00:00Z')), 'DRAFT');
    assert.equal(phaseOf(quiz, at('2026-12-01T09:59:59Z')), 'UPCOMING');
    assert.equal(phaseOf(quiz, startsAt), 'LIVE');
    assert.equal(phaseOf(quiz, endsAt), 'ENDED');
    assert.equal(phaseOf({ ...quiz, status: 'CLOSED' }, at('2026-12-01T11:00:00Z')), 'CLOSED');
  });
});
