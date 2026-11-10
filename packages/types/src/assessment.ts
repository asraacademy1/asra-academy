import type { PublicationStatus } from './catalog.js';

/**
 * Response shapes of the PHASE 09 assessment engine (docs/ASSESSMENTS.md): quizzes (QUIZ lessons),
 * examinations (scheduled, timed) and their attempts. Timestamps are ISO-8601 UTC instants produced
 * by the SERVER; marks are numbers with at most two decimals.
 *
 * Student payloads never contain correct-answer flags, explanations or scores before the
 * assessment's release rules allow it — the server omits them, the UI does not hide them.
 */

export type AssessmentStatus = 'DRAFT' | 'PUBLISHED' | 'CLOSED';
export type QuestionType = 'SINGLE_CHOICE' | 'TRUE_FALSE' | 'MULTIPLE_CHOICE' | 'SHORT_ANSWER';
export type AnswerReveal = 'NEVER' | 'AFTER_SUBMISSION' | 'AFTER_CLOSE';
export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'EXPIRED';
export type EvaluationStatus = 'PENDING' | 'EVALUATED';
export type AssessmentKind = 'QUIZ' | 'EXAM';

/**
 * What a student may know about an attempt:
 *   IN_PROGRESS        → still running
 *   PENDING_EVALUATION → finalized; written answers still need manual grading
 *   AWAITING_RELEASE   → evaluated, but results are not published yet
 *   RELEASED           → score (and, if allowed, answers) visible
 */
export type AttemptResultState =
  'IN_PROGRESS' | 'PENDING_EVALUATION' | 'AWAITING_RELEASE' | 'RELEASED';

// --- Media ----------------------------------------------------------------------------------

/** An optimized question/option image (≤ 100 KB) served from Cloudinary. */
export interface MediaDto {
  id: string;
  url: string;
  width: number;
  height: number;
}

/** `POST /faculty|admin/assessment-media` — the image can now be attached to a question. */
export interface MediaUploadDto extends MediaDto {
  bytes: number;
  format: 'webp' | 'jpg' | 'png';
}

// --- Authoring (faculty) --------------------------------------------------------------------

export interface QuestionOptionDto {
  id: string;
  text: string;
  isCorrect: boolean;
  position: number;
  image: MediaDto | null;
}

export interface QuestionDto {
  id: string;
  type: QuestionType;
  prompt: string;
  explanation: string | null;
  marks: number;
  negativeMarks: number;
  position: number;
  options: QuestionOptionDto[];
  /** Up to 3, in display order. */
  images: MediaDto[];
  /** Academy quizzes only (difficulty-based selection); always null for course quizzes/exams. */
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null;
}

export interface AttemptCounts {
  total: number;
  inProgress: number;
  /** Finalized attempts whose written answers still need grading. */
  pendingEvaluation: number;
  evaluated: number;
}

