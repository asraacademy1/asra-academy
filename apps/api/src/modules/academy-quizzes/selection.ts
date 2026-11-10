import type { AcademyQuizPhase, QuestionPoolDto } from '@asra/types';
import type { AcademyQuizSettingsInput } from '@asra/validation';

/**
 * Pure rules of academy-quiz question selection and publication (no database access, so they are
 * unit-tested exhaustively). Fairness rule: every attempt must be out of the SAME total marks, so
 * random selection needs equal marks across the pool, and selection by difficulty needs equal
 * marks within each difficulty that is drawn from.
 */

export interface PoolQuestion {
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null;
  /** Marks in integer hundredths. */
  marksCents: number;
}

type SelectionRules = Pick<
  AcademyQuizSettingsInput,
  'selection' | 'questionsPerAttempt' | 'easyCount' | 'mediumCount' | 'hardCount'
>;

const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
const LABEL = { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard' } as const;

export function poolOf(questions: readonly PoolQuestion[]): QuestionPoolDto {
  const pool: QuestionPoolDto = {
    total: questions.length,
    EASY: 0,
    MEDIUM: 0,
    HARD: 0,
    unrated: 0,
  };
  for (const question of questions) {
    if (question.difficulty) pool[question.difficulty] += 1;
    else pool.unrated += 1;
  }
  return pool;
}

const allEqual = (values: number[]) => values.every((value) => value === values[0]);

export interface SelectionPlan {
  /** Questions each attempt gets (null when the strategy cannot be satisfied). */
  perAttempt: number | null;
  /** Total marks of every attempt in hundredths (null when it would differ between attempts). */
  totalMarksCents: number | null;
  problems: string[];
}

export function planSelection(
  rules: SelectionRules,
  questions: readonly PoolQuestion[],
): SelectionPlan {
  const problems: string[] = [];
  const marks = questions.map((question) => question.marksCents);
  if (rules.selection === 'ALL') {
    return {
      perAttempt: questions.length || null,
      totalMarksCents: questions.length ? marks.reduce((sum, value) => sum + value, 0) : null,
      problems,
    };
  }
  if (rules.selection === 'RANDOM') {
    const take = rules.questionsPerAttempt ?? 0;
    if (take > questions.length) {
      problems.push(
        `Random selection gives each student ${take} questions, but the quiz has only ${questions.length}.`,
      );
    }
    const equal = questions.length > 0 && allEqual(marks);
    if (questions.length > 0 && !equal) {
      problems.push(
        'With random selection every question must carry the same marks, so all students are marked out of the same total.',
      );
    }
    return {
      perAttempt: problems.length === 0 && take > 0 ? take : null,
      totalMarksCents: equal && take <= questions.length ? take * marks[0]! : null,
      problems,
    };
  }
  // BY_DIFFICULTY
  let perAttempt = 0;
  let total = 0;
  let totalKnown = true;
  for (const difficulty of DIFFICULTIES) {
    const wanted =
      difficulty === 'EASY'
        ? (rules.easyCount ?? 0)
        : difficulty === 'MEDIUM'
          ? (rules.mediumCount ?? 0)
          : (rules.hardCount ?? 0);
    if (wanted === 0) continue;
    const ofLevel = questions.filter((question) => question.difficulty === difficulty);
    if (wanted > ofLevel.length) {
      problems.push(
        `Each student gets ${wanted} ${LABEL[difficulty]} question${wanted === 1 ? '' : 's'}, but only ${ofLevel.length} ${ofLevel.length === 1 ? 'is' : 'are'} marked ${LABEL[difficulty]}.`,
      );
      totalKnown = false;
    }
    const levelMarks = ofLevel.map((question) => question.marksCents);
    if (ofLevel.length > 0 && !allEqual(levelMarks)) {
      problems.push(
        `All ${LABEL[difficulty]} questions must carry the same marks, so all students are marked out of the same total.`,
      );
      totalKnown = false;
    } else if (ofLevel.length > 0) {
      total += wanted * levelMarks[0]!;
    }
    perAttempt += wanted;
  }
  return {
    perAttempt: problems.length === 0 && perAttempt > 0 ? perAttempt : null,
    totalMarksCents: totalKnown && perAttempt > 0 ? total : null,
    problems,
  };
}

/** Everything that blocks publication (empty = may publish). */
export function publishProblems(
  quiz: SelectionRules & { endsAt: Date },
  questions: readonly PoolQuestion[],
  now: Date,
): string[] {
  const problems: string[] = [];
  if (questions.length === 0) problems.push('Add at least one question.');
  else problems.push(...planSelection(quiz, questions).problems);
  if (quiz.endsAt <= now) problems.push('The end time has already passed. Choose a later end.');
  return problems;
}

/** DRAFT → UPCOMING → LIVE → ENDED (server time), or CLOSED. */
export function phaseOf(
  quiz: { status: 'DRAFT' | 'PUBLISHED' | 'CLOSED'; startsAt: Date; endsAt: Date },
  now: Date,
): AcademyQuizPhase {
  if (quiz.status === 'DRAFT') return 'DRAFT';
  if (quiz.status === 'CLOSED') return 'CLOSED';
  if (now < quiz.startsAt) return 'UPCOMING';
  if (now < quiz.endsAt) return 'LIVE';
  return 'ENDED';
}
