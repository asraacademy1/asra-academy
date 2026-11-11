import type { PublicAcademyQuizDetail } from '@asra/types';
import {
  Award,
  CalendarClock,
  ClipboardList,
  FileQuestion,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import Link from 'next/link';

import { MediaImg } from '@/components/assessments/question-media';
import { Container } from '@/components/layout/container';
import { Section } from '@/components/layout/section';
import { CtaBand } from '@/components/public/cta-band';
import { PageHero } from '@/components/public/page-hero';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatMarksValue, plural } from '@/lib/assessments';
import { toParagraphs } from '@/lib/catalog';
import { formatDateTime } from '@/lib/format';
import {
  PUBLIC_PHASE_BADGE,
  PUBLIC_PHASE_LABELS,
  eligibilitySummaryText,
  timingLabel,
} from '@/lib/participate';
import { STUDENT_REVEAL_LABELS, releaseLabel } from '@/lib/student/academy-quizzes';
import { PublicQuizRegistration } from './public-quiz-registration';

function buildPublicRules(quiz: PublicAcademyQuizDetail): string[] {
  const resultsAt = quiz.resultsAt ? `${formatDateTime(quiz.resultsAt)} IST` : null;
  return [
    quiz.timerMode === 'PER_QUESTION'
      ? `Each question allows ${quiz.questionTimeSeconds} seconds and advances automatically when time is up.`
      : `Each attempt allows ${timingLabel(quiz)}, ending no later than the scheduled quiz end time.`,
    quiz.navigation === 'LINEAR'
      ? `Questions appear one at a time in forward order${quiz.requireAnswerToAdvance ? '; each question must be answered before moving on' : ''}.`
      : 'You may navigate between questions freely and review answers before submitting.',
    'Quiz attempts start in fullscreen on supported desktop and mobile browsers, with server-authoritative timers.',
    quiz.negativeMarking
      ? 'Wrong answers carry negative marks; unanswered questions do not.'
      : 'There is no negative marking for wrong answers.',
    `Pass mark: ${quiz.passPercent}%. ${releaseLabel(quiz.resultRelease, resultsAt)}`,
    STUDENT_REVEAL_LABELS[quiz.answerReveal],
  ];
}

export function PublicQuizDetailView({ quiz }: { quiz: PublicAcademyQuizDetail }) {
  const path = `/participate/quizzes/${quiz.slug}`;
  const descriptionParagraphs = toParagraphs(quiz.description);
  const rules = buildPublicRules(quiz);
  const startsText = `${formatDateTime(quiz.startsAt) ?? '—'} IST`;
  const endsText = `${formatDateTime(quiz.endsAt) ?? '—'} IST`;

  return (
    <>
      <PageHero
        path={path}
        breadcrumbs={[
          { label: 'Participate', href: '/participate' },
          { label: 'Quizzes', href: '/participate/quizzes' },
          { label: quiz.title },
        ]}
        eyebrow="Academic Quiz"
        title={quiz.title}
        description={
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={PUBLIC_PHASE_BADGE[quiz.phase]}>
                {PUBLIC_PHASE_LABELS[quiz.phase]}
              </Badge>
              {quiz.prizes.length > 0 ? <Badge variant="accent">Prizes configured</Badge> : null}
            </div>
            {quiz.summary ? <p>{quiz.summary}</p> : null}
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline">
              <Link href="/participate/quizzes">Browse all quizzes</Link>
            </Button>
          </div>
        }
        aside={
          <div className="grid gap-4 rounded-2xl border bg-card p-6 shadow-card">
            {quiz.banner ? (
              <MediaImg
                image={quiz.banner}
                alt={`${quiz.title} banner`}
                eager
                className="aspect-[16/9] w-full rounded-lg border bg-muted object-cover"
              />
            ) : null}
            <h2 className="type-h4 text-heading">Quiz Schedule &amp; Registration</h2>
            <dl className="grid gap-2.5 type-body-sm">
              <Fact icon={<CalendarClock />} label="Starts" value={startsText} />
              <Fact icon={<CalendarClock />} label="Ends" value={endsText} />
              <Fact icon={<Timer />} label="Duration" value={timingLabel(quiz)} />
              <Fact
                icon={<FileQuestion />}
                label="Questions"
                value={
                  quiz.totalMarks > 0
                    ? `${plural(quiz.questionsPerAttempt, 'question')} · ${formatMarksValue(quiz.totalMarks)} marks`
                    : plural(quiz.questionsPerAttempt, 'question')
                }
              />
              <Fact
                icon={<ClipboardList />}
                label="Attempts"
                value={`${quiz.maxAttempts} allowed per student`}
              />
              <Fact
                icon={<ShieldCheck />}
                label="Eligibility"
                value={eligibilitySummaryText(quiz)}
              />
            </dl>
            <PublicQuizRegistration quiz={quiz} />
          </div>
        }
      />

      {descriptionParagraphs.length > 0 ? (
        <Section title="About this quiz" containerSize="narrow">
          <div className="grid gap-4 type-body text-foreground">
            {descriptionParagraphs.map((paragraph, index) => (
              <p key={index} className="whitespace-pre-line">
                {paragraph}
              </p>
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        tone="muted"
        title="Instructions and rules"
        description="Review the rules and schedule before registering."
        containerSize="narrow"
      >
        <div className="grid gap-4 rounded-xl border bg-card p-6 shadow-card">
          {quiz.instructions ? (
            <p className="type-body whitespace-pre-wrap text-foreground">{quiz.instructions}</p>
          ) : null}
          <ul className="grid list-disc gap-2 pl-5 type-body-sm text-foreground">
            {rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
      </Section>

      {quiz.prizes.length > 0 ? (
        <Section
          title="Prizes and recognition"
          description="Awards announced by ASRA Academy for top-ranked participants."
          containerSize="narrow"
        >
          <Container className="px-0">
            <ul className="grid gap-4 sm:grid-cols-2">
              {quiz.prizes.map((prize) => (
                <li
                  key={prize.position}
                  className="flex gap-4 rounded-xl border bg-card p-4 shadow-card"
                >
                  {prize.image ? (
                    <MediaImg
                      image={prize.image}
                      alt={`Prize for position ${prize.position}`}
                      className="size-16 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-asra-gold-100 text-asra-gold-800"
                    >
                      <Award className="size-7" />
                    </span>
                  )}
                  <span className="grid min-w-0 content-start gap-1">
                    <span className="type-caption text-muted-foreground">
                      Position {prize.position}
                    </span>
                    <span className="type-label break-words text-heading">{prize.title}</span>
                    {prize.description ? (
                      <span className="type-body-sm break-words text-muted-foreground">
                        {prize.description}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </Container>
        </Section>
      ) : null}

      <CtaBand
        title="Need help getting started?"
        description="Explore all open quizzes and participation opportunities or contact our team with questions."
        primary={{ label: 'Explore all quizzes', href: '/participate/quizzes' }}
        secondary={{ label: 'Contact us', href: '/contact' }}
        tertiary={null}
      />
    </>
  );
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 break-words">
        <dt className="inline text-muted-foreground">{label}: </dt>
        <dd className="inline font-medium text-foreground">{value}</dd>
      </div>
    </div>
  );
}
