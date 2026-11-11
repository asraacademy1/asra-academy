'use client';

import type { AnnouncementAudience, PublicAnnouncementDto } from '@asra/types';
import * as React from 'react';

import {
  createCampaignTracker,
  fetchActiveAnnouncements,
  selectActiveCampaigns,
} from '@/lib/announcements';

import { AnnouncementBanner } from './announcement-banner';
import { AnnouncementModal } from './announcement-modal';

export interface AnnouncementProviderProps {
  audiences?: readonly AnnouncementAudience[];
  children?: React.ReactNode;
}

/**
 * Non-blocking announcement campaign controller.
 * Fetches eligible campaigns once per mount, renders the highest-priority eligible top banner,
 * schedules at most one highest-priority modal after its configured delay (default 3s), and
 * tracks impressions/dismissals per campaign id to avoid duplicates across navigation.
 */
export function AnnouncementProvider({
  audiences = ['PUBLIC_VISITORS', 'PARENTS'],
  children,
}: AnnouncementProviderProps) {
  const audienceKey = React.useMemo(() => [...new Set(audiences)].sort().join(','), [audiences]);
  const [tracker] = React.useState(() => createCampaignTracker());
  const modalShownThisVisitRef = React.useRef(false);

  const [banner, setBanner] = React.useState<PublicAnnouncementDto | null>(null);
  const [modal, setModal] = React.useState<PublicAnnouncementDto | null>(null);
  const [modalOpen, setModalOpen] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    const resolvedAudiences = audienceKey
      ? (audienceKey.split(',') as AnnouncementAudience[])
      : (['PUBLIC_VISITORS'] as AnnouncementAudience[]);

    void fetchActiveAnnouncements(resolvedAudiences, { signal: controller.signal }).then(
      (items) => {
        if (controller.signal.aborted || items.length === 0) return;
        const selected = selectActiveCampaigns(items, {
          tracker,
          modalAlreadyShownThisVisit: modalShownThisVisitRef.current,
        });

        if (selected.banner) {
          setBanner(selected.banner);
        }

        if (selected.modal) {
          const targetModal = selected.modal;
          const delayMs = Math.max(0, targetModal.displayDelaySeconds ?? 3) * 1000;
          setModal(targetModal);
          delayTimer = setTimeout(() => {
            if (controller.signal.aborted) return;
            modalShownThisVisitRef.current = true;
            tracker.markModalImpression(targetModal);
            setModalOpen(true);
          }, delayMs);
        }
      },
    );

    return () => {
      controller.abort();
      if (delayTimer) clearTimeout(delayTimer);
    };
  }, [audienceKey, tracker]);

  const handleBannerDismiss = React.useCallback(
    (campaign: PublicAnnouncementDto) => {
      tracker.markDismissed(campaign);
      setBanner(null);
    },
    [tracker],
  );

  const handleBannerAction = React.useCallback(
    (campaign: PublicAnnouncementDto) => {
      tracker.markDismissed(campaign);
      setBanner(null);
    },
    [tracker],
  );

  const handleModalOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setModalOpen(nextOpen);
      if (!nextOpen && modal) {
        tracker.markDismissed(modal);
      }
    },
    [modal, tracker],
  );

  const handleModalAction = React.useCallback(
    (campaign: PublicAnnouncementDto) => {
      tracker.markDismissed(campaign);
      setModalOpen(false);
    },
    [tracker],
  );

  return (
    <>
      {banner ? (
        <AnnouncementBanner
          announcement={banner}
          onDismiss={handleBannerDismiss}
          onAction={handleBannerAction}
        />
      ) : null}
      {children}
      {modal ? (
        <AnnouncementModal
          announcement={modal}
          open={modalOpen}
          onOpenChange={handleModalOpenChange}
          onAction={handleModalAction}
        />
      ) : null}
    </>
  );
}
