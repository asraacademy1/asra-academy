import type { Metadata } from 'next';

import { AnnouncementList } from '@/components/admin/announcements/announcement-list';

export const metadata: Metadata = { title: 'Announcements' };

export default function Page() {
  return <AnnouncementList />;
}
