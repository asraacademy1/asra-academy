'use client';

import type {
  AcademyLeaderboardEntry,
  Paginated,
  StudentAcademyLeaderboardDto,
  StudentAcademyResultItem,
} from '@asra/types';
import { Medal, Trophy } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiClientError } from '@/lib/api';
import {
  formatMarksValue,
  RESULT_STATE_BADGE,
  RESULT_STATE_LABELS,
  scoreSummary,
} from '@/lib/assessments';
import { formatDateTime } from '@/lib/format';
import { academyAttemptHref, academyQuizHref, formatElapsed } from '@/lib/student/academy-quizzes';
import { cn } from '@/lib/utils';

import { ErrorPanel, ListPager, LoadingPanel } from '../student-ui';
import { errorMessage, useApiResource, useStudentApi, withPage } from '../use-student';

const home = { label: 'Dashboard', href: '/student/dashboard' };
const listCrumb = { label: 'Academy Quizzes', href: '/student/academy-quizzes' };

const TIE_BREAK_TEXT = {
  TIME_TAKEN: 'Equal scores are ranked by the shorter time taken.',
  SUBMITTED_AT: 'Equal scores are ranked by the earlier submission.',
} as const;

/** `/student/academy-quizzes/[slug]/leaderboard` — the released ranking (API applies the rules). */
export function StudentAcademyLeaderboardPage({ slug }: { slug: string }) {
  const api = useStudentApi();
  const path = `/student/academy-quizzes/${encodeURIComponent(slug)}/leaderboard?limit=100`;
  const board = useApiResource(path, () => api.get<StudentAcademyLeaderboardDto>(path));

  if (board.error && !board.data) {
    const missing =
      board.error instanceof ApiClientError && [403, 404].includes(board.error.status);
    return (
      <>
        <PageHeader title="Leaderboard" breadcrumbs={[home, listCrumb, { label: 'Leaderboard' }]} />
        <ErrorPanel
          title={missing ? 'Leaderboard not available' : undefined}
          message={
            missing
              ? 'This quiz does not exist or is not open to students.'
              : errorMessage(board.error)
          }
          onRetry={missing ? undefined : board.reload}
        />
      </>
    );
  }
  if (!board.data) return <LoadingPanel label="Loading the leaderboard…" rows={6} />;
  const data = board.data;
  return (
    <>
      <PageHeader
        title={`${data.quiz.title} — Leaderboard`}
        breadcrumbs={[
          home,
          listCrumb,
          { label: data.quiz.title, href: academyQuizHref(data.quiz.slug) },
          { label: 'Leaderboard' },
        ]}
        description={
          data.available
            ? `${data.totalRanked} student${data.totalRanked === 1 ? '' : 's'} ranked · ${data.attemptCounting === 'BEST' ? 'best attempt counts' : 'first attempt counts'}`
            : undefined
        }
      />
      {!data.available ? (
        <LeaderboardUnavailable board={data} onRetry={board.reload} />
      ) : (
        <LeaderboardView board={data} />
      )}
    </>
  );
}

