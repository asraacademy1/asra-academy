'use client';

import type {
  QuizCertificateBatchDetailDto,
  QuizCertificateBatchSummaryDto,
  QuizCertificateEmailStatus,
  QuizCertificateGenerationStatus,
} from '@asra/types';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Mail,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';

import { ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, useAdminApi } from '../use-admin';

const GEN_BADGE: Record<
  QuizCertificateGenerationStatus,
  { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' }
> = {
  PENDING: { label: 'Pending', variant: 'secondary' },
  PROCESSING: { label: 'Generating', variant: 'warning' },
  GENERATED: { label: 'Generated', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'destructive' },
};

const EMAIL_BADGE: Record<
  QuizCertificateEmailStatus,
  { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' | 'outline' }
> = {
  NOT_REQUESTED: { label: 'Not requested', variant: 'outline' },
  PENDING: { label: 'Queued', variant: 'secondary' },
  SENDING: { label: 'Sending', variant: 'warning' },
  SENT: { label: 'Sent', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'destructive' },
};

export function BatchStatusBadge({ status }: { status: QuizCertificateBatchSummaryDto['status'] }) {
  switch (status) {
    case 'COMPLETED':
      return (
        <Badge variant="success">
          <CheckCircle2 aria-hidden /> Completed
        </Badge>
      );
    case 'COMPLETED_WITH_ERRORS':
      return (
        <Badge variant="warning">
          <AlertCircle aria-hidden /> Completed with errors
        </Badge>
      );
    case 'FAILED':
      return (
        <Badge variant="destructive">
          <AlertCircle aria-hidden /> Failed
        </Badge>
      );
    case 'PROCESSING':
      return (
        <Badge variant="info">
          <Loader2 className="animate-spin" aria-hidden /> Processing
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary">
          <Clock aria-hidden /> Queued
        </Badge>
      );
  }
}

export function QuizCertificatesProgress({
  quizId,
  batchId,
  canIssue,
  initialDetail,
  onBatchUpdated,
  onViewIssuedCertificates,
}: {
  quizId: string;
  batchId: string;
  canIssue: boolean;
  initialDetail?: QuizCertificateBatchDetailDto;
  onBatchUpdated?: () => void;
  onViewIssuedCertificates?: () => void;
}) {
  const api = useAdminApi();
  const [detail, setDetail] = React.useState<QuizCertificateBatchDetailDto | null>(
    initialDetail ?? null,
  );
  const [loading, setLoading] = React.useState(!initialDetail);
  const [error, setError] = React.useState<string | null>(null);
  const [retryingScope, setRetryingScope] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<'ALL' | 'GEN_FAILED' | 'EMAIL_FAILED' | 'DONE'>('ALL');

  const loadBatch = React.useCallback(async () => {
    try {
      const next = await api.get<QuizCertificateBatchDetailDto>(
        `/admin/academy-quizzes/${quizId}/certificates/batches/${batchId}`,
      );
      setDetail(next);
      setError(null);
      return next;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [api, quizId, batchId]);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      const next = await loadBatch();
      if (cancelled) return;
      if (next && (next.batch.status === 'PENDING' || next.batch.status === 'PROCESSING')) {
        timer = setTimeout(() => void poll(), 1800);
      } else if (next) {
        onBatchUpdated?.();
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadBatch, onBatchUpdated]);

  async function handleRetry(scope: 'FAILED_GENERATIONS' | 'FAILED_EMAILS' | 'ALL_FAILED') {
    setRetryingScope(scope);
    try {
      const next = await api.post<QuizCertificateBatchDetailDto>(
        `/admin/academy-quizzes/${quizId}/certificates/batches/${batchId}/retry`,
        { scope },
      );
      setDetail(next);
      toast.success('Retry queued', {
        description: 'Processing failed items in the background.',
      });
      onBatchUpdated?.();
    } catch (err) {
      toast.error('Retry failed', { description: errorMessage(err) });
    } finally {
      setRetryingScope(null);
    }
  }

  if (loading && !detail) {
    return <LoadingPanel label="Loading certificate issuance progress…" rows={4} />;
  }
  if (error && !detail) {
    return <ErrorPanel message={error} onRetry={() => void loadBatch()} />;
  }
  if (!detail) return null;

  const { batch, items } = detail;
  const isRunning = batch.status === 'PENDING' || batch.status === 'PROCESSING';
  const pendingCount = batch.pendingGenerationCount + batch.pendingEmailCount;

  const visibleItems = items.filter((item) => {
    if (filter === 'GEN_FAILED') return item.generationStatus === 'FAILED';
    if (filter === 'EMAIL_FAILED') return item.emailStatus === 'FAILED';
    if (filter === 'DONE') {
      return (
        item.generationStatus === 'GENERATED' && (!batch.sendEmail || item.emailStatus === 'SENT')
      );
    }
    return true;
  });

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="type-label text-heading">Issuance Batch</h4>
            <BatchStatusBadge status={batch.status} />
          </div>
          <p className="type-caption text-muted-foreground">
            Started {formatDateTime(batch.createdAt)}
            {batch.initiatedByName ? ` by ${batch.initiatedByName}` : ''}
            {batch.completedAt ? ` · Finished ${formatDateTime(batch.completedAt)}` : ''}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void loadBatch()}>
          <RefreshCw className="size-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      <Progress
        value={batch.completionPercent}
        max={100}
        label={isRunning ? 'Issuance progress' : 'Completion'}
        showValue
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Total recipients" value={batch.totalRecipients} />
        <StatTile label="Generated" value={batch.generatedCount} tone="success" />
        <StatTile
          label="Generation failed"
          value={batch.generationFailedCount}
          tone={batch.generationFailedCount > 0 ? 'destructive' : undefined}
        />
        <StatTile label="Emails sent" value={batch.sendEmail ? batch.emailsSentCount : '—'} />
        <StatTile
          label="Email failed"
          value={batch.sendEmail ? batch.emailsFailedCount : '—'}
          tone={batch.emailsFailedCount > 0 ? 'destructive' : undefined}
        />
        <StatTile label="Pending work" value={pendingCount} />
      </div>

      {!isRunning && (
        <Alert
          tone={
            batch.status === 'COMPLETED'
              ? 'success'
              : batch.status === 'FAILED'
                ? 'error'
                : 'warning'
          }
          title="Certificate issuance completed"
        >
          <p className="type-body-sm">
            Successfully generated: <strong>{batch.generatedCount}</strong> · Failed:{' '}
            <strong>{batch.generationFailedCount}</strong> · Emails sent:{' '}
            <strong>{batch.emailsSentCount}</strong> · Emails failed:{' '}
            <strong>{batch.emailsFailedCount}</strong> · Already issued / excluded:{' '}
            <strong>{batch.excludedDuplicates}</strong>
          </p>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { key: 'ALL', label: `All (${items.length})` },
              {
                key: 'GEN_FAILED',
                label: `Generation Failed (${batch.generationFailedCount})`,
              },
              {
                key: 'EMAIL_FAILED',
                label: `Email Failed (${batch.emailsFailedCount})`,
              },
              { key: 'DONE', label: 'Completed' },
            ] as const
          ).map((tab) => (
            <Button
              key={tab.key}
              type="button"
              size="sm"
              variant={filter === tab.key ? 'default' : 'outline'}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canIssue && batch.generationFailedCount > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={retryingScope !== null}
              onClick={() => void handleRetry('FAILED_GENERATIONS')}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              {retryingScope === 'FAILED_GENERATIONS' ? 'Retrying…' : 'Retry Failed Generations'}
            </Button>
          )}
          {canIssue && batch.sendEmail && batch.emailsFailedCount > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={retryingScope !== null}
              onClick={() => void handleRetry('FAILED_EMAILS')}
            >
              <Mail className="size-3.5" aria-hidden />
              {retryingScope === 'FAILED_EMAILS' ? 'Retrying…' : 'Retry Failed Emails'}
            </Button>
          )}
          {onViewIssuedCertificates && (
            <Button type="button" size="sm" variant="secondary" onClick={onViewIssuedCertificates}>
              View Issued Certificates
            </Button>
          )}
        </div>
      </div>

      <div className="max-h-80 overflow-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Category / Rank</TableHead>
              <TableHead>Template</TableHead>
              <TableHead>Certificate #</TableHead>
              <TableHead>Generation</TableHead>
              <TableHead>Email</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleItems.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-6 text-center type-body-sm text-muted-foreground"
                >
                  No items match this filter.
                </TableCell>
              </TableRow>
            ) : (
              visibleItems.map((item) => {
                const genMeta = GEN_BADGE[item.generationStatus];
                const emailMeta = EMAIL_BADGE[item.emailStatus];
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <span className="type-label text-heading">{item.recipientName}</span>
                      <span className="block type-caption text-muted-foreground">
                        {item.recipientEmail}
                      </span>
                    </TableCell>
                    <TableCell className="type-body-sm">
                      {item.category === 'RANK' && item.rank !== null
                        ? `Rank #${item.rank}`
                        : 'Participation'}
                    </TableCell>
                    <TableCell className="type-body-sm">{item.templateName}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {item.certificateNumber ? (
                        <Link
                          href={`/verify/${item.certificateNumber}`}
                          target="_blank"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          {item.certificateNumber}
                          <ExternalLink className="size-3" aria-hidden />
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={genMeta.variant}>{genMeta.label}</Badge>
                      {item.generationError ? (
                        <span
                          className="mt-1 block max-w-[180px] truncate type-caption text-destructive"
                          title={item.generationError}
                        >
                          {item.generationError}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={emailMeta.variant}>{emailMeta.label}</Badge>
                      {item.emailError ? (
                        <span
                          className="mt-1 block max-w-[180px] truncate type-caption text-destructive"
                          title={item.emailError}
                        >
                          {item.emailError}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'success' | 'destructive';
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="type-caption text-muted-foreground">{label}</p>
      <p
        className={
          tone === 'success'
            ? 'mt-0.5 type-h3 text-success tabular-nums'
            : tone === 'destructive'
              ? 'mt-0.5 type-h3 text-destructive tabular-nums'
              : 'mt-0.5 type-h3 text-heading tabular-nums'
        }
      >
        {value}
      </p>
    </div>
  );
}
