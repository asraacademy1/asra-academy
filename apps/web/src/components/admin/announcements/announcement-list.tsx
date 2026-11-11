'use client';

import type { AdminAnnouncementDetail, PublicAnnouncementDto } from '@asra/types';
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_DISPLAY_TYPES,
  ANNOUNCEMENT_LIMITS,
  ANNOUNCEMENT_STATUSES,
  announcementPrioritySchema,
} from '@asra/validation';
import {
  Archive,
  ArrowUpDown,
  CalendarClock,
  Eye,
  Megaphone,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Send,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import {
  ANNOUNCEMENT_STATUS_LABELS,
  AUDIENCE_LABELS,
  DISPLAY_TYPE_LABELS,
  PRIORITY_PRESETS,
  availableAnnouncementActions,
  type AnnouncementLifecycleAction,
} from '@/lib/admin/announcements';
import { formatDateTime } from '@/lib/format';

import { FilterSelect, ListFrame, SearchBox, usePagedList } from '../admin-kit';
import { ConfirmDialog } from '../admin-ui';
import { errorMessage, useAdminApi } from '../use-admin';
import { AnnouncementPreviewDialog } from './announcement-preview-dialog';
import { AnnouncementStatusBadge } from './announcement-status-badge';

const ACTION_COPY: Record<
  AnnouncementLifecycleAction,
  {
    title: string;
    description: string;
    confirmLabel: string;
    pendingLabel: string;
    destructive?: boolean;
    successMessage: string;
  }
> = {
  publish: {
    title: 'Publish announcement',
    description:
      'Make this campaign active immediately (or at its configured start time if scheduled for the future).',
    confirmLabel: 'Publish',
    pendingLabel: 'Publishing…',
    successMessage: 'Announcement published',
  },
  schedule: {
    title: 'Schedule announcement',
    description: 'Activate this campaign so it starts displaying automatically at its start time.',
    confirmLabel: 'Schedule',
    pendingLabel: 'Scheduling…',
    successMessage: 'Announcement scheduled',
  },
  pause: {
    title: 'Pause announcement',
    description: 'Immediately hide this campaign from visitors until you resume it.',
    confirmLabel: 'Pause',
    pendingLabel: 'Pausing…',
    successMessage: 'Announcement paused',
  },
  resume: {
    title: 'Resume announcement',
    description: 'Re-enable this campaign using its configured schedule and targeting.',
    confirmLabel: 'Resume',
    pendingLabel: 'Resuming…',
    successMessage: 'Announcement resumed',
  },
  archive: {
    title: 'Archive announcement',
    description: 'Remove this campaign from active rotation and move it to the archive.',
    confirmLabel: 'Archive',
    pendingLabel: 'Archiving…',
    destructive: true,
    successMessage: 'Announcement archived',
  },
  restore: {
    title: 'Restore to draft',
    description: 'Move this archived announcement back to draft so it can be edited or published.',
    confirmLabel: 'Restore',
    pendingLabel: 'Restoring…',
    successMessage: 'Announcement restored to draft',
  },
  delete: {
    title: 'Delete announcement',
    description: 'Permanently delete this announcement and its attached image if unused elsewhere.',
    confirmLabel: 'Delete',
    pendingLabel: 'Deleting…',
    destructive: true,
    successMessage: 'Announcement deleted',
  },
};

function toPublicPreview(item: AdminAnnouncementDetail): PublicAnnouncementDto {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    image: item.image
      ? { url: item.image.url, width: item.image.width, height: item.image.height }
      : null,
    displayType: item.displayType,
    ctaText: item.ctaText,
    redirectUrl: item.redirectUrl,
    displayDelaySeconds: item.displayDelaySeconds,
    frequency: item.frequency,
    priority: item.priority,
    audience: item.audience,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
  };
}

