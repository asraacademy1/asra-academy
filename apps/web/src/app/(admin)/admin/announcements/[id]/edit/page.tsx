import type { Metadata } from 'next';

import { AnnouncementEditPage } from '@/components/admin/announcements/announcement-edit-page';

export const metadata: Metadata = { title: 'Edit announcement' };

export default async function Page({ params }: PageProps<'/admin/announcements/[id]/edit'>) {
  const { id } = await params;
  return <AnnouncementEditPage id={id} />;
}
