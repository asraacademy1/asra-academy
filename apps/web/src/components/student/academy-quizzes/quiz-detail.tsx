'use client';

import type {
  StudentAcademyAttemptStartDto,
  StudentAcademyQuizDetail,
  StudentAttemptSummary,
} from '@asra/types';
import {
  Award,
  CalendarClock,
  ClipboardList,
  FileQuestion,
  Maximize,
  PlayCircle,
  ShieldCheck,
  Timer,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { MediaImg } from '@/components/assessments/question-media';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { ApiClientError } from '@/lib/api';
import {
  ATTEMPT_STATUS_LABELS,
  formatMarksValue,
  plural,
  RESULT_STATE_BADGE,
  RESULT_STATE_LABELS,
  scoreSummary,
} from '@/lib/assessments';
import { formatDateTime } from '@/lib/format';
import {
  academyAttemptHref,
  academyLeaderboardHref,
  enterFullscreen,
  FULLSCREEN_MESSAGES,
  isFullscreen,
  startOnlyInFullscreen,
  fullscreenSupported,
  leaveFullscreen,
  releaseLabel,
  STUDENT_PHASE_BADGE,
  STUDENT_PHASE_LABELS,
  STUDENT_REVEAL_LABELS,
  timingLabel,
} from '@/lib/student/academy-quizzes';

import { ErrorPanel, LoadingPanel } from '../student-ui';
import { errorMessage, useApiResource, useStudentApi } from '../use-student';

const home = { label: 'Dashboard', href: '/student/dashboard' };
const listCrumb = { label: 'Academy Quizzes', href: '/student/academy-quizzes' };

const noSubscribe = () => () => undefined;

/** Fullscreen support, read in the browser only (null while rendering on the server). */
export function useFullscreenSupport(): boolean | null {
  return React.useSyncExternalStore(
    noSubscribe,
    () => fullscreenSupported(),
    () => null,
  );
}

/** `/student/academy-quizzes/[slug]` — announcement, rules, eligibility and the start gate. */
export function StudentAcademyQuizPage({ slug }: { slug: string }) {
  const api = useStudentApi();
  const path = `/student/academy-quizzes/${encodeURIComponent(slug)}`;
  const quiz = useApiResource(path, () => api.get<StudentAcademyQuizDetail>(path));

  if (quiz.error && !quiz.data) {
    const missing = quiz.error instanceof ApiClientError && [403, 404].includes(quiz.error.status);
    return (
      <>
        <PageHeader
          title="Academy Quiz"
          breadcrumbs={[home, listCrumb, { label: 'Not available' }]}
        />
        <ErrorPanel
          title={missing ? 'Quiz not available' : undefined}
          message={
            missing
              ? 'This quiz does not exist or is not open to students.'
              : errorMessage(quiz.error)
          }
          onRetry={missing ? undefined : quiz.reload}
        />
      </>
    );
  }
  if (!quiz.data) return <LoadingPanel label="Loading quiz…" rows={6} />;
  const data = quiz.data;

  return (
    <>
      <PageHeader
        title={data.title}
        breadcrumbs={[home, listCrumb, { label: data.title }]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={STUDENT_PHASE_BADGE[data.phase]}>
              {STUDENT_PHASE_LABELS[data.phase]}
            </Badge>
            {data.summary ? <span>{data.summary}</span> : null}
          </span>
        }
      />
      {data.banner ? (
        <MediaImg
          image={data.banner}
          alt=""
          eager
          className="max-h-72 w-full rounded-xl border bg-muted object-cover"
        />
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="grid min-w-0 gap-6">
          {data.description ? (
            <Section id="about" title="About this quiz">
              <p className="type-body break-words whitespace-pre-wrap">{data.description}</p>
            </Section>
          ) : null}
          <Section id="instructions" title="Instructions">
            <div className="grid gap-3 rounded-xl border bg-card p-5">
              {data.instructions ? (
                <p className="type-body break-words whitespace-pre-wrap">{data.instructions}</p>
              ) : null}
              <RulesList quiz={data} />
            </div>
          </Section>
          {data.prizes.length > 0 ? (
            <Section id="prizes" title="Prizes">
              <ul className="grid gap-3 sm:grid-cols-2">
                {data.prizes.map((prize) => (
                  <li
                    key={prize.position}
                    className="flex gap-3 rounded-xl border bg-card p-4 shadow-card"
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
            </Section>
          ) : null}
          <Section id="attempts" title="Your attempts">
            {data.attempts.length === 0 ? (
              <p className="type-body-sm text-muted-foreground">
                You have not attempted this quiz.
              </p>
            ) : (
              <AttemptRows attempts={data.attempts} />
            )}
          </Section>
          {data.leaderboardVisible ? (
            <Section id="leaderboard" title="Leaderboard">
              <p className="type-body-sm text-muted-foreground">
                {data.phase === 'ENDED' || data.phase === 'CLOSED'
                  ? 'Rankings are shown once the results are published.'
                  : 'Rankings appear after the quiz ends and the results are published.'}
              </p>
              <Button asChild variant="outline" className="w-fit">
                <Link href={academyLeaderboardHref(data.slug)}>
                  <Trophy aria-hidden /> View leaderboard
                </Link>
              </Button>
            </Section>
          ) : null}
        </div>
        <aside className="grid gap-4 rounded-xl border bg-card p-5 shadow-card lg:sticky lg:top-4">
          <dl className="grid gap-2 type-body-sm">
            <Fact
              icon={<CalendarClock />}
              label="Opens"
              value={`${formatDateTime(data.startsAt)} IST`}
            />
            <Fact
              icon={<CalendarClock />}
              label="Ends"
              value={`${formatDateTime(data.endsAt)} IST`}
            />
            <Fact icon={<Timer />} label="Time" value={timingLabel(data)} />
            <Fact
              icon={<FileQuestion />}
              label="Questions"
              value={`${data.questionsPerAttempt} · ${formatMarksValue(data.totalMarks)} marks`}
            />
            <Fact
              icon={<ClipboardList />}
              label="Attempts"
              value={`${data.participation.attemptsUsed} of ${data.participation.maxAttempts} used`}
            />
          </dl>
          <Eligibility quiz={data} />
          <StartPanel quiz={data} onChanged={quiz.reload} />
        </aside>
      </div>
    </>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-3">
      <h2 id={`${id}-heading`} className="type-h3 text-heading">
        {title}
      </h2>
      {children}
    </section>
  );
}

function RulesList({ quiz }: { quiz: StudentAcademyQuizDetail }) {
  const resultsAt = quiz.resultsAt ? `${formatDateTime(quiz.resultsAt)} IST` : null;
  const rules = [
    quiz.timerMode === 'PER_QUESTION'
      ? `Each question has ${quiz.questionTimeSeconds} seconds. When its time is up the quiz moves to the next question.`
      : `You have ${timingLabel(quiz)} from the moment you start, ending no later than the quiz end time.`,
    quiz.navigation === 'LINEAR'
      ? `Questions come one at a time and you cannot go back to an earlier question${quiz.requireAnswerToAdvance ? '; each question must be answered before you move on' : ''}.`
      : 'You can move between questions freely and change your answers until you submit.',
    'The quiz opens in fullscreen. It cannot start on a device or browser without fullscreen support.',
    'The timer runs on the academy server: closing the page or losing your connection does not pause it. Answers are saved as you go, and when time is up the saved answers are submitted automatically.',
    quiz.negativeMarking
      ? 'Wrong answers lose marks; unanswered questions do not.'
      : 'There is no negative marking.',
    `Pass mark: ${quiz.passPercent}%. ${releaseLabel(quiz.resultRelease, resultsAt)}`,
    STUDENT_REVEAL_LABELS[quiz.answerReveal],
  ];
  return (
    <ul className="grid list-disc gap-1.5 pl-5 type-body-sm">
      {rules.map((rule) => (
        <li key={rule}>{rule}</li>
      ))}
    </ul>
  );
}

function Eligibility({ quiz }: { quiz: StudentAcademyQuizDetail }) {
  const { eligibility } = quiz;
  const audience = [
    eligibility.eligibleClasses.length
      ? `Classes: ${eligibility.eligibleClasses.map((c) => c.name).join(', ')}`
      : null,
    eligibility.eligibleStreams.length
      ? `Streams: ${eligibility.eligibleStreams.map((s) => s.name).join(', ')}`
      : null,
  ].filter(Boolean);
  return (
    <div className="grid gap-1 type-body-sm">
      <p className="flex items-center gap-2 type-label text-heading">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden /> Who can take part
      </p>
      <p className="text-muted-foreground">
        {audience.length ? audience.join(' · ') : 'All students'} · verified email required
      </p>
      {eligibility.eligible ? (
        <p className="text-success">You are eligible.</p>
      ) : (
        <p className="text-warning">{eligibility.message}</p>
      )}
      {eligibility.reasons.includes('CLASS') || eligibility.reasons.includes('STREAM') ? (
        <p className="type-caption text-muted-foreground">
          Your class and stream come from your{' '}
          <Link href="/student/profile" className="underline hover:text-primary">
            student profile
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}

/**
 * The start gate. "Start quiz" opens a modal in two steps:
 *   1. "Allow fullscreen" — the student grants the browser's fullscreen request;
 *   2. "Start the quiz now" — only now is the attempt created and its server timer started.
 * If fullscreen is unsupported or refused (or was turned off again before step 2), nothing is
 * sent to the server and the modal explains why.
 */
function StartPanel({
  quiz,
  onChanged,
}: {
  quiz: StudentAcademyQuizDetail;
  onChanged: () => void;
}) {
  const supported = useFullscreenSupport();
  const [accepted, setAccepted] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  if (quiz.participation.inProgressAttemptId) {
    return (
      <div className="grid gap-2">
        <Alert tone="warning" title="Your attempt is running">
          <p>The timer has not stopped. Continue now to use the time that is left.</p>
        </Alert>
        <Button asChild>
          <Link href={academyAttemptHref(quiz.participation.inProgressAttemptId)}>
            <PlayCircle aria-hidden /> Continue your attempt
          </Link>
        </Button>
      </div>
    );
  }
  if (quiz.cannotStartReason) {
    return (
      <Alert tone="info">
        <p>{quiz.cannotStartReason}</p>
      </Alert>
    );
  }

  const fullMinutes =
    quiz.timerMode === 'OVERALL'
      ? (quiz.durationMinutes ?? 0)
      : Math.floor(((quiz.questionTimeSeconds ?? 0) * quiz.questionsPerAttempt) / 60);
  const late =
    quiz.availableMinutesIfStartedNow !== null && quiz.availableMinutesIfStartedNow < fullMinutes;

  return (
    <div className="grid gap-3">
      {late ? (
        <Alert tone="warning" title="Starting late">
          <p>
            The quiz ends at {formatDateTime(quiz.endsAt)} IST, so an attempt started now gets about{' '}
            {plural(quiz.availableMinutesIfStartedNow ?? 0, 'minute')} instead of the full time.
          </p>
        </Alert>
      ) : null}
      {supported === false ? (
        <Alert tone="warning" title="Fullscreen is not available here">
          <p>{FULLSCREEN_MESSAGES.unsupported}</p>
        </Alert>
      ) : null}
      <label className="flex items-start gap-3 type-body-sm">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>I have read the instructions and I am ready to start.</span>
      </label>
      <Button onClick={() => setOpen(true)} disabled={!accepted || supported === false}>
        <PlayCircle aria-hidden /> Start quiz
      </Button>
      <p className="type-caption text-muted-foreground">
        You will be asked to allow fullscreen first. Your time starts only after that, when you
        press “Start the quiz now”.
      </p>
      <FullscreenStartDialog quiz={quiz} open={open} onOpenChange={setOpen} onFailed={onChanged} />
    </div>
  );
}

type StartStep = 'permission' | 'ready';

export function FullscreenStartDialog({
  quiz,
  open,
  onOpenChange,
  onFailed,
}: {
  quiz: Pick<StudentAcademyQuizDetail, 'slug' | 'title'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFailed: () => void;
}) {
  const api = useStudentApi();
  const router = useRouter();
  const [step, setStep] = React.useState<StartStep>('permission');
  const [pending, setPending] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  function close() {
    if (pending) return;
    // Cancelling before the start: nothing was created; give the screen back.
    leaveFullscreen();
    setStep('permission');
    setProblem(null);
    onOpenChange(false);
  }

  async function allow() {
    setProblem(null);
    setPending(true);
    const outcome = await enterFullscreen(); // runs inside this click (user gesture)
    setPending(false);
    if (outcome === 'entered') setStep('ready');
    else setProblem(FULLSCREEN_MESSAGES[outcome]);
  }

  async function start() {
    setProblem(null);
    setPending(true);
    try {
      const outcome = await startOnlyInFullscreen(isFullscreen, () =>
        api.post<StudentAcademyAttemptStartDto>(
          `/student/academy-quizzes/${encodeURIComponent(quiz.slug)}/attempts`,
          { acceptedInstructions: true },
        ),
      );
      if (!outcome.started) {
        setStep('permission');
        setProblem(outcome.message);
        setPending(false);
        return;
      }
      if (outcome.value.resumed) toast.info('Resuming your attempt in progress');
      router.push(academyAttemptHref(outcome.value.attempt.id));
    } catch (error) {
      leaveFullscreen();
      setPending(false);
      setStep('permission');
      onOpenChange(false);
      toast.error('Could not start', { description: errorMessage(error) });
      onFailed();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent showCloseButton={!pending}>
        {step === 'permission' ? (
          <>
            <DialogHeader>
              <DialogTitle>Allow fullscreen</DialogTitle>
              <DialogDescription>
                {quiz.title} is taken in fullscreen. Press “Allow fullscreen” and accept if your
                browser asks. Your time does not start yet.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-3 rounded-lg border bg-secondary/50 p-3 type-body-sm">
              <Maximize className="size-5 shrink-0 text-primary" aria-hidden />
              <span>Step 1 of 2: allow fullscreen. Step 2: start the quiz.</span>
            </div>
            {problem ? (
              <Alert tone="error" title="Fullscreen is not on">
                <p>{problem}</p>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void allow()}
                loading={pending}
                loadingText="Waiting for the browser…"
              >
                <Maximize aria-hidden /> Allow fullscreen
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Fullscreen is on</DialogTitle>
              <DialogDescription>
                Step 2 of 2. When you press “Start the quiz now”, your attempt begins and the timer
                starts on the server. It cannot be paused.
              </DialogDescription>
            </DialogHeader>
            {problem ? (
              <Alert tone="error">
                <p>{problem}</p>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void start()}
                loading={pending}
                loadingText="Starting…"
              >
                <PlayCircle aria-hidden /> Start the quiz now
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AttemptRows({ attempts }: { attempts: StudentAttemptSummary[] }) {
  return (
    <ul className="grid gap-2">
      {attempts.map((attempt) => (
        <li key={attempt.id}>
          <Link
            href={academyAttemptHref(attempt.id)}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 hover:bg-secondary/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span className="grid">
              <span className="type-label text-heading">Attempt {attempt.attemptNumber}</span>
              <span className="type-caption text-muted-foreground">
                {ATTEMPT_STATUS_LABELS[attempt.status]}
                {attempt.submittedAt ? ` · ${formatDateTime(attempt.submittedAt)} IST` : ''}
              </span>
            </span>
            {attempt.result ? (
              <Badge
                variant={attempt.result.passed ? 'success' : 'warning'}
                className="tabular-nums"
              >
                {scoreSummary(attempt.result)}
              </Badge>
            ) : (
              <Badge variant={RESULT_STATE_BADGE[attempt.resultState]}>
                {RESULT_STATE_LABELS[attempt.resultState]}
              </Badge>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden className="mt-0.5 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <dt className="sr-only">{label}</dt>
      <dd className="min-w-0 break-words">
        <span className="text-muted-foreground">{label}: </span>
        {value}
      </dd>
    </div>
  );
}
