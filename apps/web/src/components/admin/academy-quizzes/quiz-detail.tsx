'use client';

import {
  PERMISSIONS,
  type AdminAcademyQuizDetail,
  type AdminAuditEntryDto,
  type Paginated,
} from '@asra/types';
import { AlertTriangle, CheckCircle2, Copy, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { MediaImg } from '@/components/assessments/question-media';
import { QuestionEditor, type QuestionEndpoints } from '@/components/faculty/assessment-builder';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  ANSWER_REVEAL_OPTIONS,
  COUNTING_LABELS,
  DIFFICULTY_LABELS,
  LEADERBOARD_LABELS,
  NAVIGATION_LABELS,
  RESULT_RELEASE_LABELS,
  SELECTION_LABELS,
  TIE_BREAK_LABELS,
  availableActions,
  timingSummary,
  type QuizAction,
} from '@/lib/admin/academy-quizzes';
import { formatMarksValue } from '@/lib/assessments';
import { formatDateTime } from '@/lib/format';

import { Section } from '../admin-kit';
import { ConfirmDialog, ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, hasPermission, useAdminApi, useApiResource } from '../use-admin';
import { AcademyAttemptsSection, AdminLeaderboardSection } from './attempts';
import { CopyQuestionsDialog } from './copy-questions-dialog';
import { ADMIN_MEDIA_UPLOAD } from './quiz-form';
import { PhaseBadge } from './quiz-list';

const ACTION_COPY: Record<
  QuizAction,
  { label: string; title: string; description: string; destructive?: boolean; done: string }
> = {
  publish: {
    label: 'Publish',
    title: 'Publish this quiz?',
    description:
      'Students can see it straight away and attempt it between the start and end times. Timing, scoring, selection, eligibility and ranking are then locked.',
    done: 'Quiz published',
  },
  unpublish: {
    label: 'Back to draft',
    title: 'Move this quiz back to draft?',
    description: 'It disappears for students. Possible only because nobody has attempted it yet.',
    done: 'Quiz moved back to draft',
  },
  close: {
    label: 'Close now',
    title: 'Close this quiz now?',
    description:
      'No new attempts can start. Running attempts are submitted immediately with the answers saved so far.',
    destructive: true,
    done: 'Quiz closed',
  },
  reopen: {
    label: 'Reopen',
    title: 'Reopen this quiz?',
    description: 'Students can attempt it again until the end time.',
    done: 'Quiz reopened',
  },
  delete: {
    label: 'Delete draft',
    title: 'Delete this draft?',
    description:
      'The quiz and its questions are removed permanently. Unused images are deleted too.',
    destructive: true,
    done: 'Draft deleted',
  },
  publishResults: {
    label: 'Publish results',
    title: 'Publish the results?',
    description:
      'Students see their scores (and answers, per the reveal setting). Expired attempts are finalized first. This cannot be undone.',
    done: 'Results published',
  },
};

/** The shared editor's endpoints for academy questions (admin routes, admin uploads). */
export const ACADEMY_QUESTION_ENDPOINTS: QuestionEndpoints = {
  question: (questionId) => `/admin/academy-quiz-questions/${questionId}`,
  upload: ADMIN_MEDIA_UPLOAD,
};

