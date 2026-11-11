'use client';

import type { AdminAnnouncementDetail, AnnouncementDisplayType } from '@asra/types';
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_DISPLAY_TYPES,
  ANNOUNCEMENT_FREQUENCIES,
  ANNOUNCEMENT_LIMITS,
  announcementSettingsSchema,
} from '@asra/validation';
import { Archive, CalendarClock, Eye, Pause, Play, RotateCcw, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { ImageSlots, useImageUploader } from '@/components/assessments/image-slots';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  AUDIENCE_LABELS,
  DISPLAY_TYPE_LABELS,
  FREQUENCY_LABELS,
  PRIORITY_PRESETS,
  announcementFormFromDetail,
  announcementFormToBody,
  availableAnnouncementActions,
  emptyAnnouncementForm,
  toPreviewAnnouncement,
  type AnnouncementFormState,
  type AnnouncementLifecycleAction,
} from '@/lib/admin/announcements';
import { describeError, validateForm, type FieldErrors } from '@/lib/auth/form-errors';

import { Section } from '../admin-kit';
import { SelectField } from '../admin-ui';
import { errorMessage, useAdminApi } from '../use-admin';
import { AnnouncementPreviewDialog } from './announcement-preview-dialog';
import { AnnouncementStatusBadge } from './announcement-status-badge';

const ADMIN_MEDIA_UPLOAD = '/admin/assessment-media';

const QUICK_ACTION_MESSAGES: Record<Exclude<AnnouncementLifecycleAction, 'delete'>, string> = {
  publish: 'Announcement published',
  schedule: 'Announcement scheduled',
  pause: 'Announcement paused',
  resume: 'Announcement resumed',
  archive: 'Announcement archived',
  restore: 'Announcement restored to draft',
};

type SaveIntent = 'draft' | 'publish' | 'schedule' | 'save';

/**
 * Campaign editor for creating or editing a website announcement (popup modal or top banner).
 * Times are entered and shown in IST (`Asia/Kolkata`).
 */
