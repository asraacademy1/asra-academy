'use client';

import type { StudentAcademyAttemptDto } from '@asra/types';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookmarkCheck,
  Clock,
  Hourglass,
  Maximize,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { ConfirmDialog } from '@/components/admin/admin-ui';
import { QuestionImages } from '@/components/assessments/question-media';
import { useAnswerAutosave } from '@/components/assessments/use-answer-autosave';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ApiClientError } from '@/lib/api';
import {
  ATTEMPT_STATUS_LABELS,
  clockSkewMs,
  countdownTone,
  formatCountdown,
  formatMarksValue,
  formatScore,
  isAnswered,
  QUESTION_TYPE_LABELS,
  remainingMs,
  RESULT_STATE_BADGE,
  RESULT_STATE_LABELS,
} from '@/lib/assessments';
import { formatDateTime } from '@/lib/format';
import {
  academyQuizHref,
  clearMarked,
  enterFullscreen,
  RESUME_FULLSCREEN_MESSAGES,
  isFullscreen,
  leaveFullscreen,
  readMarked,
  writeMarked,
} from '@/lib/student/academy-quizzes';
import { cn } from '@/lib/utils';

import { AnswerInput, OwnAnswers, ReviewList, SaveIndicator, ScoreFact } from '../attempt-player';
import { ErrorPanel, LoadingPanel } from '../student-ui';
import { errorMessage, useApiResource, useStudentApi } from '../use-student';
import { useFullscreenSupport } from './quiz-detail';

/**
 * Taking an Academy Quiz (`/student/academy-attempts/[id]`).
 *
 * The SERVER decides the start, every deadline, which question may be answered (linear
 * navigation), and when the attempt is final; this page shows server state, autosaves answers
 * (shared hook) and asks the server to move on or submit.
 *
 * Fullscreen: required to OPEN a running attempt (fresh start or resume). Leaving fullscreen
 * afterwards is not watched, recorded or penalised.
 */

const home = { label: 'Dashboard', href: '/student/dashboard' };
const listCrumb = { label: 'Academy Quizzes', href: '/student/academy-quizzes' };

interface Loaded {
  data: StudentAcademyAttemptDto;
  receivedAt: number;
}

export function AcademyAttemptPlayer({ attemptId }: { attemptId: string }) {
  const api = useStudentApi();
  const path = `/student/academy-attempts/${encodeURIComponent(attemptId)}`;
  const resource = useApiResource(path, async (): Promise<Loaded> => {
    const data = await api.get<StudentAcademyAttemptDto>(path);
    return { data, receivedAt: Date.now() };
  });
  // Checked once, when the page opens: arriving from the start button means fullscreen is on.
  const [gatePassed, setGatePassed] = React.useState(
    () => typeof document !== 'undefined' && isFullscreen(),
  );

  if (resource.error && !resource.data) {
    const notFound = resource.error instanceof ApiClientError && resource.error.status === 404;
    return (
      <>
        <PageHeader title="Attempt" breadcrumbs={[home, listCrumb, { label: 'Attempt' }]} />
        <ErrorPanel
          title={notFound ? 'Attempt not found' : undefined}
          message={
            notFound ? 'This attempt does not exist or is not yours.' : errorMessage(resource.error)
          }
          onRetry={notFound ? undefined : resource.reload}
        />
      </>
    );
  }
  if (!resource.data) return <LoadingPanel label="Loading your attempt…" rows={6} />;
  const { data, receivedAt } = resource.data;
  if (data.status !== 'IN_PROGRESS') return <AcademyAttemptOutcome attempt={data} />;
  if (!gatePassed) {
    return (
      <ResumeGate attempt={data} receivedAt={receivedAt} onEntered={() => setGatePassed(true)} />
    );
  }
  return (
    <RunningAcademyAttempt
      key={`${data.id}:${receivedAt}`}
      attempt={data}
      receivedAt={receivedAt}
      onUpdate={(next) => resource.replace({ data: next, receivedAt: Date.now() })}
      onStale={resource.reload}
    />
  );
}

// --- Resume gate ----------------------------------------------------------------------------

