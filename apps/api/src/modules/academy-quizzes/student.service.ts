import type {
  AcademyIneligibility,
  AcademyPrizeDto,
  AnswerSaveResultDto,
  AttemptScoreDto,
  Paginated,
  StudentAcademyAttemptDto,
  StudentAcademyAttemptStartDto,
  StudentAcademyEligibility,
  StudentAcademyQuizDetail,
  StudentAcademyQuizItem,
  StudentAttemptSummary,
} from '@asra/types';
import type {
  AcademyAttemptAdvanceInput,
  AnswerSaveInput,
  StudentAcademyQuizListQuery,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import { Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import {
  findAttempt,
  finalizeExpiredBounded,
  finalizeLocked,
  isExpired,
  lockAttempt,
  lockStudentAssessment,
  num,
  questionImageRefs,
  rethrowAttemptRace,
  scoreOf,
  selectQuestions,
  shuffled,
  sourceQuestionSelect,
  toAttemptQuestion,
  toReviewQuestions,
  type AttemptRow,
  type SourceQuestion,
} from '../assessments/attempts.core.js';
import { EXPIRED_MESSAGE, FINAL_MESSAGE, validateAnswer } from '../assessments/attempts.service.js';
import { loadMediaRefs, mediaRefSelect, toMediaDto } from '../assessments/media/media.service.js';
import { fromCents, isAnswered, toCents } from '../assessments/scoring.js';
import { readPrizes } from './academy-quizzes.service.js';
import { phaseOf, planSelection } from './selection.js';
import {
  ACADEMY_MIN_START_REMAINING_MS,
  academyAnswersRevealed,
  academyResultState,
  advance,
  availableMinutes,
  catchUp,
  resultsReleased,
  startTiming,
  type LinearState,
} from './timing.js';

/**
 * Academy Quizzes for students (docs/ASSESSMENTS.md §Academy). Route gates: STUDENT role +
 * `academy_quizzes.participate`. Service rules:
 *   - no course enrolment is involved anywhere;
 *   - a verified email and the quiz's class/stream restrictions are required to START (checked
 *     against the database, not the token);
 *   - attempts are found only through their owner (another student's id is a 404) and only on
 *     these routes (course attempt routes 404 academy attempts and vice versa);
 *   - every deadline is server time, persisted at start and re-checked on every read, save,
 *     advance and submit; expired attempts are finalized when touched (no scheduler);
 *   - finalization, scoring and idempotency are the shared engine's (`finalizeLocked`).
 *
 * Fullscreen is a browser-side start requirement only; the server neither sees nor records it.
 */

const quizNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Academy quiz not found');
};
const attemptNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Attempt not found');
};

const quizSelect = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  description: true,
  instructions: true,
  prizes: true,
  startsAt: true,
  endsAt: true,
  resultsAt: true,
  timeZone: true,
  timerMode: true,
  durationMinutes: true,
  questionTimeSeconds: true,
  navigation: true,
  requireAnswerToAdvance: true,
  selection: true,
  questionsPerAttempt: true,
  easyCount: true,
  mediumCount: true,
  hardCount: true,
  shuffleQuestions: true,
  shuffleOptions: true,
  negativeMarking: true,
  passPercent: true,
  maxAttempts: true,
  eligibleClassIds: true,
  eligibleStreamIds: true,
  resultRelease: true,
  answerReveal: true,
  resultsPublishedAt: true,
  leaderboardVisibility: true,
  status: true,
  bannerMedia: { select: mediaRefSelect },
} satisfies Prisma.AcademyQuizSelect;

type QuizRow = Prisma.AcademyQuizGetPayload<{ select: typeof quizSelect }>;

/** Draft quizzes do not exist for students. */
const visibleStatus = { in: ['PUBLISHED', 'CLOSED'] as ('PUBLISHED' | 'CLOSED')[] };

const bannerOf = (row: QuizRow) =>
  row.bannerMedia
    ? toMediaDto({ ...row.bannerMedia, format: row.bannerMedia.format as 'webp' | 'jpg' | 'png' })
    : null;

// --- Student facts (read from the database on every request) ------------------------------

