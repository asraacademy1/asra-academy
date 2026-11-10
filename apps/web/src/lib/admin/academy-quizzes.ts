import type {
  AcademyPrizeDto,
  AcademyQuizPhase,
  AdminAcademyQuizDetail,
  AnswerReveal,
  AttemptCounting,
  LeaderboardVisibility,
  MediaDto,
  QuestionNavigation,
  QuestionSelection,
  RankingTieBreak,
  ResultRelease,
} from '@asra/types';
import { ACADEMY_POST_PUBLISH_FIELDS, type AcademyQuizSettingsInput } from '@asra/validation';

import { istInputToIso, isoToIstInput } from '@/lib/faculty/portal';

/**
 * Pure helpers of the Academy Quiz admin screens (unit-tested): labels, form state ↔ request
 * body, which settings are locked after publication, and which lifecycle actions are available.
 * The API re-validates everything; these only shape what the screens offer.
 */

export const PHASE_LABELS: Record<AcademyQuizPhase, string> = {
  DRAFT: 'Draft',
  UPCOMING: 'Scheduled',
  LIVE: 'Live',
  ENDED: 'Ended',
  CLOSED: 'Closed',
};

export const PHASE_TONE: Record<
  AcademyQuizPhase,
  'secondary' | 'outline' | 'default' | 'destructive'
> = {
  DRAFT: 'outline',
  UPCOMING: 'secondary',
  LIVE: 'default',
  ENDED: 'secondary',
  CLOSED: 'destructive',
};

export const SELECTION_LABELS: Record<QuestionSelection, string> = {
  ALL: 'Every question, for every student',
  RANDOM: 'A random set of questions per student',
  BY_DIFFICULTY: 'A set number of easy, medium and hard questions',
};

export const NAVIGATION_LABELS: Record<QuestionNavigation, string> = {
  FREE: 'Free — question palette, go back and change answers',
  LINEAR: 'Forward only — one question at a time',
};

export const RESULT_RELEASE_LABELS: Record<ResultRelease, string> = {
  IMMEDIATE: 'Immediately after each attempt',
  SCHEDULED: 'At a scheduled time',
  MANUAL: 'When an administrator publishes them',
};

export const ANSWER_REVEAL_OPTIONS: Record<AnswerReveal, string> = {
  NEVER: 'Never',
  AFTER_SUBMISSION: 'As soon as results are visible',
  AFTER_CLOSE: 'After the quiz ends',
};

export const LEADERBOARD_LABELS: Record<LeaderboardVisibility, string> = {
  HIDDEN: 'Hidden',
  SIGNED_IN: 'Signed-in students',
  PUBLIC: 'Everyone (public page)',
};

export const COUNTING_LABELS: Record<AttemptCounting, string> = {
  BEST: 'Best attempt',
  FIRST: 'First attempt',
};

export const TIE_BREAK_LABELS: Record<RankingTieBreak, string> = {
  TIME_TAKEN: 'Less time taken ranks higher',
  SUBMITTED_AT: 'Earlier submission ranks higher',
};

export const DIFFICULTY_LABELS = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' } as const;

/** The academy's display zone: schedule inputs are entered and shown in IST (as for exams). */
export const ACADEMY_TIME_ZONE = 'Asia/Kolkata';

export interface PrizeDraft {
  key: string;
  position: string;
  title: string;
  description: string;
  image: MediaDto | null;
}

/** Everything the settings form edits, as input strings/flags. */
export interface QuizFormState {
  title: string;
  slug: string;
  summary: string;
  description: string;
  instructions: string;
  banner: MediaDto | null;
  prizes: PrizeDraft[];
  startsAt: string;
  endsAt: string;
  resultsAt: string;
  timerMode: 'OVERALL' | 'PER_QUESTION';
  durationMinutes: string;
  questionTimeSeconds: string;
  navigation: QuestionNavigation;
  requireAnswerToAdvance: boolean;
  selection: QuestionSelection;
  questionsPerAttempt: string;
  easyCount: string;
  mediumCount: string;
  hardCount: string;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  negativeMarking: boolean;
  passPercent: string;
  maxAttempts: string;
  eligibleClassIds: string[];
  eligibleStreamIds: string[];
  resultRelease: ResultRelease;
  answerReveal: AnswerReveal;
  leaderboardVisibility: LeaderboardVisibility;
  maskNames: boolean;
  attemptCounting: AttemptCounting;
  tieBreak: RankingTieBreak;
}