export interface QuizSettingsDto {
  id: string;
  status: AssessmentStatus;
  timeLimitMinutes: number | null;
  maxAttempts: number;
  passPercent: number;
  negativeMarking: boolean;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  questionsPerAttempt: number | null;
  showResultImmediately: boolean;
  answerReveal: AnswerReveal;
  resultsPublishedAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

/** A QUIZ lesson of an assigned course; `quiz` is null until the online quiz is set up. */
export interface FacultyQuizItem {
  lessonId: string;
  title: string;
  lessonStatus: PublicationStatus;
  course: { id: string; title: string };
  module: { id: string; title: string };
  chapter: { id: string; title: string };
  quiz: QuizSettingsDto | null;
  questionCount: number;
  /** Σ marks of all questions (an attempt's maximum is lower with a random subset). */
  totalMarks: number;
  attempts: AttemptCounts;
  updatedAt: string;
}

export interface FacultyQuizDetail extends FacultyQuizItem {
  instructions: string | null;
  questions: QuestionDto[];
  activeStudents: number;
}

export interface FacultyExamItem {
  id: string;
  title: string;
  status: AssessmentStatus;
  course: { id: string; title: string };
  opensAt: string;
  closesAt: string;
  durationMinutes: number;
  maxAttempts: number;
  passPercent: number;
  negativeMarking: boolean;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  answerReveal: AnswerReveal;
  resultsPublishedAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  questionCount: number;
  totalMarks: number;
  attempts: AttemptCounts;
  updatedAt: string;
}

export interface FacultyExamDetail extends FacultyExamItem {
  instructions: string | null;
  questions: QuestionDto[];
  activeStudents: number;
  /** True once the window has ended or the exam is closed (results can then be published). */
  windowEnded: boolean;
}

// --- Attempts (faculty view) ----------------------------------------------------------------

export interface AttemptScoreDto {
  rawScore: number;
  penalty: number;
  score: number;
  maxScore: number;
  percent: number;
  passed: boolean;
}

export interface FacultyAttemptItem {
  id: string;
  kind: AssessmentKind;
  assessment: { id: string; title: string; lessonId: string | null };
  course: { id: string; title: string };
  student: { userId: string; fullName: string };
  attemptNumber: number;
  status: AttemptStatus;
  evaluationStatus: EvaluationStatus | null;
  startedAt: string;
  deadlineAt: string | null;
  submittedAt: string | null;
  maxScore: number;
  /** Null until evaluated. */
  result: AttemptScoreDto | null;
}

export interface ReviewOptionDto {
  id: string;
  text: string;
  isCorrect: boolean;
  selected: boolean;
  image: MediaDto | null;
}

/** One question of a finalized attempt with the answer key — faculty, or a revealed student view. */
export interface ReviewQuestionDto {
  id: string;
  position: number;
  type: QuestionType;
  prompt: string;
  explanation: string | null;
  marks: number;
  negativeMarks: number;
  options: ReviewOptionDto[];
  images: MediaDto[];
  textAnswer: string | null;
  answered: boolean;
  awardedMarks: number | null;
  penalty: number | null;
  isCorrect: boolean | null;
  feedback: string | null;
  gradedAt: string | null;
}

export interface FacultyAttemptDetail extends FacultyAttemptItem {
  questions: ReviewQuestionDto[];
  gradedBy: string[];
}

// --- Student --------------------------------------------------------------------------------

export interface StudentAttemptSummary {
  id: string;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  deadlineAt: string | null;
  submittedAt: string | null;
  resultState: AttemptResultState;
  /** Only when `resultState` is RELEASED. */
  result: AttemptScoreDto | null;
}

/** The quiz panel of a QUIZ lesson. */
export interface StudentQuizDto {
  lessonId: string;
  /** False when faculty have not opened an online quiz for this lesson. */
  available: boolean;
  /** Why a new attempt cannot start right now (null when it can). */
  cannotStartReason: string | null;
  rules: {
    status: AssessmentStatus;
    timeLimitMinutes: number | null;
    maxAttempts: number;
    passPercent: number;
    negativeMarking: boolean;
    questionsPerAttempt: number;
    showResultImmediately: boolean;
    answerReveal: AnswerReveal;
  } | null;
  attemptsUsed: number;
  inProgressAttemptId: string | null;
  attempts: StudentAttemptSummary[];
}

/** A question as shown during an attempt: no answer key, no explanation. */
export interface AttemptQuestionDto {
  id: string;
  position: number;
  type: QuestionType;
  prompt: string;
  marks: number;
  negativeMarks: number;
  options: { id: string; text: string; image: MediaDto | null }[];
  images: MediaDto[];
  selectedOptionIds: string[];
  textAnswer: string | null;
  answerSequence: number;
}

export interface StudentAttemptDto {
  id: string;
  kind: AssessmentKind;
  assessment: {
    id: string;
    title: string;
    lessonId: string | null;
    course: { id: string; title: string };
  };
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  /** Authoritative server deadline (null = untimed quiz). The countdown is display-only. */
  deadlineAt: string | null;
  submittedAt: string | null;
  /** Server clock at response time, so the countdown can correct for a wrong device clock. */
  serverNow: string;
  negativeMarking: boolean;
  maxScore: number;
  /** Present while IN_PROGRESS (to answer) and after finalization (own answers, no key). */
  questions: AttemptQuestionDto[];
  resultState: AttemptResultState;
  result: AttemptScoreDto | null;
  /** Answer key and explanations — only when the release rules allow it. */
  review: ReviewQuestionDto[] | null;
}

export interface AnswerSaveResultDto {
  attemptId: string;
  questionId: string;
  /** False when a newer answer (higher sequence) had already been saved. */
  applied: boolean;
  answerSequence: number;
  status: AttemptStatus;
  deadlineAt: string | null;
  serverNow: string;
}

export type ExamAvailability = 'UPCOMING' | 'OPEN' | 'CLOSED';

export interface StudentExamItem {
  id: string;
  title: string;
  course: { id: string; title: string };
  opensAt: string;
  closesAt: string;
  durationMinutes: number;
  maxAttempts: number;
  availability: ExamAvailability;
  attemptsUsed: number;
  inProgressAttemptId: string | null;
  resultsPublished: boolean;
  questionCount: number;
  maxScore: number;
}

export interface StudentExamDetail extends StudentExamItem {
  instructions: string | null;
  passPercent: number;
  negativeMarking: boolean;
  hasWrittenQuestions: boolean;
  cannotStartReason: string | null;
  serverNow: string;
  attempts: StudentAttemptSummary[];
}

/** One released quiz/exam result of the signed-in student. */
export interface StudentAssessmentResultItem {
  attemptId: string;
  kind: AssessmentKind;
  title: string;
  course: { id: string; title: string };
  lessonId: string | null;
  attemptNumber: number;
  submittedAt: string;
  result: AttemptScoreDto;
}

/** Start response: the attempt plus whether an existing in-progress attempt was resumed. */
export interface AttemptStartDto {
  resumed: boolean;
  attempt: StudentAttemptDto;
}

// --- Assignments (PHASE 09 additions) -------------------------------------------------------

export interface SubmissionRevisionDto {
  version: number;
  body: string;
  attachmentUrl: string | null;
  submittedAt: string;
  late: boolean;
}

export interface GradeHistoryEntry {
  at: string;
  by: string | null;
  action: 'graded' | 'regraded' | 'released';
  marksAwarded: number | null;
  previousMarks: number | null;
}
