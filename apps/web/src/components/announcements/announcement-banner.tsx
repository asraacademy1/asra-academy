'use client';

import type { PublicAnnouncementDto } from '@asra/types';
import { ArrowRight, Megaphone, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Container } from '@/components/layout/container';
import { Button } from '@/components/ui/button';
import { isExternalRedirectUrl, isSafeRedirectUrl } from '@/lib/announcements';

export interface AnnouncementBannerProps {
  announcement: PublicAnnouncementDto;
  onDismiss: (announcement: PublicAnnouncementDto) => void;
  onAction?: (announcement: PublicAnnouncementDto) => void;
}

/**
 * Top promotional/notice banner rendered cleanly above site navigation. Supports responsive
 * mobile and desktop layouts, safe CTA redirects, and keyboard-accessible dismissal.
 */
export function AnnouncementBanner({ announcement, onDismiss, onAction }: AnnouncementBannerProps) {
  const safeHref = isSafeRedirectUrl(announcement.redirectUrl) ? announcement.redirectUrl : null;
  const ctaLabel = announcement.ctaText?.trim() || 'Learn more';

  return (
    <aside
      data-slot="announcement-banner"
      data-announcement-id={announcement.id}
      role="region"
      aria-label={`Announcement: ${announcement.title}`}
      className="relative z-40 border-b border-asra-green-800 bg-asra-green-900 text-asra-warm-white"
    >
      <Container className="flex flex-wrap items-center justify-between gap-3 py-2.5 pr-11 sm:flex-nowrap sm:pr-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {announcement.image ? (
            // eslint-disable-next-line @next/next/no-img-element -- pre-optimized Cloudinary image
            <img
              src={announcement.image.url}
              alt=""
              width={announcement.image.width}
              height={announcement.image.height}
              loading="eager"
              decoding="async"
              className="hidden size-10 shrink-0 rounded-md border border-asra-green-700 object-cover sm:block"
            />
          ) : (
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-asra-green-800 text-asra-gold-500"
            >
              <Megaphone className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="type-label text-asra-warm-white">{announcement.title}</p>
            {announcement.description ? (
              <p className="line-clamp-2 type-caption text-asra-green-100 sm:line-clamp-1">
                {announcement.description}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {safeHref ? (
            isExternalRedirectUrl(safeHref) ? (
              <Button
                asChild
                variant="accent"
                size="sm"
                className="h-8 rounded-full px-3.5 text-xs"
              >
                <a
                  href={safeHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => onAction?.(announcement)}
                >
                  {ctaLabel}
                  <ArrowRight className="size-3.5" aria-hidden />
                </a>
              </Button>
            ) : (
              <Button
                asChild
                variant="accent"
                size="sm"
                className="h-8 rounded-full px-3.5 text-xs"
              >
                <Link href={safeHref} onClick={() => onAction?.(announcement)}>
                  {ctaLabel}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </Button>
            )
          ) : null}

          <button
            type="button"
            onClick={() => onDismiss(announcement)}
            aria-label={`Dismiss announcement: ${announcement.title}`}
            className="absolute top-2 right-2 inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-asra-green-100 transition-colors hover:bg-asra-green-800 hover:text-asra-warm-white focus-visible:ring-[3px] focus-visible:ring-asra-gold-500/70 focus-visible:outline-none sm:static"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </Container>
    </aside>
  );
}
