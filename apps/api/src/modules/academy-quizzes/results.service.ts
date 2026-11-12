import type {
  AdminAcademyAttemptDetail,
  AdminAcademyAttemptItem,
  AdminAcademyAttemptPage,
  AdminAcademyLeaderboardDto,
  Paginated,
  StudentAcademyLeaderboardDto,
  StudentAcademyResultItem,
} from '@asra/types';
import type {
  AdminAcademyAttemptListQuery,
  LeaderboardQuery,
  PaginationQuery,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import {
  finalizeExpiredBounded,
  loadWithExpiry,
  num,
  scoreOf,
  toReviewQuestions,
} from '../assessments/attempts.core.js';
import { toCents } from '../assessments/scoring.js';
import { maskName, pickPerStudent, rankEntries, type RankCandidate } from './leaderboard.js';
import { academyResultState, resultsReleased } from './timing.js';

/**
 * Academy Quiz results: the leaderboard (students and managers), attempt management (managers)
 * and the student's own results list. Expired attempts are finalized before anything is read
 * (finalize-on-access; no scheduler). Release rules come from `timing.ts`, the same rules the
 * attempt pages use, so a score is never visible in one place and hidden in another.
 */

const quizNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Academy quiz not found');
};
const attemptNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Attempt not found');
};

/**
 * Bounded finalize-on-access for one quiz (no scheduler; see ACADEMY_FINALIZE_LIMITS). Returns how
 * many expired attempts are still unfinalized: while any are, no ranking is shown.
 */
export const finalizeQuizBacklog = async (quizId: string): Promise<number> =>
  (await finalizeExpiredBounded({ where: Prisma.sql`AND "academy_quiz_id" = ${quizId}::uuid` }))
    .remaining;

/** Shown while a backlog of expired attempts is being finalized (safe to retry). */
export const FINALIZING_MESSAGE = 'Results are being finalized. Please try again in a moment.';

const rulesSelect = {
  id: true,
  slug: true,
  title: true,
  status: true,
  endsAt: true,
  resultRelease: true,
  resultsAt: true,
  resultsPublishedAt: true,
  answerReveal: true,
  leaderboardVisibility: true,
  maskNames: true,
  attemptCounting: true,
  tieBreak: true,
} satisfies Prisma.AcademyQuizSelect;
type QuizRules = Prisma.AcademyQuizGetPayload<{ select: typeof rulesSelect }>;

// --- Leaderboard ----------------------------------------------------------------------------

async function rankedAttempts(quiz: QuizRules) {
  const rows = await prisma.assessmentAttempt.findMany({
    where: {
      academyQuizId: quiz.id,
      status: { in: ['SUBMITTED', 'EXPIRED'] },
      evaluationStatus: 'EVALUATED',
      submittedAt: { not: null },
      score: { not: null },
    },
    select: {
      id: true,
      userId: true,
      attemptNumber: true,
      score: true,
      maxScore: true,
      percent: true,
      startedAt: true,
      submittedAt: true,
      student: { select: { fullName: true } },
    },
  });
  const candidates: RankCandidate[] = rows.map((row) => ({
    attemptId: row.id,
    userId: row.userId,
    fullName: row.student.fullName,
    attemptNumber: row.attemptNumber,
    scoreCents: toCents(row.score!),
    maxScoreCents: toCents(row.maxScore),
    percent: num(row.percent) ?? 0,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt!,
  }));
  return rankEntries(
    pickPerStudent(candidates, quiz.attemptCounting, quiz.tieBreak),
    quiz.tieBreak,
  );
}

/**
 * Shared finalized leaderboard ranking for one Academy Quiz (reuses the canonical best-attempt
 * selection and competition tie-breaking logic).
 */
export async function rankedAttemptsForQuiz(quiz: {
  id: string;
  attemptCounting: 'BEST' | 'FIRST';
  tieBreak: 'TIME_TAKEN' | 'SUBMITTED_AT';
}) {
  return rankedAttempts(quiz as QuizRules);
}

/** Why students cannot see the leaderboard now (null = they can). */
function leaderboardBlocker(quiz: QuizRules, now: Date): string | null {
  if (quiz.leaderboardVisibility === 'HIDDEN') return 'This quiz does not show a leaderboard.';
  if (quiz.status !== 'CLOSED' && now < quiz.endsAt) {
    return 'The leaderboard appears after the quiz ends.';
  }
  if (!resultsReleased(quiz, now)) {
    return quiz.resultRelease === 'SCHEDULED' && quiz.resultsAt
      ? 'The leaderboard appears when results are published.'
      : 'The leaderboard appears when the academy publishes the results.';
  }
  return null;
}

