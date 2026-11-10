/**
 * Academy Quizzes — leaderboard, Results-page section and admin attempt screens (static render).
 * Release, ranking and permission rules are enforced and tested in
 * apps/api/tests/academy-quizzes-results.test.ts; these tests check what each screen shows.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PERMISSIONS,
  type AdminAcademyAttemptDetail,
  type AdminAcademyAttemptItem,
  type StudentAcademyLeaderboardDto,
} from '@asra/types';

import { canAccessAdminPath } from '@/components/admin/admin-shell';
import {
  AdminLeaderboard,
  AttemptDetailView,
  AttemptsTable,
  FinalizingNotice,
} from '@/components/admin/academy-quizzes/attempts';
import {
  AcademyResultCard,
  LeaderboardUnavailable,
  LeaderboardView,
} from '@/components/student/academy-quizzes/leaderboard';
import { formatElapsed } from '@/lib/student/academy-quizzes';

/** Static HTML without React's text separators. */
const render = (element: React.ReactElement) =>
  renderToStaticMarkup(element).replaceAll('<!-- -->', '');

const entry = (rank: number, displayName: string, isMe = false) => ({
  rank,
  displayName,
  score: rank === 1 ? 6 : 4,
  maxScore: 6,
  percent: rank === 1 ? 100 : 66.67,
  timeTakenSeconds: 245,
  submittedAt: '2026-12-01T05:10:00.000Z',
  isMe,
});

const board = (over: Partial<StudentAcademyLeaderboardDto> = {}): StudentAcademyLeaderboardDto => ({
  quiz: { id: 'q1', slug: 'olympiad', title: 'Olympiad' },
  available: true,
  finalizing: false,
  unavailableReason: null,
  attemptCounting: 'BEST',
  tieBreak: 'TIME_TAKEN',
  maskNames: false,
  totalRanked: 3,
  entries: [entry(1, 'Sam Rivera'), entry(2, 'Una Kapoor', true), entry(2, 'Tara Singh')],
  me: entry(2, 'Una Kapoor', true),
  ...over,
});

describe('student leaderboard', () => {
  it('formats time taken', () => {
    assert.equal(formatElapsed(245), '4 min 5 s');
    assert.equal(formatElapsed(59), '59 s');
    assert.equal(formatElapsed(120), '2 min');
  });

  it('shows ranks with shared ties, the student’s own row and the tie rule', () => {
    const html = render(<LeaderboardView board={board()} />);
    assert.match(html, /Your rank/);
    assert.match(html, /of 3/);
    assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
    assert.match(html, /\(you\)/);
    assert.match(html, /4 min 5 s/);
    assert.match(html, /shorter time taken/);
    assert.match(html, /share a rank/);
    assert.doesNotMatch(html, /userId|@/);
  });

  it('says when names are masked and when the student is not ranked', () => {
    const html = render(
      <LeaderboardView
        board={board({ maskNames: true, me: null, entries: [entry(1, 'S. R.')], totalRanked: 1 })}
      />,
    );
    assert.match(html, /shown as initials/);
    assert.match(html, /not on this leaderboard/);
    assert.match(html, /S\. R\./);
  });

  it('while results are being finalized: no ranking, a clear message and a retry', () => {
    const html = render(
      <LeaderboardUnavailable
        board={board({
          available: false,
          finalizing: true,
          unavailableReason: 'Results are being finalized. Please try again in a moment.',
          entries: [],
          me: null,
          totalRanked: 0,
        })}
        onRetry={() => {}}
      />,
    );
    assert.match(html, /Results are being finalized/);
    assert.match(html, /Try again/);
    assert.doesNotMatch(html, /Your rank/);
  });

  it('an unreleased leaderboard explains why and offers no retry', () => {
    const html = render(
      <LeaderboardUnavailable
        board={board({
          available: false,
          unavailableReason: 'The leaderboard appears after the quiz ends.',
          entries: [],
          me: null,
        })}
        onRetry={() => {}}
      />,
    );
    assert.match(html, /Leaderboard not available yet/);
    assert.match(html, /after the quiz ends/);
    assert.doesNotMatch(html, /Try again/);
  });
});

describe('Results page — Academy Quizzes', () => {
  const item = {
    attemptId: 'a1',
    quiz: { id: 'q1', slug: 'olympiad', title: 'Olympiad' },
    attemptNumber: 1,
    status: 'SUBMITTED' as const,
    submittedAt: '2026-12-01T05:10:00.000Z',
  };

  it('shows a released score and links to the attempt', () => {
    const html = render(
      <AcademyResultCard
        item={{
          ...item,
          resultState: 'RELEASED',
          resultsAt: null,
          result: { rawScore: 4, penalty: 0, score: 4, maxScore: 6, percent: 66.67, passed: true },
        }}
      />,
    );
    assert.match(html, /Academy Quiz · attempt 1/);
    assert.match(html, /66\.67%/);
    assert.match(html, /href="\/student\/academy-attempts\/a1"/);
  });

  it('shows the scheduled release time (IST) instead of a score while waiting', () => {
    const html = render(
      <AcademyResultCard
        item={{
          ...item,
          status: 'EXPIRED',
          resultState: 'AWAITING_RELEASE',
          resultsAt: '2026-12-02T04:30:00.000Z',
          result: null,
        }}
      />,
    );
    assert.match(html, /auto-submitted/);
    assert.match(html, /Results on/);
    assert.match(html, /IST/);
    assert.match(html, /Result not published yet/);
    assert.doesNotMatch(html, /%/);
  });
});

