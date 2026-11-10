'use client';

import type { AttemptQuestionDto, ReviewQuestionDto, StudentAttemptDto } from '@asra/types';
import { TEXT_ANSWER_MAX_LENGTH } from '@asra/validation';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Clock,
  CloudOff,
  Loader2,
  Send,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { ConfirmDialog } from '@/components/admin/admin-ui';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  useAnswerAutosave,
  type AnswerChange,
  type LocalAnswer,
} from '@/components/assessments/use-answer-autosave';
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
  toggleOption,
} from '@/lib/assessments';
import { OptionImage, QuestionImages, optionLetter } from '@/components/assessments/question-media';
import { formatDateTime } from '@/lib/format';
import { learnHref } from '@/lib/student/learning';
import { cn } from '@/lib/utils';

import { ErrorPanel, LoadingPanel } from './student-ui';
import { errorMessage, useApiResource, useStudentApi } from './use-student';

/**
 * Taking a quiz or an examination (PHASE 09, docs/ASSESSMENTS.md §8).
 *
 * The SERVER decides everything that matters: the start time, the deadline, whether an answer is
 * accepted and when the attempt is final. This component only
 *   - shows a countdown computed from the server deadline, corrected by the server clock;
 *   - autosaves each answer with an increasing sequence number (late retries cannot overwrite a
 *     newer answer) and retries after network failures;
 *   - asks the server to submit when the student confirms or when the countdown reaches zero
 *     (if that request is lost, the server finalizes the attempt at its deadline anyway).
 */

const home = { label: 'Dashboard', href: '/student/dashboard' };

function backHref(attempt: StudentAttemptDto) {
  return attempt.kind === 'QUIZ'
    ? learnHref(attempt.assessment.course.id, attempt.assessment.lessonId)
    : `/student/exams/${attempt.assessment.id}`;
}

