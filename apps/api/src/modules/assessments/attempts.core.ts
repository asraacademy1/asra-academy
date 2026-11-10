import { randomInt } from 'node:crypto';
import type {
  AnswerReveal,
  AttemptQuestionDto,
  AttemptResultState,
  AttemptScoreDto,
  FacultyAttemptDetail,
  FacultyAttemptItem,
  ReviewQuestionDto,
  StudentAttemptDto,
  StudentAttemptSummary,
} from '@asra/types';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import { Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../utils/app-error.js';
import type { MediaFormat } from '@asra/validation';
import { ACADEMY_FINALIZE_LIMITS } from '../../config/constants.js';
import { loadMediaRefs, mediaRefSelect, toMediaDto, type MediaRef } from './media/media.service.js';
import { fromCents, isAnswered, scoreAttempt, toCents, type ScoringQuestion } from './scoring.js';

/**
 * Shared attempt machinery for quizzes and examinations (docs/ASSESSMENTS.md §4–§8).
 *
 *   start  → snapshot of the assigned questions (order, options, keys, marks) is persisted
 *   answer → stored against the attempt's own snapshot, only while IN_PROGRESS and before the
 *            server deadline (row lock serialises answers with finalization)
 *   final  → ONE code path (`finalizeLocked`) for submit, deadline expiry and quiz closure: it runs
 *            on a row locked FOR UPDATE and only from IN_PROGRESS, so retries, concurrent submits
 *            and the sweeper can never finalize or score an attempt twice
 *
 * Every read/save/submit re-checks the deadline itself (`expireIfDue`), so correctness never
 * depends on the background sweeper having run.
 */

// --- Snapshot -------------------------------------------------------------------------------

/** An image frozen into a snapshot: everything needed to show it, whatever happens later. */
export type SnapshotImage = MediaRef;

export interface SnapshotOption {
  id: string;
  text: string;
  isCorrect: boolean;
  /** Absent in snapshots taken before question images existed. */
  image?: SnapshotImage | null;
}

export interface QuestionSnapshot {
  prompt: string;
  explanation: string | null;
  options: SnapshotOption[];
  images: SnapshotImage[];
}

/** Historical snapshots (no `images`, no option `image`) read as "no images". */
export function readSnapshot(value: Prisma.JsonValue): QuestionSnapshot {
  const raw = (value ?? {}) as Partial<QuestionSnapshot>;
  return {
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    explanation: typeof raw.explanation === 'string' ? raw.explanation : null,
    options: Array.isArray(raw.options) ? raw.options : [],
    images: Array.isArray(raw.images) ? raw.images : [],
  };
}

const optionImageDto = (option: SnapshotOption) => (option.image ? toMediaDto(option.image) : null);

/** Fisher–Yates with a CSPRNG (students cannot predict the order from earlier attempts). */
export function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export const sourceQuestionSelect = {
  id: true,
  type: true,
  prompt: true,
  explanation: true,
  marks: true,
  negativeMarks: true,
  position: true,
  difficulty: true,
  imageIds: true,
  options: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      text: true,
      isCorrect: true,
      position: true,
      image: { select: mediaRefSelect },
    },
  },
} satisfies Prisma.AssessmentQuestionSelect;

export type SourceQuestion = Prisma.AssessmentQuestionGetPayload<{
  select: typeof sourceQuestionSelect;
}>;

const asRef = (row: {
  id: string;
  publicId: string;
  format: string;
  width: number;
  height: number;
}) => ({ ...row, format: row.format as MediaFormat }) satisfies MediaRef;

/** Question images (an id array, no FK) are loaded in one query for a set of questions. */
export function questionImageRefs(db: DbClient, questions: readonly SourceQuestion[]) {
  return loadMediaRefs(
    db,
    questions.flatMap((question) => question.imageIds),
  );
}

/** A question's images in order (ids whose media no longer exists are skipped). */
export function imagesOf(question: Pick<SourceQuestion, 'imageIds'>, media: Map<string, MediaRef>) {
  return question.imageIds.flatMap((id) => {
    const ref = media.get(id);
    return ref ? [ref] : [];
  });
}

