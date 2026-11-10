import { PERMISSIONS, type QuestionDto } from '@asra/types';
import { QUESTION_LIMITS, type QuestionInput, type QuestionOrderInput } from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import { Prisma } from '../../generated/prisma/client.js';
import { accessPolicy } from '../../services/access-policy.service.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { logger } from '../../lib/logger.js';
import type { MediaFormat } from '@asra/validation';
import {
  imagesOf,
  questionImageRefs,
  sourceQuestionSelect,
  type SourceQuestion,
} from './attempts.core.js';
import {
  assertAttachable,
  releaseMedia,
  toMediaDto,
  type MediaRef,
} from './media/media.service.js';
import { fromCents, toCents } from './scoring.js';

/**
 * Question authoring shared by quizzes and examinations (docs/ASSESSMENTS.md §3). Questions can be
 * added, edited, removed and reordered only while their assessment is DRAFT: once students can
 * attempt it, the question set is frozen (and every attempt has its own snapshot anyway).
 */

export type QuestionOwner =
  { quizId: string } | { examinationId: string } | { academyQuizId: string };

export interface OwnerContext {
  owner: QuestionOwner;
  /** The course of a course quiz/exam; null for academy quizzes (no course). */
  courseId: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
  kind: 'QUIZ' | 'EXAM' | 'ACADEMY';
}

/**
 * Which owner kinds a caller may reach through a question id: the faculty portal only course
 * quizzes/exams (assigned course), administration only academy quizzes. A question of the other
 * kind is a 404 — the two access rules can never mix.
 */
export type QuestionScope = 'COURSE' | 'ACADEMY';

const KIND_NOUN = { QUIZ: 'quiz', EXAM: 'exam', ACADEMY: 'academy quiz' } as const;

export function toQuestionDto(row: SourceQuestion, media: Map<string, MediaRef>): QuestionDto {
  return {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    explanation: row.explanation,
    marks: fromCents(toCents(row.marks)),
    negativeMarks: fromCents(toCents(row.negativeMarks)),
    position: row.position,
    options: row.options.map((option) => ({
      id: option.id,
      text: option.text,
      isCorrect: option.isCorrect,
      position: option.position,
      image: option.image
        ? toMediaDto({ ...option.image, format: option.image.format as MediaFormat })
        : null,
    })),
    images: imagesOf(row, media).map(toMediaDto),
    difficulty: row.difficulty,
  };
}

export async function listQuestions(owner: QuestionOwner, db: DbClient = prisma) {
  const rows = await db.assessmentQuestion.findMany({
    where: owner,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: sourceQuestionSelect,
  });
  const media = await questionImageRefs(db, rows);
  return rows.map((row) => toQuestionDto(row, media));
}

/** Every image a set of questions uses (question images + option images). */
export async function mediaUsedBy(
  db: DbClient,
  where: Prisma.AssessmentQuestionWhereInput,
): Promise<string[]> {
  const rows = await db.assessmentQuestion.findMany({
    where,
    select: { imageIds: true, options: { select: { imageId: true } } },
  });
  return rows.flatMap((row) => [
    ...row.imageIds,
    ...row.options.flatMap((option) => (option.imageId ? [option.imageId] : [])),
  ]);
}

/**
 * After a committed change: deletes those of `ids` nothing references any more (images shared
 * with another question or used by an attempt are kept). A storage failure never fails the
 * request — the image stays DELETING and is retried later.
 */
export async function releaseMediaSafely(ids: Iterable<string>): Promise<void> {
  await releaseMedia(ids).catch((error) =>
    logger.warn({ err: error }, 'Image release deferred to the next cleanup'),
  );
}

const inputMediaIds = (input: QuestionInput) => [
  ...input.imageIds,
  ...input.options.flatMap((option) => (option.imageId ? [option.imageId] : [])),
];

/** Σ marks and count per owner, in one query. */
export async function questionTotals(
  where: Prisma.AssessmentQuestionWhereInput,
  by: 'quizId' | 'examinationId' | 'academyQuizId',
) {
  const rows = await prisma.assessmentQuestion.groupBy({
    by: [by],
    where,
    _count: { _all: true },
    _sum: { marks: true },
  });
  const totals = new Map<string, { count: number; marks: number }>();
  for (const row of rows) {
    const id = (row as Record<string, unknown>)[by] as string | null;
    if (!id) continue;
    totals.set(id, {
      count: row._count._all,
      marks: row._sum.marks ? fromCents(toCents(row._sum.marks)) : 0,
    });
  }
  return totals;
}

