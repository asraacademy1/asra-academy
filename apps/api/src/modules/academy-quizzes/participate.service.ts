import {
  PERMISSIONS,
  type AcademyPrizeDto,
  type Paginated,
  type PublicAcademyQuizDetail,
  type PublicAcademyQuizItem,
  type PublicParticipateActivitiesDto,
  type PublicParticipateSummaryDto,
  type PublicSitemapQuiz,
  type QuizRegistrationBlockCode,
  type QuizRegistrationResultDto,
  type QuizRegistrationStatusDto,
} from '@asra/types';
import type { PaginationQuery, PublicParticipateQuizzesQuery } from '@asra/validation';
import { SITEMAP_COURSE_LIMIT } from '../../config/constants.js';
import { prisma } from '../../database/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { lockStudentAssessment, sourceQuestionSelect } from '../assessments/attempts.core.js';
import { loadMediaRefs, mediaRefSelect, toMediaDto } from '../assessments/media/media.service.js';
import { toCents } from '../assessments/scoring.js';
import { readPrizes } from './academy-quizzes.service.js';
import { phaseOf, planSelection } from './selection.js';

/**
 * Public Participate discovery & verified quiz registration (`docs/ASSESSMENTS.md` §Academy).
 *
 * Security & visibility invariants enforced in database queries:
 *   - Public listings return ONLY quizzes with `status = PUBLISHED`, `visibility = PUBLIC`,
 *     and `endsAt > now` (categorised as LIVE vs UPCOMING).
 *   - Public detail & registration routes return ONLY `visibility = PUBLIC` and
 *     `status IN (PUBLISHED, CLOSED)`. DRAFT or PRIVATE quizzes return 404 (never enumerated).
 *   - Public DTOs never expose questions, answer options, answer keys, attempts, or user data.
 *   - Registration requires an authenticated, active, email-verified student account, checks
 *     class/stream eligibility, enforces DB uniqueness (`[quizId, userId]`), and serializes
 *     against quiz close/edit (`FOR SHARE`) and duplicate requests (`lockStudentAssessment`).
 */

const quizNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Academy quiz not found');
};

const publicListWhere = (
  now: Date,
  filter: 'all' | 'live' | 'upcoming',
): Prisma.AcademyQuizWhereInput => {
  const base: Prisma.AcademyQuizWhereInput = {
    status: 'PUBLISHED',
    visibility: 'PUBLIC',
  };
  if (filter === 'live') {
    return { ...base, startsAt: { lte: now }, endsAt: { gt: now } };
  }
  if (filter === 'upcoming') {
    return { ...base, startsAt: { gt: now } };
  }
  return { ...base, endsAt: { gt: now } };
};

const publicDetailWhere = (slug: string): Prisma.AcademyQuizWhereInput => ({
  slug,
  visibility: 'PUBLIC',
  status: { in: ['PUBLISHED', 'CLOSED'] },
});

const publicQuizSelect = {
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
  negativeMarking: true,
  passPercent: true,
  maxAttempts: true,
  eligibleClassIds: true,
  eligibleStreamIds: true,
  resultRelease: true,
  answerReveal: true,
  leaderboardVisibility: true,
  status: true,
  visibility: true,
  bannerMedia: { select: mediaRefSelect },
} satisfies Prisma.AcademyQuizSelect;

type PublicQuizRow = Prisma.AcademyQuizGetPayload<{ select: typeof publicQuizSelect }>;

const bannerOf = (row: PublicQuizRow) =>
  row.bannerMedia
    ? toMediaDto({ ...row.bannerMedia, format: row.bannerMedia.format as 'webp' | 'jpg' | 'png' })
    : null;

function questionsCountOf(quiz: PublicQuizRow, poolSize: number): number {
  if (quiz.selection === 'RANDOM') return quiz.questionsPerAttempt ?? 0;
  if (quiz.selection === 'BY_DIFFICULTY') {
    return (quiz.easyCount ?? 0) + (quiz.mediumCount ?? 0) + (quiz.hardCount ?? 0);
  }
  return poolSize;
}

