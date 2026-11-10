import { z } from 'zod';
import { ANSWER_REVEALS } from './assessment.js';
import { optionalSlugInputSchema, optionalTextSchema, paginationQuerySchema } from './common.js';
import { isoInstantSchema } from './faculty.js';

/**
 * Academy Quiz administration (standalone quizzes, docs/ASSESSMENTS.md §Academy). The rules mirror
 * the `academy_quizzes_*` CHECK constraints so problems are reported per field before the
 * database would refuse them. Bodies are `.strict()`: status, publication/closing times, results
 * publication and the creator are server-controlled.
 */

export const ACADEMY_TIMER_MODES = ['OVERALL', 'PER_QUESTION'] as const;
export const QUESTION_NAVIGATIONS = ['FREE', 'LINEAR'] as const;
export const QUESTION_SELECTIONS = ['ALL', 'RANDOM', 'BY_DIFFICULTY'] as const;
export const RESULT_RELEASES = ['IMMEDIATE', 'SCHEDULED', 'MANUAL'] as const;
export const LEADERBOARD_VISIBILITIES = ['HIDDEN', 'SIGNED_IN', 'PUBLIC'] as const;
export const ATTEMPT_COUNTINGS = ['BEST', 'FIRST'] as const;
export const RANKING_TIE_BREAKS = ['TIME_TAKEN', 'SUBMITTED_AT'] as const;
export const ACADEMY_QUIZ_TRANSITIONS = ['publish', 'unpublish', 'close', 'reopen'] as const;
export const ACADEMY_QUIZ_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED'] as const;

export const ACADEMY_QUIZ_LIMITS = {
  title: 200,
  summary: 500,
  text: 20_000,
  durationMinutes: { min: 1, max: 600 },
  questionTimeSeconds: { min: 10, max: 600 },
  maxAttempts: { min: 1, max: 5 },
  prizes: 10,
  prizeTitle: 120,
  prizeDescription: 1000,
  eligibleIds: 50,
  questionsPerAttempt: 200,
} as const;

const intIn = (label: string, { min, max }: { min: number; max: number }) =>
  z
    .number({ message: `Enter the ${label}` })
    .int('Use a whole number')
    .min(min, `At least ${min}`)
    .max(max, `At most ${max}`);

const countSchema = z.number().int('Use a whole number').min(0, 'Cannot be negative').max(200);

/** IANA time zone (e.g. "Asia/Kolkata"); used to display the schedule, never to compute it. */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Choose a valid time zone');

export const prizeSchema = z
  .object({
    position: z.number().int().min(1, 'Positions start at 1').max(100),
    title: z.string().trim().min(1, 'Name the prize').max(ACADEMY_QUIZ_LIMITS.prizeTitle),
    description: optionalTextSchema(ACADEMY_QUIZ_LIMITS.prizeDescription).transform(
      (value) => value ?? null,
    ),
    imageMediaId: z.uuid('Upload the image again').nullable().default(null),
  })
  .strict();
export type PrizeInput = z.infer<typeof prizeSchema>;

const uuidList = (label: string) =>
  z
    .array(z.uuid())
    .max(ACADEMY_QUIZ_LIMITS.eligibleIds, `At most ${ACADEMY_QUIZ_LIMITS.eligibleIds} ${label}`)
    .refine((ids) => new Set(ids).size === ids.length, `Each ${label.replace(/es$|s$/, '')} once`);

/** Every setting of an academy quiz, WITHOUT defaults (so a PATCH never fills omitted keys). */
const fieldShape = {
  title: z.string().trim().min(1, 'Enter a title').max(ACADEMY_QUIZ_LIMITS.title),
  slug: optionalSlugInputSchema,
  summary: optionalTextSchema(ACADEMY_QUIZ_LIMITS.summary).transform((v) => v ?? null),
  description: optionalTextSchema(ACADEMY_QUIZ_LIMITS.text).transform((v) => v ?? null),
  instructions: optionalTextSchema(ACADEMY_QUIZ_LIMITS.text).transform((v) => v ?? null),
  bannerMediaId: z.uuid('Upload the banner again').nullable(),
  prizes: z
    .array(prizeSchema)
    .max(ACADEMY_QUIZ_LIMITS.prizes, `At most ${ACADEMY_QUIZ_LIMITS.prizes} prizes`),
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  resultsAt: isoInstantSchema.nullable(),
  timeZone: timeZoneSchema,
  timerMode: z.enum(ACADEMY_TIMER_MODES),
  durationMinutes: intIn('duration', ACADEMY_QUIZ_LIMITS.durationMinutes).nullable(),
  questionTimeSeconds: intIn(
    'time per question',
    ACADEMY_QUIZ_LIMITS.questionTimeSeconds,
  ).nullable(),
  navigation: z.enum(QUESTION_NAVIGATIONS),
  requireAnswerToAdvance: z.boolean(),
  selection: z.enum(QUESTION_SELECTIONS),
  questionsPerAttempt: intIn('number of questions', {
    min: 1,
    max: ACADEMY_QUIZ_LIMITS.questionsPerAttempt,
  }).nullable(),
  easyCount: countSchema.nullable(),
  mediumCount: countSchema.nullable(),
  hardCount: countSchema.nullable(),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  negativeMarking: z.boolean(),
  passPercent: intIn('pass mark', { min: 0, max: 100 }),
  maxAttempts: intIn('number of attempts', ACADEMY_QUIZ_LIMITS.maxAttempts),
  eligibleClassIds: uuidList('classes'),
  eligibleStreamIds: uuidList('streams'),
  resultRelease: z.enum(RESULT_RELEASES),
  answerReveal: z.enum(ANSWER_REVEALS),
  leaderboardVisibility: z.enum(LEADERBOARD_VISIBILITIES),
  maskNames: z.boolean(),
  attemptCounting: z.enum(ATTEMPT_COUNTINGS),
  tieBreak: z.enum(RANKING_TIE_BREAKS),
};