/**
 * Picks and orders the questions of a new attempt. With `take`, a uniformly random subset is drawn
 * (kept in authoring order unless questions are shuffled). True/False options are never shuffled.
 * Images are frozen into the snapshot and listed in `mediaIds`, which keeps them referenced (and
 * therefore never deleted) for as long as the attempt exists.
 */
export function selectQuestions(
  questions: readonly SourceQuestion[],
  rules: { shuffleQuestions: boolean; shuffleOptions: boolean; take: number | null },
  media: Map<string, MediaRef> = new Map(),
) {
  let chosen = [...questions].sort((a, b) => a.position - b.position);
  if (rules.take !== null && rules.take < chosen.length) {
    const picked = new Set(
      shuffled(chosen)
        .slice(0, rules.take)
        .map((q) => q.id),
    );
    chosen = chosen.filter((q) => picked.has(q.id));
  }
  if (rules.shuffleQuestions) chosen = shuffled(chosen);
  return chosen.map((question, position) => {
    const options: SnapshotOption[] = question.options.map(({ id, text, isCorrect, image }) => ({
      id,
      text,
      isCorrect,
      image: image ? asRef(image) : null,
    }));
    const images = imagesOf(question, media);
    const snapshot: QuestionSnapshot = {
      prompt: question.prompt,
      explanation: question.explanation,
      options: rules.shuffleOptions && question.type !== 'TRUE_FALSE' ? shuffled(options) : options,
      images,
    };
    return {
      questionId: question.id,
      position,
      type: question.type,
      snapshot: snapshot as unknown as Prisma.InputJsonObject,
      mediaIds: [
        ...images.map((image) => image.id),
        ...options.flatMap((option) => (option.image ? [option.image.id] : [])),
      ],
      marks: question.marks,
      negativeMarks: question.negativeMarks,
    };
  });
}

/**
 * Serialises attempt creation for ONE student and ONE assessment (transaction-scoped advisory
 * lock), so concurrent "start" requests see each other's attempt instead of both passing the
 * attempt-limit check. The unique (assessment, user, attemptNumber) index is the backstop.
 */
