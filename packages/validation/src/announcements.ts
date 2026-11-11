import { z } from 'zod';
import {
  optionalTextSchema,
  paginationQuerySchema,
  safeExternalUrlSchema,
  searchQuerySchema,
} from './common.js';
import { isoInstantSchema } from './faculty.js';

/**
 * Website announcement & popup validation schemas, shared by the API and the admin/public UI.
 */

export const ANNOUNCEMENT_DISPLAY_TYPES = ['MODAL', 'TOP_BANNER'] as const;
export const ANNOUNCEMENT_FREQUENCIES = [
  'EVERY_VISIT',
  'ONCE_PER_SESSION',
  'ONCE_PER_VISITOR',
] as const;
export const ANNOUNCEMENT_AUDIENCES = [
  'ALL',
  'PUBLIC_VISITORS',
  'STUDENTS',
  'PARENTS',
  'FACULTY',
] as const;
export const ANNOUNCEMENT_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'PUBLISHED',
  'PAUSED',
  'EXPIRED',
  'ARCHIVED',
] as const;

export const ANNOUNCEMENT_LIMITS = {
  title: 160,
  description: 2000,
  ctaText: 60,
  redirectUrl: 2048,
  displayDelaySeconds: { min: 0, max: 300, defaultModal: 3, defaultBanner: 0 },
  priority: { min: 0, max: 1000, default: 0 },
} as const;

function hasUnsafeRedirectChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Validates redirect targets for announcement CTA buttons:
 * - Either a safe site-relative path starting with a single `/` (never `//` or `/\`)
 * - Or a valid `https://` URL on a public domain (no `javascript:`, `data:`, `http:`, credentials,
 *   localhost, or IP literals).
 */
export function isSafeAnnouncementRedirectUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > ANNOUNCEMENT_LIMITS.redirectUrl || hasUnsafeRedirectChars(value)) {
    return false;
  }
  if (value.startsWith('/')) {
    if (value.startsWith('//')) return false;
    try {
      const parsed = new URL(value, 'https://same-origin.invalid');
      return parsed.origin === 'https://same-origin.invalid';
    } catch {
      return false;
    }
  }
  return safeExternalUrlSchema.safeParse(value).success;
}

export const safeAnnouncementRedirectUrlSchema = z
  .string()
  .trim()
  .max(
    ANNOUNCEMENT_LIMITS.redirectUrl,
    `URL must be at most ${ANNOUNCEMENT_LIMITS.redirectUrl} characters`,
  )
  .refine(
    isSafeAnnouncementRedirectUrl,
    'Enter an internal path starting with / or a full https:// URL on a public domain',
  );

const optionalRedirectUrlSchema = z
  .union([z.literal(''), safeAnnouncementRedirectUrlSchema])
  .nullable()
  .optional()
  .transform((value) => (value === '' ? null : value));

const optionalInstantSchema = z
  .union([z.literal(''), isoInstantSchema])
  .nullable()
  .transform((value) => (value === '' ? null : value))
  .optional();

function hasDisallowedControlChars(value: string, allowNewlines: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code < 0x20) {
      if (allowNewlines && (code === 0x0a || code === 0x0d || code === 0x09)) continue;
      return true;
    }
  }
  return false;
}

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Enter an announcement title')
  .max(ANNOUNCEMENT_LIMITS.title, `Title must be at most ${ANNOUNCEMENT_LIMITS.title} characters`)
  .refine((v) => !hasDisallowedControlChars(v, false), 'Title contains unsupported characters');

const descriptionSchema = optionalTextSchema(ANNOUNCEMENT_LIMITS.description)
  .refine(
    (v) => v === undefined || v === null || !hasDisallowedControlChars(v, true),
    'Description contains unsupported control characters',
  )
  .transform((v) => v ?? null);

const ctaTextSchema = optionalTextSchema(ANNOUNCEMENT_LIMITS.ctaText)
  .refine(
    (v) => v === undefined || v === null || !hasDisallowedControlChars(v, false),
    'CTA text contains unsupported characters',
  )
  .transform((v) => v ?? null);

const displayDelaySchema = z
  .number({ message: 'Enter display delay in seconds' })
  .int('Use a whole number of seconds')
  .min(
    ANNOUNCEMENT_LIMITS.displayDelaySeconds.min,
    `Delay must be at least ${ANNOUNCEMENT_LIMITS.displayDelaySeconds.min} seconds`,
  )
  .max(
    ANNOUNCEMENT_LIMITS.displayDelaySeconds.max,
    `Delay must be at most ${ANNOUNCEMENT_LIMITS.displayDelaySeconds.max} seconds`,
  );

