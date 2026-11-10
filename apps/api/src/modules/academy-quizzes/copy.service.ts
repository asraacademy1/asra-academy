import {
  PERMISSIONS,
  type CopyQuestionsResultDto,
  type CopySourceItem,
  type Paginated,
  type QuestionDto,
} from '@asra/types';
import {
  QUESTION_LIMITS,
  type CopyQuestionsInput,
  type CopySourceKind,
  type CopySourceListQuery,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { accessPolicy } from '../../services/access-policy.service.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { sourceQuestionSelect } from '../assessments/attempts.core.js';
import { assertAttachable } from '../assessments/media/media.service.js';
import {
  listQuestions,
  mediaUsedBy,
  questionTotals,
  type QuestionOwner,
} from '../assessments/questions.service.js';
import { academyAudit, lockQuiz } from './academy-quizzes.service.js';

/**
 * Copying existing questions into a DRAFT academy quiz. Each copy is a NEW, independent question
 * (editing it never changes the source), with its options and image REFERENCES: no file is
 * duplicated, and because the copy references the same media, the shared cleanup keeps the image
 * until neither question (nor any attempt) uses it. Written-answer questions are skipped (academy
 * quizzes are scored automatically).
 *
 * Reading a course quiz/exam — its answer key included — requires `content.manage` (Admin and
 * Super Admin hold it); academy quizzes need only `academy_quizzes.manage` (route-level).
 */

const sourceNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Source not found');
};

function assertMayRead(auth: AuthContext, kind: CopySourceKind) {
  if (kind !== 'ACADEMY') accessPolicy.assertPermission(auth, PERMISSIONS.CONTENT_MANAGE);
}

const ownerOf = (kind: CopySourceKind, id: string): QuestionOwner =>
  kind === 'QUIZ'
    ? { quizId: id }
    : kind === 'EXAM'
      ? { examinationId: id }
      : { academyQuizId: id };

async function assertSourceExists(db: DbClient, kind: CopySourceKind, id: string) {
  const exists =
    kind === 'QUIZ'
      ? await db.quiz.count({ where: { id } })
      : kind === 'EXAM'
        ? await db.examination.count({ where: { id } })
        : await db.academyQuiz.count({ where: { id } });
  if (!exists) sourceNotFound();
}