async function studentFacts(auth: AuthContext, db: DbClient = prisma) {
  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: {
      emailVerifiedAt: true,
      studentProfile: { select: { classId: true, streamId: true } },
    },
  });
  return {
    emailVerified: Boolean(user?.emailVerifiedAt),
    classId: user?.studentProfile?.classId ?? null,
    streamId: user?.studentProfile?.streamId ?? null,
  };
}
type StudentFacts = Awaited<ReturnType<typeof studentFacts>>;

const INELIGIBLE_MESSAGE: Record<AcademyIneligibility, string> = {
  EMAIL_NOT_VERIFIED: 'Verify your email address to take part in Academy Quizzes.',
  CLASS: 'This quiz is open to students of other classes only.',
  STREAM: 'This quiz is open to students of other streams only.',
};

function ineligibility(quiz: QuizRow, facts: StudentFacts): AcademyIneligibility[] {
  const reasons: AcademyIneligibility[] = [];
  if (!facts.emailVerified) reasons.push('EMAIL_NOT_VERIFIED');
  if (
    quiz.eligibleClassIds.length > 0 &&
    (facts.classId === null || !quiz.eligibleClassIds.includes(facts.classId))
  ) {
    reasons.push('CLASS');
  }
  if (
    quiz.eligibleStreamIds.length > 0 &&
    (facts.streamId === null || !quiz.eligibleStreamIds.includes(facts.streamId))
  ) {
    reasons.push('STREAM');
  }
  return reasons;
}

/** Listing filter: quizzes restricted to other classes/streams are not advertised. */
function audienceWhere(facts: StudentFacts, userId: string): Prisma.AcademyQuizWhereInput {
  const classOk: Prisma.AcademyQuizWhereInput[] = [{ eligibleClassIds: { isEmpty: true } }];
  if (facts.classId) classOk.push({ eligibleClassIds: { has: facts.classId } });
  const streamOk: Prisma.AcademyQuizWhereInput[] = [{ eligibleStreamIds: { isEmpty: true } }];
  if (facts.streamId) streamOk.push({ eligibleStreamIds: { has: facts.streamId } });
  return {
    OR: [{ AND: [{ OR: classOk }, { OR: streamOk }] }, { attempts: { some: { userId } } }],
  };
}

// --- Questions of an attempt ----------------------------------------------------------------

async function poolOfQuiz(db: DbClient, quizId: string) {
  return db.assessmentQuestion.findMany({
    where: { academyQuizId: quizId },
    select: sourceQuestionSelect,
  });
}

const poolPlan = (quiz: QuizRow, questions: SourceQuestion[]) =>
  planSelection(
    quiz,
    questions.map((question) => ({
      difficulty: question.difficulty,
      marksCents: toCents(question.marks),
    })),
  );

/** The questions one new attempt gets, per the quiz's selection strategy. */
function drawQuestions(quiz: QuizRow, questions: SourceQuestion[]): SourceQuestion[] {
  if (quiz.selection === 'ALL') return questions;
  if (quiz.selection === 'RANDOM') {
    const picked = new Set(
      shuffled(questions)
        .slice(0, quiz.questionsPerAttempt ?? 0)
        .map((question) => question.id),
    );
    return questions.filter((question) => picked.has(question.id));
  }
  const wanted = {
    EASY: quiz.easyCount ?? 0,
    MEDIUM: quiz.mediumCount ?? 0,
    HARD: quiz.hardCount ?? 0,
  };
  const picked = new Set<string>();
  for (const level of ['EASY', 'MEDIUM', 'HARD'] as const) {
    if (wanted[level] === 0) continue;
    shuffled(questions.filter((question) => question.difficulty === level))
      .slice(0, wanted[level])
      .forEach((question) => picked.add(question.id));
  }
  return questions.filter((question) => picked.has(question.id));
}

// --- Availability ---------------------------------------------------------------------------