describe('admin attempt management', () => {
  const attempt = (over: Partial<AdminAcademyAttemptItem> = {}): AdminAcademyAttemptItem => ({
    id: 'att-1',
    student: { userId: 'u1', fullName: 'Sam Rivera', email: 'sam@example.test' },
    attemptNumber: 1,
    status: 'SUBMITTED',
    evaluationStatus: 'EVALUATED',
    startedAt: '2026-12-01T05:00:00.000Z',
    deadlineAt: '2026-12-01T05:30:00.000Z',
    submittedAt: '2026-12-01T05:04:00.000Z',
    durationSeconds: 240,
    maxScore: 6,
    result: { rawScore: 4, penalty: 0, score: 4, maxScore: 6, percent: 66.67, passed: true },
    answeredCount: 3,
    questionCount: 3,
    ...over,
  });

  it('lists student, status, duration, progress and score', () => {
    const html = render(
      <AttemptsTable
        quizId="q1"
        items={[
          attempt(),
          attempt({
            id: 'att-2',
            status: 'IN_PROGRESS',
            submittedAt: null,
            durationSeconds: null,
            result: null,
            answeredCount: 1,
          }),
        ]}
      />,
    );
    assert.match(html, /Sam Rivera/);
    assert.match(html, /sam@example\.test/);
    assert.match(html, /4 min/);
    assert.match(html, /3\/3/);
    assert.match(html, /In progress/);
    assert.match(html, /href="\/admin\/academy-quizzes\/q1\/attempts\/att-1"/);
  });

  const detail = (over: Partial<AdminAcademyAttemptDetail> = {}): AdminAcademyAttemptDetail => ({
    ...attempt(),
    quiz: { id: 'q1', slug: 'olympiad', title: 'Olympiad' },
    questions: [
      {
        id: 'aq1',
        position: 0,
        type: 'SINGLE_CHOICE',
        prompt: 'What is 2 + 3?',
        explanation: 'Add them.',
        marks: 2,
        negativeMarks: 0,
        options: [
          { id: 'o1', text: '4', isCorrect: false, selected: false, image: null },
          { id: 'o2', text: '5', isCorrect: true, selected: true, image: null },
        ],
        images: [],
        textAnswer: null,
        answered: true,
        awardedMarks: 2,
        penalty: 0,
        isCorrect: true,
        feedback: null,
        gradedAt: null,
      },
    ],
    resultVisibleToStudent: false,
    ...over,
  });

  it('a finalized attempt shows the answer review and whether students see the score', () => {
    const html = render(<AttemptDetailView quizId="q1" attempt={detail()} />);
    assert.match(html, /Answers and answer key/);
    assert.match(html, /correct answer/);
    assert.match(html, /Not yet \(release rules\)/);
  });

  it('a running attempt never shows answers', () => {
    const html = render(
      <AttemptDetailView
        quizId="q1"
        attempt={detail({ status: 'IN_PROGRESS', submittedAt: null, result: null, questions: [] })}
      />,
    );
    assert.match(html, /Attempt in progress/);
    assert.doesNotMatch(html, /answer key<\/h2>/);
    assert.doesNotMatch(html, /correct answer/);
  });

  it('leaderboard preview shows real names and the student visibility state', () => {
    const html = render(
      <AdminLeaderboard
        quizId="q1"
        board={{
          releasedToStudents: false,
          visibility: 'SIGNED_IN',
          pendingFinalization: 0,
          totalRanked: 1,
          entries: [
            { ...entry(1, 'S. R.'), userId: 'u1', fullName: 'Sam Rivera', attemptId: 'att-1' },
          ],
        }}
      />,
    );
    assert.match(html, /Sam Rivera/);
    assert.match(html, /not visible to students yet/);
  });

  it('leaderboard preview shows no partial ranking while attempts are being finalized', () => {
    const html = render(
      <AdminLeaderboard
        quizId="q1"
        board={{
          releasedToStudents: true,
          visibility: 'SIGNED_IN',
          pendingFinalization: 120,
          totalRanked: 0,
          entries: [],
        }}
      />,
    );
    assert.match(html, /Results are being finalized/);
    assert.match(html, /120 expired attempts are still being finalized/);
    assert.match(html, /Continue finalizing/);
    assert.doesNotMatch(html, /No evaluated attempts/);
    assert.match(
      render(<FinalizingNotice pending={1} onRetry={() => {}} />),
      /1 expired attempt is/,
    );
  });

  it('attempt pages are inside the manage-protected admin section', () => {
    const can = (permission: string) => permission === PERMISSIONS.ACADEMY_QUIZZES_MANAGE;
    assert.equal(canAccessAdminPath('/admin/academy-quizzes/q1/attempts/att-1', can), true);
    assert.equal(
      canAccessAdminPath('/admin/academy-quizzes/q1/attempts/att-1', () => false),
      false,
    );
  });
});
