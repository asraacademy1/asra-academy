import type { Metadata } from 'next';

import { AnnouncementForm } from '@/components/admin/announcements/announcement-form';

export const metadata: Metadata = { title: 'New announcement' };

export default function Page() {
  return <AnnouncementForm />;
}