function cannotStartReason(
  quiz: QuizRow,
  now: Date,
  reasons: AcademyIneligibility[],
  attemptsUsed: number,
  planOk: boolean,
): string | null {
  if (quiz.status === 'CLOSED') return 'This quiz has been closed.';
  if (now < quiz.startsAt) return 'This quiz has not started yet.';
  if (now >= quiz.endsAt) return 'This quiz has ended.';
  if (reasons.length > 0) return INELIGIBLE_MESSAGE[reasons[0]!];
  if (attemptsUsed >= quiz.maxAttempts) {
    return quiz.maxAttempts === 1
      ? 'You have already attempted this quiz.'
      : `You have used all ${quiz.maxAttempts} attempts.`;
  }
  if (quiz.endsAt.getTime() - now.getTime() < ACADEMY_MIN_START_REMAINING_MS) {
    return 'Less than a minute is left before the quiz ends, so a new attempt cannot start.';
  }
  if (!planOk) return 'This quiz is not ready yet. Please try again later.';
  return null;
}

// --- Attempt serialisation ------------------------------------------------------------------

type AcademyAttemptRow = AttemptRow & { academyQuiz: NonNullable<AttemptRow['academyQuiz']> };

function summaryOf(
  row: Pick<
    AttemptRow,
    | 'id'
    | 'attemptNumber'
    | 'status'
    | 'startedAt'
    | 'deadlineAt'
    | 'submittedAt'
    | 'evaluationStatus'
    | 'score'
    | 'rawScore'
    | 'penalty'
    | 'maxScore'
    | 'percent'
    | 'passed'
  >,
  quiz: Parameters<typeof resultsReleased>[0],
  now: Date,
): StudentAttemptSummary {
  const resultState = academyResultState(row, quiz, now);
  return {
    id: row.id,
    attemptNumber: row.attemptNumber,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    resultState,
    result: resultState === 'RELEASED' ? scoreOf(row) : null,
  };
}

function toAttemptDto(row: AcademyAttemptRow, now: Date): StudentAcademyAttemptDto {
  const quiz = row.academyQuiz;
  const resultState = academyResultState(row, quiz, now);
  const running = row.status === 'IN_PROGRESS';
  const linear = quiz.navigation === 'LINEAR';
  const questions =
    running && linear
      ? row.questions.filter((question) => question.position === row.currentPosition)
      : row.questions;
  return {
    id: row.id,
    quiz: { id: quiz.id, slug: quiz.slug, title: quiz.title },
    attemptNumber: row.attemptNumber,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    deadlineAt: row.deadlineAt!.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    serverNow: now.toISOString(),
    timerMode: quiz.timerMode,
    navigation: quiz.navigation,
    requireAnswerToAdvance: quiz.requireAnswerToAdvance,
    questionCount: row.questions.length,
    currentPosition: running && linear ? row.currentPosition : null,
    currentQuestionDeadlineAt:
      running && linear ? (row.currentQuestionDeadlineAt?.toISOString() ?? null) : null,
    negativeMarking: quiz.negativeMarking,
    maxScore: num(row.maxScore) ?? 0,
    questions: questions.map(toAttemptQuestion),
    resultState,
    resultsAt:
      resultState === 'AWAITING_RELEASE' && quiz.resultRelease === 'SCHEDULED'
        ? (quiz.resultsAt?.toISOString() ?? null)
        : null,
    result: resultState === 'RELEASED' ? scoreOf(row) : null,
    review: academyAnswersRevealed(resultState, quiz, now) ? toReviewQuestions(row) : null,
  };
}

// --- Attempt access and lazy state ----------------------------------------------------------

/** Owner + kind check without revealing whether the id exists. */
async function assertOwnAcademyAttempt(auth: AuthContext, id: string, db: DbClient = prisma) {
  const owner = await db.assessmentAttempt.findUnique({
    where: { id },
    select: { userId: true, academyQuizId: true },
  });
  if (!owner || owner.userId !== auth.userId || owner.academyQuizId === null) attemptNotFound();
}

const asAcademy = (row: AttemptRow | null): AcademyAttemptRow => {
  if (!row || !row.academyQuiz) return attemptNotFound();
  return row as AcademyAttemptRow;
};

function linearStateOf(row: AcademyAttemptRow): LinearState | null {
  if (row.academyQuiz.navigation !== 'LINEAR' || row.currentPosition === null) return null;
  return {
    position: row.currentPosition,
    questionDeadlineAt: row.currentQuestionDeadlineAt,
    deadlineAt: row.deadlineAt!,
  };
}

