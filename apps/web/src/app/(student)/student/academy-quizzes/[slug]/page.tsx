import type { Metadata } from 'next';

import { StudentAcademyQuizPage } from '@/components/student/academy-quizzes/quiz-detail';

export const metadata: Metadata = { title: 'Academy Quiz' };

export default async function StudentAcademyQuizRoute({
  params,
}: PageProps<'/student/academy-quizzes/[slug]'>) {
  const { slug } = await params;
  return <StudentAcademyQuizPage slug={slug} />;
}