function registrationWindowState(
  quiz: Pick<PublicQuizRow, 'status' | 'endsAt'>,
  now: Date,
): { open: boolean; reason: string | null } {
  if (quiz.status === 'CLOSED') {
    return { open: false, reason: 'This quiz is closed and no longer accepts registrations.' };
  }
  if (quiz.status === 'DRAFT') {
    return { open: false, reason: 'This quiz is not available.' };
  }
  if (now >= quiz.endsAt) {
    return { open: false, reason: 'This quiz has already ended and registration is closed.' };
  }
  return { open: true, reason: null };
}

async function resolveClassesAndStreams(
  quizzes: Pick<PublicQuizRow, 'eligibleClassIds' | 'eligibleStreamIds'>[],
) {
  const classIds = [...new Set(quizzes.flatMap((q) => q.eligibleClassIds))];
  const streamIds = [...new Set(quizzes.flatMap((q) => q.eligibleStreamIds))];
  const [classes, streams] = await Promise.all([
    classIds.length
      ? prisma.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, name: true },
          orderBy: { sortOrder: 'asc' },
        })
      : Promise.resolve([]),
    streamIds.length
      ? prisma.stream.findMany({
          where: { id: { in: streamIds } },
          select: { id: true, name: true },
          orderBy: { sortOrder: 'asc' },
        })
      : Promise.resolve([]),
  ]);
  return {
    classMap: new Map(classes.map((c) => [c.id, c])),
    streamMap: new Map(streams.map((s) => [s.id, s])),
  };
}

async function quizMarksAndCounts(ids: string[]) {
  if (ids.length === 0)
    return new Map<
      string,
      { difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null; marksCents: number }[]
    >();
  const rows = await prisma.assessmentQuestion.findMany({
    where: { academyQuizId: { in: ids } },
    select: { academyQuizId: true, difficulty: true, marks: true },
  });
  const byQuiz = new Map<
    string,
    { difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null; marksCents: number }[]
  >();
  for (const row of rows) {
    if (!row.academyQuizId) continue;
    const list = byQuiz.get(row.academyQuizId) ?? [];
    list.push({ difficulty: row.difficulty, marksCents: toCents(row.marks) });
    byQuiz.set(row.academyQuizId, list);
  }
  return byQuiz;
}

function toPublicItem(
  quiz: PublicQuizRow,
  pool: { difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null; marksCents: number }[],
  classMap: Map<string, { id: string; name: string }>,
  streamMap: Map<string, { id: string; name: string }>,
  now: Date,
): PublicAcademyQuizItem {
  const plan = planSelection(quiz, pool);
  const windowState = registrationWindowState(quiz, now);
  return {
    id: quiz.id,
    slug: quiz.slug,
    title: quiz.title,
    summary: quiz.summary,
    banner: bannerOf(quiz),
    phase: phaseOf(quiz, now) as PublicAcademyQuizItem['phase'],
    startsAt: quiz.startsAt.toISOString(),
    endsAt: quiz.endsAt.toISOString(),
    timeZone: quiz.timeZone,
    timerMode: quiz.timerMode,
    durationMinutes: quiz.durationMinutes,
    questionTimeSeconds: quiz.questionTimeSeconds,
    questionsPerAttempt: questionsCountOf(quiz, pool.length),
    totalMarks: plan.totalMarksCents === null ? 0 : plan.totalMarksCents / 100,
    hasPrizes: readPrizes(quiz.prizes).length > 0,
    eligibleClasses: quiz.eligibleClassIds.flatMap((id) => {
      const ref = classMap.get(id);
      return ref ? [ref] : [];
    }),
    eligibleStreams: quiz.eligibleStreamIds.flatMap((id) => {
      const ref = streamMap.get(id);
      return ref ? [ref] : [];
    }),
    registrationOpen: windowState.open,
    registrationClosedReason: windowState.reason,
  };
}

async function hydratePublicItems(
  rows: PublicQuizRow[],
  now: Date,
): Promise<PublicAcademyQuizItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [questionMap, refs] = await Promise.all([
    quizMarksAndCounts(ids),
    resolveClassesAndStreams(rows),
  ]);
  return rows.map((row) =>
    toPublicItem(row, questionMap.get(row.id) ?? [], refs.classMap, refs.streamMap, now),
  );
}

