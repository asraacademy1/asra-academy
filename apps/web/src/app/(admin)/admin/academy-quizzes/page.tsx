import type { Metadata } from 'next';

import { AcademyQuizList } from '@/components/admin/academy-quizzes/quiz-list';

export const metadata: Metadata = { title: 'Academy Quizzes' };

export default function Page() {
  return <AcademyQuizList />;
}