export async function lockStudentAssessment(tx: DbClient, assessmentId: string, userId: string) {
  const key = `assessment:${assessmentId}:${userId}`;
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) AS l`;
}

// --- Attempt rows ---------------------------------------------------------------------------

const lessonCourse = {
  select: {
    id: true,
    title: true,
    chapter: { select: { module: { select: { course: { select: { id: true, title: true } } } } } },
  },
} as const;

export const attemptSelect = {
  id: true,
  quizId: true,
  examinationId: true,
  academyQuizId: true,
  userId: true,
  attemptNumber: true,
  currentPosition: true,
  currentQuestionDeadlineAt: true,
  status: true,
  startedAt: true,
  deadlineAt: true,
  submittedAt: true,
  finalizedAt: true,
  evaluationStatus: true,
  maxScore: true,
  rawScore: true,
  penalty: true,
  score: true,
  percent: true,
  passed: true,
  evaluatedAt: true,
  updatedAt: true,
  student: { select: { fullName: true } },
  questions: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      questionId: true,
      position: true,
      type: true,
      snapshot: true,
      marks: true,
      negativeMarks: true,
      selectedOptionIds: true,
      textAnswer: true,
      answerSequence: true,
      answeredAt: true,
      awardedMarks: true,
      penalty: true,
      isCorrect: true,
      feedback: true,
      gradedAt: true,
      gradedBy: { select: { fullName: true } },
    },
  },
  quiz: {
    select: {
      id: true,
      status: true,
      negativeMarking: true,
      passPercent: true,
      showResultImmediately: true,
      answerReveal: true,
      resultsPublishedAt: true,
      lesson: lessonCourse,
    },
  },
  examination: {
    select: {
      id: true,
      title: true,
      status: true,
      negativeMarking: true,
      passPercent: true,
      answerReveal: true,
      resultsPublishedAt: true,
      closesAt: true,
      course: { select: { id: true, title: true } },
    },
  },
  academyQuiz: {
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      negativeMarking: true,
      passPercent: true,
      endsAt: true,
      timerMode: true,
      questionTimeSeconds: true,
      navigation: true,
      requireAnswerToAdvance: true,
      resultRelease: true,
      resultsAt: true,
      resultsPublishedAt: true,
      answerReveal: true,
    },
  },
} satisfies Prisma.AssessmentAttemptSelect;

export type AttemptRow = Prisma.AssessmentAttemptGetPayload<{ select: typeof attemptSelect }>;

/** The same attempt fields without its questions, for lists and summaries. */
const { questions: _questions, ...summaryFields } = attemptSelect;
export const attemptSummarySelect = summaryFields satisfies Prisma.AssessmentAttemptSelect;
export type AttemptSummaryRow = Prisma.AssessmentAttemptGetPayload<{
  select: typeof attemptSummarySelect;
}>;

/** The assessment an attempt belongs to, flattened for both kinds. */
export function assessmentOf(row: AttemptSummaryRow) {
  if (row.quiz) {
    const lesson = row.quiz.lesson;
    return {
      kind: 'QUIZ' as const,
      id: row.quiz.id,
      title: lesson.title,
      lessonId: lesson.id,
      course: lesson.chapter.module.course,
      negativeMarking: row.quiz.negativeMarking,
      passPercent: row.quiz.passPercent,
      answerReveal: row.quiz.answerReveal as AnswerReveal,
      resultsReleased: row.quiz.showResultImmediately || row.quiz.resultsPublishedAt !== null,
      resultsPublishedAt: row.quiz.resultsPublishedAt,
      closed: (_now: Date) => row.quiz!.status === 'CLOSED',
    };
  }
  // Course-shaped view only: academy attempts are served by their own module (never here).
  if (!row.examination) throw new AppError('NOT_FOUND', 'Attempt not found');
  const exam = row.examination;
  return {
    kind: 'EXAM' as const,
    id: exam.id,
    title: exam.title,
    lessonId: null,
    course: exam.course,
    negativeMarking: exam.negativeMarking,
    passPercent: exam.passPercent,
    answerReveal: exam.answerReveal as AnswerReveal,
    resultsReleased: exam.resultsPublishedAt !== null,
    resultsPublishedAt: exam.resultsPublishedAt,
    closed: (now: Date) => exam.status === 'CLOSED' || now >= exam.closesAt,
  };
}

export async function findAttempt(db: DbClient, id: string): Promise<AttemptRow | null> {
  return db.assessmentAttempt.findUnique({ where: { id }, select: attemptSelect });
}

/** Locks the attempt row for the rest of the transaction and re-reads it. */
export async function lockAttempt(tx: DbClient, id: string): Promise<AttemptRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "assessment_attempts" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (locked.length === 0) return null;
  return findAttempt(tx, id);
}

export const isExpired = (row: Pick<AttemptRow, 'status' | 'deadlineAt'>, now: Date) =>
  row.status === 'IN_PROGRESS' && row.deadlineAt !== null && now >= row.deadlineAt;

function scoringInput(row: AttemptRow): ScoringQuestion[] {
  return row.questions.map((question) => {
    const snapshot = readSnapshot(question.snapshot);
    return {
      type: question.type,
      marks: toCents(question.marks),
      negativeMarks: toCents(question.negativeMarks),
      correctOptionIds: snapshot.options.filter((o) => o.isCorrect).map((o) => o.id),
      selectedOptionIds: question.selectedOptionIds,
      textAnswer: question.textAnswer,
      manualMarks:
        question.type === 'SHORT_ANSWER' &&
        question.gradedAt !== null &&
        question.awardedMarks !== null
          ? toCents(question.awardedMarks)
          : null,
    };
  });
}

const decimal = (cents: number) => new Prisma.Decimal(fromCents(cents).toFixed(2));

/**
 * Writes the evaluation of an attempt from its persisted answers: per-question outcomes and,
 * when nothing awaits manual grading, the attempt score. Idempotent: running it twice on the same
 * answers writes the same values.
 */
/**
 * The scoring rules of an attempt's assessment — all three kinds. Finalization (submit, expiry,
 * closure) needs only these, so it works for academy quizzes without the course-shaped DTO view.
 */
export function scoringRulesOf(row: Pick<AttemptRow, 'quiz' | 'examination' | 'academyQuiz'>) {
  const owner = row.quiz ?? row.examination ?? row.academyQuiz;
  if (!owner) throw new Error('Attempt without an assessment');
  return { negativeMarking: owner.negativeMarking, passPercent: owner.passPercent };
}

interface QuestionOutcomeWrite {
  id: string;
  awarded: string | null;
  penalty: string;
  isCorrect: boolean | null;
}

/** Scores an attempt in memory: the per-question writes and the attempt-level result. */
function evaluate(row: AttemptRow, now: Date) {
  const evaluation = scoreAttempt(scoringInput(row), scoringRulesOf(row));
  const writes: QuestionOutcomeWrite[] = [];
  row.questions.forEach((question, index) => {
    const outcome = evaluation.outcomes[index]!;
    if (question.type === 'SHORT_ANSWER' && outcome.pendingManual) return;
    if (question.type === 'SHORT_ANSWER' && question.gradedAt !== null) return;
    writes.push({
      id: question.id,
      awarded: outcome.awarded === null ? null : fromCents(outcome.awarded).toFixed(2),
      penalty: fromCents(outcome.penalty).toFixed(2),
      isCorrect: outcome.isCorrect,
    });
  });
  const score = evaluation.score;
  return {
    writes,
    scored: {
      evaluationStatus: score ? ('EVALUATED' as const) : ('PENDING' as const),
      rawScore: score ? decimal(score.rawScore) : null,
      penalty: score ? decimal(score.penalty) : null,
      score: score ? decimal(score.score) : null,
      percent: score ? decimal(score.percent) : null,
      passed: score ? score.passed : null,
      evaluatedAt: score ? now : null,
    },
  };
}

/** Rows per set-based UPDATE (4 parameters each; far below PostgreSQL's 65 535 limit). */
const WRITE_CHUNK = 2_000;

/**
 * Writes per-question outcomes of one or many attempts with one UPDATE … FROM (VALUES …) per
 * chunk instead of one UPDATE per question. Same columns and values as before.
 */
async function writeQuestionOutcomes(tx: DbClient, writes: QuestionOutcomeWrite[]) {
  for (let start = 0; start < writes.length; start += WRITE_CHUNK) {
    const values = writes
      .slice(start, start + WRITE_CHUNK)
      .map(
        (w) =>
          Prisma.sql`(${w.id}::uuid, ${w.awarded}::numeric, ${w.penalty}::numeric, ${w.isCorrect}::boolean)`,
      );
    await tx.$executeRaw`
      UPDATE "attempt_questions" AS q
         SET "awarded_marks" = v.awarded, "penalty" = v.penalty, "is_correct" = v.is_correct
        FROM (VALUES ${Prisma.join(values)}) AS v(id, awarded, penalty, is_correct)
       WHERE q."id" = v.id`;
  }
}

async function writeEvaluation(tx: DbClient, row: AttemptRow, now: Date) {
  const { writes, scored } = evaluate(row, now);
  await writeQuestionOutcomes(tx, writes);
  return scored;
}

export type FinalizationMode = 'SUBMITTED' | 'EXPIRED';

/**
 * The finalization writes for attempts that are LOCKED (FOR UPDATE) and IN_PROGRESS: scoring,
 * status and the audit entry, set-based so a batch costs a handful of statements. The attempt
 * UPDATE only matches IN_PROGRESS rows and the whole transaction is rolled back unless every row
 * matched, so an attempt can never be finalized (or scored, or audited) twice.
 */
async function finalizeRowsLocked(
  tx: DbClient,
  rows: AttemptRow[],
  mode: FinalizationMode,
  now: Date,
  actorId: string | null,
): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) {
    if (row.status !== 'IN_PROGRESS') {
      throw new Error(`finalizeLocked called on a ${row.status} attempt`);
    }
    if (mode === 'EXPIRED' && row.deadlineAt === null) {
      throw new Error('An attempt without a deadline cannot expire');
    }
  }
  const evaluated = rows.map((row) => ({ row, ...evaluate(row, now) }));
  await writeQuestionOutcomes(
    tx,
    evaluated.flatMap((entry) => entry.writes),
  );
  const values = evaluated.map(({ row, scored }) => {
    const submittedAt = mode === 'EXPIRED' ? row.deadlineAt! : now;
    return Prisma.sql`(${row.id}::uuid, ${submittedAt}::timestamptz,
      ${scored.evaluationStatus}::"evaluation_status", ${scored.rawScore?.toString() ?? null}::numeric,
      ${scored.penalty?.toString() ?? null}::numeric, ${scored.score?.toString() ?? null}::numeric,
      ${scored.percent?.toString() ?? null}::numeric, ${scored.passed}::boolean,
      ${scored.evaluatedAt}::timestamptz)`;
  });
  const updated = await tx.$executeRaw`
    UPDATE "assessment_attempts" AS a
       SET "status" = ${mode}::"attempt_status",
           "submitted_at" = v.submitted_at,
           "finalized_at" = ${now}::timestamptz,
           "evaluation_status" = v.evaluation_status,
           "raw_score" = v.raw_score,
           "penalty" = v.penalty,
           "score" = v.score,
           "percent" = v.percent,
           "passed" = v.passed,
           "evaluated_at" = v.evaluated_at,
           "updated_at" = CURRENT_TIMESTAMP
      FROM (VALUES ${Prisma.join(values)})
           AS v(id, submitted_at, evaluation_status, raw_score, penalty, score, percent, passed, evaluated_at)
     WHERE a."id" = v.id AND a."status" = 'IN_PROGRESS'`;
  if (updated !== rows.length) {
    throw new Error(`Finalization matched ${updated} of ${rows.length} attempts; rolled back`);
  }
  await tx.assessmentAuditLog.createMany({
    data: evaluated.map(({ row, scored }) => ({
      action: 'attempt.finalized',
      actorId,
      entityType: 'attempt',
      entityId: row.id,
      data: {
        mode,
        evaluationStatus: scored.evaluationStatus,
        score: scored.score?.toString() ?? null,
      },
    })),
  });
}

/**
 * THE finalization path. Must be called on a row locked with `lockAttempt` that is IN_PROGRESS.
 * EXPIRED attempts are recorded as submitted at their deadline (the answers saved before it).
 */
export async function finalizeLocked(
  tx: DbClient,
  row: AttemptRow,
  mode: FinalizationMode,
  now: Date,
  actorId: string | null,
): Promise<AttemptRow> {
  await finalizeRowsLocked(tx, [row], mode, now, actorId);
  return (await findAttempt(tx, row.id))!;
}

/** Finalizes a locked attempt whose deadline has passed; returns the (possibly new) row. */
export async function expireIfDue(tx: DbClient, row: AttemptRow, now: Date): Promise<AttemptRow> {
  return isExpired(row, now) ? finalizeLocked(tx, row, 'EXPIRED', now, null) : row;
}

/**
 * Lazily applies expiry before an attempt is shown: a cheap unlocked read first, and a locked
 * finalization only when the deadline has passed.
 */
export async function loadWithExpiry(id: string, now = clock.now()): Promise<AttemptRow | null> {
  const row = await findAttempt(prisma, id);
  if (!row || !isExpired(row, now)) return row;
  return prisma.$transaction(async (tx) => {
    const locked = await lockAttempt(tx, id);
    return locked ? expireIfDue(tx, locked, now) : null;
  });
}

/**
 * Ends every running attempt of an assessment that is being closed (quiz closure). Each attempt's
 * deadline is moved to now (never before its start) and it is finalized as EXPIRED with the
 * answers saved so far.
 */
export async function finalizeAllInProgress(
  tx: DbClient,
  where: { quizId: string } | { examinationId: string } | { academyQuizId: string },
  now: Date,
  actorId: string,
): Promise<number> {
  const column = Prisma.raw(
    'quizId' in where
      ? '"quiz_id"'
      : 'examinationId' in where
        ? '"examination_id"'
        : '"academy_quiz_id"',
  );
  const ownerId = Object.values(where)[0] as string;
  // Lock every running attempt of the assessment at once, in a stable order (no deadlocks with
  // per-attempt requests, which lock one row each).
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "assessment_attempts"
     WHERE ${column} = ${ownerId}::uuid AND "status" = 'IN_PROGRESS'
     ORDER BY "id"
     FOR UPDATE`;
  const ids = locked.map((row) => row.id);
  for (let start = 0; start < ids.length; start += CLOSE_CHUNK) {
    const chunk = ids.slice(start, start + CLOSE_CHUNK);
    // Deadline moves to now (never before the start), and a per-question deadline never past it
    // (both CHECK constraints require that).
    await tx.$executeRaw`
      UPDATE "assessment_attempts" AS a
         SET "deadline_at" = c.cutoff,
             "current_question_deadline_at" = CASE
               WHEN a."current_question_deadline_at" > c.cutoff THEN c.cutoff
               ELSE a."current_question_deadline_at" END,
             "updated_at" = CURRENT_TIMESTAMP
        FROM (SELECT "id", GREATEST(${now}::timestamptz, "started_at" + interval '1 millisecond') AS cutoff
                FROM "assessment_attempts"
               WHERE "id" IN (${Prisma.join(chunk.map((id) => Prisma.sql`${id}::uuid`))})) AS c
       WHERE a."id" = c."id" AND (a."deadline_at" IS NULL OR a."deadline_at" > c.cutoff)`;
    const rows = await tx.assessmentAttempt.findMany({
      where: { id: { in: chunk }, status: 'IN_PROGRESS' },
      select: attemptSelect,
    });
    await finalizeRowsLocked(tx, rows, 'EXPIRED', now, actorId);
  }
  return ids.length;
}

