'use client';

import type { PublicAnnouncementDto } from '@asra/types';
import * as React from 'react';

import { AnnouncementBanner } from '@/components/announcements/announcement-banner';
import { AnnouncementModal } from '@/components/announcements/announcement-modal';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AUDIENCE_LABELS, DISPLAY_TYPE_LABELS, FREQUENCY_LABELS } from '@/lib/admin/announcements';

/**
 * Interactive preview dialog for administrators to inspect how an announcement will render as a
 * modal popup or top banner on the public website before publishing.
 */
export function AnnouncementPreviewDialog({
  announcement,
  open,
  onOpenChange,
}: {
  announcement: PublicAnnouncementDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [modalPreviewOpen, setModalPreviewOpen] = React.useState(false);

  if (!announcement) return null;

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setModalPreviewOpen(false);
    onOpenChange(nextOpen);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Announcement preview</DialogTitle>
            <DialogDescription>
              {DISPLAY_TYPE_LABELS[announcement.displayType]} ·{' '}
              {AUDIENCE_LABELS[announcement.audience]} · {FREQUENCY_LABELS[announcement.frequency]}
            </DialogDescription>
          </DialogHeader>

          {announcement.displayType === 'TOP_BANNER' ? (
            <div className="overflow-hidden rounded-xl border bg-background">
              <AnnouncementBanner
                announcement={announcement}
                onDismiss={() => onOpenChange(false)}
              />
              <div className="p-6 text-center type-body-sm text-muted-foreground">
                Public website header and page content appear directly below this banner.
              </div>
            </div>
          ) : (
            <div className="grid gap-4 rounded-xl border bg-muted/40 p-5">
              <div className="grid gap-1">
                <p className="type-label text-heading">Popup modal configuration</p>
                <p className="type-caption text-muted-foreground">
                  Appears after {announcement.displayDelaySeconds} second
                  {announcement.displayDelaySeconds === 1 ? '' : 's'} with priority{' '}
                  {announcement.priority}.
                </p>
              </div>
              <div>
                <Button type="button" onClick={() => setModalPreviewOpen(true)}>
                  Launch live modal preview
                </Button>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Close preview
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {open && modalPreviewOpen ? (
        <AnnouncementModal
          announcement={announcement}
          open={modalPreviewOpen}
          onOpenChange={setModalPreviewOpen}
        />
      ) : null}
    </>
  );
}