function useCountdown(deadlineAt: string | null, serverNow: string, receivedAt: number) {
  const [skew] = React.useState(() => clockSkewMs(serverNow, receivedAt));
  const [now, setNow] = React.useState(receivedAt);
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return { remaining: remainingMs(deadlineAt, skew, now), skew, now };
}

function ResumeGate({
  attempt,
  receivedAt,
  onEntered,
}: {
  attempt: StudentAcademyAttemptDto;
  receivedAt: number;
  onEntered: () => void;
}) {
  const supported = useFullscreenSupport();
  const { remaining } = useCountdown(attempt.deadlineAt, attempt.serverNow, receivedAt);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function enter() {
    setPending(true);
    const outcome = await enterFullscreen();
    setPending(false);
    if (outcome === 'entered') onEntered();
    else setProblem(RESUME_FULLSCREEN_MESSAGES[outcome]);
  }

  return (
    <>
      <PageHeader
        title={attempt.quiz.title}
        breadcrumbs={[
          home,
          listCrumb,
          { label: attempt.quiz.title, href: academyQuizHref(attempt.quiz.slug) },
          { label: `Attempt ${attempt.attemptNumber}` },
        ]}
      />
      <div className="mx-auto grid w-full max-w-lg gap-4 rounded-xl border bg-card p-6 text-center shadow-card">
        <Maximize className="mx-auto size-10 text-primary" aria-hidden />
        <h2 className="type-h3 text-heading">Continue in fullscreen</h2>
        <p className="type-body text-muted-foreground">
          Your attempt is still running on the server
          {remaining !== null ? (
            <>
              {' '}
              with <strong className="font-mono tabular-nums">
                {formatCountdown(remaining)}
              </strong>{' '}
              left
            </>
          ) : null}
          . The quiz continues in fullscreen.
        </p>
        {supported === false ? (
          <Alert tone="warning" title="Fullscreen is not available here">
            <p>{RESUME_FULLSCREEN_MESSAGES.unsupported}</p>
          </Alert>
        ) : null}
        {problem ? (
          <Alert tone="error">
            <p>{problem}</p>
          </Alert>
        ) : null}
        <Button
          onClick={() => void enter()}
          disabled={supported === false}
          loading={pending}
          loadingText="Opening…"
          className="justify-self-center"
        >
          <Maximize aria-hidden /> Allow fullscreen and continue
        </Button>
        <Link
          href={academyQuizHref(attempt.quiz.slug)}
          className="type-body-sm text-muted-foreground underline hover:text-primary"
        >
          Back to the quiz page
        </Link>
      </div>
    </>
  );
}

// --- Running attempt ------------------------------------------------------------------------

