'use client';

import type {
  AdminAcademyAttemptDetail,
  AdminAcademyAttemptItem,
  AdminAcademyAttemptPage,
  AdminAcademyLeaderboardDto,
} from '@asra/types';
import { Eye, ListChecks, Trophy } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/layout/page-header';
import { ReviewList } from '@/components/student/attempt-player';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LEADERBOARD_LABELS } from '@/lib/admin/academy-quizzes';
import { ATTEMPT_STATUS_LABELS, formatMarksValue, scoreSummary } from '@/lib/assessments';
import { formatDateTime } from '@/lib/format';
import { formatElapsed } from '@/lib/student/academy-quizzes';

import { FilterSelect, ListFrame, SearchBox, Section, usePagedList } from '../admin-kit';
import { ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, useAdminApi, useApiResource } from '../use-admin';

/**
 * Academy Quiz attempt management and the leaderboard preview (managers only; the API checks
 * `academy_quizzes.manage` on every request). Running attempts show progress, never answers.
 */

const STATUS_OPTIONS = [
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'EXPIRED', label: 'Auto-submitted' },
];

const STATUS_TONE = { IN_PROGRESS: 'warning', SUBMITTED: 'success', EXPIRED: 'secondary' } as const;

export const attemptDetailHref = (quizId: string, attemptId: string) =>
  `/admin/academy-quizzes/${quizId}/attempts/${attemptId}`;

export function AttemptStatusBadge({ status }: { status: AdminAcademyAttemptItem['status'] }) {
  return <Badge variant={STATUS_TONE[status]}>{ATTEMPT_STATUS_LABELS[status]}</Badge>;
}

/**
 * Shown while attempts that expired unattended are still being finalized (the API finalizes a
 * bounded number per request; reloading continues the work and is always safe).
 */
export function FinalizingNotice({ pending, onRetry }: { pending: number; onRetry: () => void }) {
  return (
    <Alert tone="warning" title="Results are being finalized">
      <p>
        {pending} expired attempt{pending === 1 ? ' is' : 's are'} still being finalized. Rankings
        and result publication wait until all are done.
      </p>
      <Button className="mt-2" size="sm" variant="outline" onClick={onRetry}>
        Continue finalizing
      </Button>
    </Alert>
  );
}

export function AcademyAttemptsSection({ quizId }: { quizId: string }) {
  const [status, setStatus] = React.useState('');
  const [q, setQ] = React.useState('');
  const { list, setPage } = usePagedList<AdminAcademyAttemptItem>(
    `/admin/academy-quizzes/${quizId}/attempts`,
    { status: status || undefined, q: q || undefined },
  );
  const pending =
    (list.data as Partial<AdminAcademyAttemptPage> | undefined)?.pendingFinalization ?? 0;
  return (
    <Section
      title="Attempts"
      description="Every attempt, newest first. Expired attempts are finalized when this list loads."
    >
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          id="attempt-status"
          label="Status"
          value={status}
          onChange={setStatus}
          options={STATUS_OPTIONS}
        />
        <SearchBox id="attempt-search" placeholder="Student name or email" onSearch={setQ} />
      </div>
      {pending > 0 ? <FinalizingNotice pending={pending} onRetry={list.reload} /> : null}
      <ListFrame
        list={list}
        setPage={setPage}
        label="attempts"
        icon={<ListChecks />}
        emptyTitle="No attempts yet"
        emptyText={
          status || q
            ? 'Nothing matches these filters.'
            : 'Attempts appear here as students take the quiz.'
        }
      >
        {(items) => <AttemptsTable quizId={quizId} items={items} />}
      </ListFrame>
    </Section>
  );
}