/** Whether a read must take the lock (deadline passed, or a question's time ran out). */
function needsUpdate(row: AcademyAttemptRow, now: Date): boolean {
  if (isExpired(row, now)) return true;
  const state = linearStateOf(row);
  if (!state || row.status !== 'IN_PROGRESS') return false;
  return (
    catchUp(state, row.questions.length, row.academyQuiz.questionTimeSeconds, now).position !==
    state.position
  );
}

/**
 * On a LOCKED row: finalizes it when its deadline has passed, otherwise applies per-question
 * catch-up. Returns the current row.
 */
async function settleLocked(
  tx: DbClient,
  row: AcademyAttemptRow,
  now: Date,
): Promise<AcademyAttemptRow> {
  if (row.status !== 'IN_PROGRESS') return row;
  if (isExpired(row, now)) {
    return asAcademy(await finalizeLocked(tx, row, 'EXPIRED', now, null));
  }
  const state = linearStateOf(row);
  if (!state) return row;
  const next = catchUp(state, row.questions.length, row.academyQuiz.questionTimeSeconds, now);
  if (next.position === state.position) return row;
  await tx.assessmentAttempt.update({
    where: { id: row.id },
    data: { currentPosition: next.position, currentQuestionDeadlineAt: next.questionDeadlineAt },
  });
  return asAcademy(await findAttempt(tx, row.id));
}

async function loadSettled(id: string, now: Date): Promise<AcademyAttemptRow> {
  const row = asAcademy(await findAttempt(prisma, id));
  if (!needsUpdate(row, now)) return row;
  return prisma.$transaction(async (tx) =>
    settleLocked(tx, asAcademy(await lockAttempt(tx, id)), now),
  );
}

/** Finalizes this student's expired academy attempts (listing/detail pages; no scheduler). */
const sweepOwn = (userId: string) =>
  finalizeExpiredBounded({
    where: Prisma.sql`AND "user_id" = ${userId}::uuid AND "academy_quiz_id" IS NOT NULL`,
  });

// --- Listing and detail ---------------------------------------------------------------------

const attemptFactsSelect = {
  id: true,
  academyQuizId: true,
  attemptNumber: true,
  status: true,
  startedAt: true,
  deadlineAt: true,
  submittedAt: true,
  evaluationStatus: true,
  maxScore: true,
  rawScore: true,
  penalty: true,
  score: true,
  percent: true,
  passed: true,
} satisfies Prisma.AssessmentAttemptSelect;

type AttemptFacts = Prisma.AssessmentAttemptGetPayload<{ select: typeof attemptFactsSelect }>;

function participationOf(quiz: QuizRow, attempts: AttemptFacts[], now: Date) {
  const released = resultsReleased(quiz, now);
  let best: AttemptScoreDto | null = null;
  if (released) {
    for (const attempt of attempts) {
      const score = attempt.evaluationStatus === 'EVALUATED' ? scoreOf(attempt) : null;
      if (score && (best === null || score.score > best.score)) best = score;
    }
  }
  return {
    attemptsUsed: attempts.length,
    maxAttempts: quiz.maxAttempts,
    inProgressAttemptId: attempts.find((attempt) => attempt.status === 'IN_PROGRESS')?.id ?? null,
    bestResult: best,
  };
}

function questionsPerAttempt(quiz: QuizRow, poolSize: number): number {
  if (quiz.selection === 'RANDOM') return quiz.questionsPerAttempt ?? 0;
  if (quiz.selection === 'BY_DIFFICULTY') {
    return (quiz.easyCount ?? 0) + (quiz.mediumCount ?? 0) + (quiz.hardCount ?? 0);
  }
  return poolSize;
}

function toItem(
  quiz: QuizRow,
  poolSize: number,
  attempts: AttemptFacts[],
  eligible: boolean,
  now: Date,
): StudentAcademyQuizItem {
  return {
    id: quiz.id,
    slug: quiz.slug,
    title: quiz.title,
    summary: quiz.summary,
    banner: bannerOf(quiz),
    phase: phaseOf(quiz, now) as StudentAcademyQuizItem['phase'],
    startsAt: quiz.startsAt.toISOString(),
    endsAt: quiz.endsAt.toISOString(),
    timerMode: quiz.timerMode,
    durationMinutes: quiz.durationMinutes,
    questionTimeSeconds: quiz.questionTimeSeconds,
    questionsPerAttempt: questionsPerAttempt(quiz, poolSize),
    hasPrizes: readPrizes(quiz.prizes).length > 0,
    eligible,
    participation: participationOf(quiz, attempts, now),
  };
}