function RunningAcademyAttempt({
  attempt,
  receivedAt,
  onUpdate,
  onStale,
}: {
  attempt: StudentAcademyAttemptDto;
  receivedAt: number;
  onUpdate: (attempt: StudentAcademyAttemptDto) => void;
  onStale: () => void;
}) {
  const api = useStudentApi();
  const questions = attempt.questions;
  const linear = attempt.navigation === 'LINEAR';
  const { remaining, skew, now } = useCountdown(attempt.deadlineAt, attempt.serverNow, receivedAt);
  const questionRemaining = attempt.currentQuestionDeadlineAt
    ? remainingMs(attempt.currentQuestionDeadlineAt, skew, now)
    : null;
  const [index, setIndex] = React.useState(0);
  const [online, setOnline] = React.useState(true);
  const [confirming, setConfirming] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [advancing, setAdvancing] = React.useState(false);
  const [finalNotice, setFinalNotice] = React.useState<string | null>(null);
  const [marked, setMarked] = React.useState<Set<string>>(() => readMarked(attempt.id));
  const submitStarted = React.useRef(false);
  const refreshStarted = React.useRef(false);

  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // A navigation warning is a courtesy only: closing the page never stops the server timer.
  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const handleConflict = React.useCallback(
    (error: ApiClientError) => {
      const details = error.details as { reason?: string } | undefined;
      if (details?.reason === 'QUESTION_LOCKED') {
        toast.info('That question is closed', { description: error.message });
      } else {
        setFinalNotice(error.message);
      }
      onStale();
    },
    [onStale],
  );
  const answerPath = React.useCallback(
    (questionId: string) => `/student/academy-attempts/${attempt.id}/answers/${questionId}`,
    [attempt.id],
  );
  const { answers, change, flush, unsaved } = useAnswerAutosave({
    api,
    questions,
    answerPath,
    onConflict: handleConflict,
  });

  const submit = React.useCallback(
    async (automatic: boolean) => {
      if (submitStarted.current) return; // double clicks / timer + click → one request
      submitStarted.current = true;
      setSubmitting(true);
      try {
        if (!automatic) await flush();
        const final = await api.post<StudentAcademyAttemptDto>(
          `/student/academy-attempts/${attempt.id}/submit`,
        );
        toast.success(
          final.status === 'EXPIRED' ? 'Time is up — answers submitted' : 'Attempt submitted',
        );
        onUpdate(final);
      } catch (error) {
        submitStarted.current = false;
        setSubmitting(false);
        toast.error('Could not submit', {
          description: `${errorMessage(error)} If time runs out, the server submits your saved answers automatically.`,
        });
        throw error;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, attempt.id, onUpdate],
  );

  // Attempt time over → ask the server to finalize (it would anyway, on the next access).
  React.useEffect(() => {
    if (remaining === 0 && !submitStarted.current) {
      const timer = setTimeout(() => void submit(true).catch(() => undefined), 0);
      return () => clearTimeout(timer);
    }
  }, [remaining, submit]);

  // Per-question time over (not the last question) → the server has moved on: fetch it.
  React.useEffect(() => {
    if (questionRemaining === 0 && remaining !== 0 && !refreshStarted.current) {
      refreshStarted.current = true;
      const timer = setTimeout(() => {
        void flush().finally(onStale);
      }, 300);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionRemaining, remaining, onStale]);

  const question = linear ? questions[0] : questions[index];
  if (!question) {
    return <LoadingPanel label="Loading the next question…" rows={4} />;
  }
  const local = answers[question.id]!;
  const position = linear ? (attempt.currentPosition ?? 0) : index;
  const isLast = position >= attempt.questionCount - 1;
  const currentAnswered = isAnswered({ type: question.type, ...local });
  const answeredCount = questions.filter((q) =>
    isAnswered({ type: q.type, ...answers[q.id]! }),
  ).length;
  const unanswered = linear ? (currentAnswered ? 0 : 1) : questions.length - answeredCount;
  const locked = submitting || advancing || finalNotice !== null;

  function toggleMark(questionId: string) {
    setMarked((current) => {
      const next = new Set(current);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      writeMarked(attempt.id, next);
      return next;
    });
  }

  async function next() {
    if (advancing) return;
    setAdvancing(true);
    try {
      await flush();
      const moved = await api.post<StudentAcademyAttemptDto>(
        `/student/academy-attempts/${attempt.id}/advance`,
        { fromPosition: position },
      );
      onUpdate(moved);
    } catch (error) {
      setAdvancing(false);
      toast.error('Could not move on', { description: errorMessage(error) });
      if (error instanceof ApiClientError && error.status === 409) onStale();
    }
  }

  const tone = countdownTone(remaining);
  const questionTone = countdownTone(questionRemaining);

  return (
    <>
      <PageHeader
        title={attempt.quiz.title}
        breadcrumbs={[
          home,
          listCrumb,
          { label: attempt.quiz.title, href: academyQuizHref(attempt.quiz.slug) },
          { label: `Attempt ${attempt.attemptNumber}` },
        ]}
        description={`${attempt.questionCount} question${attempt.questionCount === 1 ? '' : 's'} · ${formatMarksValue(attempt.maxScore)} marks${attempt.negativeMarking ? ' · negative marking applies' : ''}`}
      />

      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span
            role="timer"
            aria-live={tone === 'normal' ? 'off' : 'polite'}
            aria-label={`Time remaining ${formatCountdown(remaining ?? 0)}`}
            className={cn(
              'flex items-center gap-2 type-h4 font-mono tabular-nums',
              tone === 'warning' && 'text-warning',
              tone === 'critical' && 'text-destructive',
            )}
          >
            <Clock className="size-5" aria-hidden />
            {formatCountdown(remaining ?? 0)}
          </span>
          {questionRemaining !== null ? (
            <span
              role="timer"
              aria-live={questionTone === 'normal' ? 'off' : 'polite'}
              aria-label={`Time left for this question ${formatCountdown(questionRemaining)}`}
              className={cn(
                'flex items-center gap-1.5 font-mono type-body-sm tabular-nums',
                questionTone === 'critical' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              <Hourglass className="size-4" aria-hidden /> This question{' '}
              {formatCountdown(questionRemaining)}
            </span>
          ) : null}
        </div>
        <SaveIndicator unsaved={unsaved} online={online} />
        <Button
          onClick={() => setConfirming(true)}
          disabled={submitting}
          loading={submitting}
          loadingText="Submitting…"
        >
          <Send aria-hidden /> Submit
        </Button>
      </div>

      {finalNotice ? (
        <Alert tone="warning" title="This attempt is closed">
          <p>{finalNotice}</p>
        </Alert>
      ) : null}
      {!online ? (
        <Alert tone="warning" title="You are offline">
          <p>
            Your latest answers will be sent when the connection returns. Only answers the server
            receives before the deadline count.
          </p>
        </Alert>
      ) : null}
      <p className="type-caption text-muted-foreground">
        Ends at {formatDateTime(attempt.deadlineAt)} IST (server time). The timer keeps running on
        the server even if you close this page.
      </p>

      <div
        className={cn('grid gap-6', !linear && 'lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start')}
      >
        <section
          aria-labelledby="question-heading"
          className="grid min-w-0 gap-4 rounded-xl border bg-card p-4 shadow-card sm:p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="question-heading" className="type-h4 text-heading">
              Question {position + 1} of {attempt.questionCount}
            </h2>
            <span className="flex flex-wrap gap-2">
              <Badge variant="outline">{QUESTION_TYPE_LABELS[question.type]}</Badge>
              <Badge variant="secondary">
                {formatMarksValue(question.marks)} mark{question.marks === 1 ? '' : 's'}
                {attempt.negativeMarking && question.negativeMarks > 0
                  ? ` · −${formatMarksValue(question.negativeMarks)} if wrong`
                  : ''}
              </Badge>
            </span>
          </div>
          {/* Question text is plain text, never HTML. */}
          <p className="type-body break-words whitespace-pre-wrap">{question.prompt}</p>
          <QuestionImages key={question.id} images={question.images} priority />
          <AnswerInput
            question={question}
            answer={local}
            disabled={locked}
            onChange={(nextAnswer) => change(question, nextAnswer)}
          />
          {linear ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="type-caption text-muted-foreground">
                You cannot return to a question after moving on.
                {attempt.requireAnswerToAdvance ? ' Answer it to continue.' : ''}
              </p>
              {isLast ? (
                <Button onClick={() => setConfirming(true)} disabled={submitting}>
                  <Send aria-hidden /> Finish and submit
                </Button>
              ) : (
                <Button
                  onClick={() => void next()}
                  disabled={locked || (attempt.requireAnswerToAdvance && !currentAnswered)}
                  loading={advancing}
                  loadingText="Saving…"
                >
                  Next question <ArrowRight aria-hidden />
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="outline"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
              >
                <ArrowLeft aria-hidden /> Previous
              </Button>
              <Button
                variant="ghost"
                aria-pressed={marked.has(question.id)}
                onClick={() => toggleMark(question.id)}
              >
                {marked.has(question.id) ? (
                  <>
                    <BookmarkCheck aria-hidden /> Marked for review
                  </>
                ) : (
                  <>
                    <Bookmark aria-hidden /> Mark for review
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))}
                disabled={index === questions.length - 1}
              >
                Next <ArrowRight aria-hidden />
              </Button>
            </div>
          )}
        </section>

        {linear ? null : (
          <nav aria-label="Questions" className="grid gap-3 rounded-xl border bg-card p-4">
            <p className="type-label text-heading">
              {answeredCount} of {questions.length} answered
              {marked.size > 0 ? ` · ${marked.size} marked` : ''}
            </p>
            <ol className="grid grid-cols-6 gap-2 sm:grid-cols-8 lg:grid-cols-5">
              {questions.map((q, i) => {
                const answered = isAnswered({ type: q.type, ...answers[q.id]! });
                const flagged = marked.has(q.id);
                return (
                  <li key={q.id}>
                    <button
                      type="button"
                      onClick={() => setIndex(i)}
                      aria-current={i === index ? 'step' : undefined}
                      aria-label={`Question ${i + 1}, ${answered ? 'answered' : 'not answered'}${flagged ? ', marked for review' : ''}`}
                      className={cn(
                        'relative flex size-9 items-center justify-center rounded-md border type-label tabular-nums focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                        answered ? 'border-primary bg-secondary text-primary' : 'bg-background',
                        i === index && 'ring-2 ring-primary',
                      )}
                    >
                      {i + 1}
                      {flagged ? (
                        <span
                          aria-hidden
                          className="absolute -top-1 -right-1 size-2.5 rounded-full bg-warning"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="type-caption text-muted-foreground">
              Marks for review are kept on this device only and do not affect your score.
            </p>
          </nav>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Submit your answers?"
        description={
          linear
            ? isLast
              ? `${unanswered ? 'This question is not answered. ' : ''}You cannot change your answers after submitting.`
              : `${attempt.questionCount - position - 1} question${attempt.questionCount - position - 1 === 1 ? ' is' : 's are'} still ahead and will count as unanswered. You cannot change your answers after submitting.`
            : unanswered > 0
              ? `${unanswered} question${unanswered === 1 ? ' is' : 's are'} not answered${marked.size ? ` and ${marked.size} marked for review` : ''}. You cannot change your answers after submitting.`
              : 'You cannot change your answers after submitting.'
        }
        confirmLabel="Submit"
        pendingLabel="Submitting…"
        onConfirm={() => submit(false)}
      />
    </>
  );
}

// --- Finalized attempt ----------------------------------------------------------------------

export function AcademyAttemptOutcome({ attempt }: { attempt: StudentAcademyAttemptDto }) {
  React.useEffect(() => {
    leaveFullscreen();
    clearMarked(attempt.id);
  }, [attempt.id]);
  const result = attempt.result;
  return (
    <>
      <PageHeader
        title={attempt.quiz.title}
        breadcrumbs={[
          home,
          listCrumb,
          { label: attempt.quiz.title, href: academyQuizHref(attempt.quiz.slug) },
          { label: `Attempt ${attempt.attemptNumber}` },
        ]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={RESULT_STATE_BADGE[attempt.resultState]}>
              {RESULT_STATE_LABELS[attempt.resultState]}
            </Badge>
            <span>
              {ATTEMPT_STATUS_LABELS[attempt.status]}
              {attempt.submittedAt ? ` · ${formatDateTime(attempt.submittedAt)} IST` : ''}
            </span>
          </span>
        }
        actions={
          <Button asChild variant="outline">
            <Link href={academyQuizHref(attempt.quiz.slug)}>Back to the quiz</Link>
          </Button>
        }
      />
      {attempt.status === 'EXPIRED' ? (
        <Alert tone="info" title="Submitted automatically">
          <p>
            Time ran out. The answers the server had received before the deadline were submitted.
          </p>
        </Alert>
      ) : null}
      {result ? (
        <section
          aria-labelledby="score-heading"
          className="grid grid-cols-2 gap-4 rounded-xl border bg-card p-6 shadow-card sm:grid-cols-4"
        >
          <h2 id="score-heading" className="sr-only">
            Your result
          </h2>
          <ScoreFact label="Score" value={formatScore(result.score, result.maxScore)} />
          <ScoreFact label="Percentage" value={`${result.percent}%`} />
          <ScoreFact
            label="Result"
            value={result.passed ? 'Passed' : 'Not passed'}
            tone={result.passed ? 'success' : 'warning'}
          />
          <ScoreFact
            label="Negative marks"
            value={result.penalty > 0 ? `−${formatMarksValue(result.penalty)}` : 'None'}
          />
        </section>
      ) : (
        <Alert tone="info" title="Result not published yet">
          <p>
            Your answers are saved.{' '}
            {attempt.resultsAt
              ? `Results are published on ${formatDateTime(attempt.resultsAt)} IST.`
              : 'The academy will publish the results after the quiz ends.'}{' '}
            Come back to this page to see your score.
          </p>
        </Alert>
      )}
      {attempt.review ? (
        <ReviewList questions={attempt.review} />
      ) : (
        <OwnAnswers
          attempt={attempt}
          note="Correct answers are shown only when the quiz rules allow it."
        />
      )}
    </>
  );
}
