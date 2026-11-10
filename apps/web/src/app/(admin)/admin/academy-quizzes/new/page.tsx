import type { Metadata } from 'next';

import { AcademyQuizForm } from '@/components/admin/academy-quizzes/quiz-form';

export const metadata: Metadata = { title: 'New academy quiz' };

export default function Page() {
  return <AcademyQuizForm />;
}
