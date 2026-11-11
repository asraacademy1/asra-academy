import type {
  AnswerReveal,
  AssessmentStatus,
  AttemptCounts,
  AttemptQuestionDto,
  AttemptResultState,
  AttemptScoreDto,
  AttemptStatus,
  MediaDto,
  QuestionDto,
  ReviewQuestionDto,
  StudentAttemptSummary,
} from './assessment.js';
import type { Paginated } from './catalog.js';

/** Academy Quiz administration DTOs (standalone quizzes; docs/ASSESSMENTS.md §Academy). */

export type AcademyTimerMode = 'OVERALL' | 'PER_QUESTION';
export type QuestionNavigation = 'FREE' | 'LINEAR';
export type QuestionSelection = 'ALL' | 'RANDOM' | 'BY_DIFFICULTY';
export type QuestionDifficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type ResultRelease = 'IMMEDIATE' | 'SCHEDULED' | 'MANUAL';
export type LeaderboardVisibility = 'HIDDEN' | 'SIGNED_IN' | 'PUBLIC';
export type AttemptCounting = 'BEST' | 'FIRST';
export type RankingTieBreak = 'TIME_TAKEN' | 'SUBMITTED_AT';

/**
 * Where a quiz is in its life, derived from `status` and SERVER time:
 * DRAFT → (published) UPCOMING → LIVE → ENDED, or CLOSED when an administrator closed it.
 */
export type AcademyQuizPhase = 'DRAFT' | 'UPCOMING' | 'LIVE' | 'ENDED' | 'CLOSED';

export interface AcademyPrizeDto {
  position: number;
  title: string;
  description: string | null;
  image: MediaDto | null;
}

export interface AcademyQuizSettingsDto {
  title: string;
  slug: string;
  summary: string | null;
  description: string | null;
  instructions: string | null;
  startsAt: string;
  endsAt: string;
  resultsAt: string | null;
  timeZone: string;
  timerMode: AcademyTimerMode;
  durationMinutes: number | null;
  questionTimeSeconds: number | null;
  navigation: QuestionNavigation;
  requireAnswerToAdvance: boolean;
  selection: QuestionSelection;
  questionsPerAttempt: number | null;
  easyCount: number | null;
  mediumCount: number | null;
  hardCount: number | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  negativeMarking: boolean;
  passPercent: number;
  maxAttempts: number;
  eligibleClassIds: string[];
  eligibleStreamIds: string[];
  resultRelease: ResultRelease;
  answerReveal: AnswerReveal;
  leaderboardVisibility: LeaderboardVisibility;
  visibility: AcademyQuizVisibility;
  maskNames: boolean;
  attemptCounting: AttemptCounting;
  tieBreak: RankingTieBreak;
}

export interface AdminAcademyQuizItem {
  id: string;
  slug: string;
  title: string;
  status: AssessmentStatus;
  visibility: AcademyQuizVisibility;
  phase: AcademyQuizPhase;
  startsAt: string;
  endsAt: string;
  questionCount: number;
  registrationsCount?: number;
  attempts: AttemptCounts;
  publishedAt: string | null;
  updatedAt: string;
}

/** Questions available to the selection strategy, by difficulty (unrated = no difficulty). */
export interface QuestionPoolDto {
  total: number;
  EASY: number;
  MEDIUM: number;
  HARD: number;
  unrated: number;
}

export interface AdminAcademyQuizDetail extends AdminAcademyQuizItem {
  settings: AcademyQuizSettingsDto;
  banner: MediaDto | null;
  prizes: AcademyPrizeDto[];
  eligibleClasses: { id: string; name: string }[];
  eligibleStreams: { id: string; name: string }[];
  questions: QuestionDto[];
  pool: QuestionPoolDto;
  /** Questions every attempt gets, or null while the strategy cannot be satisfied. */
  questionsPerAttempt: number | null;
  /** Marks every attempt is out of, or null when selection would give unequal totals. */
  totalMarksPerAttempt: number | null;
  /** Why publishing is not possible yet (empty when it is). */
  publishProblems: string[];
  resultsPublishedAt: string | null;
  closedAt: string | null;
  /** Server time the phase was computed at. */
  serverNow: string;
}

/** A quiz/exam/academy quiz whose questions may be copied into an academy quiz. */
export interface CopySourceItem {
  kind: 'QUIZ' | 'EXAM' | 'ACADEMY';
  id: string;
  title: string;
  /** Course title for course quizzes/exams; null for academy quizzes. */
  context: string | null;
  status: AssessmentStatus;
  questionCount: number;
}

export interface CopyQuestionsResultDto {
  copied: number;
  /** Written-answer questions cannot be auto-scored, so they are never copied. */
  skippedWritten: number;
  questions: QuestionDto[];
}

// --- Student side -----------------------------------------------------------------------------

/** Student listing tabs: UPCOMING (not started), LIVE (open now), COMPLETED (ended or closed). */
export type StudentAcademyQuizTab = 'UPCOMING' | 'LIVE' | 'COMPLETED';

