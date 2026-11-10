import type { Metadata } from 'next';

import { AcademyAttemptPlayer } from '@/components/student/academy-quizzes/attempt-player';

export const metadata: Metadata = { title: 'Academy Quiz attempt' };

export default async function StudentAcademyAttemptRoute({
  params,
}: PageProps<'/student/academy-attempts/[attemptId]'>) {
  const { attemptId } = await params;
  return <AcademyAttemptPlayer attemptId={attemptId} />;
}
