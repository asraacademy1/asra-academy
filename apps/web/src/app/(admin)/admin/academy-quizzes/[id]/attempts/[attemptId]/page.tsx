import type { Metadata } from 'next';

import { AdminAcademyAttemptPage } from '@/components/admin/academy-quizzes/attempts';

export const metadata: Metadata = { title: 'Academy Quiz attempt' };

export default async function AdminAcademyAttemptRoute({
  params,
}: PageProps<'/admin/academy-quizzes/[id]/attempts/[attemptId]'>) {
  const { id, attemptId } = await params;
  return <AdminAcademyAttemptPage quizId={id} attemptId={attemptId} />;
}
