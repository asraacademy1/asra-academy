'use client';

import type { PublicAnnouncementDto } from '@asra/types';
import { ArrowRight, Megaphone } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isExternalRedirectUrl, isSafeRedirectUrl } from '@/lib/announcements';

export interface AnnouncementModalProps {
  announcement: PublicAnnouncementDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction?: (announcement: PublicAnnouncementDto) => void;
}

export function AnnouncementModalCard({
  announcement,
  onClose,
  onAction,
}: {
  announcement: PublicAnnouncementDto;
  onClose: () => void;
  onAction?: (announcement: PublicAnnouncementDto) => void;
}) {
  const safeHref = isSafeRedirectUrl(announcement.redirectUrl) ? announcement.redirectUrl : null;
  const ctaLabel = announcement.ctaText?.trim() || 'Learn more';

  return (
    <>
      {announcement.image ? (
        <div className="relative bg-secondary/40">
          {/* eslint-disable-next-line @next/next/no-img-element -- pre-optimized Cloudinary image */}
          <img
            src={announcement.image.url}
            alt={announcement.title}
            width={announcement.image.width}
            height={announcement.image.height}
            loading="eager"
            decoding="async"
            className="max-h-60 w-full object-cover"
          />
        </div>
      ) : null}

      <div className="grid gap-4 p-5 sm:p-6">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2 text-primary">
            <span
              aria-hidden
              className="inline-flex size-7 items-center justify-center rounded-full bg-secondary"
            >
              <Megaphone className="size-4" />
            </span>
            <span className="type-caption font-semibold tracking-wide uppercase">Announcement</span>
          </div>
          <DialogTitle className="type-h3 text-heading">{announcement.title}</DialogTitle>
          {announcement.description ? (
            <DialogDescription className="mt-1 type-body whitespace-pre-line text-foreground/85">
              {announcement.description}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">
              Important announcement from ASRA Academy
            </DialogDescription>
          )}
        </DialogHeader>

        <DialogFooter className="pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {safeHref ? (
            isExternalRedirectUrl(safeHref) ? (
              <Button asChild variant="accent">
                <a
                  href={safeHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    onAction?.(announcement);
                    onClose();
                  }}
                >
                  {ctaLabel}
                  <ArrowRight className="size-4" aria-hidden />
                </a>
              </Button>
            ) : (
              <Button asChild variant="accent">
                <Link
                  href={safeHref}
                  onClick={() => {
                    onAction?.(announcement);
                    onClose();
                  }}
                >
                  {ctaLabel}
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
            )
          ) : null}
        </DialogFooter>
      </div>
    </>
  );
}

/**
 * Accessible popup modal built on Radix Dialog (focus trap, Escape close, focus restoration).
 * Renders optional pre-optimized Cloudinary media, plain-text description, and validated CTA link.
 */
export function AnnouncementModal({
  announcement,
  open,
  onOpenChange,
  onAction,
}: AnnouncementModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="announcement-modal"
        data-announcement-id={announcement.id}
        className="w-[calc(100%-2rem)] max-w-lg overflow-hidden p-0"
      >
        <AnnouncementModalCard
          announcement={announcement}
          onClose={() => onOpenChange(false)}
          onAction={onAction}
        />
      </DialogContent>
    </Dialog>
  );
}