/** `/admin/academy-quizzes/[id]` — overview, readiness, lifecycle, questions, prizes, history. */
export function AcademyQuizDetail({ id }: { id: string }) {
  const api = useAdminApi();
  const router = useRouter();
  const { user } = useAuth();
  const path = `/admin/academy-quizzes/${id}`;
  const quiz = useApiResource(path, () => api.get<AdminAcademyQuizDetail>(path));
  const [confirming, setConfirming] = React.useState<QuizAction | null>(null);
  const [copying, setCopying] = React.useState(false);

  if (quiz.error && !quiz.data) {
    return <ErrorPanel message={errorMessage(quiz.error)} onRetry={quiz.reload} />;
  }
  if (!quiz.data) return <LoadingPanel label="Loading the quiz…" />;
  const data = quiz.data;
  const actions = availableActions(data);
  const draft = data.status === 'DRAFT';

  async function run(action: QuizAction) {
    try {
      if (action === 'delete') {
        await api.del(path);
        toast.success(ACTION_COPY.delete.done);
        router.push('/admin/academy-quizzes');
        return;
      }
      const next =
        action === 'publishResults'
          ? await api.post<AdminAcademyQuizDetail>(`${path}/publish-results`)
          : await api.post<AdminAcademyQuizDetail>(`${path}/status`, { action });
      quiz.replace(next);
      toast.success(ACTION_COPY[action].done);
    } catch (error) {
      toast.error('Could not complete the action', { description: errorMessage(error) });
      quiz.reload();
      throw error;
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title={data.title}
        description={`/student/academy-quizzes/${data.slug}`}
        breadcrumbs={[
          { label: 'Academy Quizzes', href: '/admin/academy-quizzes' },
          { label: data.title },
        ]}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <PhaseBadge phase={data.phase} />
            <Button asChild variant="outline">
              <Link href={`${path}/edit`}>
                <Pencil aria-hidden /> Settings
              </Link>
            </Button>
            {actions.map((action) => (
              <Button
                key={action}
                variant={
                  ACTION_COPY[action].destructive
                    ? 'destructive'
                    : action === 'publish'
                      ? 'default'
                      : 'outline'
                }
                disabled={action === 'publish' && data.publishProblems.length > 0}
                title={
                  action === 'publish' && data.publishProblems.length > 0
                    ? 'Resolve the publication blockers first'
                    : undefined
                }
                onClick={() => setConfirming(action)}
              >
                {ACTION_COPY[action].label}
              </Button>
            ))}
          </span>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Schedule (IST)">
          <dl className="grid gap-2 type-body-sm">
            <Row label="Starts">{formatDateTime(data.startsAt)}</Row>
            <Row label="Ends">{formatDateTime(data.endsAt)}</Row>
            <Row label="Timer">{timingSummary(data)}</Row>
            {data.closedAt ? <Row label="Closed">{formatDateTime(data.closedAt)}</Row> : null}
          </dl>
        </Section>
        <Section title="Attempts">
          <dl className="grid gap-2 type-body-sm">
            <Row label="Total">{data.attempts.total}</Row>
            <Row label="In progress">{data.attempts.inProgress}</Row>
            <Row label="Evaluated">{data.attempts.evaluated}</Row>
            <Row label="Per student">{data.settings.maxAttempts}</Row>
          </dl>
        </Section>
        <Section title="Results">
          <dl className="grid gap-2 type-body-sm">
            <Row label="Shown">{RESULT_RELEASE_LABELS[data.settings.resultRelease]}</Row>
            {data.settings.resultsAt ? (
              <Row label="At">{formatDateTime(data.settings.resultsAt)}</Row>
            ) : null}
            <Row label="Published">
              {data.resultsPublishedAt ? formatDateTime(data.resultsPublishedAt) : 'Not yet'}
            </Row>
            <Row label="Leaderboard">{LEADERBOARD_LABELS[data.settings.leaderboardVisibility]}</Row>
          </dl>
        </Section>
      </div>

      <Readiness quiz={data} />

      <div className="grid gap-3">
        {draft ? (
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setCopying(true)}>
              <Copy aria-hidden /> Copy questions from…
            </Button>
          </div>
        ) : null}
        <QuestionEditor
          kind="QUIZ"
          questions={data.questions}
          editable={draft}
          addPath={`${path}/questions`}
          orderPath={`${path}/question-order`}
          endpoints={ACADEMY_QUESTION_ENDPOINTS}
          showDifficulty
          onChanged={quiz.reload}
        />
      </div>

      {draft ? null : (
        <>
          <AcademyAttemptsSection quizId={id} />
          <AdminLeaderboardSection quizId={id} />
        </>
      )}

      <SettingsSummary quiz={data} />
      <PrizesPreview quiz={data} />
      {hasPermission(user, PERMISSIONS.AUDIT_LOGS_VIEW) ? <History quizId={id} /> : null}

      {confirming ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(null)}
          title={ACTION_COPY[confirming].title}
          description={ACTION_COPY[confirming].description}
          confirmLabel={ACTION_COPY[confirming].label}
          pendingLabel="Working…"
          destructive={ACTION_COPY[confirming].destructive}
          onConfirm={async () => {
            await run(confirming);
            setConfirming(null);
          }}
        />
      ) : null}
      {copying ? (
        <CopyQuestionsDialog quizId={id} onClose={() => setCopying(false)} onCopied={quiz.reload} />
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** What every attempt will look like, and what stops publication. */
export function Readiness({ quiz }: { quiz: AdminAcademyQuizDetail }) {
  const s = quiz.settings;
  const wanted =
    s.selection === 'BY_DIFFICULTY'
      ? { EASY: s.easyCount ?? 0, MEDIUM: s.mediumCount ?? 0, HARD: s.hardCount ?? 0 }
      : null;
  return (
    <Section title="Question availability" description={SELECTION_LABELS[s.selection]}>
      <div className="overflow-x-auto">
        <table className="w-full type-body-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-medium">Difficulty</th>
              <th className="py-1 text-right font-medium">In the quiz</th>
              {wanted ? <th className="py-1 text-right font-medium">Each student gets</th> : null}
            </tr>
          </thead>
          <tbody>
            {(['EASY', 'MEDIUM', 'HARD'] as const).map((level) => (
              <tr key={level} className="border-t">
                <td className="py-1">{DIFFICULTY_LABELS[level]}</td>
                <td className="py-1 text-right">{quiz.pool[level]}</td>
                {wanted ? (
                  <td
                    className={
                      wanted[level] > quiz.pool[level]
                        ? 'py-1 text-right font-semibold text-destructive'
                        : 'py-1 text-right'
                    }
                  >
                    {wanted[level]}
                  </td>
                ) : null}
              </tr>
            ))}
            <tr className="border-t">
              <td className="py-1">Not rated</td>
              <td className="py-1 text-right">{quiz.pool.unrated}</td>
              {wanted ? (
                <td className="py-1 text-right text-muted-foreground">never drawn</td>
              ) : null}
            </tr>
            <tr className="border-t font-semibold">
              <td className="py-1">Total</td>
              <td className="py-1 text-right">{quiz.pool.total}</td>
              {wanted ? (
                <td className="py-1 text-right">{quiz.questionsPerAttempt ?? '—'}</td>
              ) : null}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="type-body-sm">
        Each attempt: <strong>{quiz.questionsPerAttempt ?? '—'}</strong> question
        {quiz.questionsPerAttempt === 1 ? '' : 's'}, out of{' '}
        <strong>
          {quiz.totalMarksPerAttempt === null ? '—' : formatMarksValue(quiz.totalMarksPerAttempt)}
        </strong>{' '}
        marks{s.negativeMarking ? ' (negative marking on)' : ''}.
      </p>
      {quiz.status === 'DRAFT' ? (
        quiz.publishProblems.length > 0 ? (
          <Alert tone="warning" title="Before publishing">
            <ul className="list-disc pl-5">
              {quiz.publishProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Alert>
        ) : (
          <p className="flex items-center gap-2 type-body-sm text-success">
            <CheckCircle2 className="size-4" aria-hidden /> Ready to publish.
          </p>
        )
      ) : null}
      {quiz.status === 'DRAFT' &&
      quiz.publishProblems.length === 0 &&
      s.timerMode === 'PER_QUESTION' ? (
        <p className="flex items-center gap-2 type-caption text-muted-foreground">
          <AlertTriangle className="size-4" aria-hidden />
          With {s.questionTimeSeconds} s per question an attempt takes at most{' '}
          {Math.ceil(((quiz.questionsPerAttempt ?? 0) * (s.questionTimeSeconds ?? 0)) / 60)} min
          (never beyond the end time).
        </p>
      ) : null}
    </Section>
  );
}

function SettingsSummary({ quiz }: { quiz: AdminAcademyQuizDetail }) {
  const s = quiz.settings;
  return (
    <Section title="Rules" description="As students will see them on the instructions screen.">
      <dl className="grid gap-2 type-body-sm sm:grid-cols-2">
        <Row label="Navigation">{NAVIGATION_LABELS[s.navigation]}</Row>
        <Row label="Answer required to continue">{s.requireAnswerToAdvance ? 'Yes' : 'No'}</Row>
        <Row label="Shuffle questions / options">
          {s.shuffleQuestions ? 'Yes' : 'No'} / {s.shuffleOptions ? 'Yes' : 'No'}
        </Row>
        <Row label="Pass mark">{s.passPercent}%</Row>
        <Row label="Correct answers shown">{ANSWER_REVEAL_OPTIONS[s.answerReveal]}</Row>
        <Row label="Ranked attempt">{COUNTING_LABELS[s.attemptCounting]}</Row>
        <Row label="Equal scores">{TIE_BREAK_LABELS[s.tieBreak]}</Row>
        <Row label="Names on leaderboard">{s.maskNames ? 'Masked' : 'Shown'}</Row>
        <Row label="Eligible classes">
          {quiz.eligibleClasses.length ? quiz.eligibleClasses.map((c) => c.name).join(', ') : 'All'}
        </Row>
        <Row label="Eligible streams">
          {quiz.eligibleStreams.length ? quiz.eligibleStreams.map((c) => c.name).join(', ') : 'All'}
        </Row>
      </dl>
      {s.instructions ? (
        <p className="rounded-lg border bg-background p-3 type-body-sm whitespace-pre-line">
          {s.instructions}
        </p>
      ) : null}
    </Section>
  );
}

function PrizesPreview({ quiz }: { quiz: AdminAcademyQuizDetail }) {
  if (!quiz.banner && quiz.prizes.length === 0 && !quiz.settings.description) return null;
  return (
    <Section title="Announcement and prizes">
      {quiz.banner ? (
        <MediaImg
          image={quiz.banner}
          alt="Quiz banner"
          className="h-auto max-h-64 w-full rounded-lg border object-cover"
        />
      ) : null}
      {quiz.settings.description ? (
        <p className="type-body-sm whitespace-pre-line">{quiz.settings.description}</p>
      ) : null}
      {quiz.prizes.length > 0 ? (
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {quiz.prizes.map((prize) => (
            <li key={prize.position} className="grid gap-2 rounded-lg border p-3">
              <span className="type-label text-heading">
                #{prize.position} · {prize.title}
              </span>
              {prize.description ? (
                <span className="type-body-sm text-muted-foreground">{prize.description}</span>
              ) : null}
              {prize.image ? (
                <MediaImg
                  image={prize.image}
                  alt={`Prize ${prize.position}`}
                  className="h-auto max-h-40 w-full object-contain"
                />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </Section>
  );
}

/** Administrative history of this quiz (the audit log is readable with `audit_logs.view`). */
function History({ quizId }: { quizId: string }) {
  const api = useAdminApi();
  const path = `/admin/audit-logs?source=admin&entityId=${quizId}&pageSize=50`;
  const history = useApiResource(path, () => api.get<Paginated<AdminAuditEntryDto>>(path));
  return (
    <Section title="History" description="Administrative changes, newest first.">
      {!history.data ? (
        history.error ? (
          <p className="type-body-sm text-destructive">{errorMessage(history.error)}</p>
        ) : (
          <LoadingPanel rows={2} />
        )
      ) : history.data.items.length === 0 ? (
        <p className="type-body-sm text-muted-foreground">No changes recorded yet.</p>
      ) : (
        <ol className="grid gap-2 type-body-sm">
          {history.data.items.map((entry) => (
            <li key={entry.id} className="flex flex-wrap justify-between gap-2 border-b pb-2">
              <span>
                <span className="font-medium">{historyLabel(entry.action)}</span>
                {entry.actor ? (
                  <span className="text-muted-foreground"> · {entry.actor.fullName}</span>
                ) : null}
              </span>
              <span className="text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

const HISTORY_LABELS: Record<string, string> = {
  'academy_quiz.created': 'Created',
  'academy_quiz.updated': 'Settings changed',
  'academy_quiz.published': 'Published',
  'academy_quiz.unpublished': 'Moved back to draft',
  'academy_quiz.closed': 'Closed',
  'academy_quiz.reopened': 'Reopened',
  'academy_quiz.results_published': 'Results published',
  'academy_quiz.questions_copied': 'Questions copied',
  'academy_quiz.deleted': 'Deleted',
};
export const historyLabel = (action: string) => HISTORY_LABELS[action] ?? action;