export function AnnouncementForm({
  announcement,
  onUpdated,
}: {
  announcement?: AdminAnnouncementDetail;
  onUpdated?: (next: AdminAnnouncementDetail) => void;
}) {
  const api = useAdminApi();
  const router = useRouter();
  const upload = useImageUploader(ADMIN_MEDIA_UPLOAD);

  const [form, setForm] = React.useState<AnnouncementFormState>(() =>
    announcement ? announcementFormFromDetail(announcement) : emptyAnnouncementForm(),
  );
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);

  const set = (patch: Partial<AnnouncementFormState>) =>
    setForm((current) => ({ ...current, ...patch }));

  const isArchived = announcement?.status === 'ARCHIVED';
  const actions = announcement ? availableAnnouncementActions(announcement) : [];

  function handleDisplayTypeChange(nextType: AnnouncementDisplayType) {
    const defaultDelay =
      nextType === 'TOP_BANNER'
        ? String(ANNOUNCEMENT_LIMITS.displayDelaySeconds.defaultBanner)
        : String(ANNOUNCEMENT_LIMITS.displayDelaySeconds.defaultModal);
    const shouldSwapDefault =
      (form.displayType === 'MODAL' && form.displayDelaySeconds === '3') ||
      (form.displayType === 'TOP_BANNER' && form.displayDelaySeconds === '0');
    set({
      displayType: nextType,
      ...(shouldSwapDefault ? { displayDelaySeconds: defaultDelay } : {}),
    });
  }

  async function saveWithIntent(intent: SaveIntent) {
    if (pending || uploading || isArchived) return;
    const body = announcementFormToBody(form);
    const checked = validateForm(announcementSettingsSchema, body);
    setFormError(null);
    if (checked.errors) {
      setErrors(checked.errors);
      setFormError('Check the highlighted fields before continuing.');
      return;
    }

    if (intent === 'schedule') {
      if (!checked.data.startsAt) {
        setErrors({ startsAt: 'Choose a future start date and time to schedule.' });
        setFormError('Scheduled announcements require a future start time.');
        return;
      }
      if (Date.parse(checked.data.startsAt) <= Date.now()) {
        setErrors({ startsAt: 'Start date and time must be in the future to schedule.' });
        setFormError('Start date and time must be in the future.');
        return;
      }
    }

    setErrors({});
    setPending(true);
    try {
      let saved: AdminAnnouncementDetail;
      if (!announcement) {
        saved = await api.post<AdminAnnouncementDetail>('/admin/announcements', checked.data);
      } else {
        saved = await api.patch<AdminAnnouncementDetail>(
          `/admin/announcements/${announcement.id}`,
          checked.data,
        );
      }

      if (intent === 'publish') {
        saved = await api.post<AdminAnnouncementDetail>(
          `/admin/announcements/${saved.id}/publish`,
          { immediate: false },
        );
        toast.success(
          saved.status === 'SCHEDULED' ? 'Announcement scheduled' : 'Announcement published',
        );
      } else if (intent === 'schedule') {
        saved = await api.post<AdminAnnouncementDetail>(
          `/admin/announcements/${saved.id}/schedule`,
          {
            startsAt: checked.data.startsAt ?? undefined,
            endsAt: checked.data.endsAt ?? null,
          },
        );
        toast.success('Announcement scheduled');
      } else {
        toast.success(announcement ? 'Announcement saved' : 'Announcement saved as draft');
      }

      if (!announcement) {
        router.push('/admin/announcements');
      } else {
        onUpdated?.(saved);
        setForm(announcementFormFromDetail(saved));
      }
    } catch (error) {
      const described = describeError(error);
      setErrors(described.fieldErrors);
      setFormError(described.message);
    } finally {
      setPending(false);
    }
  }

  async function runQuickTransition(action: Exclude<AnnouncementLifecycleAction, 'delete'>) {
    if (!announcement || pending) return;
    setPending(true);
    setFormError(null);
    try {
      const updated = await api.post<AdminAnnouncementDetail>(
        `/admin/announcements/${announcement.id}/${action}`,
        {},
      );
      toast.success(QUICK_ACTION_MESSAGES[action]);
      onUpdated?.(updated);
      setForm(announcementFormFromDetail(updated));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void saveWithIntent(announcement ? 'save' : 'draft');
      }}
      noValidate
      className="grid gap-6"
    >
      <PageHeader
        title={announcement ? `Edit announcement` : 'New announcement'}
        description="Configure website modals or top banners. All schedule times use India Standard Time (IST)."
        breadcrumbs={[
          { label: 'Administration', href: '/admin' },
          { label: 'Announcements', href: '/admin/announcements' },
          { label: announcement ? announcement.title : 'New' },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {announcement ? <AnnouncementStatusBadge status={announcement.status} /> : null}
            <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>
              <Eye aria-hidden /> Preview
            </Button>
          </div>
        }
      />

      {isArchived ? (
        <Alert tone="warning" title="Archived announcement">
          <p>Restore this campaign to draft before making edits or re-publishing.</p>
        </Alert>
      ) : null}

      {formError ? (
        <Alert tone="error">
          <p>{formError}</p>
        </Alert>
      ) : null}

      <Section
        title="Announcement content"
        description="Plain-text headline, message, and optional promotional image."
      >
        <Field id="ann-title" label="Title" error={errors.title}>
          <Input
            value={form.title}
            maxLength={ANNOUNCEMENT_LIMITS.title}
            disabled={isArchived || pending}
            placeholder="Admissions Open for Academic Session 2027–28"
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>

        <Field
          id="ann-description"
          label="Description"
          optional
          error={errors.description}
          hint="Shown below the title as plain text."
        >
          <Textarea
            rows={4}
            value={form.description}
            maxLength={ANNOUNCEMENT_LIMITS.description}
            disabled={isArchived || pending}
            placeholder="Registrations are open for Classes 6–12 (CBSE), English, and competitive quizzes. Limited seats available."
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>

        <div className="grid gap-1">
          <span className="type-label">
            Promotional image <span className="font-normal text-muted-foreground">(optional)</span>
          </span>
          <ImageSlots
            label="Announcement image"
            images={form.image ? [form.image] : []}
            max={1}
            onChange={(next) => set({ image: next[0] ?? null })}
            upload={upload}
            onBusyChange={setUploading}
            disabled={isArchived || pending}
          />
          <p className="type-caption text-muted-foreground">
            Automatically optimized (WebP/JPEG, ≤ 100 KB) and stored via Cloudinary.
          </p>
          {errors.imageMediaId ? (
            <p className="type-body-sm text-destructive">{errors.imageMediaId}</p>
          ) : null}
        </div>
      </Section>

      <Section
        title="Call to action & redirect"
        description="Optional action button linking to an internal page or verified external HTTPS site."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="ann-cta"
            label="CTA button text"
            optional
            error={errors.ctaText}
            hint="Defaults to “Learn more” if a redirect URL is provided without custom text."
          >
            <Input
              value={form.ctaText}
              maxLength={ANNOUNCEMENT_LIMITS.ctaText}
              disabled={isArchived || pending}
              placeholder="Apply Now"
              onChange={(e) => set({ ctaText: e.target.value })}
            />
          </Field>

          <Field
            id="ann-redirect"
            label="Redirect URL"
            optional
            error={errors.redirectUrl}
            hint="Internal path (e.g. /admission) or full https:// URL."
          >
            <Input
              value={form.redirectUrl}
              maxLength={ANNOUNCEMENT_LIMITS.redirectUrl}
              disabled={isArchived || pending}
              placeholder="/admission"
              onChange={(e) => set({ redirectUrl: e.target.value })}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Placement, audience & priority"
        description="Control how and to whom this campaign renders. Higher priority wins when multiple campaigns qualify."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="ann-display-type"
            label="Display type"
            value={form.displayType}
            disabled={isArchived || pending}
            onValueChange={(value) => handleDisplayTypeChange(value as AnnouncementDisplayType)}
            options={ANNOUNCEMENT_DISPLAY_TYPES.map((value) => ({
              value,
              label: DISPLAY_TYPE_LABELS[value],
            }))}
          />

          <SelectField
            id="ann-audience"
            label="Audience targeting"
            value={form.audience}
            disabled={isArchived || pending}
            onValueChange={(value) => set({ audience: value as AnnouncementFormState['audience'] })}
            options={ANNOUNCEMENT_AUDIENCES.map((value) => ({
              value,
              label: AUDIENCE_LABELS[value],
            }))}
          />

          <SelectField
            id="ann-frequency"
            label="Display frequency"
            value={form.frequency}
            disabled={isArchived || pending}
            onValueChange={(value) =>
              set({ frequency: value as AnnouncementFormState['frequency'] })
            }
            options={ANNOUNCEMENT_FREQUENCIES.map((value) => ({
              value,
              label: FREQUENCY_LABELS[value],
            }))}
          />

          <Field
            id="ann-delay"
            label="Display delay (seconds)"
            error={errors.displayDelaySeconds}
            hint="Default is 3 seconds for popup modals and 0 seconds for top banners (0–300s)."
          >
            <Input
              type="number"
              min={ANNOUNCEMENT_LIMITS.displayDelaySeconds.min}
              max={ANNOUNCEMENT_LIMITS.displayDelaySeconds.max}
              value={form.displayDelaySeconds}
              disabled={isArchived || pending}
              onChange={(e) => set({ displayDelaySeconds: e.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-2">
          <Field
            id="ann-priority"
            label="Priority (0–1000)"
            error={errors.priority}
            hint="Higher priority campaigns win when multiple announcements are eligible at the same time."
          >
            <Input
              type="number"
              min={ANNOUNCEMENT_LIMITS.priority.min}
              max={ANNOUNCEMENT_LIMITS.priority.max}
              value={form.priority}
              disabled={isArchived || pending}
              onChange={(e) => set({ priority: e.target.value })}
              className="max-w-xs"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {PRIORITY_PRESETS.map((preset) => (
              <Button
                key={preset.value}
                type="button"
                size="sm"
                variant="outline"
                disabled={isArchived || pending}
                onClick={() => set({ priority: String(preset.value) })}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Schedule (IST)"
        description="Optional start and end timestamps. Expired campaigns stop showing automatically."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="ann-starts"
            label="Start date & time (IST)"
            optional
            error={errors.startsAt}
            hint="Leave empty to start as soon as published."
          >
            <Input
              type="datetime-local"
              value={form.startsAt}
              disabled={isArchived || pending}
              onChange={(e) => set({ startsAt: e.target.value })}
            />
          </Field>

          <Field
            id="ann-ends"
            label="End date & time (IST)"
            optional
            error={errors.endsAt}
            hint="Leave empty for no automatic end date."
          >
            <Input
              type="datetime-local"
              value={form.endsAt}
              disabled={isArchived || pending}
              onChange={(e) => set({ endsAt: e.target.value })}
            />
          </Field>
        </div>
      </Section>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" disabled={pending}>
            <Link href="/admin/announcements">Back to announcements</Link>
          </Button>
          <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>
            <Eye aria-hidden /> Preview
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!announcement ? (
            <>
              <Button
                type="submit"
                variant="outline"
                loading={pending}
                disabled={uploading}
                loadingText="Saving…"
              >
                Save as draft
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending || uploading}
                onClick={() => void saveWithIntent('schedule')}
              >
                <CalendarClock aria-hidden /> Schedule
              </Button>
              <Button
                type="button"
                disabled={pending || uploading}
                onClick={() => void saveWithIntent('publish')}
              >
                <Send aria-hidden /> Publish now
              </Button>
            </>
          ) : (
            <>
              {!isArchived ? (
                <Button type="submit" loading={pending} disabled={uploading} loadingText="Saving…">
                  Save changes
                </Button>
              ) : null}
              {actions.includes('publish') ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending || uploading}
                  onClick={() => void saveWithIntent('publish')}
                >
                  <Send aria-hidden /> Publish
                </Button>
              ) : null}
              {actions.includes('schedule') ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending || uploading}
                  onClick={() => void saveWithIntent('schedule')}
                >
                  <CalendarClock aria-hidden /> Schedule
                </Button>
              ) : null}
              {actions.includes('pause') ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void runQuickTransition('pause')}
                >
                  <Pause aria-hidden /> Pause
                </Button>
              ) : null}
              {actions.includes('resume') ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => void runQuickTransition('resume')}
                >
                  <Play aria-hidden /> Resume
                </Button>
              ) : null}
              {actions.includes('restore') ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => void runQuickTransition('restore')}
                >
                  <RotateCcw aria-hidden /> Restore to draft
                </Button>
              ) : null}
              {actions.includes('archive') ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void runQuickTransition('archive')}
                >
                  <Archive aria-hidden /> Archive
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>

      <AnnouncementPreviewDialog
        announcement={toPreviewAnnouncement(form, announcement?.id)}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
    </form>
  );
}
