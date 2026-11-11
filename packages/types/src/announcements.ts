import type { MediaDto } from './assessment.js';

/**
 * Website announcements & promotional popups module.
 * Timestamps are ISO-8601 UTC instants produced by the server.
 */

export type AnnouncementDisplayType = 'MODAL' | 'TOP_BANNER';

export type AnnouncementFrequency = 'EVERY_VISIT' | 'ONCE_PER_SESSION' | 'ONCE_PER_VISITOR';

export type AnnouncementAudience = 'ALL' | 'PUBLIC_VISITORS' | 'STUDENTS' | 'PARENTS' | 'FACULTY';

export type AnnouncementStatus =
  'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'PAUSED' | 'EXPIRED' | 'ARCHIVED';

export interface AnnouncementAuthorDto {
  id: string;
  fullName: string;
}

export interface AdminAnnouncementItem {
  id: string;
  title: string;
  description: string | null;
  image: MediaDto | null;
  displayType: AnnouncementDisplayType;
  ctaText: string | null;
  redirectUrl: string | null;
  startsAt: string | null;
  endsAt: string | null;
  displayDelaySeconds: number;
  frequency: AnnouncementFrequency;
  priority: number;
  audience: AnnouncementAudience;
  /** Effective status computed with server time (e.g. EXPIRED after endsAt). */
  status: AnnouncementStatus;
  /** Stored lifecycle status column in the database. */
  storedStatus: AnnouncementStatus;
  publishedAt: string | null;
  pausedAt: string | null;
  archivedAt: string | null;
  createdBy: AnnouncementAuthorDto | null;
  updatedBy: AnnouncementAuthorDto | null;
  createdAt: string;
  updatedAt: string;
  serverNow: string;
}

export type AdminAnnouncementDetail = AdminAnnouncementItem;

/** Publicly safe announcement payload — never includes internal metadata or unpublished rows. */
export interface PublicAnnouncementImageDto {
  url: string;
  width: number;
  height: number;
}

export interface PublicAnnouncementDto {
  id: string;
  title: string;
  description: string | null;
  image: PublicAnnouncementImageDto | null;
  displayType: AnnouncementDisplayType;
  ctaText: string | null;
  redirectUrl: string | null;
  displayDelaySeconds: number;
  frequency: AnnouncementFrequency;
  priority: number;
  audience: AnnouncementAudience;
  startsAt: string | null;
  endsAt: string | null;
}
