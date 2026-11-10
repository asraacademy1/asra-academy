'use client';

import type { AdminAcademyQuizDetail } from '@asra/types';

import { ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, useAdminApi, useApiResource } from '../use-admin';
import { AcademyQuizForm } from './quiz-form';

/** `/admin/academy-quizzes/[id]/edit` — loads the quiz, then the shared settings form. */
export function AcademyQuizSettingsPage({ id }: { id: string }) {
  const api = useAdminApi();
  const path = `/admin/academy-quizzes/${id}`;
  const quiz = useApiResource(path, () => api.get<AdminAcademyQuizDetail>(path));
  if (quiz.error && !quiz.data) {
    return <ErrorPanel message={errorMessage(quiz.error)} onRetry={quiz.reload} />;
  }
  if (!quiz.data) return <LoadingPanel label="Loading the settings…" />;
  return <AcademyQuizForm key={quiz.data.updatedAt} quiz={quiz.data} />;
}