async function evaluateUserRegistrationAccess(
  db: typeof prisma | Prisma.TransactionClient,
  auth: AuthContext,
  quiz: Pick<
    PublicQuizRow,
    'id' | 'slug' | 'status' | 'visibility' | 'endsAt' | 'eligibleClassIds' | 'eligibleStreamIds'
  >,
  now: Date,
) {
  const [user, existingReg, classes, streams] = await Promise.all([
    db.user.findUnique({
      where: { id: auth.userId },
      select: {
        id: true,
        status: true,
        emailVerifiedAt: true,
        roles: {
          select: {
            role: {
              select: {
                key: true,
                permissions: { select: { permission: { select: { key: true } } } },
              },
            },
          },
        },
        studentProfile: { select: { classId: true, streamId: true } },
      },
    }),
    db.academyQuizRegistration.findUnique({
      where: { quizId_userId: { quizId: quiz.id, userId: auth.userId } },
      select: { registeredAt: true },
    }),
    quiz.eligibleClassIds.length
      ? db.class.findMany({
          where: { id: { in: quiz.eligibleClassIds } },
          select: { id: true, name: true },
          orderBy: { sortOrder: 'asc' },
        })
      : Promise.resolve([]),
    quiz.eligibleStreamIds.length
      ? db.stream.findMany({
          where: { id: { in: quiz.eligibleStreamIds } },
          select: { id: true, name: true },
          orderBy: { sortOrder: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required');
  if (user.status !== 'ACTIVE') {
    throw new AppError('ACCOUNT_DISABLED', 'This account is disabled. Contact the academy.');
  }

  const emailVerified = Boolean(user.emailVerifiedAt);
  const canParticipate = user.roles.some(({ role }) =>
    role.permissions.some(
      ({ permission }) => permission.key === PERMISSIONS.ACADEMY_QUIZZES_PARTICIPATE,
    ),
  );
  const classId = user.studentProfile?.classId ?? null;
  const streamId = user.studentProfile?.streamId ?? null;

  let blockedCode: QuizRegistrationBlockCode | null = null;
  let blockedReason: string | null = null;

  if (existingReg) {
    blockedCode = 'ALREADY_REGISTERED';
    blockedReason = 'You are already registered for this quiz.';
  } else if (quiz.status === 'CLOSED') {
    blockedCode = 'QUIZ_CLOSED';
    blockedReason = 'This quiz is closed and no longer accepts registrations.';
  } else if (now >= quiz.endsAt) {
    blockedCode = 'QUIZ_ENDED';
    blockedReason = 'This quiz has already ended and registration is closed.';
  } else if (!emailVerified) {
    blockedCode = 'EMAIL_NOT_VERIFIED';
    blockedReason = 'Verify your email address before registering for quizzes.';
  } else if (!canParticipate) {
    blockedCode = 'NOT_STUDENT';
    blockedReason = 'Only verified student accounts can register for quizzes.';
  } else if (
    quiz.eligibleClassIds.length > 0 &&
    (!classId || !quiz.eligibleClassIds.includes(classId))
  ) {
    blockedCode = 'NOT_ELIGIBLE';
    blockedReason = 'This quiz is open to students of other classes only.';
  } else if (
    quiz.eligibleStreamIds.length > 0 &&
    (!streamId || !quiz.eligibleStreamIds.includes(streamId))
  ) {
    blockedCode = 'NOT_ELIGIBLE';
    blockedReason = 'This quiz is open to students of other streams only.';
  }

  return {
    registered: Boolean(existingReg),
    registeredAt: existingReg?.registeredAt.toISOString() ?? null,
    emailVerified,
    canRegister: blockedCode === null,
    blockedCode,
    blockedReason,
    eligibleClasses: classes,
    eligibleStreams: streams,
  };
}

export const publicParticipateService = {
  /** Counts of currently public & active activities for footer/navigation. */
  async summary(now = clock.now()): Promise<PublicParticipateSummaryDto> {
    const [liveQuizzesCount, upcomingQuizzesCount] = await Promise.all([
      prisma.academyQuiz.count({ where: publicListWhere(now, 'live') }),
      prisma.academyQuiz.count({ where: publicListWhere(now, 'upcoming') }),
    ]);
    return {
      liveQuizzesCount,
      upcomingQuizzesCount,
      competitionsCount: 0,
      assessmentsCount: 0,
    };
  },

  /** Structured overview for `/participate` landing page. */
  async activities(): Promise<PublicParticipateActivitiesDto> {
    const now = clock.now();
    const [liveRows, upcomingRows, summary] = await Promise.all([
      prisma.academyQuiz.findMany({
        where: publicListWhere(now, 'live'),
        select: publicQuizSelect,
        orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
        take: 12,
      }),
      prisma.academyQuiz.findMany({
        where: publicListWhere(now, 'upcoming'),
        select: publicQuizSelect,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: 12,
      }),
      publicParticipateService.summary(now),
    ]);

    const [liveQuizzes, upcomingQuizzes] = await Promise.all([
      hydratePublicItems(liveRows, now),
      hydratePublicItems(upcomingRows, now),
    ]);

    return {
      summary,
      liveQuizzes,
      upcomingQuizzes,
      competitions: [],
      assessments: [],
      serverNow: now.toISOString(),
    };
  },

  /** Paginated list of public LIVE and/or UPCOMING quizzes for `/participate/quizzes`. */
  async listQuizzes(
    query: PublicParticipateQuizzesQuery,
  ): Promise<Paginated<PublicAcademyQuizItem>> {
    const now = clock.now();
    const where = publicListWhere(now, query.status);
    const { skip, take } = pageArgs(query);
    const orderBy: Prisma.AcademyQuizOrderByWithRelationInput[] =
      query.status === 'live'
        ? [{ endsAt: 'asc' }, { id: 'asc' }]
        : [{ startsAt: 'asc' }, { id: 'asc' }];
    const [rows, total] = await Promise.all([
      prisma.academyQuiz.findMany({ where, select: publicQuizSelect, orderBy, skip, take }),
      prisma.academyQuiz.count({ where }),
    ]);
    return paginated(await hydratePublicItems(rows, now), total, query);
  },

  /**
   * Public quiz detail for `/participate/quizzes/[slug]`.
   * Rejects DRAFT and PRIVATE quizzes with 404 (never enumerating hidden items) and never
   * returns questions, answer keys, submissions, or admin internals.
   */
  async quizDetail(slug: string): Promise<PublicAcademyQuizDetail> {
    const now = clock.now();
    const quiz =
      (await prisma.academyQuiz.findFirst({
        where: publicDetailWhere(slug),
        select: publicQuizSelect,
      })) ?? quizNotFound();

    const [poolRows, refs] = await Promise.all([
      prisma.assessmentQuestion.findMany({
        where: { academyQuizId: quiz.id },
        select: { difficulty: sourceQuestionSelect.difficulty, marks: sourceQuestionSelect.marks },
      }),
      resolveClassesAndStreams([quiz]),
    ]);

    const pool = poolRows.map((q) => ({ difficulty: q.difficulty, marksCents: toCents(q.marks) }));
    const item = toPublicItem(quiz, pool, refs.classMap, refs.streamMap, now);
    const prizes = readPrizes(quiz.prizes);
    const prizeMedia = await loadMediaRefs(
      prisma,
      prizes.flatMap((prize) => (prize.imageMediaId ? [prize.imageMediaId] : [])),
    );

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
      navigation: quiz.navigation,
      requireAnswerToAdvance: quiz.requireAnswerToAdvance,
      negativeMarking: quiz.negativeMarking,
      passPercent: quiz.passPercent,
      maxAttempts: quiz.maxAttempts,
      resultsAt: quiz.resultsAt?.toISOString() ?? null,
      resultRelease: quiz.resultRelease,
      answerReveal: quiz.answerReveal,
      leaderboardVisible: quiz.leaderboardVisibility !== 'HIDDEN',
      serverNow: now.toISOString(),
    };
  },

  /** Public competitions placeholder list (no separate competition records exist yet). */
  async listCompetitions(query: PaginationQuery): Promise<Paginated<PublicAcademyQuizItem>> {
    return paginated([], 0, query);
  },

  /** Public assessments placeholder list (course exams require enrolment; none are public). */
  async listAssessments(query: PaginationQuery): Promise<Paginated<PublicAcademyQuizItem>> {
    return paginated([], 0, query);
  },

  /** Sitemap feed for public published quizzes. */
  async sitemapQuizzes(): Promise<PublicSitemapQuiz[]> {
    const rows = await prisma.academyQuiz.findMany({
      where: { status: 'PUBLISHED', visibility: 'PUBLIC' },
      select: { slug: true, updatedAt: true },
      orderBy: [{ startsAt: 'desc' }, { slug: 'asc' }],
      take: SITEMAP_COURSE_LIMIT,
    });
    return rows.map((row) => ({ slug: row.slug, updatedAt: row.updatedAt.toISOString() }));
  },

  /** Authenticated registration state for one public quiz. */
  async registrationStatus(auth: AuthContext, slug: string): Promise<QuizRegistrationStatusDto> {
    const now = clock.now();
    const quiz =
      (await prisma.academyQuiz.findFirst({
        where: publicDetailWhere(slug),
        select: {
          id: true,
          slug: true,
          status: true,
          visibility: true,
          endsAt: true,
          eligibleClassIds: true,
          eligibleStreamIds: true,
        },
      })) ?? quizNotFound();

    const state = await evaluateUserRegistrationAccess(prisma, auth, quiz, now);
    return { quizId: quiz.id, slug: quiz.slug, ...state };
  },

  /**
   * Registers an authenticated, email-verified, eligible student for a public quiz.
   * Rejects unverified (403 EMAIL_NOT_VERIFIED), non-student (403 FORBIDDEN), hidden/draft (404),
   * closed/ended/ineligible/duplicate (409 CONFLICT). Handles concurrent duplicate POSTs via
   * advisory transaction lock + PostgreSQL unique constraint catch (`P2002`).
   */
  async register(auth: AuthContext, slug: string): Promise<QuizRegistrationResultDto> {
    try {
      return await prisma.$transaction(async (tx) => {
        const found =
          (await tx.academyQuiz.findFirst({
            where: { slug },
            select: { id: true },
          })) ?? quizNotFound();

        // Serialize against admin close / unpublish / visibility changes (those take FOR UPDATE).
        await tx.$queryRaw`SELECT "id" FROM "academy_quizzes" WHERE "id" = ${found.id}::uuid FOR SHARE`;
        await lockStudentAssessment(tx, found.id, auth.userId);

        const quiz = await tx.academyQuiz.findUnique({
          where: { id: found.id },
          select: {
            id: true,
            slug: true,
            title: true,
            status: true,
            visibility: true,
            endsAt: true,
            eligibleClassIds: true,
            eligibleStreamIds: true,
          },
        });
        if (!quiz || quiz.visibility !== 'PUBLIC' || quiz.status === 'DRAFT') {
          quizNotFound();
        }

        const now = clock.now();
        const state = await evaluateUserRegistrationAccess(tx, auth, quiz!, now);

        if (!state.canRegister) {
          if (state.blockedCode === 'EMAIL_NOT_VERIFIED') {
            throw new AppError('EMAIL_NOT_VERIFIED', state.blockedReason!);
          }
          if (state.blockedCode === 'NOT_STUDENT') {
            throw new AppError('FORBIDDEN', state.blockedReason!);
          }
          throw new AppError('CONFLICT', state.blockedReason!);
        }

        const created = await tx.academyQuizRegistration.create({
          data: { quizId: quiz!.id, userId: auth.userId, registeredAt: now },
          select: { registeredAt: true },
        });

        return {
          registered: true,
          registeredAt: created.registeredAt.toISOString(),
          quizId: quiz!.id,
          slug: quiz!.slug,
          title: quiz!.title,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError('CONFLICT', 'You are already registered for this quiz.');
      }
      throw error;
    }
  },
};