let prizeSeq = 0;
export const prizeKey = () => `prize-${(prizeSeq += 1)}`;

const text = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : String(value);

export function emptyForm(): QuizFormState {
  return {
    title: '',
    slug: '',
    summary: '',
    description: '',
    instructions: '',
    banner: null,
    prizes: [],
    startsAt: '',
    endsAt: '',
    resultsAt: '',
    timerMode: 'OVERALL',
    durationMinutes: '30',
    questionTimeSeconds: '60',
    navigation: 'FREE',
    requireAnswerToAdvance: false,
    selection: 'ALL',
    questionsPerAttempt: '',
    easyCount: '',
    mediumCount: '',
    hardCount: '',
    shuffleQuestions: false,
    shuffleOptions: false,
    negativeMarking: false,
    passPercent: '40',
    maxAttempts: '1',
    eligibleClassIds: [],
    eligibleStreamIds: [],
    resultRelease: 'IMMEDIATE',
    answerReveal: 'AFTER_CLOSE',
    leaderboardVisibility: 'SIGNED_IN',
    maskNames: false,
    attemptCounting: 'BEST',
    tieBreak: 'TIME_TAKEN',
  };
}

export function formFromDetail(quiz: AdminAcademyQuizDetail): QuizFormState {
  const s = quiz.settings;
  return {
    title: s.title,
    slug: s.slug,
    summary: s.summary ?? '',
    description: s.description ?? '',
    instructions: s.instructions ?? '',
    banner: quiz.banner,
    prizes: quiz.prizes.map((prize: AcademyPrizeDto) => ({
      key: prizeKey(),
      position: String(prize.position),
      title: prize.title,
      description: prize.description ?? '',
      image: prize.image,
    })),
    startsAt: isoToIstInput(s.startsAt),
    endsAt: isoToIstInput(s.endsAt),
    resultsAt: isoToIstInput(s.resultsAt),
    timerMode: s.timerMode,
    durationMinutes: text(s.durationMinutes) || '30',
    questionTimeSeconds: text(s.questionTimeSeconds) || '60',
    navigation: s.navigation,
    requireAnswerToAdvance: s.requireAnswerToAdvance,
    selection: s.selection,
    questionsPerAttempt: text(s.questionsPerAttempt),
    easyCount: text(s.easyCount),
    mediumCount: text(s.mediumCount),
    hardCount: text(s.hardCount),
    shuffleQuestions: s.shuffleQuestions,
    shuffleOptions: s.shuffleOptions,
    negativeMarking: s.negativeMarking,
    passPercent: String(s.passPercent),
    maxAttempts: String(s.maxAttempts),
    eligibleClassIds: s.eligibleClassIds,
    eligibleStreamIds: s.eligibleStreamIds,
    resultRelease: s.resultRelease,
    answerReveal: s.answerReveal,
    leaderboardVisibility: s.leaderboardVisibility,
    maskNames: s.maskNames,
    attemptCounting: s.attemptCounting,
    tieBreak: s.tieBreak,
  };
}

/** "" → null; anything else → a number (invalid text becomes NaN and fails validation). */
const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));
const trimmedOrNull = (value: string) => (value.trim() === '' ? null : value);

/**
 * Form → request body. Fields that do not apply to the chosen mode are sent as null/false, so the
 * body always satisfies the cross-field rules for what the administrator actually chose.
 * Invalid times become `undefined` (the field then reports "Enter a valid date and time").
 */
