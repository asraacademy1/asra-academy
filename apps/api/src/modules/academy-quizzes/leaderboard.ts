/**
 * Pure leaderboard rules (no database access; unit-tested directly).
 *
 *   1. Only finalized, evaluated attempts take part (the caller filters).
 *   2. One attempt per student: FIRST = their first attempt; BEST = highest score, then the better
 *      tie-break value, then the earlier attempt.
 *   3. Order: score (desc), then the tie-break (less time taken, or earlier submission), then the
 *      attempt id so the order is stable.
 *   4. Competition ranking: equal score AND equal tie-break value (whole seconds) share a rank
 *      (1, 2, 2, 4).
 *
 * Scores are compared in integer hundredths, never as floats.
 */

export type Counting = 'BEST' | 'FIRST';
export type TieBreak = 'TIME_TAKEN' | 'SUBMITTED_AT';

export interface RankCandidate {
  attemptId: string;
  userId: string;
  fullName: string;
  attemptNumber: number;
  scoreCents: number;
  maxScoreCents: number;
  percent: number;
  startedAt: Date;
  submittedAt: Date;
}

export type Ranked<T extends RankCandidate> = T & { rank: number; timeTakenSeconds: number };

/** Seconds taken, rounded exactly as the leaderboard displays it. */
const secondsTaken = (candidate: RankCandidate) =>
  Math.max(0, Math.round((candidate.submittedAt.getTime() - candidate.startedAt.getTime()) / 1000));

/**
 * Tie-break value in WHOLE seconds: two students who see the same score and the same time on the
 * leaderboard share a rank (millisecond differences nobody can see never decide a rank).
 */
const tieValue = (candidate: RankCandidate, tieBreak: TieBreak) =>
  tieBreak === 'TIME_TAKEN'
    ? secondsTaken(candidate)
    : Math.floor(candidate.submittedAt.getTime() / 1000);

/** Negative when `a` ranks above `b`. */
function compare(a: RankCandidate, b: RankCandidate, tieBreak: TieBreak): number {
  if (a.scoreCents !== b.scoreCents) return b.scoreCents - a.scoreCents;
  const byTie = tieValue(a, tieBreak) - tieValue(b, tieBreak);
  if (byTie !== 0) return byTie;
  return a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0;
}

/** The one attempt per student that is ranked. */
export function pickPerStudent<T extends RankCandidate>(
  rows: readonly T[],
  counting: Counting,
  tieBreak: TieBreak,
): T[] {
  const chosen = new Map<string, T>();
  for (const row of rows) {
    const current = chosen.get(row.userId);
    if (!current) {
      chosen.set(row.userId, row);
      continue;
    }
    if (counting === 'FIRST') {
      if (row.attemptNumber < current.attemptNumber) chosen.set(row.userId, row);
      continue;
    }
    const order = compare(row, current, tieBreak);
    if (order < 0 || (order === 0 && row.attemptNumber < current.attemptNumber)) {
      chosen.set(row.userId, row);
    }
  }
  return [...chosen.values()];
}

export function rankEntries<T extends RankCandidate>(
  candidates: readonly T[],
  tieBreak: TieBreak,
): Ranked<T>[] {
  const sorted = [...candidates].sort((a, b) => compare(a, b, tieBreak));
  const ranked: Ranked<T>[] = [];
  sorted.forEach((candidate, index) => {
    const previous = ranked[index - 1];
    const tied =
      previous !== undefined &&
      previous.scoreCents === candidate.scoreCents &&
      tieValue(previous, tieBreak) === tieValue(candidate, tieBreak);
    ranked.push({
      ...candidate,
      rank: tied ? previous.rank : index + 1,
      timeTakenSeconds: secondsTaken(candidate),
    });
  });
  return ranked;
}

/** "Riya Sharma" → "R. S." (masked leaderboards show initials only). */
export function maskName(fullName: string): string {
  const initials = fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${[...part][0]!.toUpperCase()}.`);
  return initials.length ? initials.join(' ') : 'Student';
}
