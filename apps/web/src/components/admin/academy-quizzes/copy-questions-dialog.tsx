'use client';

import {
  PERMISSIONS,
  type CopyQuestionsResultDto,
  type CopySourceItem,
  type QuestionDto,
} from '@asra/types';
import type { CopySourceKind } from '@asra/validation';
import { ArrowLeft, Copy } from 'lucide-react';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { QuestionImages } from '@/components/assessments/question-media';
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
import { QUESTION_TYPE_LABELS, formatMarksValue } from '@/lib/assessments';

import { FilterSelect, ListFrame, SearchBox, usePagedList } from '../admin-kit';
import { LoadingPanel } from '../admin-ui';
import { errorMessage, hasPermission, useAdminApi, useApiResource } from '../use-admin';

const KIND_LABELS: Record<CopySourceKind, string> = {
  ACADEMY: 'Academy quizzes',
  QUIZ: 'Course quizzes',
  EXAM: 'Course exams',
};

/** Source kinds this account may read (course answer keys need `content.manage`). */
export function copyKindsFor(can: (permission: string) => boolean): CopySourceKind[] {
  return can(PERMISSIONS.CONTENT_MANAGE) ? ['ACADEMY', 'QUIZ', 'EXAM'] : ['ACADEMY'];
}

/**
 * Copies chosen questions from a course quiz, an exam or another academy quiz into this DRAFT.
 * Copies are new, independent questions that reuse the same images (no duplicate files; the
 * server keeps an image while any question or attempt uses it). Written answers cannot be copied.
 */