export function AttemptsTable({
  quizId,
  items,
}: {
  quizId: string;
  items: AdminAcademyAttemptItem[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Student</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Started (IST)</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right">Answered</TableHead>
          <TableHead className="text-right">Score</TableHead>
          <TableHead className="text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((attempt) => (
          <TableRow key={attempt.id}>
            <TableCell>
              <span className="type-label text-heading">{attempt.student.fullName}</span>
              <span className="block type-caption text-muted-foreground">
                {attempt.student.email} · attempt {attempt.attemptNumber}
              </span>
            </TableCell>
            <TableCell>
              <AttemptStatusBadge status={attempt.status} />
            </TableCell>
            <TableCell className="type-body-sm whitespace-nowrap">
              {formatDateTime(attempt.startedAt)}
              {attempt.submittedAt ? (
                <span className="block text-muted-foreground">
                  submitted {formatDateTime(attempt.submittedAt)}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap tabular-nums">
              {attempt.durationSeconds === null ? '—' : formatElapsed(attempt.durationSeconds)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {attempt.answeredCount}/{attempt.questionCount}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap tabular-nums">
              {attempt.result ? scoreSummary(attempt.result) : '—'}
            </TableCell>
            <TableCell className="text-right">
              <Button asChild size="icon-sm" variant="ghost">
                <Link
                  href={attemptDetailHref(quizId, attempt.id)}
                  aria-label={`Open attempt ${attempt.attemptNumber} of ${attempt.student.fullName}`}
                >
                  <Eye aria-hidden />
                </Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function AdminLeaderboardSection({ quizId }: { quizId: string }) {
  const api = useAdminApi();
  const path = `/admin/academy-quizzes/${quizId}/leaderboard`;
  const board = useApiResource(path, () => api.get<AdminAcademyLeaderboardDto>(path));
  return (
    <Section
      title="Leaderboard"
      description="Live ranking for administrators: unmasked, at any time. Students see it only when the rules allow."
    >
      {board.error && !board.data ? (
        <ErrorPanel message={errorMessage(board.error)} onRetry={board.reload} />
      ) : !board.data ? (
        <LoadingPanel rows={3} />
      ) : (
        <AdminLeaderboard board={board.data} quizId={quizId} onRetry={board.reload} />
      )}
    </Section>
  );
}

export function AdminLeaderboard({
  board,
  quizId,
  onRetry,
}: {
  board: AdminAcademyLeaderboardDto;
  quizId: string;
  onRetry?: () => void;
}) {
  return (
    <div className="grid gap-3">
      {board.pendingFinalization > 0 ? (
        <FinalizingNotice pending={board.pendingFinalization} onRetry={onRetry ?? (() => {})} />
      ) : null}
      <p className="type-body-sm">
        Student visibility: {LEADERBOARD_LABELS[board.visibility]} ·{' '}
        {board.releasedToStudents ? (
          <span className="text-success">visible to students now</span>
        ) : (
          <span className="text-muted-foreground">not visible to students yet</span>
        )}
      </p>
      {board.pendingFinalization > 0 ? null : board.entries.length === 0 ? (
        <p className="type-body-sm text-muted-foreground">No evaluated attempts to rank yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Rank</TableHead>
                <TableHead>Student</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Attempt</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {board.entries.map((entry) => (
                <TableRow key={entry.attemptId}>
                  <TableCell className="tabular-nums">
                    {entry.rank === 1 ? (
                      <Trophy className="mr-1 inline size-4 text-asra-gold-700" aria-hidden />
                    ) : null}
                    {entry.rank}
                  </TableCell>
                  <TableCell>{entry.fullName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMarksValue(entry.score)}/{formatMarksValue(entry.maxScore)} (
                    {entry.percent}%)
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatElapsed(entry.timeTakenSeconds)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={attemptDetailHref(quizId, entry.attemptId)}
                      className="type-label text-primary hover:underline"
                    >
                      Attempt
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="type-caption text-muted-foreground">
        Equal score and equal tie-break value share a rank.
      </p>
    </div>
  );
}

/** `/admin/academy-quizzes/[id]/attempts/[attemptId]` */
export function AdminAcademyAttemptPage({
  quizId,
  attemptId,
}: {
  quizId: string;
  attemptId: string;
}) {
  const api = useAdminApi();
  const path = `/admin/academy-attempts/${attemptId}`;
  const attempt = useApiResource(path, () => api.get<AdminAcademyAttemptDetail>(path));
  if (attempt.error && !attempt.data) {
    return <ErrorPanel message={errorMessage(attempt.error)} onRetry={attempt.reload} />;
  }
  if (!attempt.data) return <LoadingPanel label="Loading the attempt…" />;
  return <AttemptDetailView quizId={quizId} attempt={attempt.data} />;
}

export function AttemptDetailView({
  quizId,
  attempt,
}: {
  quizId: string;
  attempt: AdminAcademyAttemptDetail;
}) {
  const running = attempt.status === 'IN_PROGRESS';
  return (
    <div className="grid gap-6">
      <PageHeader
        title={`${attempt.student.fullName} — attempt ${attempt.attemptNumber}`}
        breadcrumbs={[
          { label: 'Academy Quizzes', href: '/admin/academy-quizzes' },
          { label: attempt.quiz.title, href: `/admin/academy-quizzes/${quizId}` },
          { label: `Attempt ${attempt.attemptNumber}` },
        ]}
        description={attempt.student.email}
        actions={<AttemptStatusBadge status={attempt.status} />}
      />
      <div className="grid gap-4 md:grid-cols-3">
        <Section title="Timing (IST)">
          <dl className="grid gap-2 type-body-sm">
            <Fact label="Started">{formatDateTime(attempt.startedAt)}</Fact>
            {attempt.deadlineAt ? (
              <Fact label="Deadline">{formatDateTime(attempt.deadlineAt)}</Fact>
            ) : null}
            <Fact label="Submitted">
              {attempt.submittedAt ? formatDateTime(attempt.submittedAt) : 'Not yet'}
            </Fact>
            <Fact label="Duration">
              {attempt.durationSeconds === null ? '—' : formatElapsed(attempt.durationSeconds)}
            </Fact>
          </dl>
        </Section>
        <Section title="Score">
          <dl className="grid gap-2 type-body-sm">
            <Fact label="Marks">
              {attempt.result
                ? `${formatMarksValue(attempt.result.score)} / ${formatMarksValue(attempt.result.maxScore)}`
                : `— / ${formatMarksValue(attempt.maxScore)}`}
            </Fact>
            <Fact label="Percentage">{attempt.result ? `${attempt.result.percent}%` : '—'}</Fact>
            <Fact label="Result">
              {attempt.result ? (attempt.result.passed ? 'Passed' : 'Not passed') : '—'}
            </Fact>
            <Fact label="Penalty">
              {attempt.result && attempt.result.penalty > 0
                ? `−${formatMarksValue(attempt.result.penalty)}`
                : 'None'}
            </Fact>
          </dl>
        </Section>
        <Section title="Progress">
          <dl className="grid gap-2 type-body-sm">
            <Fact label="Answered">
              {attempt.answeredCount} of {attempt.questionCount}
            </Fact>
            <Fact label="Student sees score">
              {attempt.resultVisibleToStudent ? 'Yes' : 'Not yet (release rules)'}
            </Fact>
          </dl>
        </Section>
      </div>
      {running ? (
        <Alert tone="info" title="Attempt in progress">
          <p>
            Answers are shown once the attempt is submitted or its time runs out. Running attempts
            never show answers or the answer key.
          </p>
        </Alert>
      ) : (
        <ReviewList questions={attempt.questions} heading="Answers and answer key" />
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}
