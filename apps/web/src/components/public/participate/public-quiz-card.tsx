import type { PublicAcademyQuizItem } from '@asra/types';
import { CalendarClock, Gift, ShieldCheck, Timer, Trophy } from 'lucide-react';
import Link from 'next/link';

import { MediaImg } from '@/components/assessments/question-media';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatMarksValue, plural } from '@/lib/assessments';
import {
  PUBLIC_PHASE_BADGE,
  PUBLIC_PHASE_LABELS,
  eligibilitySummaryText,
  formatQuizWindowIst,
  publicQuizHref,
  timingLabel,
} from '@/lib/participate';

export function PublicQuizCard({
  quiz,
  headingLevel = 'h2',
}: {
  quiz: PublicAcademyQuizItem;
  headingLevel?: 'h2' | 'h3';
}) {
  const href = publicQuizHref(quiz.slug);
  const Heading = headingLevel;

  return (
    <Card className="flex h-full flex-col gap-3 overflow-hidden p-0">
      {quiz.banner ? (
        <MediaImg
          image={quiz.banner}
          alt={`${quiz.title} banner`}
          className="aspect-[16/7] w-full bg-muted object-cover"
        />
      ) : (
        <div aria-hidden className="flex aspect-[16/7] items-center justify-center bg-secondary">
          <Trophy className="size-10 text-primary" />
        </div>
      )}

      <div className="flex flex-1 flex-col gap-3 px-5 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={PUBLIC_PHASE_BADGE[quiz.phase]}>{PUBLIC_PHASE_LABELS[quiz.phase]}</Badge>
          {quiz.hasPrizes ? (
            <Badge variant="accent">
              <Gift aria-hidden /> Prizes
            </Badge>
          ) : null}
        </div>

        <Heading className="type-h4 break-words text-heading">
          <Link
            href={href}
            className="rounded-sm hover:text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {quiz.title}
          </Link>
        </Heading>

        {quiz.summary ? (
          <p className="line-clamp-2 type-body-sm text-muted-foreground">{quiz.summary}</p>
        ) : null}

        <dl className="grid gap-1.5 type-body-sm">
          <div className="flex items-start gap-2">
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <dt className="sr-only">Schedule</dt>
            <dd>{formatQuizWindowIst(quiz.startsAt, quiz.endsAt)}</dd>
          </div>
          <div className="flex items-start gap-2">
            <Timer className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <dt className="sr-only">Duration and marks</dt>
            <dd>
              {timingLabel(quiz)} · {plural(quiz.questionsPerAttempt, 'question')}
              {quiz.totalMarks > 0 ? ` · ${formatMarksValue(quiz.totalMarks)} marks` : ''}
            </dd>
          </div>
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <dt className="sr-only">Eligibility</dt>
            <dd className="text-muted-foreground">{eligibilitySummaryText(quiz)}</dd>
          </div>
        </dl>

        <div className="mt-auto flex flex-wrap gap-2 pt-2">
          <Button asChild size="sm" variant="outline">
            <Link href={href}>View Details</Link>
          </Button>
          {quiz.registrationOpen ? (
            <Button asChild size="sm">
              <Link href={href}>Register Now</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
