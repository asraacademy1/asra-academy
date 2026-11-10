import type { Metadata } from 'next';

import { AcademyQuizSettingsPage } from '@/components/admin/academy-quizzes/quiz-settings-page';

export const metadata: Metadata = { title: 'Academy quiz settings' };

export default async function Page({ params }: PageProps<'/admin/academy-quizzes/[id]/edit'>) {
  const { id } = await params;
  return <AcademyQuizSettingsPage id={id} />;
}
