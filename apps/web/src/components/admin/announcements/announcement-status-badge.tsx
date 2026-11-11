'use client';

import type { AnnouncementStatus } from '@asra/types';
import { Archive, CalendarClock, CheckCircle2, Clock, PauseCircle, PencilLine } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { ANNOUNCEMENT_STATUS_BADGE, ANNOUNCEMENT_STATUS_LABELS } from '@/lib/admin/announcements';

const STATUS_ICONS: Record<AnnouncementStatus, React.ComponentType<{ className?: string }>> = {
  DRAFT: PencilLine,
  SCHEDULED: CalendarClock,
  PUBLISHED: CheckCircle2,
  PAUSED: PauseCircle,
  EXPIRED: Clock,
  ARCHIVED: Archive,
};

export function AnnouncementStatusBadge({ status }: { status: AnnouncementStatus }) {
  const Icon = STATUS_ICONS[status];
  return (
    <Badge variant={ANNOUNCEMENT_STATUS_BADGE[status]}>
      <Icon className="size-3.5" aria-hidden />
      {ANNOUNCEMENT_STATUS_LABELS[status]}
    </Badge>
  );
}