export function CopyQuestionsDialog({
  quizId,
  onClose,
  onCopied,
}: {
  quizId: string;
  onClose: () => void;
  onCopied: () => void;
}) {
  const { user } = useAuth();
  const kinds = copyKindsFor((permission) => hasPermission(user, permission));
  const [kind, setKind] = React.useState<CopySourceKind>('ACADEMY');
  const [q, setQ] = React.useState('');
  const [source, setSource] = React.useState<CopySourceItem | null>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Copy questions</DialogTitle>
          <DialogDescription>
            Copies become independent questions of this quiz, with their options and images.
          </DialogDescription>
        </DialogHeader>
        {source ? (
          <SourceQuestions
            quizId={quizId}
            source={source}
            onBack={() => setSource(null)}
            onCopied={() => {
              onCopied();
              onClose();
            }}
          />
        ) : (
          <SourcePicker
            quizId={quizId}
            kinds={kinds}
            kind={kind}
            setKind={setKind}
            q={q}
            setQ={setQ}
            onPick={setSource}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SourcePicker({
  quizId,
  kinds,
  kind,
  setKind,
  q,
  setQ,
  onPick,
}: {
  quizId: string;
  kinds: CopySourceKind[];
  kind: CopySourceKind;
  setKind: (kind: CopySourceKind) => void;
  q: string;
  setQ: (q: string) => void;
  onPick: (source: CopySourceItem) => void;
}) {
  const { list, setPage } = usePagedList<CopySourceItem>(
    `/admin/academy-quizzes/${quizId}/copy-sources`,
    { kind, q: q || undefined },
    10,
  );
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        {kinds.length > 1 ? (
          <FilterSelect
            id="copy-kind"
            label="Copy from"
            value={kind}
            onChange={(value) => setKind((value || 'ACADEMY') as CopySourceKind)}
            options={kinds.map((value) => ({ value, label: KIND_LABELS[value] }))}
            allLabel={KIND_LABELS.ACADEMY}
          />
        ) : null}
        <SearchBox id="copy-search" placeholder="Search by title" onSearch={setQ} />
      </div>
      <ListFrame list={list} setPage={setPage} label="sources" emptyTitle="Nothing to copy from">
        {(items) => (
          <ul className="divide-y">
            {items.map((item) => (
              <li
                key={`${item.kind}-${item.id}`}
                className="flex items-center justify-between gap-3 p-3"
              >
                <span className="grid gap-0.5">
                  <span className="type-label text-heading">{item.title}</span>
                  <span className="type-caption text-muted-foreground">
                    {item.context ? `${item.context} · ` : ''}
                    {item.questionCount} question{item.questionCount === 1 ? '' : 's'} ·{' '}
                    {item.status.toLowerCase()}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={item.questionCount === 0}
                  onClick={() => onPick(item)}
                >
                  Choose questions
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ListFrame>
    </div>
  );
}

function SourceQuestions({
  quizId,
  source,
  onBack,
  onCopied,
}: {
  quizId: string;
  source: CopySourceItem;
  onBack: () => void;
  onCopied: () => void;
}) {
  const api = useAdminApi();
  const path = `/admin/academy-quizzes/${quizId}/copy-sources/${source.kind}/${source.id}/questions`;
  const questions = useApiResource(path, () => api.get<QuestionDto[]>(path));
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState(false);
  const copyable = (questions.data ?? []).filter((q) => q.type !== 'SHORT_ANSWER');

  async function copy() {
    setPending(true);
    try {
      const result = await api.post<CopyQuestionsResultDto>(
        `/admin/academy-quizzes/${quizId}/questions/copy`,
        { source: { kind: source.kind, id: source.id }, questionIds: [...chosen] },
      );
      toast.success(`${result.copied} question${result.copied === 1 ? '' : 's'} copied`, {
        description: result.skippedWritten
          ? `${result.skippedWritten} written-answer question(s) skipped.`
          : undefined,
      });
      onCopied();
    } catch (error) {
      toast.error('Could not copy', { description: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4">
      <Button variant="ghost" className="w-fit" onClick={onBack} disabled={pending}>
        <ArrowLeft aria-hidden /> {source.title}
      </Button>
      {!questions.data ? (
        questions.error ? (
          <Alert tone="error">
            <p>{errorMessage(questions.error)}</p>
          </Alert>
        ) : (
          <LoadingPanel />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="type-body-sm text-muted-foreground">
              {chosen.size} of {copyable.length} selected
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setChosen(
                  chosen.size === copyable.length ? new Set() : new Set(copyable.map((q) => q.id)),
                )
              }
            >
              {chosen.size === copyable.length ? 'Select none' : 'Select all'}
            </Button>
          </div>
          <ol className="grid gap-2">
            {questions.data.map((question, index) => {
              const written = question.type === 'SHORT_ANSWER';
              const id = `copy-q-${question.id}`;
              return (
                <li key={question.id} className="rounded-lg border p-3">
                  <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
                    <input
                      id={id}
                      type="checkbox"
                      className="mt-1 size-4 accent-primary"
                      disabled={written}
                      checked={chosen.has(question.id)}
                      onChange={(event) => {
                        const next = new Set(chosen);
                        if (event.target.checked) next.add(question.id);
                        else next.delete(question.id);
                        setChosen(next);
                      }}
                    />
                    <span className="grid min-w-0 gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="type-label">Q{index + 1}</span>
                        <Badge variant="outline">{QUESTION_TYPE_LABELS[question.type]}</Badge>
                        <Badge variant="secondary">{formatMarksValue(question.marks)} marks</Badge>
                        {question.difficulty ? (
                          <Badge variant="outline">{question.difficulty.toLowerCase()}</Badge>
                        ) : null}
                        {written ? (
                          <span className="type-caption text-muted-foreground">
                            Written answers cannot be copied (academy quizzes are auto-scored)
                          </span>
                        ) : null}
                      </span>
                      <span className="type-body-sm break-words whitespace-pre-wrap">
                        {question.prompt}
                      </span>
                      {question.images.length > 0 ? (
                        <span className="max-w-sm">
                          <QuestionImages images={question.images} />
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ol>
        </>
      )}
      <DialogFooter>
        <Button
          onClick={() => void copy()}
          loading={pending}
          loadingText="Copying…"
          disabled={chosen.size === 0}
        >
          <Copy aria-hidden /> Copy {chosen.size || ''} question{chosen.size === 1 ? '' : 's'}
        </Button>
      </DialogFooter>
    </div>
  );
}