const entryOf = (
  row: Awaited<ReturnType<typeof rankedAttempts>>[number],
  mask: boolean,
  userId: string,
) => ({
  rank: row.rank,
  displayName: mask ? maskName(row.fullName) : row.fullName,
  score: row.scoreCents / 100,
  maxScore: row.maxScoreCents / 100,
  percent: row.percent,
  timeTakenSeconds: row.timeTakenSeconds,
  submittedAt: row.submittedAt.toISOString(),
  isMe: row.userId === userId,
});

export const academyResultsService = {
  /**
   * Student leaderboard: only for published quizzes whose visibility is not HIDDEN, after the
   * quiz has ended (or was closed) AND results are released. Entries carry no ids or emails.
   * PUBLIC currently behaves like SIGNED_IN (no anonymous page exists).
   */
  async studentLeaderboard(
    auth: AuthContext,
    slug: string,
    query: LeaderboardQuery,
  ): Promise<StudentAcademyLeaderboardDto> {
    const quiz =
      (await prisma.academyQuiz.findFirst({
        where: { slug, status: { in: ['PUBLISHED', 'CLOSED'] } },
        select: rulesSelect,
      })) ?? quizNotFound();
    const now = clock.now();
    const blocker = leaderboardBlocker(quiz, now);
    const base = {
      quiz: { id: quiz.id, slug: quiz.slug, title: quiz.title },
      attemptCounting: quiz.attemptCounting,
      tieBreak: quiz.tieBreak,
      maskNames: quiz.maskNames,
    };
    const unavailable = (reason: string, finalizing: boolean) => ({
      ...base,
      available: false,
      finalizing,
      unavailableReason: reason,
      totalRanked: 0,
      entries: [],
      me: null,
    });
    if (blocker) return unavailable(blocker, false);
    // Never a partial ranking: attempts that expired unattended must be finalized first.
    if ((await finalizeQuizBacklog(quiz.id)) > 0) return unavailable(FINALIZING_MESSAGE, true);
    const ranked = await rankedAttempts(quiz);
    const entries = ranked.map((row) => entryOf(row, quiz.maskNames, auth.userId));
    return {
      ...base,
      available: true,
      finalizing: false,
      unavailableReason: null,
      totalRanked: entries.length,
      entries: entries.slice(0, query.limit),
      me: entries.find((entry) => entry.isMe) ?? null,
    };
  },

  /** Managers: the same ranking at any time, unmasked, with whether students can see it yet. */
  async adminLeaderboard(quizId: string): Promise<AdminAcademyLeaderboardDto> {
    const quiz =
      (await prisma.academyQuiz.findUnique({ where: { id: quizId }, select: rulesSelect })) ??
      quizNotFound();
    const pendingFinalization = await finalizeQuizBacklog(quiz.id);
    const base = {
      releasedToStudents: leaderboardBlocker(quiz, clock.now()) === null,
      visibility: quiz.leaderboardVisibility,
      pendingFinalization,
    };
    if (pendingFinalization > 0) return { ...base, totalRanked: 0, entries: [] };
    const ranked = await rankedAttempts(quiz);
    return {
      ...base,
      totalRanked: ranked.length,
      entries: ranked.map((row) => {
        const { isMe: _isMe, ...entry } = entryOf(row, false, '');
        return { ...entry, userId: row.userId, fullName: row.fullName, attemptId: row.attemptId };
      }),
    };
  },

  // --- Attempt management (managers) -------------------------------------------------------

  async adminAttempts(
    quizId: string,
    query: AdminAcademyAttemptListQuery,
  ): Promise<AdminAcademyAttemptPage> {
    const quiz =
      (await prisma.academyQuiz.findUnique({ where: { id: quizId }, select: { id: true } })) ??
      quizNotFound();
    const pendingFinalization = await finalizeQuizBacklog(quiz.id);
    const where: Prisma.AssessmentAttemptWhereInput = {
      academyQuizId: quiz.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            student: {
              OR: [
                { fullName: { contains: query.q, mode: 'insensitive' } },
                { email: { contains: query.q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.assessmentAttempt.findMany({
        where,
        select: adminAttemptSelect,
        orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      prisma.assessmentAttempt.count({ where }),
    ]);
    const counts = await questionCounts(rows.map((row) => row.id));
    return {
      ...paginated(
        rows.map((row) => toAdminItem(row, counts)),
        total,
        query,
      ),
      pendingFinalization,
    };
  },

  /**
   * One attempt for managers. Finalized attempts include the per-question review with the
   * answer key (managers author the questions); a running attempt shows progress only — never a
   * live, key-annotated view of a student's answers.
   */
  async adminAttempt(id: string): Promise<AdminAcademyAttemptDetail> {
    const ref = await prisma.assessmentAttempt.findUnique({
      where: { id },
      select: { academyQuizId: true },
    });
    if (!ref?.academyQuizId) attemptNotFound();
    const now = clock.now();
    const row = (await loadWithExpiry(id, now)) ?? attemptNotFound();
    const [summary, quiz] = await Promise.all([
      prisma.assessmentAttempt.findUniqueOrThrow({ where: { id }, select: adminAttemptSelect }),
      prisma.academyQuiz.findUniqueOrThrow({
        where: { id: ref!.academyQuizId! },
        select: rulesSelect,
      }),
    ]);
    const counts = await questionCounts([id]);
    return {
      ...toAdminItem(summary, counts),
      quiz: { id: quiz.id, slug: quiz.slug, title: quiz.title },
      questions: row.status === 'IN_PROGRESS' ? [] : toReviewQuestions(row),
      resultVisibleToStudent: academyResultState(row, quiz, now) === 'RELEASED',
    };
  },

  // --- Student results ---------------------------------------------------------------------

  /** The student's finalized Academy Quiz attempts, newest first, with release applied. */
  async studentResults(
    auth: AuthContext,
    query: PaginationQuery,
  ): Promise<Paginated<StudentAcademyResultItem>> {
    await finalizeExpiredBounded({
      where: Prisma.sql`AND "user_id" = ${auth.userId}::uuid AND "academy_quiz_id" IS NOT NULL`,
    });
    const where: Prisma.AssessmentAttemptWhereInput = {
      userId: auth.userId,
      academyQuizId: { not: null },
      status: { in: ['SUBMITTED', 'EXPIRED'] },
    };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.assessmentAttempt.findMany({
        where,
        select: {
          id: true,
          attemptNumber: true,
          status: true,
          submittedAt: true,
          evaluationStatus: true,
          rawScore: true,
          penalty: true,
          score: true,
          maxScore: true,
          percent: true,
          passed: true,
          academyQuiz: { select: rulesSelect },
        },
        orderBy: [{ submittedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      prisma.assessmentAttempt.count({ where }),
    ]);
    const now = clock.now();
    return paginated(
      rows.map((row) => {
        const quiz = row.academyQuiz!;
        const resultState = academyResultState(row, quiz, now);
        return {
          attemptId: row.id,
          quiz: { id: quiz.id, slug: quiz.slug, title: quiz.title },
          attemptNumber: row.attemptNumber,
          status: row.status,
          submittedAt: row.submittedAt!.toISOString(),
          resultState,
          resultsAt:
            resultState === 'AWAITING_RELEASE' && quiz.resultRelease === 'SCHEDULED'
              ? (quiz.resultsAt?.toISOString() ?? null)
              : null,
          result: resultState === 'RELEASED' ? scoreOf(row) : null,
        };
      }),
      total,
      query,
    );
  },
};

const adminAttemptSelect = {
  id: true,
  userId: true,
  attemptNumber: true,
  status: true,
  evaluationStatus: true,
  startedAt: true,
  deadlineAt: true,
  submittedAt: true,
  rawScore: true,
  penalty: true,
  score: true,
  maxScore: true,
  percent: true,
  passed: true,
  student: { select: { fullName: true, email: true } },
} satisfies Prisma.AssessmentAttemptSelect;
type AdminAttemptRow = Prisma.AssessmentAttemptGetPayload<{ select: typeof adminAttemptSelect }>;

async function questionCounts(ids: string[]) {
  const counts = new Map<string, { total: number; answered: number }>();
  if (ids.length === 0) return counts;
  const [totals, answered] = await Promise.all([
    prisma.attemptQuestion.groupBy({
      by: ['attemptId'],
      where: { attemptId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.attemptQuestion.groupBy({
      by: ['attemptId'],
      where: { attemptId: { in: ids }, answeredAt: { not: null } },
      _count: { _all: true },
    }),
  ]);
  for (const row of totals) counts.set(row.attemptId, { total: row._count._all, answered: 0 });
  for (const row of answered) {
    const entry = counts.get(row.attemptId);
    if (entry) entry.answered = row._count._all;
  }
  return counts;
}

function toAdminItem(
  row: AdminAttemptRow,
  counts: Map<string, { total: number; answered: number }>,
): AdminAcademyAttemptItem {
  const count = counts.get(row.id) ?? { total: 0, answered: 0 };
  return {
    id: row.id,
    student: { userId: row.userId, fullName: row.student.fullName, email: row.student.email },
    attemptNumber: row.attemptNumber,
    status: row.status,
    evaluationStatus: row.evaluationStatus,
    startedAt: row.startedAt.toISOString(),
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    durationSeconds: row.submittedAt
      ? Math.max(0, Math.round((row.submittedAt.getTime() - row.startedAt.getTime()) / 1000))
      : null,
    maxScore: num(row.maxScore) ?? 0,
    result: scoreOf(row),
    answeredCount: count.answered,
    questionCount: count.total,
  };
}
