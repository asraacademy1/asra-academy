'use client';

import type { AnswerSaveResultDto, AttemptQuestionDto } from '@asra/types';
import * as React from 'react';

import { toast } from '@/components/ui/toast';
import { ApiClientError } from '@/lib/api';

/**
 * Answer autosave shared by the course quiz/exam player and the Academy Quiz player.
 *
 *   - every change gets a higher sequence number, so a late retry can never overwrite a newer
 *     answer on the server;
 *   - choices are sent at once, written answers after a short pause in typing;
 *   - network/server failures are retried with back-off; a 4xx is shown and not retried;
 *   - a 409 means the server will not accept answers any more (submitted, expired, or — for
 *     linear quizzes — the question is locked): `onConflict` decides what to do.
 *
 * The server stays authoritative; this only keeps the browser's copy in step with it.
 */

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface LocalAnswer {
  selectedOptionIds: string[];
  textAnswer: string | null;
  sequence: number;
  state: SaveState;
}

export type AnswerChange = Partial<Pick<LocalAnswer, 'selectedOptionIds' | 'textAnswer'>>;

const TEXT_DEBOUNCE_MS = 800;
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];

interface AutosaveApi {
  put<T>(path: string, body?: unknown): Promise<T>;
}

export function useAnswerAutosave({
  api,
  questions,
  answerPath,
  onConflict,
}: {
  api: AutosaveApi;
  questions: AttemptQuestionDto[];
  answerPath: (questionId: string) => string;
  onConflict: (error: ApiClientError) => void;
}) {
  const [answers, setAnswers] = React.useState<Record<string, LocalAnswer>>(() =>
    Object.fromEntries(
      questions.map((q) => [
        q.id,
        {
          selectedOptionIds: q.selectedOptionIds,
          textAnswer: q.textAnswer,
          sequence: q.answerSequence,
          state: 'saved' as SaveState,
        },
      ]),
    ),
  );
  const answersRef = React.useRef(answers);
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = React.useRef(new Map<string, Promise<void>>());
  const retries = React.useRef(new Map<string, number>());
  // Retries call the latest `save` through this ref (set after render).
  const saveRef = React.useRef<(questionId: string) => Promise<void>>(() => Promise.resolve());

  React.useEffect(() => {
    answersRef.current = answers;
  });

  React.useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const setState = React.useCallback((questionId: string, sequence: number, state: SaveState) => {
    setAnswers((current) => {
      const entry = current[questionId];
      if (!entry || entry.sequence !== sequence) return current; // a newer change is pending
      return { ...current, [questionId]: { ...entry, state } };
    });
  }, []);

  const save = React.useCallback(
    (questionId: string): Promise<void> => {
      const entry = answersRef.current[questionId];
      const question = questions.find((q) => q.id === questionId);
      if (!entry || !question || entry.state === 'saved') return Promise.resolve();
      const { sequence } = entry;
      setState(questionId, sequence, 'saving');
      const body =
        question.type === 'SHORT_ANSWER'
          ? { textAnswer: entry.textAnswer ?? '', sequence }
          : { selectedOptionIds: entry.selectedOptionIds, sequence };
      const request = api
        .put<AnswerSaveResultDto>(answerPath(questionId), body)
        .then(() => {
          retries.current.delete(questionId);
          setState(questionId, sequence, 'saved');
        })
        .catch((error: unknown) => {
          if (error instanceof ApiClientError && error.status === 409) {
            onConflict(error);
            return;
          }
          setState(questionId, sequence, 'error');
          if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
            toast.error('This answer was not saved', { description: error.message });
            return;
          }
          // Network or server trouble: retry with back-off.
          const attemptNo = retries.current.get(questionId) ?? 0;
          retries.current.set(questionId, attemptNo + 1);
          const delay = RETRY_DELAYS_MS[Math.min(attemptNo, RETRY_DELAYS_MS.length - 1)]!;
          timers.current.set(
            questionId,
            setTimeout(() => void saveRef.current(questionId), delay),
          );
        })
        .finally(() => inFlight.current.delete(questionId));
      inFlight.current.set(questionId, request);
      return request;
    },
    [api, answerPath, questions, setState, onConflict],
  );

  React.useEffect(() => {
    saveRef.current = save;
  });

  function change(question: AttemptQuestionDto, next: AnswerChange) {
    const entry = answersRef.current[question.id]!;
    const updated: LocalAnswer = {
      ...entry,
      ...next,
      sequence: entry.sequence + 1,
      state: 'pending',
    };
    answersRef.current = { ...answersRef.current, [question.id]: updated };
    setAnswers(answersRef.current);
    const existing = timers.current.get(question.id);
    if (existing) clearTimeout(existing);
    timers.current.set(
      question.id,
      setTimeout(
        () => void save(question.id),
        question.type === 'SHORT_ANSWER' ? TEXT_DEBOUNCE_MS : 0,
      ),
    );
  }

  /** Sends every unsaved answer now and waits for the requests in flight. */
  async function flush() {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
    await Promise.all(
      Object.entries(answersRef.current)
        .filter(([, entry]) => entry.state !== 'saved')
        .map(([questionId]) => save(questionId)),
    );
    await Promise.all(inFlight.current.values());
  }

  const unsaved = Object.values(answers).filter((a) => a.state !== 'saved').length;

  return { answers, change, flush, unsaved };
}