function tabWhere(tab: StudentAcademyQuizListQuery['tab'], now: Date) {
  switch (tab) {
    case 'UPCOMING':
      return {
        where: {
          status: 'PUBLISHED',
          startsAt: { gt: now },
        } satisfies Prisma.AcademyQuizWhereInput,
        orderBy: [
          { startsAt: 'asc' },
          { id: 'asc' },
        ] satisfies Prisma.AcademyQuizOrderByWithRelationInput[],
      };
    case 'LIVE':
      return {
        where: {
          status: 'PUBLISHED',
          startsAt: { lte: now },
          endsAt: { gt: now },
        } satisfies Prisma.AcademyQuizWhereInput,
        orderBy: [
          { endsAt: 'asc' },
          { id: 'asc' },
        ] satisfies Prisma.AcademyQuizOrderByWithRelationInput[],
      };
    case 'COMPLETED':
      return {
        where: {
          OR: [{ status: 'CLOSED' }, { status: 'PUBLISHED', endsAt: { lte: now } }],
        } satisfies Prisma.AcademyQuizWhereInput,
        orderBy: [
          { endsAt: 'desc' },
          { id: 'asc' },
        ] satisfies Prisma.AcademyQuizOrderByWithRelationInput[],
      };
  }
}

async function poolSizes(ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await prisma.assessmentQuestion.groupBy({
    by: ['academyQuizId'],
    where: { academyQuizId: { in: ids } },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.academyQuizId!, row._count._all]));
}

async function ownAttempts(userId: string, quizIds: string[]) {
  const rows = quizIds.length
    ? await prisma.assessmentAttempt.findMany({
        where: { userId, academyQuizId: { in: quizIds } },
        select: attemptFactsSelect,
        orderBy: { attemptNumber: 'asc' },
      })
    : [];
  const byQuiz = new Map<string, AttemptFacts[]>();
  for (const row of rows) {
    const list = byQuiz.get(row.academyQuizId!) ?? [];
    list.push(row);
    byQuiz.set(row.academyQuizId!, list);
  }
  return byQuiz;
}

