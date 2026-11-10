import type {
  AcademyPrizeDto,
  AcademyQuizSettingsDto,
  AdminAcademyQuizDetail,
  AdminAcademyQuizItem,
  Paginated,
  QuestionDto,
} from '@asra/types';
import {
  ACADEMY_POST_PUBLISH_FIELDS,
  ACADEMY_QUIZ_DEFAULTS,
  academyQuizSettingsSchema,
  type AcademyQuizCreateInput,
  type AcademyQuizListQuery,
  type AcademyQuizPatchInput,
  type AcademyQuizSettingsInput,
  type AcademyQuizTransition,
  type PrizeInput,
  type QuestionInput,
  type QuestionOrderInput,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { resolveUniqueSlug } from '../../utils/slug.js';
import { adminAudit } from '../admin/audit.js';
import { attemptCounts, emptyCounts, finalizeAllInProgress } from '../assessments/attempts.core.js';
import {
  assertAttachable,
  loadMediaRefs,
  mediaRefSelect,
  toMediaDto,
  type MediaRef,
} from '../assessments/media/media.service.js';
import {
  listQuestions,
  lockOwner,
  mediaUsedBy,
  questionAuthoring,
  questionTotals,
  releaseMediaSafely,
  type OwnerContext,
} from '../assessments/questions.service.js';
import { toCents } from '../assessments/scoring.js';
import { finalizeQuizBacklog } from './results.service.js';
import { phaseOf, planSelection, poolOf, publishProblems } from './selection.js';

/**
 * Academy Quiz administration (docs/ASSESSMENTS.md §Academy). Route-level permission:
 * `academy_quizzes.manage`. Rules:
 *   - DRAFT: every setting and the questions may change.
 *   - PUBLISHED/CLOSED: scoring, timing, selection, eligibility, slug and ranking are FROZEN (every
 *     attempt must be judged by the rules it started under); content, prizes and results display
 *     may change, and the end time may be extended (never shortened) before it passes.
 *   - unpublish only before any attempt; close finalizes running attempts (the one shared
 *     finalization path); reopen only before the end time.
 * Server time decides everything; no background job is involved anywhere.
 */

const notFound = (): never => {
  throw new AppError('NOT_FOUND', 'Academy quiz not found');
};

const quizInclude = { bannerMedia: { select: mediaRefSelect } } satisfies Prisma.AcademyQuizInclude;
type QuizRow = Prisma.AcademyQuizGetPayload<{ include: typeof quizInclude }>;

const asRef = (row: {
  id: string;
  publicId: string;
  format: string;
  width: number;
  height: number;
}) => ({ ...row, format: row.format as MediaRef['format'] }) satisfies MediaRef;

/** Stored prizes (JSON) — written only by this service, read defensively. */
function readPrizes(value: Prisma.JsonValue): PrizeInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const prize = raw as Partial<PrizeInput> | null;
    if (!prize || typeof prize.position !== 'number' || typeof prize.title !== 'string') return [];
    return [
      {
        position: prize.position,
        title: prize.title,
        description: typeof prize.description === 'string' ? prize.description : null,
        imageMediaId: typeof prize.imageMediaId === 'string' ? prize.imageMediaId : null,
      },
    ];
  });
}

/** The quiz's settings in request shape (ISO dates), so a PATCH can be merged and re-validated. */
function settingsOf(row: QuizRow): AcademyQuizSettingsInput {
  return {
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    description: row.description,
    instructions: row.instructions,
    bannerMediaId: row.bannerMediaId,
    prizes: readPrizes(row.prizes),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    resultsAt: row.resultsAt?.toISOString() ?? null,
    timeZone: row.timeZone,
    timerMode: row.timerMode,
    durationMinutes: row.durationMinutes,
    questionTimeSeconds: row.questionTimeSeconds,
    navigation: row.navigation,
    requireAnswerToAdvance: row.requireAnswerToAdvance,
    selection: row.selection,
    questionsPerAttempt: row.questionsPerAttempt,
    easyCount: row.easyCount,
    mediumCount: row.mediumCount,
    hardCount: row.hardCount,
    shuffleQuestions: row.shuffleQuestions,
    shuffleOptions: row.shuffleOptions,
    negativeMarking: row.negativeMarking,
    passPercent: row.passPercent,
    maxAttempts: row.maxAttempts,
    eligibleClassIds: row.eligibleClassIds,
    eligibleStreamIds: row.eligibleStreamIds,
    resultRelease: row.resultRelease,
    answerReveal: row.answerReveal,
    leaderboardVisibility: row.leaderboardVisibility,
    maskNames: row.maskNames,
    attemptCounting: row.attemptCounting,
    tieBreak: row.tieBreak,
  };
}