export function formToBody(form: QuizFormState) {
  const perQuestion = form.timerMode === 'PER_QUESTION';
  const navigation: QuestionNavigation = perQuestion ? 'LINEAR' : form.navigation;
  return {
    title: form.title,
    ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
    summary: trimmedOrNull(form.summary),
    description: trimmedOrNull(form.description),
    instructions: trimmedOrNull(form.instructions),
    bannerMediaId: form.banner?.id ?? null,
    prizes: form.prizes.map((prize) => ({
      position: Number(prize.position),
      title: prize.title,
      description: trimmedOrNull(prize.description),
      imageMediaId: prize.image?.id ?? null,
    })),
    startsAt: istInputToIso(form.startsAt) ?? undefined,
    endsAt: istInputToIso(form.endsAt) ?? undefined,
    resultsAt:
      form.resultRelease === 'SCHEDULED' ? (istInputToIso(form.resultsAt) ?? undefined) : null,
    timeZone: ACADEMY_TIME_ZONE,
    timerMode: form.timerMode,
    durationMinutes: perQuestion ? null : numberOrNull(form.durationMinutes),
    questionTimeSeconds: perQuestion ? numberOrNull(form.questionTimeSeconds) : null,
    navigation,
    requireAnswerToAdvance: navigation === 'LINEAR' ? form.requireAnswerToAdvance : false,
    selection: form.selection,
    questionsPerAttempt:
      form.selection === 'RANDOM' ? numberOrNull(form.questionsPerAttempt) : null,
    easyCount: form.selection === 'BY_DIFFICULTY' ? (numberOrNull(form.easyCount) ?? 0) : null,
    mediumCount: form.selection === 'BY_DIFFICULTY' ? (numberOrNull(form.mediumCount) ?? 0) : null,
    hardCount: form.selection === 'BY_DIFFICULTY' ? (numberOrNull(form.hardCount) ?? 0) : null,
    shuffleQuestions: form.shuffleQuestions,
    shuffleOptions: form.shuffleOptions,
    negativeMarking: form.negativeMarking,
    passPercent: Number(form.passPercent),
    maxAttempts: Number(form.maxAttempts),
    eligibleClassIds: form.eligibleClassIds,
    eligibleStreamIds: form.eligibleStreamIds,
    resultRelease: form.resultRelease,
    answerReveal: form.answerReveal,
    leaderboardVisibility: form.leaderboardVisibility,
    maskNames: form.maskNames,
    attemptCounting: form.attemptCounting,
    tieBreak: form.tieBreak,
  };
}

/** Body keys that are locked once the quiz is published (the server enforces the same list). */
const EDITABLE_AFTER_PUBLISH = new Set<string>(ACADEMY_POST_PUBLISH_FIELDS);
export const isLockedAfterPublish = (field: keyof AcademyQuizSettingsInput | 'banner') =>
  !EDITABLE_AFTER_PUBLISH.has(field === 'banner' ? 'bannerMediaId' : field);

/** A PATCH for a published quiz: only fields that may still change (the rest are frozen). */
export function publishedPatch(body: ReturnType<typeof formToBody>) {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => EDITABLE_AFTER_PUBLISH.has(key)),
  );
}

export type QuizAction = 'publish' | 'unpublish' | 'close' | 'reopen' | 'delete' | 'publishResults';

/**
 * Lifecycle actions offered for a quiz (mirrors the API's rules; the server re-checks):
 * publish — draft; unpublish — published and never attempted; close — published;
 * reopen — closed before the end time; delete — draft never attempted; publish results —
 * manual release, after the end (or closed), not yet published.
 */
export function availableActions(quiz: AdminAcademyQuizDetail, now = new Date(quiz.serverNow)) {
  const actions: QuizAction[] = [];
  const attempted = quiz.attempts.total > 0;
  const ended = now >= new Date(quiz.endsAt);
  if (quiz.status === 'DRAFT') {
    actions.push('publish');
    if (!attempted) actions.push('delete');
  }
  if (quiz.status === 'PUBLISHED') {
    if (!attempted) actions.push('unpublish');
    actions.push('close');
  }
  if (quiz.status === 'CLOSED' && !ended) actions.push('reopen');
  if (
    quiz.status !== 'DRAFT' &&
    quiz.settings.resultRelease === 'MANUAL' &&
    !quiz.resultsPublishedAt &&
    (ended || quiz.status === 'CLOSED')
  ) {
    actions.push('publishResults');
  }
  return actions;
}

/** "45 min" / "60 s per question". */
export function timingSummary(quiz: Pick<AdminAcademyQuizDetail, 'settings'>) {
  const s = quiz.settings;
  return s.timerMode === 'OVERALL'
    ? `${s.durationMinutes} min overall`
    : `${s.questionTimeSeconds} s per question`;
}
