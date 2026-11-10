import type { Metadata } from 'next';

import { StudentAcademyLeaderboardPage } from '@/components/student/academy-quizzes/leaderboard';

export const metadata: Metadata = { title: 'Leaderboard' };

export default async function StudentAcademyLeaderboardRoute({
  params,
}: PageProps<'/student/academy-quizzes/[slug]/leaderboard'>) {
  const { slug } = await params;
  return <StudentAcademyLeaderboardPage slug={slug} />;
}