/** Attempts finalized per statement batch when an assessment is closed. */
const CLOSE_CHUNK = 200;

const expiredWhere = (now: Date, extra: Prisma.Sql) => Prisma.sql`
  "status" = 'IN_PROGRESS' AND "deadline_at" IS NOT NULL AND "deadline_at" <= ${now}::timestamptz
  ${extra}`;

/**
 * One transaction: locks up to `batchSize` expired attempts (SKIP LOCKED, so parallel requests
 * and instances never wait on each other or take the same row), loads them in one query and
 * finalizes them set-based. Returns how many rows it locked.
 */
async function sweepBatch(now: Date, extra: Prisma.Sql, batchSize: number): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "assessment_attempts"
       WHERE ${expiredWhere(now, extra)}
       ORDER BY "deadline_at", "id"
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return 0;
    const rows = await tx.assessmentAttempt.findMany({
      where: { id: { in: locked.map((row) => row.id) } },
      select: attemptSelect,
    });
    // Re-checked under the lock: a row finalized meanwhile is no longer IN_PROGRESS.
    await finalizeRowsLocked(
      tx,
      rows.filter((row) => isExpired(row, now)),
      'EXPIRED',
      now,
      null,
    );
    return locked.length;
  });
}

/**
 * Background/maintenance sweep: finalizes attempts whose deadline has passed and nobody touched
 * them since. `SKIP LOCKED` lets several API instances (or a request) work in parallel without
 * waiting on each other; finalization itself is idempotent. Restart-safe: deadlines live in the
 * database, nothing is kept in memory. Runs until nothing is left (course quizzes, exams and the
 * long-running server's worker); request paths with a time limit use `finalizeExpiredBounded`.
 */