/** Why a student may not take a quiz (none = eligible). */
export type AcademyIneligibility = 'EMAIL_NOT_VERIFIED' | 'CLASS' | 'STREAM';

export interface StudentAcademyEligibility {
  eligible: boolean;
  reasons: AcademyIneligibility[];
  /** Human-readable explanation of the first reason (null when eligible). */
  message: string | null;
  eligibleClasses: { id: string; name: string }[];
  eligibleStreams: { id: string; name: string }[];
}

export interface StudentAcademyParticipation {
  attemptsUsed: number;
  maxAttempts: number;
  inProgressAttemptId: string | null;
  /** The latest finalized attempt with a visible result (if any). */
  bestResult: AttemptScoreDto | null;
}

export interface StudentAcademyQuizItem {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  banner: MediaDto | null;
  phase: Exclude<AcademyQuizPhase, 'DRAFT'>;
  startsAt: string;
  endsAt: string;
  timerMode: AcademyTimerMode;
  durationMinutes: number | null;
  questionTimeSeconds: number | null;
  questionsPerAttempt: number;
  hasPrizes: boolean;
  eligible: boolean;
  participation: StudentAcademyParticipation;
}

export interface StudentAcademyQuizDetail extends StudentAcademyQuizItem {
  description: string | null;
  instructions: string | null;
  prizes: AcademyPrizeDto[];
  resultsAt: string | null;
  timeZone: string;
  navigation: QuestionNavigation;
  requireAnswerToAdvance: boolean;
  totalMarks: number;
  negativeMarking: boolean;
  passPercent: number;
  resultRelease: ResultRelease;
  answerReveal: AnswerReveal;
  resultsPublished: boolean;
  /** False when the quiz never shows a leaderboard (HIDDEN). */
  leaderboardVisible: boolean;
  eligibility: StudentAcademyEligibility;
  /** Why a new attempt cannot start right now (null when it can). */
  cannotStartReason: string | null;
  /**
   * Minutes an attempt started NOW would get (late starters get only what is left before the
   * end); null when no attempt can start.
   */
  availableMinutesIfStartedNow: number | null;
  attempts: StudentAttemptSummary[];
  serverNow: string;
}

/**
 * One Academy Quiz attempt as the student sees it. Shaped like the course attempt DTO so the
 * shared player pieces (answer input, images, review) work unchanged.
 *
 * LINEAR navigation: while IN_PROGRESS, `questions` holds ONLY the current question (later
 * questions never reach the browser early); `currentPosition` is its 0-based position.
 */
export interface StudentAcademyAttemptDto {
  id: string;
  quiz: { id: string; slug: string; title: string };
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  deadlineAt: string;
  submittedAt: string | null;
  serverNow: string;
  timerMode: AcademyTimerMode;
  navigation: QuestionNavigation;
  requireAnswerToAdvance: boolean;
  questionCount: number;
  currentPosition: number | null;
  /** PER_QUESTION only: when the current question locks (server time). */
  currentQuestionDeadlineAt: string | null;
  negativeMarking: boolean;
  maxScore: number;
  questions: AttemptQuestionDto[];
  resultState: AttemptResultState;
  /** Scheduled release time when the result is waiting for it. */
  resultsAt: string | null;
  result: AttemptScoreDto | null;
  review: ReviewQuestionDto[] | null;
}

export interface StudentAcademyAttemptStartDto {
  resumed: boolean;
  attempt: StudentAcademyAttemptDto;
}

// --- Leaderboard, attempt management and results (Step 5) -------------------------------------

/** One ranked student. Never carries another student's id or email. */
export interface AcademyLeaderboardEntry {
  /** Competition ranking: equal score AND equal tie-break value share a rank (1, 2, 2, 4). */
  rank: number;
  /** Full name, or initials when the quiz masks names. */
  displayName: string;
  score: number;
  maxScore: number;
  percent: number;
  /** Seconds between start and submission of the ranked attempt. */
  timeTakenSeconds: number;
  submittedAt: string;
  /** True for the signed-in student's own row. */
  isMe: boolean;
}

export interface StudentAcademyLeaderboardDto {
  quiz: { id: string; slug: string; title: string };
  /** False when the leaderboard is hidden or not released yet (then `entries` is empty). */
  available: boolean;
  /**
   * True while attempts that expired unattended are still being finalized: nothing is ranked
   * until they are, and the request is safe to retry shortly.
   */
  finalizing: boolean;
  /** Why it is not available (null when it is). */
  unavailableReason: string | null;
  attemptCounting: AttemptCounting;
  tieBreak: RankingTieBreak;
  maskNames: boolean;
  totalRanked: number;
  entries: AcademyLeaderboardEntry[];
  /** The student's own entry (also when it is beyond the returned page); null if not ranked. */
  me: AcademyLeaderboardEntry | null;
}

/** Admin attempt row (managers only). */
export interface AdminAcademyAttemptItem {
  id: string;
  student: { userId: string; fullName: string; email: string };
  attemptNumber: number;
  status: AttemptStatus;
  evaluationStatus: 'PENDING' | 'EVALUATED' | null;
  startedAt: string;
  deadlineAt: string | null;
  submittedAt: string | null;
  /** Seconds from start to submission (null while running). */
  durationSeconds: number | null;
  maxScore: number;
  result: AttemptScoreDto | null;
  /** Questions answered (from the saved answers). */
  answeredCount: number;
  questionCount: number;
}