/** Defaults of a new quiz (everything except title and the schedule). */
export const ACADEMY_QUIZ_DEFAULTS = {
  summary: null,
  description: null,
  instructions: null,
  bannerMediaId: null,
  prizes: [],
  resultsAt: null,
  timeZone: 'Asia/Kolkata',
  timerMode: 'OVERALL',
  durationMinutes: null,
  questionTimeSeconds: null,
  navigation: 'FREE',
  requireAnswerToAdvance: false,
  selection: 'ALL',
  questionsPerAttempt: null,
  easyCount: null,
  mediumCount: null,
  hardCount: null,
  shuffleQuestions: false,
  shuffleOptions: false,
  negativeMarking: false,
  passPercent: 40,
  maxAttempts: 1,
  eligibleClassIds: [],
  eligibleStreamIds: [],
  resultRelease: 'IMMEDIATE',
  answerReveal: 'AFTER_CLOSE',
  leaderboardVisibility: 'SIGNED_IN',
  maskNames: false,
  attemptCounting: 'BEST',
  tieBreak: 'TIME_TAKEN',
} as const;

type Settings = z.infer<z.ZodObject<typeof fieldShape>>;

/** Cross-field rules (same as the database CHECKs, plus results not before the quiz ends). */
export function refineAcademySettings(value: Settings, ctx: z.RefinementCtx) {
  const issue = (path: keyof Settings, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  const starts = Date.parse(value.startsAt);
  const ends = Date.parse(value.endsAt);
  if (!(ends > starts)) issue('endsAt', 'The end must be after the start');

  if (value.timerMode === 'OVERALL') {
    if (value.durationMinutes === null) issue('durationMinutes', 'Enter the quiz duration');
    if (value.questionTimeSeconds !== null) {
      issue('questionTimeSeconds', 'Time per question applies only to the per-question timer');
    }
  } else {
    if (value.questionTimeSeconds === null) {
      issue('questionTimeSeconds', 'Enter the time allowed per question');
    }
    if (value.durationMinutes !== null) {
      issue('durationMinutes', 'The per-question timer has no overall duration');
    }
    if (value.navigation !== 'LINEAR') {
      issue(
        'navigation',
        'With a per-question timer, students move forward one question at a time',
      );
    }
  }
  if (value.requireAnswerToAdvance && value.navigation !== 'LINEAR') {
    issue(
      'requireAnswerToAdvance',
      'Only forward-only navigation can require an answer to continue',
    );
  }

  const counts = [value.easyCount, value.mediumCount, value.hardCount];
  if (value.selection === 'RANDOM') {
    if (value.questionsPerAttempt === null) {
      issue('questionsPerAttempt', 'Enter how many questions each student gets');
    }
  } else if (value.questionsPerAttempt !== null) {
    issue('questionsPerAttempt', 'Applies only to random selection');
  }
  if (value.selection === 'BY_DIFFICULTY') {
    if (counts.some((count) => count === null)) {
      issue('easyCount', 'Enter how many easy, medium and hard questions each student gets');
    } else if (counts.reduce((sum, count) => sum! + count!, 0)! < 1) {
      issue('easyCount', 'Each student must get at least one question');
    }
  } else if (counts.some((count) => count !== null)) {
    issue('easyCount', 'Difficulty counts apply only to selection by difficulty');
  }

  if (value.resultRelease === 'SCHEDULED') {
    if (value.resultsAt === null) issue('resultsAt', 'Choose when results are published');
    else if (Date.parse(value.resultsAt) < ends) {
      issue('resultsAt', 'Results can be published only after the quiz ends');
    }
  } else if (value.resultsAt !== null) {
    issue('resultsAt', 'A publication time applies only to scheduled results');
  }

  const positions = value.prizes.map((prize) => prize.position);
  if (new Set(positions).size !== positions.length) issue('prizes', 'Each position once');
  const images = value.prizes.flatMap((prize) => (prize.imageMediaId ? [prize.imageMediaId] : []));
  if (new Set(images).size !== images.length) issue('prizes', 'Each image may be used only once');
}

/** The complete settings of a quiz: what the service validates after applying defaults/merging. */
export const academyQuizSettingsSchema = z
  .object(fieldShape)
  .strict()
  .superRefine(refineAcademySettings);
export type AcademyQuizSettingsInput = z.infer<typeof academyQuizSettingsSchema>;

/** POST: title and schedule are required; every other setting falls back to ACADEMY_QUIZ_DEFAULTS. */
export const academyQuizCreateSchema = z
  .object(fieldShape)
  .partial()
  .required({ title: true, startsAt: true, endsAt: true })
  .strict();
export type AcademyQuizCreateInput = z.infer<typeof academyQuizCreateSchema>;

/** PATCH: any subset; the service merges it with the stored quiz and re-validates the whole. */
export const academyQuizPatchSchema = z
  .object(fieldShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one setting');
export type AcademyQuizPatchInput = z.infer<typeof academyQuizPatchSchema>;

/** Settings that may still change after publication (content, prizes, results display). */
export const ACADEMY_POST_PUBLISH_FIELDS = [
  'title',
  'summary',
  'description',
  'instructions',
  'bannerMediaId',
  'prizes',
  'endsAt',
  'resultRelease',
  'resultsAt',
  'answerReveal',
  'leaderboardVisibility',
  'maskNames',
] as const satisfies readonly (keyof Settings)[];

export const academyQuizTransitionSchema = z
  .object({ action: z.enum(ACADEMY_QUIZ_TRANSITIONS) })
  .strict();
export type AcademyQuizTransition = (typeof ACADEMY_QUIZ_TRANSITIONS)[number];

export const academyQuizListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ACADEMY_QUIZ_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});
export type AcademyQuizListQuery = z.infer<typeof academyQuizListQuerySchema>;

