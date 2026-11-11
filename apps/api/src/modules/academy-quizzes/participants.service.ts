import type { AdminAcademyParticipantItem, AdminAcademyParticipantsPage } from '@asra/types';
import type {
  AdminAcademyParticipantsExportQuery,
  AdminAcademyParticipantsQuery,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { formatInZone } from '../../lib/time-zone.js';
import { AppError } from '../../utils/app-error.js';

/**
 * Admin Academy Quiz participant listing and CSV export (`academy_quizzes.manage`).
 *
 * Source of truth: `academy_quiz_registrations` joined with whitelisted `User` fields only.
 * Never derived from `AssessmentAttempt` (a student who registered without starting still shows),
 * never mixes participants across quizzes (`where: { quizId }`), and never exposes password hashes
 * or session/token fields.
 */

const quizNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Academy quiz not found');
};

const CSV_EXPORT_MAX_ROWS = 50_000;

function startsWithFormulaTrigger(text: string): boolean {
  let i = 0;
  while (i < text.length && text.charCodeAt(i) <= 32) {
    if (text[i] === '\t' || text[i] === '\r') return true;
    i += 1;
  }
  const ch = text[i];
  return ch === '=' || ch === '+' || ch === '-' || ch === '@';
}

const participantSelect = {
  id: true,
  userId: true,
  registeredAt: true,
  user: {
    select: {
      fullName: true,
      email: true,
      phone: true,
      emailVerifiedAt: true,
    },
  },
} satisfies Prisma.AcademyQuizRegistrationSelect;

type ParticipantRow = Prisma.AcademyQuizRegistrationGetPayload<{
  select: typeof participantSelect;
}>;

function buildParticipantsWhere(
  quizId: string,
  query: Pick<AdminAcademyParticipantsQuery, 'search' | 'verificationStatus'>,
): Prisma.AcademyQuizRegistrationWhereInput {
  const userFilter: Prisma.UserWhereInput = {};
  if (query.verificationStatus === 'VERIFIED') {
    userFilter.emailVerifiedAt = { not: null };
  } else if (query.verificationStatus === 'UNVERIFIED') {
    userFilter.emailVerifiedAt = null;
  }
  if (query.search) {
    userFilter.OR = [
      { fullName: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  return {
    quizId,
    ...(Object.keys(userFilter).length > 0 ? { user: userFilter } : {}),
  };
}

function orderByFor(
  sort: AdminAcademyParticipantsQuery['sort'],
): Prisma.AcademyQuizRegistrationOrderByWithRelationInput[] {
  return sort === 'oldest'
    ? [{ registeredAt: 'asc' }, { id: 'asc' }]
    : [{ registeredAt: 'desc' }, { id: 'asc' }];
}

function toParticipantItem(row: ParticipantRow): AdminAcademyParticipantItem {
  return {
    id: row.id,
    userId: row.userId,
    studentName: row.user.fullName,
    email: row.user.email,
    phone: row.user.phone ?? null,
    registeredAt: row.registeredAt.toISOString(),
    emailVerified: row.user.emailVerifiedAt !== null,
    status: 'REGISTERED',
  };
}

/**
 * Escapes one CSV cell per RFC 4180 and neutralizes spreadsheet formula injection (`=`, `+`, `-`,
 * `@`, tab, CR, including leading whitespace before a trigger) by prefixing an apostrophe `'`.
 */
export function sanitizeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (startsWithFormulaTrigger(text)) {
    text = `'${text}`;
  }
  if (/[",\n']/.test(text) || text.startsWith("'")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildParticipantsCsv(
  items: readonly AdminAcademyParticipantItem[],
  timeZone: string,
): string {
  const header = ['Student Name', 'Email', 'Phone', 'Registration Date', 'Verification Status']
    .map(sanitizeCsvCell)
    .join(',');
  const lines = items.map((item) =>
    [
      item.studentName,
      item.email,
      item.phone ?? '',
      formatInZone(new Date(item.registeredAt), timeZone),
      item.emailVerified ? 'Verified' : 'Unverified',
    ]
      .map(sanitizeCsvCell)
      .join(','),
  );
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
}

function safeFileSlug(slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'quiz';
}

export const academyParticipantsService = {
  async list(
    quizId: string,
    query: AdminAcademyParticipantsQuery,
  ): Promise<AdminAcademyParticipantsPage> {
    const quiz =
      (await prisma.academyQuiz.findUnique({ where: { id: quizId }, select: { id: true } })) ??
      quizNotFound();

    const where = buildParticipantsWhere(quiz.id, query);
    const orderBy = orderByFor(query.sort);
    const skip = (query.page - 1) * query.limit;
    const take = query.limit;

    const [rows, total, totalRegistered] = await Promise.all([
      prisma.academyQuizRegistration.findMany({
        where,
        select: participantSelect,
        orderBy,
        skip,
        take,
      }),
      prisma.academyQuizRegistration.count({ where }),
      prisma.academyQuizRegistration.count({ where: { quizId: quiz.id } }),
    ]);

    return {
      items: rows.map(toParticipantItem),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
      totalRegistered,
    };
  },

  async exportCsv(
    quizId: string,
    query: AdminAcademyParticipantsExportQuery,
  ): Promise<{ filename: string; csv: string }> {
    const quiz =
      (await prisma.academyQuiz.findUnique({
        where: { id: quizId },
        select: { id: true, slug: true, timeZone: true },
      })) ?? quizNotFound();

    const rows = await prisma.academyQuizRegistration.findMany({
      where: buildParticipantsWhere(quiz.id, query),
      select: participantSelect,
      orderBy: orderByFor(query.sort),
      take: CSV_EXPORT_MAX_ROWS,
    });

    return {
      filename: `participants-${safeFileSlug(quiz.slug)}.csv`,
      csv: buildParticipantsCsv(rows.map(toParticipantItem), quiz.timeZone || 'Asia/Kolkata'),
    };
  },
};
