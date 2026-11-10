'use client';

import type { FacultyAttemptDetail, ReviewQuestionDto } from '@asra/types';
import { answerGradeSchema } from '@asra/validation';
import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { ApiClientError } from '@/lib/api';
import {
  ATTEMPT_STATUS_LABELS,
  formatMarksValue,
  formatScore,
  QUESTION_TYPE_LABELS,
} from '@/lib/assessments';
import { describeError, validateForm, type FieldErrors } from '@/lib/auth/form-errors';
import { OptionImage, QuestionImages, optionLetter } from '@/components/assessments/question-media';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

import {
  ErrorPanel,
  LoadingPanel,
  errorMessage,
  useApiResource,
  useFacultyApi,
} from './faculty-ui';

/**
 * One attempt as faculty see it (PHASE 09): the student's frozen questions with the answer key,
 * automatic outcomes, and manual grading of written answers. The API refuses grading once results
 * are published, and recomputes the score itself after each grade.
 */

const home = { label: 'Dashboard', href: '/faculty/dashboard' };

export function AttemptReview({ attemptId }: { attemptId: string }) {
  const api = useFacultyApi();
  const path = `/faculty/attempts/${attemptId}`;
  const attempt = useApiResource(path, () => api.get<FacultyAttemptDetail>(path));

  if (attempt.error && !attempt.data) {
    const denied = attempt.error instanceof ApiClientError && attempt.error.status === 403;
    return (
      <>
        <PageHeader title="Attempt" breadcrumbs={[home, { label: 'Attempt' }]} />
        <ErrorPanel
          title={denied ? 'No access' : undefined}
          message={errorMessage(attempt.error)}
          onRetry={denied ? undefined : attempt.reload}
        />
      </>
    );
  }
  if (!attempt.data) return <LoadingPanel label="Loading attempt…" rows={6} />;
  const data = attempt.data;
  const parent =
    data.kind === 'QUIZ'
      ? { label: data.assessment.title, href: `/faculty/quizzes/${data.assessment.lessonId}` }
      : { label: data.assessment.title, href: `/faculty/exams/${data.assessment.id}` };

  return (
    <>
      <PageHeader
        title={`${data.student.fullName} · attempt ${data.attemptNumber}`}
        breadcrumbs={[
          home,
          {
            label: data.kind === 'QUIZ' ? 'Quizzes' : 'Exams',
            href: data.kind === 'QUIZ' ? '/faculty/quizzes' : '/faculty/exams',
          },
          parent,
          { label: `Attempt ${data.attemptNumber}` },
        ]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{ATTEMPT_STATUS_LABELS[data.status]}</Badge>
            {data.evaluationStatus === 'PENDING' ? (
              <Badge variant="warning">Needs grading</Badge>
            ) : null}
            <span>
              {data.course.title} · started {formatDateTime(data.startedAt)} IST
              {data.submittedAt ? ` · submitted ${formatDateTime(data.submittedAt)} IST` : ''}
              {data.deadlineAt ? ` · deadline ${formatDateTime(data.deadlineAt)} IST` : ''}
            </span>
          </span>
        }
        actions={
          <Button asChild variant="outline">
            <Link href={parent.href}>Back to {data.kind === 'QUIZ' ? 'quiz' : 'exam'}</Link>
          </Button>
        }
      />
      {data.status === 'IN_PROGRESS' ? (
        <Alert tone="info">
          <p>
            This attempt is still in progress. Answers are shown after it is submitted or its time
            runs out.
          </p>
        </Alert>
      ) : data.result ? (
        <section
          aria-label="Score"
          className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-4"
        >
          <Fact label="Score" value={formatScore(data.result.score, data.result.maxScore)} />
          <Fact label="Percentage" value={`${data.result.percent}%`} />
          <Fact
            label="Raw / penalty"
            value={`${formatMarksValue(data.result.rawScore)} / −${formatMarksValue(data.result.penalty)}`}
          />
          <Fact label="Result" value={data.result.passed ? 'Passed' : 'Not passed'} />
        </section>
      ) : (
        <Alert tone="warning" title="Awaiting evaluation">
          <p>
            Grade every written answer below. The score is calculated when the last one is graded.
          </p>
        </Alert>
      )}
      <ol className="grid gap-3">
        {data.questions.map((question, index) => (
          <li key={question.id} className="grid gap-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="grid gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="type-label text-heading">Q{index + 1}</span>
                  <Badge variant="outline">{QUESTION_TYPE_LABELS[question.type]}</Badge>
                </span>
                <span className="type-body break-words whitespace-pre-wrap">{question.prompt}</span>
              </span>
              <MarksBadge question={question} />
            </div>
            <QuestionImages images={question.images} />
            {question.type === 'SHORT_ANSWER' ? (
              <>
                {/* Student text is rendered as text, never as HTML. */}
                <div className="rounded-lg border bg-background p-3 type-body-sm break-words whitespace-pre-wrap">
                  {question.textAnswer || (
                    <em className="text-muted-foreground">Not answered (scores 0 automatically)</em>
                  )}
                </div>
                {question.answered && data.status !== 'IN_PROGRESS' ? (
                  <GradeAnswer
                    key={`${question.id}:${question.gradedAt ?? ''}`}
                    question={question}
                    onSaved={attempt.replace}
                  />
                ) : null}
              </>
            ) : (
              <ul className="grid gap-1 type-body-sm">
                {question.options.map((option, optionIndex) => (
                  <li
                    key={option.id}
                    className={cn(
                      'flex items-start gap-2',
                      option.isCorrect && 'font-semibold text-success',
                    )}
                  >
                    {option.selected ? (
                      option.isCorrect ? (
                        <CheckCircle2 className="size-4" aria-hidden />
                      ) : (
                        <XCircle className="size-4 text-destructive" aria-hidden />
                      )
                    ) : (
                      <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
                    )}
                    <span className="grid gap-1">
                      <span>
                        {option.text || `Option ${optionLetter(optionIndex)}`}
                        {option.isCorrect ? ' (correct)' : ''}
                        {option.selected ? ' — chosen' : ''}
                      </span>
                      <OptionImage image={option.image} index={optionIndex} className="max-w-48" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="type-caption text-muted-foreground">{label}</span>
      <span className="type-h4 tabular-nums">{value}</span>
    </div>
  );
}

function MarksBadge({ question }: { question: ReviewQuestionDto }) {
  if (question.awardedMarks === null) return <Badge variant="warning">Not graded</Badge>;
  const penalty =
    question.penalty && question.penalty > 0 ? ` −${formatMarksValue(question.penalty)}` : '';
  return (
    <Badge variant={question.isCorrect ? 'success' : 'secondary'} className="tabular-nums">
      {formatMarksValue(question.awardedMarks)} / {formatMarksValue(question.marks)}
      {penalty}
    </Badge>
  );
}

function GradeAnswer({
  question,
  onSaved,
}: {
  question: ReviewQuestionDto;
  onSaved: (data: FacultyAttemptDetail) => void;
}) {
  const api = useFacultyApi();
  const [marks, setMarks] = React.useState(
    question.gradedAt && question.awardedMarks !== null ? String(question.awardedMarks) : '',
  );
  const [feedback, setFeedback] = React.useState(question.feedback ?? '');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    const parsed = validateForm(answerGradeSchema, {
      awardedMarks: marks.trim() === '' ? undefined : Number(marks),
      feedback,
    });
    setFormError(null);
    if (parsed.errors) return setErrors(parsed.errors);
    if (parsed.data.awardedMarks > question.marks) {
      return setErrors({ awardedMarks: `At most ${formatMarksValue(question.marks)}` });
    }
    setErrors({});
    setPending(true);
    try {
      onSaved(
        await api.put<FacultyAttemptDetail>(
          `/faculty/attempt-answers/${question.id}/grade`,
          parsed.data,
        ),
      );
      toast.success('Marks saved', {
        description: 'Students see them only after results are published.',
      });
    } catch (error) {
      const described = describeError(error);
      setErrors(described.fieldErrors);
      setFormError(described.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end"
    >
      {formError ? (
        <Alert tone="error" className="sm:col-span-3">
          <p>{formError}</p>
        </Alert>
      ) : null}
      <Field
        id={`marks-${question.id}`}
        label={`Marks (0–${formatMarksValue(question.marks)})`}
        error={errors.awardedMarks}
      >
        <Input
          type="number"
          min={0}
          max={question.marks}
          step={0.25}
          inputMode="decimal"
          value={marks}
          onChange={(e) => setMarks(e.target.value)}
        />
      </Field>
      <Field id={`feedback-${question.id}`} label="Feedback" optional error={errors.feedback}>
        <Textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      </Field>
      <Button type="submit" loading={pending} loadingText="Saving…">
        {question.gradedAt ? 'Update marks' : 'Save marks'}
      </Button>
    </form>
  );
}