export const COPY_SOURCE_KINDS = ['QUIZ', 'EXAM', 'ACADEMY'] as const;
export type CopySourceKind = (typeof COPY_SOURCE_KINDS)[number];

export const copySourceListQuerySchema = paginationQuerySchema.extend({
  kind: z.enum(COPY_SOURCE_KINDS).optional(),
  q: z.string().trim().max(100).optional(),
});
export type CopySourceListQuery = z.infer<typeof copySourceListQuerySchema>;

export const copyQuestionsSchema = z
  .object({
    source: z.object({ kind: z.enum(COPY_SOURCE_KINDS), id: z.uuid() }).strict(),
    questionIds: z
      .array(z.uuid())
      .min(1, 'Choose at least one question')
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, 'Each question once'),
  })
  .strict();
export type CopyQuestionsInput = z.infer<typeof copyQuestionsSchema>;

// --- Student side -----------------------------------------------------------------------------

export const STUDENT_ACADEMY_TABS = ['UPCOMING', 'LIVE', 'COMPLETED'] as const;

export const studentAcademyQuizListQuerySchema = paginationQuerySchema.extend({
  tab: z.enum(STUDENT_ACADEMY_TABS).default('LIVE'),
});
export type StudentAcademyQuizListQuery = z.infer<typeof studentAcademyQuizListQuerySchema>;

/** Quizzes are addressed by slug on the student side (lower-case kebab-case, as stored). */
export const academySlugParamsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid quiz address'),
});

/**
 * Starting an attempt: the student must confirm they read the instructions. Nothing else is
 * accepted (start time, deadline and questions are decided by the server).
 */
export const academyAttemptStartSchema = z
  .object({ acceptedInstructions: z.literal(true, 'Confirm that you have read the instructions') })
  .strict();
export type AcademyAttemptStartInput = z.infer<typeof academyAttemptStartSchema>;

/**
 * LINEAR navigation: move past the question at `fromPosition`. The position makes the request
 * idempotent (a retry after a lost response does not skip a second question).
 */
export const academyAttemptAdvanceSchema = z
  .object({ fromPosition: z.number().int().min(0).max(1000) })
  .strict();
export type AcademyAttemptAdvanceInput = z.infer<typeof academyAttemptAdvanceSchema>;

// --- Leaderboard and attempt management (Step 5) ----------------------------------------------

export const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

export const ACADEMY_ATTEMPT_FILTERS = ['IN_PROGRESS', 'SUBMITTED', 'EXPIRED'] as const;

export const adminAcademyAttemptListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ACADEMY_ATTEMPT_FILTERS).optional(),
  q: z.string().trim().max(100).optional(),
});
export type AdminAcademyAttemptListQuery = z.infer<typeof adminAcademyAttemptListQuerySchema>;