/** Columns written from validated settings (the slug is resolved separately). */
function dataOf(settings: AcademyQuizSettingsInput) {
  const { slug: _slug, prizes, startsAt, endsAt, resultsAt, ...rest } = settings;
  return {
    ...rest,
    prizes: prizes as unknown as Prisma.InputJsonArray,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    resultsAt: resultsAt ? new Date(resultsAt) : null,
  };
}

const DATE_KEYS = new Set(['startsAt', 'endsAt', 'resultsAt']);

/** Whether a PATCH value equals the stored one (instants compared as instants, not as text). */
function sameValue(key: string, next: unknown, current: unknown): boolean {
  if (next === undefined) return true; // e.g. an empty slug: "keep it"
  if (DATE_KEYS.has(key) && typeof next === 'string' && typeof current === 'string') {
    return Date.parse(next) === Date.parse(current);
  }
  return JSON.stringify(next) === JSON.stringify(current);
}

const mediaIdsOf = (settings: Pick<AcademyQuizSettingsInput, 'bannerMediaId' | 'prizes'>) => [
  ...(settings.bannerMediaId ? [settings.bannerMediaId] : []),
  ...settings.prizes.flatMap((prize) => (prize.imageMediaId ? [prize.imageMediaId] : [])),
];

/** Class/stream restrictions must name existing rows (ids are an array, so no FK checks them). */
async function assertEligibilityIds(db: DbClient, settings: AcademyQuizSettingsInput) {
  const [classes, streams] = await Promise.all([
    settings.eligibleClassIds.length
      ? db.class.count({ where: { id: { in: settings.eligibleClassIds } } })
      : 0,
    settings.eligibleStreamIds.length
      ? db.stream.count({ where: { id: { in: settings.eligibleStreamIds } } })
      : 0,
  ]);
  if (classes !== settings.eligibleClassIds.length) {
    throw fieldError('VALIDATION_ERROR', 'eligibleClassIds', 'One of the classes no longer exists');
  }
  if (streams !== settings.eligibleStreamIds.length) {
    throw fieldError(
      'VALIDATION_ERROR',
      'eligibleStreamIds',
      'One of the streams no longer exists',
    );
  }
}

async function lockQuiz(tx: DbClient, id: string): Promise<QuizRow> {
  await lockOwner(tx, { academyQuizId: id });
  return (await tx.academyQuiz.findUnique({ where: { id }, include: quizInclude })) ?? notFound();
}

const audit = (
  db: DbClient,
  action:
    | 'academy_quiz.created'
    | 'academy_quiz.updated'
    | 'academy_quiz.deleted'
    | 'academy_quiz.published'
    | 'academy_quiz.unpublished'
    | 'academy_quiz.closed'
    | 'academy_quiz.reopened'
    | 'academy_quiz.results_published'
    | 'academy_quiz.questions_copied',
  actorId: string,
  entityId: string,
  data?: Prisma.InputJsonObject,
) => adminAudit(db, { action, actorId, entityType: 'academy_quiz', entityId, data });

export { audit as academyAudit };

function toSettingsDto(row: QuizRow): AcademyQuizSettingsDto {
  const { prizes: _prizes, bannerMediaId: _banner, ...settings } = settingsOf(row);
  return { ...settings, slug: row.slug };
}