export function assertDraft(context: OwnerContext) {
  if (context.status !== 'DRAFT') {
    throw new AppError(
      'CONFLICT',
      `Questions can only be changed while the ${KIND_NOUN[context.kind]} is a draft. Unpublish it first (possible only before anyone has attempted it).`,
    );
  }
}

function assertTypeAllowed(context: OwnerContext, input: QuestionInput) {
  if (context.kind !== 'EXAM' && input.type === 'SHORT_ANSWER') {
    throw fieldError(
      'VALIDATION_ERROR',
      'type',
      'Quizzes are scored automatically, so written answers are only available in examinations.',
    );
  }
}

export async function lockOwner(tx: DbClient, owner: QuestionOwner) {
  if ('quizId' in owner) {
    await tx.$queryRaw`SELECT "id" FROM "quizzes" WHERE "id" = ${owner.quizId}::uuid FOR UPDATE`;
  } else if ('examinationId' in owner) {
    await tx.$queryRaw`SELECT "id" FROM "examinations" WHERE "id" = ${owner.examinationId}::uuid FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT "id" FROM "academy_quizzes" WHERE "id" = ${owner.academyQuizId}::uuid FOR UPDATE`;
  }
}

const optionRows = (input: QuestionInput) =>
  input.options.map((option, position) => ({
    text: option.text,
    isCorrect: option.isCorrect,
    position,
    imageId: option.imageId,
  }));

const contentData = (input: QuestionInput, kind: OwnerContext['kind']) => ({
  type: input.type,
  prompt: input.prompt,
  explanation: input.explanation ?? null,
  marks: new Prisma.Decimal(input.marks.toFixed(2)),
  negativeMarks: new Prisma.Decimal(input.negativeMarks.toFixed(2)),
  imageIds: input.imageIds,
  // Difficulty drives academy selection only; course quizzes/exams never store one.
  difficulty: kind === 'ACADEMY' ? input.difficulty : null,
});

export const questionAuthoring = {
  /**
   * Appends a question. `resolve` re-reads the owner INSIDE the transaction after locking it, so a
   * concurrent publish cannot slip a question into a published assessment. Images must be uploads
   * of the caller (checked and locked by `assertAttachable`).
   */
  async add(
    auth: AuthContext,
    resolve: (tx: DbClient) => Promise<OwnerContext>,
    input: QuestionInput,
  ): Promise<QuestionDto> {
    return prisma.$transaction(async (tx) => {
      const context = await resolve(tx);
      await lockOwner(tx, context.owner);
      const fresh = await resolve(tx);
      assertDraft(fresh);
      assertTypeAllowed(fresh, input);
      const count = await tx.assessmentQuestion.count({ where: fresh.owner });
      if (count >= QUESTION_LIMITS.questionsPerAssessment) {
        throw new AppError(
          'CONFLICT',
          `An assessment can have at most ${QUESTION_LIMITS.questionsPerAssessment} questions.`,
        );
      }
      const media = await assertAttachable(tx, auth, inputMediaIds(input));
      const created = await tx.assessmentQuestion.create({
        data: {
          ...fresh.owner,
          ...contentData(input, fresh.kind),
          position: count,
          options: { create: optionRows(input) },
        },
        select: sourceQuestionSelect,
      });
      return toQuestionDto(created, media);
    });
  },

  /**
   * Replaces a question's content, images and options (DRAFT only). Images the question already
   * had may be kept; new ones must be the caller's uploads. Images this save removed are released
   * after commit (kept if anything else still uses them).
   */
  async update(
    auth: AuthContext,
    questionId: string,
    input: QuestionInput,
    scope: QuestionScope = 'COURSE',
  ): Promise<QuestionDto> {
    const { dto, removed } = await prisma.$transaction(async (tx) => {
      const context = await resolveQuestionOwner(auth, questionId, tx, scope);
      await lockOwner(tx, context.owner);
      assertDraft(await resolveQuestionOwner(auth, questionId, tx, scope));
      assertTypeAllowed(context, input);
      const previous = new Set(await mediaUsedBy(tx, { id: questionId }));
      const next = inputMediaIds(input);
      const media = await assertAttachable(tx, auth, next, previous);
      await tx.assessmentQuestionOption.deleteMany({ where: { questionId } });
      const updated = await tx.assessmentQuestion.update({
        where: { id: questionId },
        data: { ...contentData(input, context.kind), options: { create: optionRows(input) } },
        select: sourceQuestionSelect,
      });
      const kept = new Set(next);
      return {
        dto: toQuestionDto(updated, media),
        removed: [...previous].filter((id) => !kept.has(id)),
      };
    });
    await releaseMediaSafely(removed);
    return dto;
  },

  /** Removes a question and closes the gap in positions (DRAFT only); releases its images. */
  async remove(
    auth: AuthContext,
    questionId: string,
    scope: QuestionScope = 'COURSE',
  ): Promise<void> {
    const removed = await prisma.$transaction(async (tx) => {
      const context = await resolveQuestionOwner(auth, questionId, tx, scope);
      await lockOwner(tx, context.owner);
      assertDraft(await resolveQuestionOwner(auth, questionId, tx, scope));
      const media = await mediaUsedBy(tx, { id: questionId });
      await tx.assessmentQuestion.delete({ where: { id: questionId } });
      const rest = await tx.assessmentQuestion.findMany({
        where: context.owner,
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, position: true },
      });
      await Promise.all(
        rest.map((row, position) =>
          row.position === position
            ? null
            : tx.assessmentQuestion.update({ where: { id: row.id }, data: { position } }),
        ),
      );
      return media;
    });
    await releaseMediaSafely(removed);
  },

  /** Applies a complete new order: the list must contain every question exactly once. */
  async reorder(
    resolve: (tx: DbClient) => Promise<OwnerContext>,
    input: QuestionOrderInput,
  ): Promise<QuestionDto[]> {
    return prisma.$transaction(async (tx) => {
      const context = await resolve(tx);
      await lockOwner(tx, context.owner);
      assertDraft(await resolve(tx));
      const current = await tx.assessmentQuestion.findMany({
        where: context.owner,
        select: { id: true },
      });
      const known = new Set(current.map((row) => row.id));
      if (
        input.questionIds.length !== current.length ||
        input.questionIds.some((id) => !known.has(id))
      ) {
        throw fieldError(
          'VALIDATION_ERROR',
          'questionIds',
          'Send every question of this assessment exactly once',
        );
      }
      await Promise.all(
        input.questionIds.map((id, position) =>
          tx.assessmentQuestion.update({ where: { id }, data: { position } }),
        ),
      );
      return listQuestions(context.owner, tx);
    });
  },
};

