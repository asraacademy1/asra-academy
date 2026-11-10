import type {
  AcademyQuizPhase,
  AnswerReveal,
  AcademyTimerMode,
  ResultRelease,
  StudentAcademyQuizTab,
} from '@asra/types';

/**
 * Student-side helpers for Academy Quizzes: labels, the fullscreen START requirement and the
 * browser-only "mark for review" list.
 *
 * Fullscreen is required to start or resume an attempt and nothing else: exits are NOT watched,
 * recorded or reported, and the server never sees fullscreen state.
 */

export const ACADEMY_TAB_LABELS: Record<StudentAcademyQuizTab, string> = {
  LIVE: 'Live now',
  UPCOMING: 'Upcoming',
  COMPLETED: 'Completed',
};

export const STUDENT_PHASE_LABELS: Record<Exclude<AcademyQuizPhase, 'DRAFT'>, string> = {
  UPCOMING: 'Upcoming',
  LIVE: 'Live now',
  ENDED: 'Ended',
  CLOSED: 'Closed',
};

export const STUDENT_PHASE_BADGE = {
  UPCOMING: 'info',
  LIVE: 'success',
  ENDED: 'secondary',
  CLOSED: 'secondary',
} as const;

export const academyQuizHref = (slug: string) =>
  `/student/academy-quizzes/${encodeURIComponent(slug)}`;
export const academyAttemptHref = (id: string) =>
  `/student/academy-attempts/${encodeURIComponent(id)}`;

export function timingLabel(quiz: {
  timerMode: AcademyTimerMode;
  durationMinutes: number | null;
  questionTimeSeconds: number | null;
}): string {
  if (quiz.timerMode === 'PER_QUESTION') {
    return `${quiz.questionTimeSeconds ?? 0} seconds per question`;
  }
  const minutes = quiz.durationMinutes ?? 0;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function releaseLabel(release: ResultRelease, resultsAtText: string | null): string {
  if (release === 'IMMEDIATE') return 'Your score is shown as soon as you submit.';
  if (release === 'SCHEDULED') {
    return `Scores are published on ${resultsAtText ?? 'the announced date'}.`;
  }
  return 'Scores are published by the academy after the quiz ends.';
}

export const STUDENT_REVEAL_LABELS: Record<AnswerReveal, string> = {
  NEVER: 'Correct answers are not shown.',
  AFTER_SUBMISSION: 'Correct answers are shown once your score is visible.',
  AFTER_CLOSE: 'Correct answers are shown after the quiz ends.',
};

/** 245 → "4 min 5 s"; 59 → "59 s". */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export const academyLeaderboardHref = (slug: string) =>
  `/student/academy-quizzes/${encodeURIComponent(slug)}/leaderboard`;

// --- Fullscreen (start requirement only) ----------------------------------------------------

type FullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

/** Whether this browser can put the page in fullscreen (iPhone Safari cannot). */
export function fullscreenSupported(doc: Document = document): boolean {
  const d = doc as FullscreenDocument;
  const element = d.documentElement as FullscreenElement;
  const api =
    typeof element.requestFullscreen === 'function' ||
    typeof element.webkitRequestFullscreen === 'function';
  return api && (d.fullscreenEnabled === true || d.webkitFullscreenEnabled === true);
}

export function isFullscreen(doc: Document = document): boolean {
  const d = doc as FullscreenDocument;
  return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement);
}

export type FullscreenOutcome = 'entered' | 'unsupported' | 'refused';

/**
 * Asks for fullscreen (must run inside a click handler). Resolves once the browser has actually
 * switched, or reports why not — the caller must not start an attempt unless it is 'entered'.
 */
export async function enterFullscreen(
  doc: Document = document,
  waitMs = 1500,
): Promise<FullscreenOutcome> {
  if (!fullscreenSupported(doc)) return 'unsupported';
  if (isFullscreen(doc)) return 'entered';
  const element = doc.documentElement as FullscreenElement;
  try {
    if (typeof element.requestFullscreen === 'function') {
      await element.requestFullscreen({ navigationUI: 'hide' });
    } else {
      await element.webkitRequestFullscreen!();
    }
  } catch {
    return 'refused';
  }
  // Older WebKit switches asynchronously after the call returns.
  const until = Date.now() + waitMs;
  while (!isFullscreen(doc) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return isFullscreen(doc) ? 'entered' : 'refused';
}

/** Leaves fullscreen when the attempt is over (a courtesy; never required). */
export function leaveFullscreen(doc: Document = document): void {
  if (!isFullscreen(doc)) return;
  const d = doc as FullscreenDocument;
  try {
    const result =
      typeof d.exitFullscreen === 'function' ? d.exitFullscreen() : d.webkitExitFullscreen?.();
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Nothing to do: the student can leave fullscreen themselves.
  }
}

export const FULLSCREEN_MESSAGES: Record<Exclude<FullscreenOutcome, 'entered'> | 'left', string> = {
  unsupported:
    'This browser or device cannot show the quiz in fullscreen, so the quiz cannot start here. Please use a computer, an Android phone or tablet, or an iPad with an up-to-date browser (Chrome, Edge, Firefox or Safari). iPhones do not support fullscreen pages.',
  refused:
    'Fullscreen was not turned on, so the quiz has not started and your time is not running. Press “Allow fullscreen” again and accept when the browser asks.',
  left: 'Fullscreen was turned off before the quiz started, so it has not started. Allow fullscreen again to continue.',
};

/**
 * THE start rule: the attempt is created (and its server timer started) only while the page is
 * in fullscreen, which the student granted in the previous step. Otherwise `create` is never
 * called and the student is asked to allow fullscreen again.
 */
export async function startOnlyInFullscreen<T>(
  inFullscreen: () => boolean,
  create: () => Promise<T>,
): Promise<{ started: true; value: T } | { started: false; message: string }> {
  if (!inFullscreen()) return { started: false, message: FULLSCREEN_MESSAGES.left };
  return { started: true, value: await create() };
}

/** Reopening a RUNNING attempt: the server timer is already counting down. */
export const RESUME_FULLSCREEN_MESSAGES: Record<Exclude<FullscreenOutcome, 'entered'>, string> = {
  unsupported:
    'This browser or device cannot show the quiz in fullscreen, so the attempt cannot continue here. Your time is still running: continue on a computer, an Android phone or tablet, or an iPad. Answers already saved are submitted automatically when the time is up.',
  refused:
    'Fullscreen was not turned on. Your attempt is still running and the time keeps counting down. Press “Allow fullscreen and continue” again and accept when the browser asks.',
};

// --- Mark for review (this browser only) ----------------------------------------------------

const reviewKey = (attemptId: string) => `asra:academy-review:${attemptId}`;

/** Questions the student marked for review on this device (never sent to the server). */
export function readMarked(attemptId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(reviewKey(attemptId));
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

export function writeMarked(attemptId: string, ids: ReadonlySet<string>): void {
  try {
    if (ids.size === 0) window.localStorage.removeItem(reviewKey(attemptId));
    else window.localStorage.setItem(reviewKey(attemptId), JSON.stringify([...ids]));
  } catch {
    // Storage unavailable (private mode, blocked): marks last for this page view only.
  }
}

export function clearMarked(attemptId: string): void {
  writeMarked(attemptId, new Set());
}