export async function sweepExpiredAttempts(
  options: { now?: Date; batchSize?: number; where?: Prisma.Sql } = {},
): Promise<number> {
  const now = options.now ?? clock.now();
  const batchSize = options.batchSize ?? 25;
  const extra = options.where ?? Prisma.empty;
  let total = 0;
  for (;;) {
    const processed = await sweepBatch(now, extra, batchSize);
    total += processed;
    if (processed < batchSize) break;
  }
  if (total > 0) logger.info({ finalized: total }, 'Expired assessment attempts finalized');
  return total;
}

export interface BoundedSweepResult {
  /** Attempts locked and finalized by this call. */
  finalized: number;
  /** Expired attempts still IN_PROGRESS afterwards (including ones another request holds). */
  remaining: number;
}

/**
 * The same sweep with a bound, for request paths under a function time limit: at most
 * `maxAttempts` attempts, and no new batch after `budgetMs` (wall time). Every batch commits on
 * its own, so a retry continues where this one stopped and never re-finalizes anything.
 * `remaining > 0` means callers must not show rankings or release results yet.
 */
export async function finalizeExpiredBounded(options: {
  where: Prisma.Sql;
  now?: Date;
  batchSize?: number;
  maxAttempts?: number;
  budgetMs?: number;
}): Promise<BoundedSweepResult> {
  const now = options.now ?? clock.now();
  const batchSize = options.batchSize ?? ACADEMY_FINALIZE_LIMITS.batchSize;
  const maxAttempts = options.maxAttempts ?? ACADEMY_FINALIZE_LIMITS.maxPerRequest;
  const budgetMs = options.budgetMs ?? ACADEMY_FINALIZE_LIMITS.budgetMs;
  const started = performance.now();
  let finalized = 0;
  while (finalized < maxAttempts && performance.now() - started < budgetMs) {
    const size = Math.min(batchSize, maxAttempts - finalized);
    const processed = await sweepBatch(now, options.where, size);
    finalized += processed;
    if (processed < size) break;
  }
  const counted = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS "count" FROM "assessment_attempts" WHERE ${expiredWhere(now, options.where)}`;
  const count = counted[0]?.count ?? 0;
  if (finalized > 0 || count > 0) {
    logger.info(
      { finalized, remaining: count, ms: Math.round(performance.now() - started) },
      'Expired assessment attempts finalized (bounded)',
    );
  }
  return { finalized, remaining: count };
}

/** Re-scores a finalized attempt after manual grading (still idempotent). */
export async function reevaluateLocked(tx: DbClient, row: AttemptRow, now: Date) {
  const scored = await writeEvaluation(tx, row, now);
  await tx.assessmentAttempt.update({ where: { id: row.id }, data: scored });
  return (await findAttempt(tx, row.id))!;
}

// --- Visibility -----------------------------------------------------------------------------

export function resultStateOf(row: AttemptSummaryRow): AttemptResultState {
  if (row.status === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (row.evaluationStatus !== 'EVALUATED') return 'PENDING_EVALUATION';
  return assessmentOf(row).resultsReleased ? 'RELEASED' : 'AWAITING_RELEASE';
}

/** Correct answers/explanations: only after the result itself is visible, per `answerReveal`. */
export function answersRevealed(row: AttemptSummaryRow, now: Date): boolean {
  if (resultStateOf(row) !== 'RELEASED') return false;
  const assessment = assessmentOf(row);
  if (assessment.answerReveal === 'AFTER_SUBMISSION') return true;
  if (assessment.answerReveal === 'AFTER_CLOSE') return assessment.closed(now);
  return false;
}

// --- Serialisers ----------------------------------------------------------------------------

export const num = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : fromCents(toCents(value));

export function scoreOf(
  row: Pick<
    AttemptSummaryRow,
    'evaluationStatus' | 'rawScore' | 'penalty' | 'score' | 'maxScore' | 'percent' | 'passed'
  >,
): AttemptScoreDto | null {
  if (row.evaluationStatus !== 'EVALUATED' || row.score === null) return null;
  return {
    rawScore: num(row.rawScore) ?? 0,
    penalty: num(row.penalty) ?? 0,
    score: num(row.score) ?? 0,
    maxScore: num(row.maxScore) ?? 0,
    percent: num(row.percent) ?? 0,
    passed: row.passed ?? false,
  };
}

export function toAttemptQuestion(question: AttemptRow['questions'][number]): AttemptQuestionDto {
  const snapshot = readSnapshot(question.snapshot);
  return {
    id: question.id,
    position: question.position,
    type: question.type,
    prompt: snapshot.prompt,
    marks: num(question.marks) ?? 0,
    negativeMarks: num(question.negativeMarks) ?? 0,
    // The answer key never leaves the server here.
    options: snapshot.options.map((option) => ({
      id: option.id,
      text: option.text,
      image: optionImageDto(option),
    })),
    images: snapshot.images.map(toMediaDto),
    selectedOptionIds: question.selectedOptionIds,
    textAnswer: question.textAnswer,
    answerSequence: question.answerSequence,
  };
}

export function toReviewQuestions(row: AttemptRow): ReviewQuestionDto[] {
  return row.questions.map((question) => {
    const snapshot = readSnapshot(question.snapshot);
    const selected = new Set(question.selectedOptionIds);
    return {
      id: question.id,
      position: question.position,
      type: question.type,
      prompt: snapshot.prompt,
      explanation: snapshot.explanation,
      marks: num(question.marks) ?? 0,
      negativeMarks: num(question.negativeMarks) ?? 0,
      options: snapshot.options.map((option) => ({
        id: option.id,
        text: option.text,
        isCorrect: option.isCorrect,
        selected: selected.has(option.id),
        image: optionImageDto(option),
      })),
      images: snapshot.images.map(toMediaDto),
      textAnswer: question.textAnswer,
      answered: isAnswered(question),
      awardedMarks: num(question.awardedMarks),
      penalty: num(question.penalty),
      isCorrect: question.isCorrect,
      feedback: question.feedback,
      gradedAt: question.gradedAt?.toISOString() ?? null,
    };
  });
}

export function toStudentSummary(row: AttemptSummaryRow): StudentAttemptSummary {
  const resultState = resultStateOf(row);
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

export function toStudentAttempt(row: AttemptRow, now: Date): StudentAttemptDto {
  const assessment = assessmentOf(row);
  const summary = toStudentSummary(row);
  const revealed = answersRevealed(row, now);
  return {
    id: row.id,
    kind: assessment.kind,
    assessment: {
      id: assessment.id,
      title: assessment.title,
      lessonId: assessment.lessonId,
      course: assessment.course,
    },
    attemptNumber: row.attemptNumber,
    status: row.status,
    startedAt: summary.startedAt,
    deadlineAt: summary.deadlineAt,
    submittedAt: summary.submittedAt,
    serverNow: now.toISOString(),
    negativeMarking: assessment.negativeMarking,
    maxScore: num(row.maxScore) ?? 0,
    questions: row.questions.map(toAttemptQuestion),
    resultState: summary.resultState,
    result: summary.result,
    review: revealed ? toReviewQuestions(row) : null,
  };
}

export function toFacultyItem(row: AttemptSummaryRow): FacultyAttemptItem {
  const assessment = assessmentOf(row);
  return {
    id: row.id,
    kind: assessment.kind,
    assessment: { id: assessment.id, title: assessment.title, lessonId: assessment.lessonId },
    course: assessment.course,
    student: { userId: row.userId, fullName: row.student.fullName },
    attemptNumber: row.attemptNumber,
    status: row.status,
    evaluationStatus: row.evaluationStatus,
    startedAt: row.startedAt.toISOString(),
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    maxScore: num(row.maxScore) ?? 0,
    result: scoreOf(row),
  };
}

export function toFacultyDetail(row: AttemptRow): FacultyAttemptDetail {
  const graders = new Set(
    row.questions.flatMap((question) => (question.gradedBy ? [question.gradedBy.fullName] : [])),
  );
  return {
    ...toFacultyItem(row),
    // Running attempts show what was saved so far, but never a key-annotated live view.
    questions: row.status === 'IN_PROGRESS' ? [] : toReviewQuestions(row),
    gradedBy: [...graders],
  };
}

// --- Counting -------------------------------------------------------------------------------

export async function attemptCounts(
  where:
    | { quizId: { in: string[] } }
    | { examinationId: { in: string[] } }
    | { academyQuizId: { in: string[] } },
) {
  const key =
    'quizId' in where ? 'quizId' : 'examinationId' in where ? 'examinationId' : 'academyQuizId';
  const ids =
    'quizId' in where
      ? where.quizId.in
      : 'examinationId' in where
        ? where.examinationId.in
        : where.academyQuizId.in;
  const counts = new Map<
    string,
    { total: number; inProgress: number; pendingEvaluation: number; evaluated: number }
  >();
  if (ids.length === 0) return counts;
  const rows = await prisma.assessmentAttempt.groupBy({
    by: [key, 'status', 'evaluationStatus'],
    where,
    _count: { _all: true },
  });
  for (const row of rows) {
    const id = (row as Record<string, unknown>)[key] as string;
    const entry = counts.get(id) ?? { total: 0, inProgress: 0, pendingEvaluation: 0, evaluated: 0 };
    entry.total += row._count._all;
    if (row.status === 'IN_PROGRESS') entry.inProgress += row._count._all;
    else if (row.evaluationStatus === 'PENDING') entry.pendingEvaluation += row._count._all;
    else entry.evaluated += row._count._all;
    counts.set(id, entry);
  }
  return counts;
}

export const emptyCounts = () => ({ total: 0, inProgress: 0, pendingEvaluation: 0, evaluated: 0 });

/** Turns a Prisma unique violation on attempt numbers into the documented 409. */
export function rethrowAttemptRace(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new AppError(
      'CONFLICT',
      'Another attempt was started at the same time. Reload and try again.',
    );
  }
  throw error;
}