export const studentAcademyQuizService = {
  async list(
    auth: AuthContext,
    query: StudentAcademyQuizListQuery,
  ): Promise<Paginated<StudentAcademyQuizItem>> {
    await sweepOwn(auth.userId);
    const now = clock.now();
    const facts = await studentFacts(auth);
    const tab = tabWhere(query.tab, now);
    const where: Prisma.AcademyQuizWhereInput = {
      AND: [tab.where, audienceWhere(facts, auth.userId)],
    };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.academyQuiz.findMany({ where, select: quizSelect, orderBy: tab.orderBy, skip, take }),
      prisma.academyQuiz.count({ where }),
    ]);
    const ids = rows.map((row) => row.id);
    const [sizes, attempts] = await Promise.all([poolSizes(ids), ownAttempts(auth.userId, ids)]);
    return paginated(
      rows.map((row) =>
        toItem(
          row,
          sizes.get(row.id) ?? 0,
          attempts.get(row.id) ?? [],
          ineligibility(row, facts).length === 0,
          now,
        ),
      ),
      total,
      query,
    );
  },

  async detail(auth: AuthContext, slug: string): Promise<StudentAcademyQuizDetail> {
    await sweepOwn(auth.userId);
    const quiz =
      (await prisma.academyQuiz.findFirst({
        where: { slug, status: visibleStatus },
        select: quizSelect,
      })) ?? quizNotFound();
    const now = clock.now();
    const [facts, pool, attemptsByQuiz, classes, streams] = await Promise.all([
      studentFacts(auth),
      poolOfQuiz(prisma, quiz.id),
      ownAttempts(auth.userId, [quiz.id]),
      prisma.class.findMany({
        where: { id: { in: quiz.eligibleClassIds } },
        select: { id: true, name: true },
        orderBy: { sortOrder: 'asc' },
      }),
      prisma.stream.findMany({
        where: { id: { in: quiz.eligibleStreamIds } },
        select: { id: true, name: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    const attempts = attemptsByQuiz.get(quiz.id) ?? [];
    const reasons = ineligibility(quiz, facts);
    const plan = poolPlan(quiz, pool);
    const eligibility: StudentAcademyEligibility = {
      eligible: reasons.length === 0,
      reasons,
      message: reasons.length > 0 ? INELIGIBLE_MESSAGE[reasons[0]!] : null,
      eligibleClasses: classes,
      eligibleStreams: streams,
    };
    const item = toItem(quiz, pool.length, attempts, eligibility.eligible, now);
    const reason = item.participation.inProgressAttemptId
      ? null
      : cannotStartReason(quiz, now, reasons, attempts.length, plan.problems.length === 0);
    const prizes = readPrizes(quiz.prizes);
    const prizeMedia = await loadMediaRefs(
      prisma,
      prizes.flatMap((prize) => (prize.imageMediaId ? [prize.imageMediaId] : [])),
    );
    const perAttempt = item.questionsPerAttempt;
    return {
      ...item,
      description: quiz.description,
      instructions: quiz.instructions,
      prizes: [...prizes]
        .sort((a, b) => a.position - b.position)
        .map((prize): AcademyPrizeDto => {
          const image = prize.imageMediaId ? prizeMedia.get(prize.imageMediaId) : undefined;
          return {
            position: prize.position,
            title: prize.title,
            description: prize.description,
            image: image ? toMediaDto(image) : null,
          };
        }),
      resultsAt: quiz.resultsAt?.toISOString() ?? null,
      timeZone: quiz.timeZone,
      navigation: quiz.navigation,
      requireAnswerToAdvance: quiz.requireAnswerToAdvance,
      totalMarks: plan.totalMarksCents === null ? 0 : plan.totalMarksCents / 100,
      negativeMarking: quiz.negativeMarking,
      passPercent: quiz.passPercent,
      resultRelease: quiz.resultRelease,
      answerReveal: quiz.answerReveal,
      resultsPublished: resultsReleased(quiz, now),
      leaderboardVisible: quiz.leaderboardVisibility !== 'HIDDEN',
      eligibility,
      cannotStartReason: reason,
      availableMinutesIfStartedNow:
        reason === null && !item.participation.inProgressAttemptId
          ? availableMinutes(now, quiz, perAttempt)
          : null,
      attempts: attempts.map((attempt) => summaryOf(attempt, quiz, now)),
      serverNow: now.toISOString(),
    };
  },

  /**
   * Starts (or resumes) an attempt. Server rules, in order: quiz published and visible; a running
   * attempt is resumed (after its expiry/catch-up is applied); window open with ≥ 1 minute left;
   * verified email and class/stream eligibility (fresh from the database); attempts left;
   * selection satisfiable. Start = server now; deadline per `startTiming` (never after endsAt).
   */
  async start(auth: AuthContext, slug: string): Promise<StudentAcademyAttemptStartDto> {
    try {
      return await prisma.$transaction(async (tx) => {
        const found =
          (await tx.academyQuiz.findFirst({
            where: { slug, status: visibleStatus },
            select: { id: true },
          })) ?? quizNotFound();
        // Shared lock: many students start concurrently, but never while the quiz is being
        // closed or edited (those take FOR UPDATE), so a close always sees every new attempt.
        await tx.$queryRaw`SELECT "id" FROM "academy_quizzes" WHERE "id" = ${found.id}::uuid FOR SHARE`;
        await lockStudentAssessment(tx, found.id, auth.userId);
        const quiz = (await tx.academyQuiz.findUnique({
          where: { id: found.id },
          select: quizSelect,
        }))!;
        const now = clock.now();
        const existing = await tx.assessmentAttempt.findMany({
          where: { academyQuizId: quiz.id, userId: auth.userId },
          select: { id: true, status: true },
        });
        const running = existing.find((attempt) => attempt.status === 'IN_PROGRESS');
        if (running) {
          const row = await settleLocked(tx, asAcademy(await lockAttempt(tx, running.id)), now);
          if (row.status === 'IN_PROGRESS')
            return { resumed: true, attempt: toAttemptDto(row, now) };
        }
        const [facts, pool] = await Promise.all([studentFacts(auth, tx), poolOfQuiz(tx, quiz.id)]);
        const plan = poolPlan(quiz, pool);
        const reason = cannotStartReason(
          quiz,
          now,
          ineligibility(quiz, facts),
          existing.length,
          plan.problems.length === 0 && pool.length > 0,
        );
        if (reason) throw new AppError('CONFLICT', reason);
        const drawn = drawQuestions(quiz, pool);
        const chosen = selectQuestions(
          drawn,
          {
            shuffleQuestions: quiz.shuffleQuestions,
            shuffleOptions: quiz.shuffleOptions,
            take: null,
          },
          await questionImageRefs(tx, drawn),
        );
        const timing = startTiming(now, quiz, chosen.length);
        const maxCents = chosen.reduce((sum, question) => sum + toCents(question.marks), 0);
        const created = await tx.assessmentAttempt.create({
          data: {
            academyQuizId: quiz.id,
            userId: auth.userId,
            attemptNumber: existing.length + 1,
            startedAt: now,
            deadlineAt: timing.deadlineAt,
            currentPosition: quiz.navigation === 'LINEAR' ? 0 : null,
            currentQuestionDeadlineAt:
              quiz.navigation === 'LINEAR' ? timing.currentQuestionDeadlineAt : null,
            maxScore: new Prisma.Decimal(fromCents(maxCents).toFixed(2)),
            questions: { create: chosen },
          },
          select: { id: true },
        });
        return {
          resumed: false,
          attempt: toAttemptDto(asAcademy(await findAttempt(tx, created.id)), now),
        };
      });
    } catch (error) {
      return rethrowAttemptRace(error);
    }
  },
};

// --- Attempts -------------------------------------------------------------------------------

const QUESTION_LOCKED = 'This question is locked: you have moved past it or its time has run out.';

export const studentAcademyAttemptService = {
  async get(auth: AuthContext, id: string): Promise<StudentAcademyAttemptDto> {
    await assertOwnAcademyAttempt(auth, id);
    const now = clock.now();
    return toAttemptDto(await loadSettled(id, now), now);
  },

  /**
   * Stores one answer, only while the attempt is IN_PROGRESS before its server deadline and, with
   * LINEAR navigation, only for the current question (after per-question catch-up). The row lock
   * orders saves strictly against advance, submit and expiry.
   */
  async saveAnswer(
    auth: AuthContext,
    id: string,
    questionId: string,
    input: AnswerSaveInput,
  ): Promise<AnswerSaveResultDto> {
    const outcome = await prisma.$transaction(async (tx) => {
      await assertOwnAcademyAttempt(auth, id, tx);
      const now = clock.now();
      const locked = asAcademy(await lockAttempt(tx, id));
      if (locked.status !== 'IN_PROGRESS') return { kind: 'final' as const, status: locked.status };
      const row = await settleLocked(tx, locked, now);
      if (row.status !== 'IN_PROGRESS') return { kind: 'expired' as const, status: row.status };
      const question = row.questions.find((q) => q.id === questionId);
      if (!question) throw new AppError('NOT_FOUND', 'Question not found in this attempt');
      if (row.academyQuiz.navigation === 'LINEAR' && question.position !== row.currentPosition) {
        return { kind: 'locked' as const, position: row.currentPosition };
      }
      const answer = validateAnswer(question, input);
      const base = {
        attemptId: id,
        questionId,
        status: row.status,
        deadlineAt: row.deadlineAt?.toISOString() ?? null,
        serverNow: now.toISOString(),
      };
      if (input.sequence <= question.answerSequence) {
        return {
          kind: 'saved' as const,
          dto: { ...base, applied: false, answerSequence: question.answerSequence },
        };
      }
      const answered = isAnswered({ type: question.type, ...answer });
      await tx.attemptQuestion.update({
        where: { id: questionId },
        data: {
          selectedOptionIds: answer.selectedOptionIds,
          textAnswer: answer.textAnswer,
          answerSequence: input.sequence,
          answeredAt: answered ? now : null,
        },
      });
      return {
        kind: 'saved' as const,
        dto: { ...base, applied: true, answerSequence: input.sequence },
      };
    });
    if (outcome.kind === 'final') {
      throw new AppError('CONFLICT', FINAL_MESSAGE, { attemptStatus: outcome.status });
    }
    if (outcome.kind === 'expired') {
      throw new AppError('CONFLICT', EXPIRED_MESSAGE, { attemptStatus: outcome.status });
    }
    if (outcome.kind === 'locked') {
      throw new AppError('CONFLICT', QUESTION_LOCKED, {
        reason: 'QUESTION_LOCKED',
        currentPosition: outcome.position,
      });
    }
    return outcome.dto;
  },

  /**
   * LINEAR navigation: leave the question at `fromPosition` for the next one. Idempotent: if the
   * attempt is already past `fromPosition` (a retry, or its time ran out) the current state is
   * returned unchanged. `requireAnswerToAdvance` is enforced here, on the server.
   */
  async advance(
    auth: AuthContext,
    id: string,
    input: AcademyAttemptAdvanceInput,
  ): Promise<StudentAcademyAttemptDto> {
    const outcome = await prisma.$transaction(async (tx) => {
      await assertOwnAcademyAttempt(auth, id, tx);
      const now = clock.now();
      const locked = asAcademy(await lockAttempt(tx, id));
      const row = await settleLocked(tx, locked, now);
      if (row.status !== 'IN_PROGRESS') return { kind: 'final' as const, row, now };
      const state = linearStateOf(row);
      if (!state) {
        throw new AppError('CONFLICT', 'This quiz lets you move between questions freely.');
      }
      if (input.fromPosition < state.position) return { kind: 'ok' as const, row, now };
      if (input.fromPosition > state.position) {
        throw new AppError('CONFLICT', 'That question has not been reached yet.', {
          reason: 'POSITION_MISMATCH',
          currentPosition: state.position,
        });
      }
      const count = row.questions.length;
      if (state.position >= count - 1) {
        throw new AppError('CONFLICT', 'This is the last question. Submit when you are ready.');
      }
      const current = row.questions.find((question) => question.position === state.position)!;
      if (row.academyQuiz.requireAnswerToAdvance && !isAnswered(current)) {
        throw new AppError('CONFLICT', 'Answer this question before moving on.', {
          reason: 'ANSWER_REQUIRED',
        });
      }
      const next = advance(
        state,
        count,
        {
          timerMode: row.academyQuiz.timerMode,
          durationMinutes: null,
          questionTimeSeconds: row.academyQuiz.questionTimeSeconds,
          endsAt: row.academyQuiz.endsAt,
        },
        now,
      );
      await tx.assessmentAttempt.update({
        where: { id },
        data: {
          currentPosition: next.position,
          currentQuestionDeadlineAt: next.questionDeadlineAt,
          deadlineAt: next.deadlineAt,
        },
      });
      return { kind: 'ok' as const, row: asAcademy(await findAttempt(tx, id)), now };
    });
    return toAttemptDto(outcome.row, outcome.now);
  },

  /**
   * Finalizes from the answers ALREADY stored (no body). Before the deadline → SUBMITTED; at/after
   * it → EXPIRED with the answers saved in time. Repeats return the same final attempt.
   */
  async submit(
    auth: AuthContext,
    id: string,
  ): Promise<{
    outcome: 'submitted' | 'expired' | 'already_final';
    attempt: StudentAcademyAttemptDto;
  }> {
    return prisma.$transaction(async (tx) => {
      await assertOwnAcademyAttempt(auth, id, tx);
      const row = asAcademy(await lockAttempt(tx, id));
      const now = clock.now();
      if (row.status !== 'IN_PROGRESS') {
        return { outcome: 'already_final' as const, attempt: toAttemptDto(row, now) };
      }
      const mode = isExpired(row, now) ? ('EXPIRED' as const) : ('SUBMITTED' as const);
      const finalized = asAcademy(await finalizeLocked(tx, row, mode, now, auth.userId));
      return {
        outcome: mode === 'EXPIRED' ? ('expired' as const) : ('submitted' as const),
        attempt: toAttemptDto(finalized, now),
      };
    });
  },
};