/** `/admin/announcements` — Website Management → Announcements listing. */
export function AnnouncementList() {
  const api = useAdminApi();
  const [status, setStatus] = React.useState('');
  const [displayType, setDisplayType] = React.useState('');
  const [audience, setAudience] = React.useState('');
  const [q, setQ] = React.useState('');

  const { list, setPage } = usePagedList<AdminAnnouncementDetail>('/admin/announcements', {
    status: status || undefined,
    displayType: displayType || undefined,
    audience: audience || undefined,
    q: q || undefined,
  });

  const [previewItem, setPreviewItem] = React.useState<AdminAnnouncementDetail | null>(null);
  const [confirmState, setConfirmState] = React.useState<{
    item: AdminAnnouncementDetail;
    action: AnnouncementLifecycleAction;
  } | null>(null);
  const [priorityTarget, setPriorityTarget] = React.useState<AdminAnnouncementDetail | null>(null);
  const [priorityInput, setPriorityInput] = React.useState('50');
  const [priorityError, setPriorityError] = React.useState<string | null>(null);
  const [priorityPending, setPriorityPending] = React.useState(false);

  async function runLifecycleAction() {
    if (!confirmState) return;
    const { item, action } = confirmState;
    try {
      if (action === 'delete') {
        await api.del(`/admin/announcements/${item.id}`);
      } else {
        await api.post(`/admin/announcements/${item.id}/${action}`, {});
      }
      toast.success(ACTION_COPY[action].successMessage);
      list.reload();
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  }

  function openPriorityDialog(item: AdminAnnouncementDetail) {
    setPriorityTarget(item);
    setPriorityInput(String(item.priority));
    setPriorityError(null);
  }

  async function savePriority(event: React.FormEvent) {
    event.preventDefault();
    if (!priorityTarget || priorityPending) return;
    const parsed = announcementPrioritySchema.safeParse({
      priority: priorityInput.trim() === '' ? Number.NaN : Number(priorityInput),
    });
    if (!parsed.success) {
      setPriorityError(parsed.error.issues[0]?.message ?? 'Enter a valid priority (0–1000).');
      return;
    }
    setPriorityPending(true);
    setPriorityError(null);
    try {
      await api.patch(`/admin/announcements/${priorityTarget.id}/priority`, parsed.data);
      toast.success('Priority updated');
      setPriorityTarget(null);
      list.reload();
    } catch (error) {
      setPriorityError(errorMessage(error));
    } finally {
      setPriorityPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Announcements"
        description="Manage website popup modals and top banners for admissions, exams, quizzes, events, and results."
        breadcrumbs={[
          { label: 'Administration', href: '/admin' },
          { label: 'Website Management' },
          { label: 'Announcements' },
        ]}
        actions={
          <Button asChild>
            <Link href="/admin/announcements/new">
              <Plus aria-hidden /> New announcement
            </Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          id="announcement-status"
          label="Status"
          value={status}
          onChange={setStatus}
          options={ANNOUNCEMENT_STATUSES.map((value) => ({
            value,
            label: ANNOUNCEMENT_STATUS_LABELS[value],
          }))}
        />
        <FilterSelect
          id="announcement-type"
          label="Display type"
          value={displayType}
          onChange={setDisplayType}
          options={ANNOUNCEMENT_DISPLAY_TYPES.map((value) => ({
            value,
            label: DISPLAY_TYPE_LABELS[value],
          }))}
        />
        <FilterSelect
          id="announcement-audience"
          label="Audience"
          value={audience}
          onChange={setAudience}
          options={ANNOUNCEMENT_AUDIENCES.map((value) => ({
            value,
            label: AUDIENCE_LABELS[value],
          }))}
        />
        <SearchBox
          id="announcement-search"
          placeholder="Search title or description"
          onSearch={setQ}
        />
      </div>

      <ListFrame
        list={list}
        setPage={setPage}
        label="announcements"
        icon={<Megaphone />}
        emptyTitle="No announcements yet"
        emptyText={
          status || displayType || audience || q
            ? 'Nothing matches these filters.'
            : 'Create your first announcement campaign to notify visitors without code changes.'
        }
      >
        {(items) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Placement & Audience</TableHead>
                <TableHead>Schedule (IST)</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const actions = availableAnnouncementActions(item);
                return (
                  <TableRow key={item.id}>
                    <TableCell className="max-w-xs">
                      <div className="flex items-start gap-3">
                        {item.image ? (
                          // eslint-disable-next-line @next/next/no-img-element -- pre-optimized Cloudinary image
                          <img
                            src={item.image.url}
                            alt=""
                            width={item.image.width}
                            height={item.image.height}
                            className="size-10 shrink-0 rounded-md border object-cover"
                          />
                        ) : (
                          <span
                            aria-hidden
                            className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-secondary/50 text-primary"
                          >
                            <Megaphone className="size-4" />
                          </span>
                        )}
                        <div className="min-w-0">
                          <Link
                            href={`/admin/announcements/${item.id}/edit`}
                            className="block truncate type-label text-heading hover:text-primary hover:underline"
                          >
                            {item.title}
                          </Link>
                          {item.description ? (
                            <p className="line-clamp-1 type-caption text-muted-foreground">
                              {item.description}
                            </p>
                          ) : null}
                          {item.redirectUrl ? (
                            <p className="truncate type-caption text-primary">
                              {item.ctaText ? `${item.ctaText} → ` : ''}
                              {item.redirectUrl}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <AnnouncementStatusBadge status={item.status} />
                    </TableCell>
                    <TableCell className="type-body-sm">
                      <div className="grid gap-0.5">
                        <span className="font-medium text-heading">
                          {DISPLAY_TYPE_LABELS[item.displayType]}
                        </span>
                        <span className="type-caption text-muted-foreground">
                          {AUDIENCE_LABELS[item.audience]}
                        </span>
                        <span className="type-caption text-muted-foreground">
                          Delay {item.displayDelaySeconds}s ·{' '}
                          {item.frequency.toLowerCase().replace(/_/g, ' ')}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="type-body-sm whitespace-nowrap">
                      <span>{item.startsAt ? formatDateTime(item.startsAt) : 'Immediate'}</span>
                      <span className="block type-caption text-muted-foreground">
                        {item.endsAt ? `Until ${formatDateTime(item.endsAt)}` : 'No expiry'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="tabular-nums">
                          {item.priority}
                        </Badge>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Adjust priority of ${item.title}`}
                          onClick={() => openPriorityDialog(item)}
                        >
                          <ArrowUpDown className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex flex-wrap justify-end gap-1">
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Preview ${item.title}`}
                          onClick={() => setPreviewItem(item)}
                        >
                          <Eye aria-hidden />
                        </Button>
                        {item.status !== 'ARCHIVED' ? (
                          <Button asChild size="icon-sm" variant="ghost">
                            <Link
                              href={`/admin/announcements/${item.id}/edit`}
                              aria-label={`Edit ${item.title}`}
                            >
                              <Pencil aria-hidden />
                            </Link>
                          </Button>
                        ) : null}
                        {actions.includes('publish') ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Publish ${item.title}`}
                            onClick={() => setConfirmState({ item, action: 'publish' })}
                          >
                            <Send aria-hidden />
                          </Button>
                        ) : null}
                        {actions.includes('schedule') ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Schedule ${item.title}`}
                            onClick={() => setConfirmState({ item, action: 'schedule' })}
                          >
                            <CalendarClock aria-hidden />
                          </Button>
                        ) : null}
                        {actions.includes('pause') ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Pause ${item.title}`}
                            onClick={() => setConfirmState({ item, action: 'pause' })}
                          >
                            <Pause aria-hidden />
                          </Button>
                        ) : null}
                        {actions.includes('resume') ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Resume ${item.title}`}
                            onClick={() => setConfirmState({ item, action: 'resume' })}
                          >
                            <Play aria-hidden />
                          </Button>
                        ) : null}
                        {actions.includes('restore') ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Restore ${item.title}`}
                            onClick={() => setConfirmState({ item, action: 'restore' })}
                          >
                            <RotateCcw aria-hidden />
                          </Button>
                        ) : null}
                        {actions.includes('archive') ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Archive ${item.title}`}
                            onClick={() => setConfirmState({ item, action: 'archive' })}
                          >
                            <Archive aria-hidden />
                          </Button>
                        ) : null}
                        {actions.includes('delete') ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Delete ${item.title}`}
                            onClick={() => setConfirmState({ item, action: 'delete' })}
                          >
                            <Trash2 className="text-destructive" aria-hidden />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </ListFrame>

      <AnnouncementPreviewDialog
        announcement={previewItem ? toPublicPreview(previewItem) : null}
        open={previewItem !== null}
        onOpenChange={(open) => !open && setPreviewItem(null)}
      />

      {confirmState ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmState(null)}
          title={ACTION_COPY[confirmState.action].title}
          description={
            <>
              <span className="font-medium text-heading">{confirmState.item.title}</span>:{' '}
              {ACTION_COPY[confirmState.action].description}
            </>
          }
          confirmLabel={ACTION_COPY[confirmState.action].confirmLabel}
          pendingLabel={ACTION_COPY[confirmState.action].pendingLabel}
          destructive={ACTION_COPY[confirmState.action].destructive}
          onConfirm={runLifecycleAction}
        />
      ) : null}

      <Dialog
        open={priorityTarget !== null}
        onOpenChange={(open) => !priorityPending && !open && setPriorityTarget(null)}
      >
        <DialogContent>
          <form onSubmit={savePriority} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Adjust campaign priority</DialogTitle>
              <DialogDescription>
                When multiple campaigns are eligible, the highest priority wins (0–
                {ANNOUNCEMENT_LIMITS.priority.max}).
              </DialogDescription>
            </DialogHeader>
            <Field id="priority-input" label="Priority" error={priorityError ?? undefined}>
              <Input
                type="number"
                min={ANNOUNCEMENT_LIMITS.priority.min}
                max={ANNOUNCEMENT_LIMITS.priority.max}
                value={priorityInput}
                onChange={(e) => setPriorityInput(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              {PRIORITY_PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setPriorityInput(String(preset.value))}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={priorityPending}
                onClick={() => setPriorityTarget(null)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={priorityPending} loadingText="Saving…">
                Save priority
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
