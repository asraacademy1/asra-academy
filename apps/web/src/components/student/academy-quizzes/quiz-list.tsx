'use client';

import type { Paginated, StudentAcademyQuizItem, StudentAcademyQuizTab } from '@asra/types';
import { CalendarClock, Gift, Timer, Trophy } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { MediaImg } from '@/components/assessments/question-media';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/public/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { plural, scoreSummary } from '@/lib/assessments';
import { formatDateTime } from '@/lib/format';
import {
  ACADEMY_TAB_LABELS,
  academyQuizHref,
  STUDENT_PHASE_BADGE,
  STUDENT_PHASE_LABELS,
  timingLabel,
} from '@/lib/student/academy-quizzes';

import { ErrorPanel, ListPager, LoadingPanel } from '../student-ui';
import { errorMessage, useApiResource, useStudentApi, withPage } from '../use-student';

const home = { label: 'Dashboard', href: '/student/dashboard' };
const TABS: StudentAcademyQuizTab[] = ['LIVE', 'UPCOMING', 'COMPLETED'];

const EMPTY: Record<StudentAcademyQuizTab, { title: string; description: string }> = {
  LIVE: {
    title: 'No quiz is live right now',
    description: 'Check the Upcoming tab to see when the next Academy Quiz opens.',
  },
  UPCOMING: {
    title: 'No upcoming quizzes',
    description: 'New Academy Quizzes are announced here before they open.',
  },
  COMPLETED: {
    title: 'No completed quizzes yet',
    description: 'Quizzes that have ended appear here with your results.',
  },
};

/** `/student/academy-quizzes` — Live, Upcoming and Completed Academy Quizzes. */
export function StudentAcademyQuizzesPage() {
  const api = useStudentApi();
  const [tab, setTab] = React.useState<StudentAcademyQuizTab>('LIVE');
  const [page, setPage] = React.useState(1);
  const url = withPage('/student/academy-quizzes', page, { tab, pageSize: '12' });
  const list = useApiResource(url, () => api.get<Paginated<StudentAcademyQuizItem>>(url));

  return (
    <>
      <PageHeader
        title="Academy Quizzes"
        breadcrumbs={[home, { label: 'Academy Quizzes' }]}
        description="Open quizzes and competitions from ASRA Academy. No course enrolment is needed. Times are in IST."
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as StudentAcademyQuizTab);
          setPage(1);
        }}
      >
        <TabsList>
          {TABS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {ACADEMY_TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {list.error && !list.data ? (
        <ErrorPanel message={errorMessage(list.error)} onRetry={list.reload} />
      ) : !list.data ? (
        <LoadingPanel label="Loading quizzes…" />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<Trophy />} {...EMPTY[tab]} />
      ) : (
        <div className="grid gap-4" aria-busy={list.loading || undefined}>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.data.items.map((quiz) => (
              <li key={quiz.id} className="grid">
                <AcademyQuizCard quiz={quiz} />
              </li>
            ))}
          </ul>
          <ListPager pagination={list.data.pagination} onPageChange={setPage} label="Quiz pages" />
        </div>
      )}
    </>
  );
}

export function AcademyQuizCard({ quiz }: { quiz: StudentAcademyQuizItem }) {
  const href = academyQuizHref(quiz.slug);
  const { participation } = quiz;
  const action = participation.inProgressAttemptId
    ? 'Continue'
    : quiz.phase === 'LIVE' &&
        quiz.eligible &&
        participation.attemptsUsed < participation.maxAttempts
      ? 'View and start'
      : 'View details';
  return (
    <Card className="gap-3 overflow-hidden p-0">
      {quiz.banner ? (
        <MediaImg
          image={quiz.banner}
          alt=""
          className="aspect-[16/7] w-full bg-muted object-cover"
        />
      ) : (
        <div aria-hidden className="flex aspect-[16/7] items-center justify-center bg-secondary">
          <Trophy className="size-10 text-primary" />
        </div>
      )}
      <div className="grid gap-3 px-5 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STUDENT_PHASE_BADGE[quiz.phase]}>
            {STUDENT_PHASE_LABELS[quiz.phase]}
          </Badge>
          {participation.inProgressAttemptId ? (
            <Badge variant="warning">Attempt in progress</Badge>
          ) : null}
          {!quiz.eligible ? <Badge variant="secondary">Not eligible</Badge> : null}
          {quiz.hasPrizes ? (
            <Badge variant="accent">
              <Gift aria-hidden /> Prizes
            </Badge>
          ) : null}
        </div>
        <h2 className="type-h4 break-words text-heading">
          <Link
            href={href}
            className="rounded-sm hover:text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {quiz.title}
          </Link>
        </h2>
        {quiz.summary ? (
          <p className="line-clamp-2 type-body-sm text-muted-foreground">{quiz.summary}</p>
        ) : null}
        <dl className="grid gap-1 type-body-sm">
          <div className="flex items-start gap-2">
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <dt className="sr-only">Schedule</dt>
            <dd>
              {formatDateTime(quiz.startsAt)} – {formatDateTime(quiz.endsAt)} IST
            </dd>
          </div>
          <div className="flex items-start gap-2">
            <Timer className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <dt className="sr-only">Time and questions</dt>
            <dd>
              {timingLabel(quiz)} · {plural(quiz.questionsPerAttempt, 'question')}
            </dd>
          </div>
        </dl>
        {participation.bestResult ? (
          <p className="type-body-sm">
            Your best result:{' '}
            <span className="font-semibold tabular-nums">
              {scoreSummary(participation.bestResult)}
            </span>
          </p>
        ) : participation.attemptsUsed > 0 && !participation.inProgressAttemptId ? (
          <p className="type-body-sm text-muted-foreground">
            You took part · result not published yet
          </p>
        ) : null}
        <Button asChild size="sm" variant="outline" className="w-fit">
          <Link href={href}>{action}</Link>
        </Button>
      </div>
    </Card>
  );
}
