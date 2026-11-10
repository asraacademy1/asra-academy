import type { Metadata } from 'next';

import { StudentAcademyQuizzesPage } from '@/components/student/academy-quizzes/quiz-list';

export const metadata: Metadata = { title: 'Academy Quizzes' };

export default function StudentAcademyQuizzesRoute() {
  return <StudentAcademyQuizzesPage />;
}