/** Why the leaderboard is not shown; while results are being finalized, a safe retry. */
export function LeaderboardUnavailable({
  board,
  onRetry,
}: {
  board: StudentAcademyLeaderboardDto;
  onRetry: () => void;
}) {
  return (
    <Alert
      tone="info"
      title={board.finalizing ? 'Results are being finalized' : 'Leaderboard not available yet'}
    >
      <p>{board.unavailableReason}</p>
      {board.finalizing ? (
        <Button className="mt-2" size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Alert>
  );
}

export function LeaderboardView({ board }: { board: StudentAcademyLeaderboardDto }) {
  return (
    <div className="grid gap-4">
      {board.me ? (
        <Card className="flex-row flex-wrap items-center gap-4">
          <Medal className="size-8 text-asra-gold-700" aria-hidden />
          <div className="grid">
            <span className="type-caption text-muted-foreground">Your rank</span>
            <span className="type-h3 text-heading tabular-nums">
              {board.me.rank}{' '}
              <span className="type-body text-muted-foreground">of {board.totalRanked}</span>
            </span>
          </div>
          <span className="type-body-sm tabular-nums">
            {formatMarksValue(board.me.score)}/{formatMarksValue(board.me.maxScore)} ·{' '}
            {board.me.percent}% · {formatElapsed(board.me.timeTakenSeconds)}
          </span>
        </Card>
      ) : (
        <p className="type-body-sm text-muted-foreground">
          You are not on this leaderboard (no evaluated attempt).
        </p>
      )}
      {board.entries.length === 0 ? (
        <p className="type-body-sm text-muted-foreground">Nobody has been ranked yet.</p>
      ) : (
        <LeaderboardTable entries={board.entries} />
      )}
      <p className="type-caption text-muted-foreground">
        {TIE_BREAK_TEXT[board.tieBreak]} Students with the same score and the same{' '}
        {board.tieBreak === 'TIME_TAKEN' ? 'time' : 'submission time'} share a rank.
        {board.maskNames ? ' Names are shown as initials.' : ''}
      </p>
    </div>
  );
}

export function LeaderboardTable({ entries }: { entries: AcademyLeaderboardEntry[] }) {
  return (
    <Table scrollLabel="Leaderboard">
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">Rank</TableHead>
          <TableHead>Student</TableHead>
          <TableHead className="text-right">Score</TableHead>
          <TableHead className="text-right">Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry, index) => (
          <TableRow
            key={`${entry.rank}-${index}`}
            aria-current={entry.isMe ? 'true' : undefined}
            className={cn(entry.isMe && 'bg-secondary font-semibold')}
          >
            <TableCell className="tabular-nums">
              {entry.rank <= 3 ? (
                <span className="inline-flex items-center gap-1">
                  <Trophy
                    aria-hidden
                    className={cn(
                      'size-4',
                      entry.rank === 1 ? 'text-asra-gold-700' : 'text-muted-foreground',
                    )}
                  />
                  {entry.rank}
                </span>
              ) : (
                entry.rank
              )}
            </TableCell>
            <TableCell className="break-words">
              {entry.displayName}
              {entry.isMe ? (
                <span className="type-caption text-muted-foreground"> (you)</span>
              ) : null}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap tabular-nums">
              {formatMarksValue(entry.score)}/{formatMarksValue(entry.maxScore)}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap tabular-nums">
              {formatElapsed(entry.timeTakenSeconds)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// --- Results page section -------------------------------------------------------------------

/** Academy Quiz attempts on the student's Results page (release rules applied by the API). */
export function AcademyResults() {
  const api = useStudentApi();
  const [page, setPage] = React.useState(1);
  const url = withPage('/student/academy-results', page);
  const list = useApiResource(url, () => api.get<Paginated<StudentAcademyResultItem>>(url));
  if (list.error && !list.data) {
    // Students without Academy Quiz access simply have no section content.
    if (list.error instanceof ApiClientError && list.error.status === 403) return null;
    return <ErrorPanel message={errorMessage(list.error)} onRetry={list.reload} />;
  }
  if (!list.data) return <LoadingPanel label="Loading Academy Quiz results…" rows={2} />;
  if (list.data.items.length === 0) {
    return (
      <p className="type-body-sm text-muted-foreground">
        No Academy Quiz attempts yet.{' '}
        <Link href="/student/academy-quizzes" className="underline hover:text-primary">
          See the Academy Quizzes
        </Link>
        .
      </p>
    );
  }
  return (
    <div className="grid gap-4">
      <ul className="grid gap-3">
        {list.data.items.map((item) => (
          <li key={item.attemptId}>
            <AcademyResultCard item={item} />
          </li>
        ))}
      </ul>
      <ListPager
        pagination={list.data.pagination}
        onPageChange={setPage}
        label="Academy result pages"
      />
    </div>
  );
}

export function AcademyResultCard({ item }: { item: StudentAcademyResultItem }) {
  return (
    <Card className="gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="grid gap-1">
        <span className="type-caption text-muted-foreground">
          Academy Quiz · attempt {item.attemptNumber} ·{' '}
          {item.status === 'EXPIRED' ? 'auto-submitted' : 'submitted'}{' '}
          {formatDateTime(item.submittedAt)} IST
        </span>
        <h3 className="type-h4 text-heading">
          <Link
            href={academyAttemptHref(item.attemptId)}
            className="rounded-sm hover:text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {item.quiz.title}
          </Link>
        </h3>
        {item.resultState === 'AWAITING_RELEASE' && item.resultsAt ? (
          <span className="type-caption text-muted-foreground">
            Results on {formatDateTime(item.resultsAt)} IST
          </span>
        ) : null}
      </div>
      {item.result ? (
        <Badge variant={item.result.passed ? 'success' : 'warning'} className="tabular-nums">
          {scoreSummary(item.result)}
        </Badge>
      ) : (
        <Badge variant={RESULT_STATE_BADGE[item.resultState]}>
          {RESULT_STATE_LABELS[item.resultState]}
        </Badge>
      )}
    </Card>
  );
}