export function AttemptPlayer({ attemptId }: { attemptId: string }) {
  const api = useStudentApi();
  const path = `/student/attempts/${attemptId}`;
  const resource = useApiResource(path, async () => {
    const data = await api.get<StudentAttemptDto>(path);
    return { data, receivedAt: Date.now() };
  });

  if (resource.error && !resource.data) {
    const notFound = resource.error instanceof ApiClientError && resource.error.status === 404;
    return (
      <>
        <PageHeader title="Attempt" breadcrumbs={[home, { label: 'Attempt' }]} />
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
  return data.status === 'IN_PROGRESS' ? (
    <RunningAttempt
      key={`${data.id}:${receivedAt}`}
      attempt={data}
      receivedAt={receivedAt}
      onFinal={(final) => resource.replace({ data: final, receivedAt: Date.now() })}
      onStale={resource.reload}
    />
  ) : (
    <AttemptOutcome attempt={data} />
  );
}

// --- Running attempt ------------------------------------------------------------------------

function RunningAttempt({
  attempt,
  receivedAt,
  onFinal,
  onStale,
}: {
  attempt: StudentAttemptDto;
  receivedAt: number;
  onFinal: (attempt: StudentAttemptDto) => void;
  onStale: () => void;
}) {
  const api = useStudentApi();
  const questions = attempt.questions;
  const [index, setIndex] = React.useState(0);
  const [skew] = React.useState(() => clockSkewMs(attempt.serverNow, receivedAt));
  const [now, setNow] = React.useState(receivedAt);
  const [online, setOnline] = React.useState(true);
  const [confirming, setConfirming] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [finalNotice, setFinalNotice] = React.useState<string | null>(null);
  const submitStarted = React.useRef(false);

  // Display clock: one tick per second. The server keeps the authoritative time.
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

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
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const handleConflict = React.useCallback(
    (error: ApiClientError) => {
      setFinalNotice(error.message);
      onStale();
    },
    [onStale],
  );
  const answerPath = React.useCallback(
    (questionId: string) => `/student/attempts/${attempt.id}/answers/${questionId}`,
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
        const final = await api.post<StudentAttemptDto>(`/student/attempts/${attempt.id}/submit`);
        toast.success(
          final.status === 'EXPIRED' ? 'Time is up — answers submitted' : 'Attempt submitted',
        );
        onFinal(final);
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
    [api, attempt.id, onFinal],
  );

  const remaining = remainingMs(attempt.deadlineAt, skew, now);
  const tone = countdownTone(remaining);

  // When the countdown reaches zero, ask the server to finalize (it would anyway at the deadline).
  React.useEffect(() => {
    if (remaining === 0 && !submitStarted.current) {
      const timer = setTimeout(() => void submit(true).catch(() => undefined), 0);
      return () => clearTimeout(timer);
    }
  }, [remaining, submit]);

  const question = questions[index]!;
  const local = answers[question.id]!;
  const unanswered = questions.filter(
    (q) => !isAnswered({ type: q.type, ...answers[q.id]! }),
  ).length;

  return (
    <>
      <PageHeader
        title={attempt.assessment.title}
        breadcrumbs={[
          home,
          attempt.kind === 'EXAM'
            ? { label: 'Exams', href: '/student/exams' }
            : { label: 'Quizzes', href: '/student/quizzes' },
          { label: `Attempt ${attempt.attemptNumber}` },
        ]}
        description={`${attempt.assessment.course.title} · ${questions.length} question${questions.length === 1 ? '' : 's'} · ${formatMarksValue(attempt.maxScore)} marks${attempt.negativeMarking ? ' · negative marking applies' : ''}`}
      />

      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        {remaining === null ? (
          <span className="flex items-center gap-2 type-body-sm text-muted-foreground">
            <Clock className="size-4" aria-hidden /> No time limit
          </span>
        ) : (
          <span
            role="timer"
            aria-live={tone === 'normal' ? 'off' : 'polite'}
            aria-label={`Time remaining ${formatCountdown(remaining)}`}
            className={cn(
              'flex items-center gap-2 type-h4 font-mono tabular-nums',
              tone === 'warning' && 'text-warning',
              tone === 'critical' && 'text-destructive',
            )}
          >
            <Clock className="size-5" aria-hidden />
            {formatCountdown(remaining)}
          </span>
        )}
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
      {attempt.deadlineAt ? (
        <p className="type-caption text-muted-foreground">
          Server deadline: {formatDateTime(attempt.deadlineAt)} IST. The timer keeps running on the
          server even if you close this page.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
        <section
          aria-labelledby="question-heading"
          className="grid gap-4 rounded-xl border bg-card p-5 shadow-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="question-heading" className="type-h4 text-heading">
              Question {index + 1} of {questions.length}
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
            disabled={submitting || finalNotice !== null}
            onChange={(next) => change(question, next)}
          />
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="outline"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
            >
              <ArrowLeft aria-hidden /> Previous
            </Button>
            <Button
              variant="outline"
              onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))}
              disabled={index === questions.length - 1}
            >
              Next <ArrowRight aria-hidden />
            </Button>
          </div>
        </section>

        <nav aria-label="Questions" className="grid gap-3 rounded-xl border bg-card p-4">
          <p className="type-label text-heading">
            {questions.length - unanswered} of {questions.length} answered
          </p>
          <ol className="grid grid-cols-5 gap-2">
            {questions.map((q, i) => {
              const answered = isAnswered({ type: q.type, ...answers[q.id]! });
              return (
                <li key={q.id}>
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-current={i === index ? 'step' : undefined}
                    aria-label={`Question ${i + 1}, ${answered ? 'answered' : 'not answered'}`}
                    className={cn(
                      'flex size-9 items-center justify-center rounded-md border type-label tabular-nums focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                      answered ? 'border-primary bg-secondary text-primary' : 'bg-background',
                      i === index && 'ring-2 ring-primary',
                    )}
                  >
                    {i + 1}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Submit your answers?"
        description={
          unanswered > 0
            ? `${unanswered} question${unanswered === 1 ? ' is' : 's are'} not answered. You cannot change your answers after submitting.`
            : 'You cannot change your answers after submitting.'
        }
        confirmLabel="Submit"
        pendingLabel="Submitting…"
        onConfirm={() => submit(false)}
      />
    </>
  );
}

export function SaveIndicator({ unsaved, online }: { unsaved: number; online: boolean }) {
  if (!online) {
    return (
      <span className="flex items-center gap-1.5 type-body-sm text-warning">
        <CloudOff className="size-4" aria-hidden /> Offline — {unsaved} unsaved
      </span>
    );
  }
  return (
    <span role="status" className="flex items-center gap-1.5 type-body-sm text-muted-foreground">
      {unsaved > 0 ? (
        <>
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> Saving…
        </>
      ) : (
        <>
          <CheckCircle2 className="size-4 text-success" aria-hidden /> All answers saved
        </>
      )}
    </span>
  );
}

export function AnswerInput({
  question,
  answer,
  disabled,
  onChange,
}: {
  question: AttemptQuestionDto;
  answer: Pick<LocalAnswer, 'selectedOptionIds' | 'textAnswer'>;
  disabled: boolean;
  onChange: (next: AnswerChange) => void;
}) {
  if (question.type === 'SHORT_ANSWER') {
    return (
      <div className="grid gap-1">
        <label htmlFor={`answer-${question.id}`} className="type-label">
          Your answer
        </label>
        <Textarea
          id={`answer-${question.id}`}
          rows={8}
          maxLength={TEXT_ANSWER_MAX_LENGTH}
          value={answer.textAnswer ?? ''}
          disabled={disabled}
          onChange={(event) => onChange({ textAnswer: event.target.value })}
        />
        <span className="type-caption text-muted-foreground">Saved automatically as you type.</span>
      </div>
    );
  }
  const multiple = question.type === 'MULTIPLE_CHOICE';
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 type-label">
        {multiple ? 'Choose every correct answer' : 'Choose one answer'}
      </legend>
      {question.options.map((option, optionIndex) => {
        const checked = answer.selectedOptionIds.includes(option.id);
        return (
          <label
            key={option.id}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-3 type-body transition-colors hover:bg-secondary/60',
              checked && 'border-primary bg-secondary',
            )}
          >
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={`question-${question.id}`}
              checked={checked}
              onChange={() =>
                onChange({
                  selectedOptionIds: toggleOption(
                    question.type,
                    answer.selectedOptionIds,
                    option.id,
                  ),
                })
              }
              onClick={(event) => {
                // Clicking the chosen radio again clears the answer (unanswered = no penalty).
                if (!multiple && checked) {
                  event.preventDefault();
                  onChange({ selectedOptionIds: [] });
                }
              }}
              className="mt-1 size-4 accent-primary"
              aria-label={option.text ? undefined : `Option ${optionLetter(optionIndex)}`}
            />
            <span className="grid min-w-0 gap-2">
              {option.text ? <span className="break-words">{option.text}</span> : null}
              <OptionImage image={option.image} index={optionIndex} />
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

// --- Finalized attempt ----------------------------------------------------------------------

export function AttemptOutcome({ attempt }: { attempt: StudentAttemptDto }) {
  const result = attempt.result;
  return (
    <>
      <PageHeader
        title={attempt.assessment.title}
        breadcrumbs={[
          home,
          attempt.kind === 'EXAM'
            ? { label: 'Exams', href: '/student/exams' }
            : { label: 'Quizzes', href: '/student/quizzes' },
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
            <Link href={backHref(attempt)}>
              {attempt.kind === 'EXAM' ? 'Back to the exam' : 'Back to the lesson'}
            </Link>
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
          className="grid gap-4 rounded-xl border bg-card p-6 shadow-card sm:grid-cols-4"
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
      ) : attempt.resultState === 'PENDING_EVALUATION' ? (
        <Alert tone="info" title="Awaiting evaluation">
          <p>
            Your written answers are being graded by your faculty. Your score appears once results
            are published.
          </p>
        </Alert>
      ) : (
        <Alert tone="info" title="Result not published yet">
          <p>
            Your answers are saved. Your faculty will publish the results; they will appear here and
            on your Results page.
          </p>
        </Alert>
      )}
      {attempt.review ? (
        <ReviewList questions={attempt.review} />
      ) : (
        <OwnAnswers attempt={attempt} />
      )}
    </>
  );
}

export function ScoreFact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'warning';
}) {
  return (
    <div className="grid gap-1">
      <span className="type-caption text-muted-foreground">{label}</span>
      <span
        className={cn(
          'type-h3 tabular-nums',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** The student's own answers, without the answer key (used until answers may be revealed). */
export function OwnAnswers({
  attempt,
  note = 'Correct answers are shown only when your faculty allow it.',
}: {
  attempt: { questions: AttemptQuestionDto[] };
  note?: string;
}) {
  return (
    <section aria-labelledby="answers-heading" className="grid gap-3">
      <h2 id="answers-heading" className="type-h3 text-heading">
        Your answers
      </h2>
      <ol className="grid gap-3">
        {attempt.questions.map((q, i) => (
          <li key={q.id} className="grid gap-2 rounded-xl border bg-card p-4">
            <span className="type-label text-heading">
              {i + 1}. <span className="whitespace-pre-wrap">{q.prompt}</span>
            </span>
            <QuestionImages images={q.images} />
            {q.type === 'SHORT_ANSWER' ? (
              <p className="type-body-sm whitespace-pre-wrap">
                {q.textAnswer || <em className="text-muted-foreground">Not answered</em>}
              </p>
            ) : (
              <ul className="grid gap-1 type-body-sm">
                {q.options.map((o, optionIndex) => (
                  <li key={o.id} className="flex items-start gap-2">
                    {q.selectedOptionIds.includes(o.id) ? (
                      <CheckCircle2 className="size-4 text-primary" aria-label="Your choice" />
                    ) : (
                      <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
                    )}
                    <span className="grid gap-1">
                      {o.text ? <span>{o.text}</span> : null}
                      <OptionImage image={o.image} index={optionIndex} className="max-w-48" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <p className="type-caption text-muted-foreground">{note}</p>
    </section>
  );
}

/** Answer key + explanations (only returned by the API when release rules allow it). */
export function ReviewList({
  questions,
  heading = 'Answers and explanations',
}: {
  questions: ReviewQuestionDto[];
  heading?: string;
}) {
  return (
    <section aria-labelledby="review-heading" className="grid gap-3">
      <h2 id="review-heading" className="type-h3 text-heading">
        {heading}
      </h2>
      <ol className="grid gap-3">
        {questions.map((q, i) => (
          <li key={q.id} className="grid gap-2 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="type-label break-words text-heading">
                {i + 1}. <span className="whitespace-pre-wrap">{q.prompt}</span>
              </span>
              <OutcomeBadge question={q} />
            </div>
            <QuestionImages images={q.images} />
            {q.type === 'SHORT_ANSWER' ? (
              <div className="grid gap-1">
                <p className="type-body-sm whitespace-pre-wrap">
                  {q.textAnswer || <em className="text-muted-foreground">Not answered</em>}
                </p>
                {q.feedback ? (
                  <p className="type-body-sm whitespace-pre-line text-muted-foreground">
                    Feedback: {q.feedback}
                  </p>
                ) : null}
              </div>
            ) : (
              <ul className="grid gap-1 type-body-sm">
                {q.options.map((o, optionIndex) => (
                  <li
                    key={o.id}
                    className={cn(
                      'flex items-start gap-2',
                      o.isCorrect && 'font-semibold text-success',
                    )}
                  >
                    {o.selected ? (
                      o.isCorrect ? (
                        <CheckCircle2 className="size-4" aria-hidden />
                      ) : (
                        <XCircle className="size-4 text-destructive" aria-hidden />
                      )
                    ) : (
                      <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
                    )}
                    <span className="grid gap-1">
                      <span>
                        {o.text || `Option ${optionLetter(optionIndex)}`}
                        {o.isCorrect ? ' (correct answer)' : ''}
                        {o.selected ? ' — selected' : ''}
                      </span>
                      <OptionImage image={o.image} index={optionIndex} className="max-w-48" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {q.explanation ? (
              <p className="type-caption whitespace-pre-line text-muted-foreground">
                {q.explanation}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function OutcomeBadge({ question }: { question: ReviewQuestionDto }) {
  if (question.awardedMarks === null) {
    return (
      <Badge variant="warning">
        <AlertTriangle aria-hidden /> Not graded yet
      </Badge>
    );
  }
  const marks = `${formatMarksValue(question.awardedMarks)}/${formatMarksValue(question.marks)}`;
  const penalty =
    question.penalty && question.penalty > 0 ? ` −${formatMarksValue(question.penalty)}` : '';
  return (
    <Badge
      variant={question.isCorrect ? 'success' : question.answered ? 'destructive' : 'secondary'}
    >
      {question.isCorrect ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}
      {question.answered ? marks + penalty : 'Not answered'}
    </Badge>
  );
}