function toItem(
  row: QuizRow,
  totals: Map<string, { count: number; marks: number }>,
  counts: Awaited<ReturnType<typeof attemptCounts>>,
  now: Date,
): AdminAcademyQuizItem {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    phase: phaseOf(row, now),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    questionCount: totals.get(row.id)?.count ?? 0,
    attempts: counts.get(row.id) ?? emptyCounts(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const poolQuestions = (questions: QuestionDto[]) =>
  questions.map((question) => ({
    difficulty: question.difficulty,
    marksCents: toCents(question.marks),
  }));

/** Owner context for the shared question authoring (re-read inside its transaction). */
const ownerResolver =
  (id: string) =>
  async (tx: DbClient): Promise<OwnerContext> => {
    const row =
      (await tx.academyQuiz.findUnique({
        where: { id },
        select: { id: true, status: true },
      })) ?? notFound();
    return {
      owner: { academyQuizId: row.id },
      courseId: null,
      status: row.status,
      kind: 'ACADEMY',
    };
  };

export const academyQuizAdminService = {
  async list(query: AcademyQuizListQuery): Promise<Paginated<AdminAcademyQuizItem>> {
    const where: Prisma.AcademyQuizWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.academyQuiz.findMany({
        where,
        include: quizInclude,
        orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      prisma.academyQuiz.count({ where }),
    ]);
    const ids = rows.map((row) => row.id);
    const [totals, counts] = await Promise.all([
      ids.length ? questionTotals({ academyQuizId: { in: ids } }, 'academyQuizId') : new Map(),
      attemptCounts({ academyQuizId: { in: ids } }),
    ]);
    const now = clock.now();
    return paginated(
      rows.map((row) => toItem(row, totals, counts, now)),
      total,
      query,
    );
  },

  async detail(id: string): Promise<AdminAcademyQuizDetail> {
    const row =
      (await prisma.academyQuiz.findUnique({ where: { id }, include: quizInclude })) ?? notFound();
    const settings = settingsOf(row);
    const [questions, counts, prizeMedia, classes, streams] = await Promise.all([
      listQuestions({ academyQuizId: id }),
      attemptCounts({ academyQuizId: { in: [id] } }),
      loadMediaRefs(
        prisma,
        settings.prizes.flatMap((prize) => (prize.imageMediaId ? [prize.imageMediaId] : [])),
      ),
      prisma.class.findMany({
        where: { id: { in: row.eligibleClassIds } },
        select: { id: true, name: true },
        orderBy: { sortOrder: 'asc' },
      }),
      prisma.stream.findMany({
        where: { id: { in: row.eligibleStreamIds } },
        select: { id: true, name: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    const now = clock.now();
    const pool = poolQuestions(questions);
    const plan = planSelection(settings, pool);
    const prizes: AcademyPrizeDto[] = [...settings.prizes]
      .sort((a, b) => a.position - b.position)
      .map((prize) => {
        const image = prize.imageMediaId ? prizeMedia.get(prize.imageMediaId) : undefined;
        return {
          position: prize.position,
          title: prize.title,
          description: prize.description,
          image: image ? toMediaDto(image) : null,
        };
      });
    return {
      ...toItem(row, new Map([[id, { count: questions.length, marks: 0 }]]), counts, now),
      settings: toSettingsDto(row),
      banner: row.bannerMedia ? toMediaDto(asRef(row.bannerMedia)) : null,
      prizes,
      eligibleClasses: classes,
      eligibleStreams: streams,
      questions,
      pool: poolOf(pool),
      questionsPerAttempt: plan.perAttempt,
      totalMarksPerAttempt: plan.totalMarksCents === null ? null : plan.totalMarksCents / 100,
      publishProblems: row.status === 'DRAFT' ? publishProblems(row, pool, now) : [],
      resultsPublishedAt: row.resultsPublishedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      serverNow: now.toISOString(),
    };
  },

  async create(auth: AuthContext, input: AcademyQuizCreateInput): Promise<AdminAcademyQuizDetail> {
    const settings = academyQuizSettingsSchema.parse({ ...ACADEMY_QUIZ_DEFAULTS, ...input });
    const id = await prisma.$transaction(async (tx) => {
      await assertEligibilityIds(tx, settings);
      await assertAttachable(tx, auth, mediaIdsOf(settings));
      const slug = await resolveUniqueSlug({
        requested: settings.slug,
        source: settings.title,
        fallback: 'academy-quiz',
        maxLength: 120,
        isTaken: async (candidate) =>
          (await tx.academyQuiz.count({ where: { slug: candidate } })) > 0,
      });
      const created = await tx.academyQuiz.create({
        data: { ...dataOf(settings), slug, createdById: auth.userId },
        select: { id: true },
      });
      await audit(tx, 'academy_quiz.created', auth.userId, created.id, { slug });
      return created.id;
    });
    return academyQuizAdminService.detail(id);
  },

  async update(
    auth: AuthContext,
    id: string,
    patch: AcademyQuizPatchInput,
  ): Promise<AdminAcademyQuizDetail> {
    const removed = await prisma.$transaction(async (tx) => {
      const row = await lockQuiz(tx, id);
      const current = settingsOf(row);
      const now = clock.now();
      const changed = (Object.keys(patch) as (keyof AcademyQuizPatchInput)[]).filter(
        (key) => !sameValue(key, patch[key], current[key]),
      );
      if (row.status !== 'DRAFT') {
        const allowed = new Set<string>(ACADEMY_POST_PUBLISH_FIELDS);
        const frozen = changed.filter((key) => !allowed.has(key));
        if (frozen.length > 0) {
          throw new AppError(
            'CONFLICT',
            'These settings cannot change after publication, because attempts must be judged by the rules they started under. Unpublish the quiz first (possible only before anyone has attempted it).',
            frozen.map((key) => ({ path: [key], message: 'Locked after publication' })),
          );
        }
        if (changed.includes('endsAt')) {
          const next = new Date(patch.endsAt!);
          if (row.status !== 'PUBLISHED' || now >= row.endsAt || next <= row.endsAt) {
            throw fieldError(
              'CONFLICT',
              'endsAt',
              'A published quiz can only be extended (a later end), and only before it ends.',
            );
          }
        }
      }
      const merged = academyQuizSettingsSchema.parse({ ...current, ...patch });
      if (changed.includes('eligibleClassIds') || changed.includes('eligibleStreamIds')) {
        await assertEligibilityIds(tx, merged);
      }
      const previous = new Set(mediaIdsOf(current));
      const next = mediaIdsOf(merged);
      await assertAttachable(tx, auth, next, previous);
      let slug = row.slug;
      if (changed.includes('slug') && merged.slug && merged.slug !== row.slug) {
        slug = await resolveUniqueSlug({
          requested: merged.slug,
          source: merged.title,
          fallback: 'academy-quiz',
          maxLength: 120,
          isTaken: async (candidate) =>
            (await tx.academyQuiz.count({ where: { slug: candidate, NOT: { id } } })) > 0,
        });
      }
      await tx.academyQuiz.update({ where: { id }, data: { ...dataOf(merged), slug } });
      if (changed.length > 0) {
        await audit(tx, 'academy_quiz.updated', auth.userId, id, { fields: changed });
      }
      const kept = new Set(next);
      return [...previous].filter((mediaId) => !kept.has(mediaId));
    });
    await releaseMediaSafely(removed);
    return academyQuizAdminService.detail(id);
  },

  /** Deletes a DRAFT that nobody attempted, with its questions; releases unused images. */
  async remove(auth: AuthContext, id: string): Promise<void> {
    const media = await prisma.$transaction(async (tx) => {
      const row = await lockQuiz(tx, id);
      if (row.status !== 'DRAFT') {
        throw new AppError(
          'CONFLICT',
          'Only a draft academy quiz can be deleted. Close it instead.',
        );
      }
      if ((await tx.assessmentAttempt.count({ where: { academyQuizId: id } })) > 0) {
        throw new AppError('CONFLICT', 'This quiz has attempts, so it cannot be deleted.');
      }
      const ids = [
        ...(await mediaUsedBy(tx, { academyQuizId: id })),
        ...mediaIdsOf(settingsOf(row)),
      ];
      await tx.academyQuiz.delete({ where: { id } });
      await audit(tx, 'academy_quiz.deleted', auth.userId, id, {
        slug: row.slug,
        title: row.title,
      });
      return ids;
    });
    await releaseMediaSafely(media);
  },

  async transition(
    auth: AuthContext,
    id: string,
    action: AcademyQuizTransition,
  ): Promise<AdminAcademyQuizDetail> {
    await prisma.$transaction(async (tx) => {
      const row = await lockQuiz(tx, id);
      const now = clock.now();
      const refuse = (message: string): never => {
        throw new AppError('CONFLICT', message);
      };
      switch (action) {
        case 'publish': {
          if (row.status !== 'DRAFT') {
            refuse(`Only a draft quiz can be published (it is ${row.status.toLowerCase()}).`);
          }
          const questions = await listQuestions({ academyQuizId: id }, tx);
          const problems = publishProblems(row, poolQuestions(questions), now);
          if (problems.length > 0) {
            throw new AppError(
              'VALIDATION_ERROR',
              'This quiz cannot be published yet.',
              problems.map((message) => ({ path: ['publish'], message })),
            );
          }
          await tx.academyQuiz.update({
            where: { id },
            data: { status: 'PUBLISHED', publishedAt: now, closedAt: null },
          });
          break;
        }
        case 'unpublish': {
          if (row.status !== 'PUBLISHED') refuse('Only a published quiz can go back to draft.');
          if ((await tx.assessmentAttempt.count({ where: { academyQuizId: id } })) > 0) {
            refuse(
              'Students have already attempted this quiz, so it cannot go back to draft. Close it instead.',
            );
          }
          await tx.academyQuiz.update({
            where: { id },
            data: { status: 'DRAFT', publishedAt: null },
          });
          break;
        }
        case 'close': {
          if (row.status !== 'PUBLISHED') refuse('Only a published quiz can be closed.');
          // Running attempts end now with the answers saved so far (one finalization path).
          await finalizeAllInProgress(tx, { academyQuizId: id }, now, auth.userId);
          await tx.academyQuiz.update({
            where: { id },
            data: { status: 'CLOSED', closedAt: now },
          });
          break;
        }
        case 'reopen': {
          if (row.status !== 'CLOSED') refuse('Only a closed quiz can be reopened.');
          if (now >= row.endsAt) {
            refuse('The end time has passed, so the quiz cannot be reopened.');
          }
          await tx.academyQuiz.update({
            where: { id },
            data: { status: 'PUBLISHED', closedAt: null },
          });
          break;
        }
      }
      const actions = {
        publish: 'academy_quiz.published',
        unpublish: 'academy_quiz.unpublished',
        close: 'academy_quiz.closed',
        reopen: 'academy_quiz.reopened',
      } as const;
      await audit(tx, actions[action], auth.userId, id);
    });
    return academyQuizAdminService.detail(id);
  },

  /**
   * Manual result release (resultRelease = MANUAL), once the quiz has ended or been closed.
   * Expired attempts are finalized first (bounded per request), so nothing is released
   * half-evaluated: while any remain, nothing is published and the admin retries. Idempotent.
   */
  async publishResults(
    auth: AuthContext,
    id: string,
  ): Promise<{ published: boolean; quiz: AdminAcademyQuizDetail }> {
    const pending = await finalizeQuizBacklog(id);
    const alreadyPublished =
      pending > 0 &&
      (await prisma.academyQuiz.findUnique({ where: { id }, select: { resultsPublishedAt: true } }))
        ?.resultsPublishedAt;
    if (pending > 0 && !alreadyPublished) {
      throw new AppError(
        'CONFLICT',
        `${pending} expired attempt${pending === 1 ? ' is' : 's are'} still being finalized, so nothing was published yet. Please try again in a moment.`,
        { finalizing: true, pendingAttempts: pending },
      );
    }
    const published = await prisma.$transaction(async (tx) => {
      const row = await lockQuiz(tx, id);
      if (row.resultsPublishedAt) return false;
      if (row.status === 'DRAFT') {
        throw new AppError('CONFLICT', 'A draft quiz has no results to publish.');
      }
      if (row.resultRelease !== 'MANUAL') {
        throw new AppError(
          'CONFLICT',
          row.resultRelease === 'IMMEDIATE'
            ? 'Results of this quiz are shown immediately after each attempt.'
            : 'Results of this quiz are published automatically at the scheduled time.',
        );
      }
      const now = clock.now();
      if (row.status === 'PUBLISHED' && now < row.endsAt) {
        throw new AppError('CONFLICT', 'Results can be published once the quiz has ended.');
      }
      await tx.academyQuiz.update({ where: { id }, data: { resultsPublishedAt: now } });
      await audit(tx, 'academy_quiz.results_published', auth.userId, id);
      return true;
    });
    return { published, quiz: await academyQuizAdminService.detail(id) };
  },

  // --- Questions (shared authoring + media; academy owner) ----------------------------------

  addQuestion(auth: AuthContext, id: string, input: QuestionInput): Promise<QuestionDto> {
    return questionAuthoring.add(auth, ownerResolver(id), input);
  },
  reorderQuestions(id: string, input: QuestionOrderInput): Promise<QuestionDto[]> {
    return questionAuthoring.reorder(ownerResolver(id), input);
  },
  updateQuestion(auth: AuthContext, questionId: string, input: QuestionInput) {
    return questionAuthoring.update(auth, questionId, input, 'ACADEMY');
  },
  removeQuestion(auth: AuthContext, questionId: string) {
    return questionAuthoring.remove(auth, questionId, 'ACADEMY');
  },
};

export { readPrizes, lockQuiz };
