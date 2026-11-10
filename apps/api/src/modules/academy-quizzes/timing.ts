import type { AnswerReveal, AttemptResultState } from '@asra/types';

/**
 * Pure timing and release rules of academy-quiz attempts (no database access, so they are
 * unit-tested directly). The SERVER clock is the only clock: every value here is computed from
 * `now` on the server and persisted; nothing the browser sends is used.
 *
 *   OVERALL       deadline = min(start + duration, endsAt)
 *   PER_QUESTION  each question gets T seconds; the attempt deadline is
 *                 min(endsAt, currentQuestionDeadline + T × questionsAfterTheCurrentOne)
 *
 * A late starter therefore never gets time beyond the quiz end. No job moves anything forward:
 * an expired question/attempt is caught up the next time the attempt is touched.
 */

/** A new attempt may not start with less than this left before the quiz ends. */
export const ACADEMY_MIN_START_REMAINING_MS = 60_000;

export interface TimingRules {
  timerMode: 'OVERALL' | 'PER_QUESTION';
  durationMinutes: number | null;
  questionTimeSeconds: number | null;
  endsAt: Date;
}

const earliest = (...dates: Date[]) => new Date(Math.min(...dates.map((date) => date.getTime())));

/** Deadline and (PER_QUESTION) first-question deadline of an attempt started at `now`. */
export function startTiming(
  now: Date,
  rules: TimingRules,
  questionCount: number,
): { deadlineAt: Date; currentQuestionDeadlineAt: Date | null } {
  if (rules.timerMode === 'PER_QUESTION') {
    const perQuestion = rules.questionTimeSeconds! * 1000;
    const deadlineAt = earliest(
      new Date(now.getTime() + perQuestion * questionCount),
      rules.endsAt,
    );
    return {
      deadlineAt,
      currentQuestionDeadlineAt: earliest(new Date(now.getTime() + perQuestion), deadlineAt),
    };
  }
  return {
    deadlineAt: earliest(new Date(now.getTime() + rules.durationMinutes! * 60_000), rules.endsAt),
    currentQuestionDeadlineAt: null,
  };
}

/** Whole minutes an attempt started now would get (late starters get what is left). */
export function availableMinutes(now: Date, rules: TimingRules, questionCount: number): number {
  const { deadlineAt } = startTiming(now, rules, questionCount);
  return Math.max(0, Math.floor((deadlineAt.getTime() - now.getTime()) / 60_000));
}

export interface LinearState {
  position: number;
  questionDeadlineAt: Date | null;
  deadlineAt: Date;
}

/**
 * PER_QUESTION catch-up: questions whose time ran out are passed (unanswered ones stay blank) and
 * the next question's clock starts where the previous one stopped. The last question is never
 * passed; its time ending is the attempt deadline.
 */
export function catchUp(
  state: LinearState,
  questionCount: number,
  questionTimeSeconds: number | null,
  now: Date,
): LinearState {
  if (state.questionDeadlineAt === null || questionTimeSeconds === null) return state;
  let { position, questionDeadlineAt } = state;
  while (position < questionCount - 1 && now >= questionDeadlineAt) {
    position += 1;
    questionDeadlineAt = earliest(
      new Date(questionDeadlineAt.getTime() + questionTimeSeconds * 1000),
      state.deadlineAt,
    );
  }
  return { position, questionDeadlineAt, deadlineAt: state.deadlineAt };
}

/**
 * Moving on from the current question before its time is up. PER_QUESTION: the next question
 * gets a full T from now, and the attempt deadline shrinks to match (it never grows, and never
 * passes `endsAt`).
 */
export function advance(
  state: LinearState,
  questionCount: number,
  rules: TimingRules,
  now: Date,
): LinearState {
  const position = state.position + 1;
  if (rules.timerMode !== 'PER_QUESTION' || rules.questionTimeSeconds === null) {
    return { position, questionDeadlineAt: null, deadlineAt: state.deadlineAt };
  }
  const perQuestion = rules.questionTimeSeconds * 1000;
  const deadlineAt = earliest(
    new Date(now.getTime() + perQuestion * (questionCount - position)),
    rules.endsAt,
    state.deadlineAt,
  );
  return {
    position,
    questionDeadlineAt: earliest(new Date(now.getTime() + perQuestion), deadlineAt),
    deadlineAt,
  };
}

export interface ReleaseRules {
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
  endsAt: Date;
  resultRelease: 'IMMEDIATE' | 'SCHEDULED' | 'MANUAL';
  resultsAt: Date | null;
  resultsPublishedAt: Date | null;
  answerReveal: AnswerReveal;
}

/** Whether scores are visible to students now (scheduled release is checked on read; no job). */
export function resultsReleased(quiz: ReleaseRules, now: Date): boolean {
  if (quiz.resultRelease === 'IMMEDIATE') return true;
  if (quiz.resultRelease === 'SCHEDULED') return quiz.resultsAt !== null && now >= quiz.resultsAt;
  return quiz.resultsPublishedAt !== null;
}

export function academyResultState(
  attempt: { status: string; evaluationStatus: string | null },
  quiz: ReleaseRules,
  now: Date,
): AttemptResultState {
  if (attempt.status === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (attempt.evaluationStatus !== 'EVALUATED') return 'PENDING_EVALUATION';
  return resultsReleased(quiz, now) ? 'RELEASED' : 'AWAITING_RELEASE';
}

/** Correct answers and explanations: only once the score itself is visible, per `answerReveal`. */
export function academyAnswersRevealed(state: AttemptResultState, quiz: ReleaseRules, now: Date) {
  if (state !== 'RELEASED') return false;
  if (quiz.answerReveal === 'AFTER_SUBMISSION') return true;
  if (quiz.answerReveal === 'AFTER_CLOSE') return quiz.status === 'CLOSED' || now >= quiz.endsAt;
  return false;
}
