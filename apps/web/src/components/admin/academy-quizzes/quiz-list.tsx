'use client';

import type { AdminAcademyQuizItem } from '@asra/types';
import { ACADEMY_QUIZ_STATUSES } from '@asra/validation';
import { Eye, Pencil, Plus, Trophy } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/layout/page-header';
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
import { PHASE_LABELS, PHASE_TONE } from '@/lib/admin/academy-quizzes';
import { formatDateTime } from '@/lib/format';

import { FilterSelect, ListFrame, SearchBox, usePagedList } from '../admin-kit';

const STATUS_LABELS = { DRAFT: 'Draft', PUBLISHED: 'Published', CLOSED: 'Closed' } as const;

export function PhaseBadge({ phase }: { phase: AdminAcademyQuizItem['phase'] }) {
  return <Badge variant={PHASE_TONE[phase]}>{PHASE_LABELS[phase]}</Badge>;
}

/** `/admin/academy-quizzes` — every academy quiz, newest schedule first. */
export function AcademyQuizList() {
  const [status, setStatus] = React.useState('');
  const [q, setQ] = React.useState('');
  const { list, setPage } = usePagedList<AdminAcademyQuizItem>('/admin/academy-quizzes', {
    status: status || undefined,
    q: q || undefined,
  });

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Academy Quizzes"
        description="Standalone quizzes open to every eligible student, independent of course enrolment."
        breadcrumbs={[{ label: 'Administration', href: '/admin' }, { label: 'Academy Quizzes' }]}
        actions={
          <Button asChild>
            <Link href="/admin/academy-quizzes/new">
              <Plus aria-hidden /> New academy quiz
            </Link>
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          id="academy-status"
          label="Status"
          value={status}
          onChange={setStatus}
          options={ACADEMY_QUIZ_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))}
        />
        <SearchBox id="academy-search" placeholder="Search by title" onSearch={setQ} />
      </div>
      <ListFrame
        list={list}
        setPage={setPage}
        label="academy quizzes"
        icon={<Trophy />}
        emptyTitle="No academy quizzes yet"
        emptyText={
          status || q ? 'Nothing matches these filters.' : 'Create the first quiz to get started.'
        }
      >
        {(items) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quiz</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Schedule (IST)</TableHead>
                <TableHead className="text-right">Questions</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((quiz) => (
                <TableRow key={quiz.id}>
                  <TableCell>
                    <Link
                      href={`/admin/academy-quizzes/${quiz.id}`}
                      className="type-label text-heading hover:text-primary hover:underline"
                    >
                      {quiz.title}
                    </Link>
                    <p className="type-caption text-muted-foreground">
                      /student/academy-quizzes/{quiz.slug}
                    </p>
                  </TableCell>
                  <TableCell>
                    <PhaseBadge phase={quiz.phase} />
                  </TableCell>
                  <TableCell className="type-body-sm whitespace-nowrap">
                    {formatDateTime(quiz.startsAt)}
                    <span className="block text-muted-foreground">
                      to {formatDateTime(quiz.endsAt)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{quiz.questionCount}</TableCell>
                  <TableCell className="text-right">
                    {quiz.attempts.total}
                    {quiz.attempts.inProgress > 0 ? (
                      <span className="block type-caption text-muted-foreground">
                        {quiz.attempts.inProgress} in progress
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex gap-1">
                      <Button asChild size="icon-sm" variant="ghost">
                        <Link
                          href={`/admin/academy-quizzes/${quiz.id}`}
                          aria-label={`Open ${quiz.title}`}
                        >
                          <Eye aria-hidden />
                        </Link>
                      </Button>
                      <Button asChild size="icon-sm" variant="ghost">
                        <Link
                          href={`/admin/academy-quizzes/${quiz.id}/edit`}
                          aria-label={`Edit settings of ${quiz.title}`}
                        >
                          <Pencil aria-hidden />
                        </Link>
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ListFrame>
    </div>
  );
}