/** One page of a quiz's attempts for managers. */
export interface AdminAcademyAttemptPage extends Paginated<AdminAcademyAttemptItem> {
  /** Expired attempts not finalized yet (they still show as running until they are). */
  pendingFinalization: number;
}

export interface AdminAcademyAttemptDetail extends AdminAcademyAttemptItem {
  quiz: { id: string; slug: string; title: string };
  /** Per-question review with the key — finalized attempts only (empty while running). */
  questions: ReviewQuestionDto[];
  /** Whether students can currently see this score (release rules). */
  resultVisibleToStudent: boolean;
}

/** Admin leaderboard preview: always computed, never masked (managers only). */
export interface AdminAcademyLeaderboardDto {
  releasedToStudents: boolean;
  visibility: LeaderboardVisibility;
  /** Expired attempts not finalized yet; while > 0 `entries` is empty (retry shortly). */
  pendingFinalization: number;
  totalRanked: number;
  entries: (Omit<AcademyLeaderboardEntry, 'isMe'> & {
    userId: string;
    fullName: string;
    attemptId: string;
  })[];
}

/** A finalized Academy Quiz attempt on the student's Results page. */
export interface StudentAcademyResultItem {
  attemptId: string;
  quiz: { id: string; slug: string; title: string };
  attemptNumber: number;
  status: AttemptStatus;
  submittedAt: string;
  resultState: AttemptResultState;
  /** Scheduled release time while waiting for it. */
  resultsAt: string | null;
  result: AttemptScoreDto | null;
}

export type AcademyQuizVisibility = 'PUBLIC' | 'PRIVATE';

export type PublicAcademyQuizPhase = Exclude<AcademyQuizPhase, 'DRAFT'>;

export interface PublicParticipateSummaryDto {
  liveQuizzesCount: number;
  upcomingQuizzesCount: number;
  competitionsCount: number;
  assessmentsCount: number;
}

export interface PublicAcademyQuizItem {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  banner: MediaDto | null;
  phase: PublicAcademyQuizPhase;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  timerMode: AcademyTimerMode;
  durationMinutes: number | null;
  questionTimeSeconds: number | null;
  questionsPerAttempt: number;
  totalMarks: number;
  hasPrizes: boolean;
  eligibleClasses: { id: string; name: string }[];
  eligibleStreams: { id: string; name: string }[];
  registrationOpen: boolean;
  registrationClosedReason: string | null;
}

export interface PublicAcademyQuizDetail extends PublicAcademyQuizItem {
  description: string | null;
  instructions: string | null;
  prizes: AcademyPrizeDto[];
  navigation: QuestionNavigation;
  requireAnswerToAdvance: boolean;
  negativeMarking: boolean;
  passPercent: number;
  maxAttempts: number;
  resultsAt: string | null;
  resultRelease: ResultRelease;
  answerReveal: AnswerReveal;
  leaderboardVisible: boolean;
  serverNow: string;
}

export interface PublicParticipateActivitiesDto {
  summary: PublicParticipateSummaryDto;
  liveQuizzes: PublicAcademyQuizItem[];
  upcomingQuizzes: PublicAcademyQuizItem[];
  competitions: PublicAcademyQuizItem[];
  assessments: PublicAcademyQuizItem[];
  serverNow: string;
}

export type QuizRegistrationBlockCode =
  | 'EMAIL_NOT_VERIFIED'
  | 'NOT_STUDENT'
  | 'NOT_ELIGIBLE'
  | 'QUIZ_CLOSED'
  | 'QUIZ_ENDED'
  | 'QUIZ_UNAVAILABLE'
  | 'ALREADY_REGISTERED';

export interface QuizRegistrationStatusDto {
  quizId: string;
  slug: string;
  registered: boolean;
  registeredAt: string | null;
  emailVerified: boolean;
  canRegister: boolean;
  blockedCode: QuizRegistrationBlockCode | null;
  blockedReason: string | null;
  eligibleClasses: { id: string; name: string }[];
  eligibleStreams: { id: string; name: string }[];
}

export interface QuizRegistrationResultDto {
  registered: true;
  registeredAt: string;
  quizId: string;
  slug: string;
  title: string;
}

export interface PublicSitemapQuiz {
  slug: string;
  updatedAt: string;
}

export type ParticipantSort = 'newest' | 'oldest';
export type ParticipantVerificationFilter = 'ALL' | 'VERIFIED' | 'UNVERIFIED';
export type ParticipantRegistrationStatus = 'REGISTERED';

export interface AdminAcademyParticipantItem {
  id: string;
  userId: string;
  studentName: string;
  email: string;
  phone: string | null;
  registeredAt: string;
  emailVerified: boolean;
  status: ParticipantRegistrationStatus;
}

export interface AdminAcademyParticipantsPage {
  items: AdminAcademyParticipantItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  totalRegistered: number;
}