/**
 * Resolves a question's owner and checks the caller may author it:
 *   COURSE  — course quiz/exam, caller teaches its course (`content.manage_assigned`)
 *   ACADEMY — academy quiz, caller holds `academy_quizzes.manage`
 * A question outside the requested scope is a 404 (same as an unknown id).
 */
export async function resolveQuestionOwner(
  auth: AuthContext,
  questionId: string,
  db: DbClient = prisma,
  scope: QuestionScope = 'COURSE',
): Promise<OwnerContext> {
  const row = await db.assessmentQuestion.findUnique({
    where: { id: questionId },
    select: {
      quiz: {
        select: {
          id: true,
          status: true,
          lesson: { select: { chapter: { select: { module: { select: { courseId: true } } } } } },
        },
      },
      examination: { select: { id: true, status: true, courseId: true } },
      academyQuiz: { select: { id: true, status: true } },
    },
  });
  const notFound = () => new AppError('NOT_FOUND', 'Question not found');
  if (!row) throw notFound();
  if (scope === 'ACADEMY') {
    if (!row.academyQuiz) throw notFound();
    accessPolicy.assertPermission(auth, PERMISSIONS.ACADEMY_QUIZZES_MANAGE);
    return {
      owner: { academyQuizId: row.academyQuiz.id },
      courseId: null,
      status: row.academyQuiz.status,
      kind: 'ACADEMY',
    };
  }
  if (row.academyQuiz) throw notFound();
  const context: OwnerContext = row.quiz
    ? {
        owner: { quizId: row.quiz.id },
        courseId: row.quiz.lesson.chapter.module.courseId,
        status: row.quiz.status,
        kind: 'QUIZ',
      }
    : {
        owner: { examinationId: row.examination!.id },
        courseId: row.examination!.courseId,
        status: row.examination!.status,
        kind: 'EXAM',
      };
  await accessPolicy.assertTeachesCourse(
    auth,
    context.courseId!,
    PERMISSIONS.CONTENT_MANAGE_ASSIGNED,
    db,
  );
  return context;
}