export const academyCopyService = {
  async sources(
    auth: AuthContext,
    targetId: string,
    query: CopySourceListQuery,
  ): Promise<Paginated<CopySourceItem>> {
    const kind = query.kind ?? 'ACADEMY';
    assertMayRead(auth, kind);
    if (!(await prisma.academyQuiz.count({ where: { id: targetId } }))) {
      throw new AppError('NOT_FOUND', 'Academy quiz not found');
    }
    const { skip, take } = pageArgs(query);
    const search = query.q ? { contains: query.q, mode: 'insensitive' as const } : undefined;
    if (kind === 'QUIZ') {
      const where: Prisma.QuizWhereInput = search ? { lesson: { title: search } } : {};
      const [rows, total] = await Promise.all([
        prisma.quiz.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: {
            id: true,
            status: true,
            lesson: {
              select: {
                title: true,
                chapter: {
                  select: { module: { select: { course: { select: { title: true } } } } },
                },
              },
            },
          },
        }),
        prisma.quiz.count({ where }),
      ]);
      const totals = await questionTotals({ quizId: { in: rows.map((r) => r.id) } }, 'quizId');
      return paginated(
        rows.map((row) => ({
          kind,
          id: row.id,
          title: row.lesson.title,
          context: row.lesson.chapter.module.course.title,
          status: row.status,
          questionCount: totals.get(row.id)?.count ?? 0,
        })),
        total,
        query,
      );
    }
    if (kind === 'EXAM') {
      const where: Prisma.ExaminationWhereInput = search ? { title: search } : {};
      const [rows, total] = await Promise.all([
        prisma.examination.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: { id: true, title: true, status: true, course: { select: { title: true } } },
        }),
        prisma.examination.count({ where }),
      ]);
      const totals = await questionTotals(
        { examinationId: { in: rows.map((r) => r.id) } },
        'examinationId',
      );
      return paginated(
        rows.map((row) => ({
          kind,
          id: row.id,
          title: row.title,
          context: row.course.title,
          status: row.status,
          questionCount: totals.get(row.id)?.count ?? 0,
        })),
        total,
        query,
      );
    }
    const where: Prisma.AcademyQuizWhereInput = {
      NOT: { id: targetId },
      ...(search ? { title: search } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.academyQuiz.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
        select: { id: true, title: true, status: true },
      }),
      prisma.academyQuiz.count({ where }),
    ]);
    const totals = await questionTotals(
      { academyQuizId: { in: rows.map((r) => r.id) } },
      'academyQuizId',
    );
    return paginated(
      rows.map((row) => ({
        kind,
        id: row.id,
        title: row.title,
        context: null,
        status: row.status,
        questionCount: totals.get(row.id)?.count ?? 0,
      })),
      total,
      query,
    );
  },

  /** The questions of one source (with answer keys — this is an authoring view). */
  async sourceQuestions(
    auth: AuthContext,
    kind: CopySourceKind,
    id: string,
  ): Promise<QuestionDto[]> {
    assertMayRead(auth, kind);
    await assertSourceExists(prisma, kind, id);
    return listQuestions(ownerOf(kind, id));
  },

  async copy(
    auth: AuthContext,
    targetId: string,
    input: CopyQuestionsInput,
  ): Promise<CopyQuestionsResultDto> {
    const { kind, id: sourceId } = input.source;
    assertMayRead(auth, kind);
    if (kind === 'ACADEMY' && sourceId === targetId) {
      throw fieldError('VALIDATION_ERROR', 'source', 'Choose another quiz to copy from');
    }
    const result = await prisma.$transaction(async (tx) => {
      const target = await lockQuiz(tx, targetId);
      if (target.status !== 'DRAFT') {
        throw new AppError(
          'CONFLICT',
          'Questions can only be added while the academy quiz is a draft.',
        );
      }
      await assertSourceExists(tx, kind, sourceId);
      const owner = ownerOf(kind, sourceId);
      const source = await tx.assessmentQuestion.findMany({
        where: { ...owner, id: { in: input.questionIds } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: sourceQuestionSelect,
      });
      if (source.length !== input.questionIds.length) {
        throw fieldError(
          'VALIDATION_ERROR',
          'questionIds',
          'Some of the chosen questions do not belong to this source',
        );
      }
      const copyable = source.filter((question) => question.type !== 'SHORT_ANSWER');
      const existing = await tx.assessmentQuestion.count({ where: { academyQuizId: targetId } });
      if (existing + copyable.length > QUESTION_LIMITS.questionsPerAssessment) {
        throw new AppError(
          'CONFLICT',
          `An assessment can have at most ${QUESTION_LIMITS.questionsPerAssessment} questions.`,
        );
      }
      // The same media is referenced, locked FOR SHARE so it cannot start being deleted meanwhile.
      const media = await mediaUsedBy(tx, { id: { in: copyable.map((q) => q.id) } });
      await assertAttachable(tx, auth, media, new Set(media));
      for (const [index, question] of copyable.entries()) {
        await tx.assessmentQuestion.create({
          data: {
            academyQuizId: targetId,
            type: question.type,
            prompt: question.prompt,
            explanation: question.explanation,
            marks: question.marks,
            negativeMarks: question.negativeMarks,
            imageIds: question.imageIds,
            // Only academy questions carry a difficulty.
            difficulty: kind === 'ACADEMY' ? question.difficulty : null,
            position: existing + index,
            options: {
              create: question.options.map((option, position) => ({
                text: option.text,
                isCorrect: option.isCorrect,
                position,
                imageId: option.image?.id ?? null,
              })),
            },
          },
        });
      }
      await academyAudit(tx, 'academy_quiz.questions_copied', auth.userId, targetId, {
        sourceKind: kind,
        sourceId,
        copied: copyable.length,
        skippedWritten: source.length - copyable.length,
      });
      return { copied: copyable.length, skippedWritten: source.length - copyable.length };
    });
    return { ...result, questions: await listQuestions({ academyQuizId: targetId }) };
  },
};