const prioritySchema = z
  .number({ message: 'Enter priority' })
  .int('Use a whole number for priority')
  .min(
    ANNOUNCEMENT_LIMITS.priority.min,
    `Priority must be at least ${ANNOUNCEMENT_LIMITS.priority.min}`,
  )
  .max(
    ANNOUNCEMENT_LIMITS.priority.max,
    `Priority must be at most ${ANNOUNCEMENT_LIMITS.priority.max}`,
  );

const fieldShape = {
  title: titleSchema,
  description: descriptionSchema,
  imageMediaId: z.uuid('Upload the image again').nullable(),
  displayType: z.enum(ANNOUNCEMENT_DISPLAY_TYPES),
  ctaText: ctaTextSchema,
  redirectUrl: optionalRedirectUrlSchema.transform((v) => v ?? null),
  startsAt: optionalInstantSchema.transform((v) => v ?? null),
  endsAt: optionalInstantSchema.transform((v) => v ?? null),
  displayDelaySeconds: displayDelaySchema,
  frequency: z.enum(ANNOUNCEMENT_FREQUENCIES),
  priority: prioritySchema,
  audience: z.enum(ANNOUNCEMENT_AUDIENCES),
};

export const ANNOUNCEMENT_DEFAULTS = {
  description: null,
  imageMediaId: null,
  displayType: 'MODAL',
  ctaText: null,
  redirectUrl: null,
  startsAt: null,
  endsAt: null,
  displayDelaySeconds: ANNOUNCEMENT_LIMITS.displayDelaySeconds.defaultModal,
  frequency: 'ONCE_PER_SESSION',
  priority: ANNOUNCEMENT_LIMITS.priority.default,
  audience: 'ALL',
} as const;

type AnnouncementSettings = z.infer<z.ZodObject<typeof fieldShape>>;

export function refineAnnouncementSettings(value: AnnouncementSettings, ctx: z.RefinementCtx) {
  if (value.startsAt && value.endsAt) {
    if (!(Date.parse(value.endsAt) > Date.parse(value.startsAt))) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'End date and time must be after start date and time',
      });
    }
  }
  if (value.ctaText && !value.redirectUrl) {
    ctx.addIssue({
      code: 'custom',
      path: ['redirectUrl'],
      message: 'Enter a redirect URL for the CTA button',
    });
  }
}

export const announcementSettingsSchema = z
  .object(fieldShape)
  .strict()
  .superRefine(refineAnnouncementSettings);
export type AnnouncementSettingsInput = z.infer<typeof announcementSettingsSchema>;

export const announcementCreateSchema = z
  .object(fieldShape)
  .partial()
  .required({ title: true })
  .strict()
  .superRefine((value, ctx) => {
    const merged = { ...ANNOUNCEMENT_DEFAULTS, ...value } as AnnouncementSettings;
    refineAnnouncementSettings(merged, ctx);
  });
export type AnnouncementCreateInput = z.infer<typeof announcementCreateSchema>;

export const announcementUpdateSchema = z
  .object(fieldShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one setting');
export type AnnouncementUpdateInput = z.infer<typeof announcementUpdateSchema>;

export const announcementPrioritySchema = z.object({ priority: prioritySchema }).strict();
export type AnnouncementPriorityInput = z.infer<typeof announcementPrioritySchema>;

export const announcementPublishSchema = z
  .object({
    immediate: z.boolean().optional(),
  })
  .strict();
export type AnnouncementPublishInput = z.infer<typeof announcementPublishSchema>;

export const announcementScheduleSchema = z
  .object({
    startsAt: isoInstantSchema.optional(),
    endsAt: optionalInstantSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.startsAt && value.endsAt) {
      if (!(Date.parse(value.endsAt) > Date.parse(value.startsAt))) {
        ctx.addIssue({
          code: 'custom',
          path: ['endsAt'],
          message: 'End date and time must be after start date and time',
        });
      }
    }
  });
export type AnnouncementScheduleInput = z.infer<typeof announcementScheduleSchema>;

export const adminAnnouncementListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ANNOUNCEMENT_STATUSES).optional(),
  displayType: z.enum(ANNOUNCEMENT_DISPLAY_TYPES).optional(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  q: searchQuerySchema,
});
export type AdminAnnouncementListQuery = z.infer<typeof adminAnnouncementListQuerySchema>;

const audienceListSchema = z
  .string()
  .trim()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(ANNOUNCEMENT_AUDIENCES)).min(1).max(ANNOUNCEMENT_AUDIENCES.length));

export const publicActiveAnnouncementsQuerySchema = z.object({
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  audiences: audienceListSchema.optional(),
  displayType: z.enum(ANNOUNCEMENT_DISPLAY_TYPES).optional(),
});
export type PublicActiveAnnouncementsQuery = z.infer<typeof publicActiveAnnouncementsQuerySchema>;
