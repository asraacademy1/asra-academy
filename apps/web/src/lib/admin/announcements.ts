import type {
  AdminAnnouncementDetail,
  AnnouncementAudience,
  AnnouncementDisplayType,
  AnnouncementFrequency,
  AnnouncementStatus,
  MediaDto,
  PublicAnnouncementDto,
} from '@asra/types';
import { ANNOUNCEMENT_LIMITS } from '@asra/validation';
import { isoToIstInput, istInputToIso } from '@/lib/faculty/portal';

/**
 * Pure helpers & labels for the Admin Announcements module (shared by UI components and tests).
 */

export const ANNOUNCEMENT_STATUS_LABELS: Record<AnnouncementStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
  PAUSED: 'Paused',
  EXPIRED: 'Expired',
  ARCHIVED: 'Archived',
};

export const ANNOUNCEMENT_STATUS_BADGE: Record<
  AnnouncementStatus,
  'outline' | 'info' | 'success' | 'warning' | 'destructive' | 'secondary'
> = {
  DRAFT: 'outline',
  SCHEDULED: 'info',
  PUBLISHED: 'success',
  PAUSED: 'warning',
  EXPIRED: 'destructive',
  ARCHIVED: 'secondary',
};

export const DISPLAY_TYPE_LABELS: Record<AnnouncementDisplayType, string> = {
  MODAL: 'Popup modal',
  TOP_BANNER: 'Top banner',
};

export const FREQUENCY_LABELS: Record<AnnouncementFrequency, string> = {
  EVERY_VISIT: 'Every visit (once per page load)',
  ONCE_PER_SESSION: 'Once per browser session',
  ONCE_PER_VISITOR: 'Once per visitor (persists across visits)',
};

export const AUDIENCE_LABELS: Record<AnnouncementAudience, string> = {
  ALL: 'Everyone (Website & portals)',
  PUBLIC_VISITORS: 'Public website visitors',
  PARENTS: 'Parents & guardians',
  STUDENTS: 'Students (Student portal)',
  FACULTY: 'Faculty (Faculty portal)',
};

export const PRIORITY_PRESETS = [
  { label: 'Low (10)', value: 10 },
  { label: 'Normal (50)', value: 50 },
  { label: 'High (100)', value: 100 },
  { label: 'Urgent (500)', value: 500 },
] as const;

export interface AnnouncementFormState {
  title: string;
  description: string;
  image: MediaDto | null;
  displayType: AnnouncementDisplayType;
  ctaText: string;
  redirectUrl: string;
  startsAt: string;
  endsAt: string;
  displayDelaySeconds: string;
  frequency: AnnouncementFrequency;
  priority: string;
  audience: AnnouncementAudience;
}

export function emptyAnnouncementForm(): AnnouncementFormState {
  return {
    title: '',
    description: '',
    image: null,
    displayType: 'MODAL',
    ctaText: '',
    redirectUrl: '',
    startsAt: '',
    endsAt: '',
    displayDelaySeconds: String(ANNOUNCEMENT_LIMITS.displayDelaySeconds.defaultModal),
    frequency: 'ONCE_PER_SESSION',
    priority: '50',
    audience: 'ALL',
  };
}

export function announcementFormFromDetail(detail: AdminAnnouncementDetail): AnnouncementFormState {
  return {
    title: detail.title,
    description: detail.description ?? '',
    image: detail.image,
    displayType: detail.displayType,
    ctaText: detail.ctaText ?? '',
    redirectUrl: detail.redirectUrl ?? '',
    startsAt: isoToIstInput(detail.startsAt),
    endsAt: isoToIstInput(detail.endsAt),
    displayDelaySeconds: String(detail.displayDelaySeconds),
    frequency: detail.frequency,
    priority: String(detail.priority),
    audience: detail.audience,
  };
}

const trimmedOrNull = (value: string) => (value.trim() === '' ? null : value.trim());

/**
 * Converts `AnnouncementFormState` to the strict API request body.
 * Invalid IST date strings evaluate to `undefined` (or `'invalid'`) so Zod flags the field cleanly.
 */
export function announcementFormToBody(form: AnnouncementFormState) {
  const startsIso = istInputToIso(form.startsAt);
  const endsIso = istInputToIso(form.endsAt);
  return {
    title: form.title,
    description: trimmedOrNull(form.description),
    imageMediaId: form.image?.id ?? null,
    displayType: form.displayType,
    ctaText: trimmedOrNull(form.ctaText),
    redirectUrl: trimmedOrNull(form.redirectUrl),
    startsAt: startsIso === undefined ? 'invalid-date' : startsIso,
    endsAt: endsIso === undefined ? 'invalid-date' : endsIso,
    displayDelaySeconds:
      form.displayDelaySeconds.trim() === '' ? Number.NaN : Number(form.displayDelaySeconds),
    frequency: form.frequency,
    priority: form.priority.trim() === '' ? Number.NaN : Number(form.priority),
    audience: form.audience,
  };
}

export type AnnouncementLifecycleAction =
  'publish' | 'schedule' | 'pause' | 'resume' | 'archive' | 'restore' | 'delete';

/** Determines valid lifecycle actions from the campaign's effective server status. */
export function availableAnnouncementActions(
  item: Pick<AdminAnnouncementDetail, 'status' | 'startsAt' | 'endsAt' | 'serverNow'>,
): AnnouncementLifecycleAction[] {
  const actions: AnnouncementLifecycleAction[] = [];
  const nowMs = Date.parse(item.serverNow);
  const startsMs = item.startsAt ? Date.parse(item.startsAt) : null;
  const endsMs = item.endsAt ? Date.parse(item.endsAt) : null;
  const hasFutureStart = startsMs !== null && !Number.isNaN(startsMs) && startsMs > nowMs;
  const hasPassedEnd = endsMs !== null && !Number.isNaN(endsMs) && endsMs <= nowMs;

  switch (item.status) {
    case 'DRAFT':
      if (!hasPassedEnd) {
        if (hasFutureStart) actions.push('schedule');
        actions.push('publish');
      }
      actions.push('archive', 'delete');
      break;
    case 'SCHEDULED':
      actions.push('publish', 'pause', 'archive');
      break;
    case 'PUBLISHED':
      actions.push('pause', 'archive');
      break;
    case 'PAUSED':
      if (!hasPassedEnd) actions.push('resume');
      actions.push('archive', 'delete');
      break;
    case 'EXPIRED':
      actions.push('archive', 'delete');
      break;
    case 'ARCHIVED':
      actions.push('restore', 'delete');
      break;
  }
  return actions;
}

/** Converts unsaved form state into a preview DTO for `AnnouncementModal` / `AnnouncementBanner`. */
export function toPreviewAnnouncement(
  form: AnnouncementFormState,
  id = 'preview-announcement',
): PublicAnnouncementDto {
  return {
    id,
    title: form.title.trim() || 'Untitled announcement',
    description: trimmedOrNull(form.description),
    image: form.image
      ? { url: form.image.url, width: form.image.width, height: form.image.height }
      : null,
    displayType: form.displayType,
    ctaText: trimmedOrNull(form.ctaText),
    redirectUrl: trimmedOrNull(form.redirectUrl),
    displayDelaySeconds: Number.isFinite(Number(form.displayDelaySeconds))
      ? Number(form.displayDelaySeconds)
      : 3,
    frequency: form.frequency,
    priority: Number.isFinite(Number(form.priority)) ? Number(form.priority) : 0,
    audience: form.audience,
    startsAt: istInputToIso(form.startsAt) ?? null,
    endsAt: istInputToIso(form.endsAt) ?? null,
  };
}
