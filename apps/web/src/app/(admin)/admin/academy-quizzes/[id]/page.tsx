import type { Metadata } from 'next';

import { AcademyQuizDetail } from '@/components/admin/academy-quizzes/quiz-detail';

export const metadata: Metadata = { title: 'Academy quiz' };

export default async function Page({ params }: PageProps<'/admin/academy-quizzes/[id]'>) {
  const { id } = await params;
  return <AcademyQuizDetail id={id} />;
}
