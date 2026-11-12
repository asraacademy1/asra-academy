'use client';

import {
  PERMISSIONS,
  type AdminAcademyQuizDetail,
  type QuizCertificateBatchSummaryDto,
  type QuizCertificateSummaryDto,
  type QuizIssuedCertificateItemDto,
} from '@asra/types';
import {
  Award,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Eye,
  FileImage,
  History,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { triggerBlobDownload } from '@/lib/certificates';
import { formatDateTime } from '@/lib/format';

import { FilterSelect, ListFrame, SearchBox, usePagedList } from '../admin-kit';
import { ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, hasPermission, useAdminApi, useApiResource } from '../use-admin';
import { BatchStatusBadge, QuizCertificatesProgress } from './quiz-certificates-progress';
import { QuizCertificatesWizard } from './quiz-certificates-wizard';

const MODE_LABELS: Record<QuizCertificateBatchSummaryDto['recipientMode'], string> = {
  ALL_PARTICIPANTS: 'All Participants',
  RANKERS_ONLY: 'Rankers Only',
  SELECTED_RANKS: 'Selected Ranks',
  INDIVIDUAL_PARTICIPANTS: 'Individual Participants',
};

const CATEGORY_OPTIONS = [
  { value: 'PARTICIPATION', label: 'Participation' },
  { value: 'RANK', label: 'Ranker' },
];

export function QuizCertificatesSection({ quiz }: { quiz: AdminAcademyQuizDetail }) {
  const api = useAdminApi();
  const { user } = useAuth();

  const canView =
    hasPermission(user, PERMISSIONS.CERTIFICATES_VIEW) ||
    hasPermission(user, PERMISSIONS.CERTIFICATES_ISSUE) ||
    hasPermission(user, PERMISSIONS.CERTIFICATES_MANAGE);
  const canIssue =
    hasPermission(user, PERMISSIONS.CERTIFICATES_ISSUE) ||
    hasPermission(user, PERMISSIONS.CERTIFICATES_MANAGE);

  const summaryPath = canView ? `/admin/academy-quizzes/${quiz.id}/certificates/summary` : null;
  const batchesPath = canView ? `/admin/academy-quizzes/${quiz.id}/certificates/batches` : null;

  const summaryRes = useApiResource<QuizCertificateSummaryDto>(summaryPath, () =>
    api.get<QuizCertificateSummaryDto>(summaryPath!),
  );
  const batchesRes = useApiResource<QuizCertificateBatchSummaryDto[]>(batchesPath, () =>
    api.get<QuizCertificateBatchSummaryDto[]>(batchesPath!),
  );

  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [inspectBatchId, setInspectBatchId] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<'overview' | 'batches' | 'issued'>('overview');

  const [issuedSearch, setIssuedSearch] = React.useState('');
  const [issuedCategory, setIssuedCategory] = React.useState('');
  const [downloadingKey, setDownloadingKey] = React.useState<string | null>(null);

  const issuedList = usePagedList<QuizIssuedCertificateItemDto>(
    canView && activeTab === 'issued'
      ? `/admin/academy-quizzes/${quiz.id}/certificates/issued`
      : null,
    {
      search: issuedSearch || undefined,
      category: issuedCategory || undefined,
    },
  );

  const refreshAll = React.useCallback(() => {
    summaryRes.reload();
    batchesRes.reload();
    issuedList.list.reload();
  }, [summaryRes, batchesRes, issuedList.list]);

  if (!canView) {
    return null;
  }

  const summary = summaryRes.data;
  const batches = batchesRes.data ?? [];
  const isCompleted = summary
    ? summary.isCompleted
    : quiz.phase === 'ENDED' || quiz.phase === 'CLOSED';
  const isPendingFinalization = (summary?.pendingFinalization ?? 0) > 0;
  const buttonDisabled = !isCompleted || isPendingFinalization || !canIssue;

  async function handleDownload(certId: string, certNumber: string, fmt: 'pdf' | 'png') {
    const key = `${certId}:${fmt}`;
    setDownloadingKey(key);
    try {
      const blob = await api.download(`/admin/certificates/${certId}/download/${fmt}`);
      triggerBlobDownload(blob, `ASRA-Certificate-${certNumber}.${fmt}`);
    } catch (err) {
      toast.error(`Download ${fmt.toUpperCase()} failed`, {
        description: errorMessage(err),
      });
    } finally {
      setDownloadingKey(null);
    }
  }

  return (
    <div id="issue-certificates">
      <section className="grid content-start gap-4 rounded-xl border bg-card p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <h2 className="type-h4 text-heading">Issue Certificates</h2>
            <p className="type-caption text-muted-foreground">
              Generate and issue certificates to students who participated in this quiz. You can
              also issue special certificates to leaderboard rankers.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {summary ? (
              <Badge variant={summary.isCompleted ? 'success' : 'warning'}>
                {summary.isCompleted ? <CheckCircle2 aria-hidden /> : <Clock aria-hidden />}
                {summary.completionStatusLabel}
              </Badge>
            ) : null}
            <Button
              type="button"
              disabled={buttonDisabled}
              title={
                !isCompleted
                  ? 'Certificates can only be issued after the quiz has completed.'
                  : isPendingFinalization
                    ? 'Expired attempts are still finalizing.'
                    : !canIssue
                      ? 'You do not have permission to issue certificates.'
                      : undefined
              }
              onClick={() => setWizardOpen(true)}
            >
              <Award aria-hidden />
              Issue Certificates
            </Button>
          </div>
        </div>
        {summaryRes.error && !summary ? (
          <ErrorPanel message={errorMessage(summaryRes.error)} onRetry={summaryRes.reload} />
        ) : !summary ? (
          <LoadingPanel label="Loading certificate summary…" rows={2} />
        ) : (
          <div className="grid gap-5">
            {!summary.isCompleted && (
              <Alert tone="info" title="Quiz has not completed yet">
                <p className="type-body-sm">
                  Certificate issuance is disabled while the quiz is{' '}
                  <strong>{summary.completionStatusLabel.toLowerCase()}</strong>. Once the quiz
                  reaches its end time or is closed, you can issue certificates to eligible
                  participants and rankers here.
                </p>
              </Alert>
            )}

            {summary.pendingFinalization > 0 && (
              <Alert tone="warning" title="Attempts still finalizing">
                <p className="type-body-sm">
                  {summary.pendingFinalization} expired attempt
                  {summary.pendingFinalization === 1 ? ' is' : 's are'} being finalized before
                  certificates can be issued.
                </p>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <SummaryKpi
                label="Eligible participants"
                value={summary.totalEligibleParticipants}
                hint="Submitted & evaluated attempts"
              />
              <SummaryKpi
                label="Eligible rankers"
                value={summary.totalEligibleRankers}
                hint="On finalized leaderboard"
              />
              <SummaryKpi
                label="Already issued"
                value={summary.alreadyIssuedCount}
                hint={`${summary.issuedParticipationCount} participation · ${summary.issuedRankCount} rank`}
              />
              <SummaryKpi
                label="Pending issuance"
                value={summary.pendingIssuanceCount}
                hint={
                  summary.inFlightCount > 0
                    ? `${summary.inFlightCount} currently processing`
                    : 'Not yet issued'
                }
              />
              <SummaryKpi
                label="Quiz status"
                value={summary.isCompleted ? 'Completed' : summary.phase}
                hint={summary.completionStatusLabel}
              />
            </div>

            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as 'overview' | 'batches' | 'issued')}
            >
              <TabsList>
                <TabsTrigger value="overview">Summary</TabsTrigger>
                <TabsTrigger value="batches">Issuance History ({batches.length})</TabsTrigger>
                <TabsTrigger value="issued">
                  Issued Certificates ({summary.alreadyIssuedCount})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="pt-3">
                {summary.latestBatch ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 p-4">
                    <div className="grid gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="type-label text-heading">
                          Latest run: {MODE_LABELS[summary.latestBatch.recipientMode]}
                        </span>
                        <BatchStatusBadge status={summary.latestBatch.status} />
                      </div>
                      <p className="type-caption text-muted-foreground">
                        {summary.latestBatch.generatedCount}/{summary.latestBatch.totalQueued}{' '}
                        generated · {summary.latestBatch.emailsSentCount} emails sent ·{' '}
                        {summary.latestBatch.excludedDuplicates} duplicates excluded ·{' '}
                        {formatDateTime(summary.latestBatch.createdAt)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setInspectBatchId(summary.latestBatch!.id)}
                    >
                      <Eye className="size-3.5" aria-hidden /> Inspect Progress
                    </Button>
                  </div>
                ) : (
                  <p className="type-body-sm text-muted-foreground">
                    No bulk certificate issuance has been run for this quiz yet.
                  </p>
                )}
              </TabsContent>

              <TabsContent value="batches" className="pt-3">
                {batches.length === 0 ? (
                  <p className="type-body-sm text-muted-foreground">
                    No issuance batches recorded yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border bg-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Started</TableHead>
                          <TableHead>Mode</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Generated</TableHead>
                          <TableHead className="text-right">Emails</TableHead>
                          <TableHead className="text-right">Excluded</TableHead>
                          <TableHead className="text-right">
                            <span className="sr-only">Inspect</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {batches.map((b) => (
                          <TableRow key={b.id}>
                            <TableCell className="type-body-sm whitespace-nowrap">
                              {formatDateTime(b.createdAt)}
                              {b.initiatedByName ? (
                                <span className="block type-caption text-muted-foreground">
                                  by {b.initiatedByName}
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell className="type-body-sm">
                              {MODE_LABELS[b.recipientMode]}
                              <span className="block type-caption text-muted-foreground">
                                {b.format}
                              </span>
                            </TableCell>
                            <TableCell>
                              <BatchStatusBadge status={b.status} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {b.generatedCount}/{b.totalQueued}
                              {b.generationFailedCount > 0 ? (
                                <span className="block type-caption text-destructive">
                                  {b.generationFailedCount} failed
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {b.sendEmail ? `${b.emailsSentCount}/${b.generatedCount}` : 'Off'}
                              {b.emailsFailedCount > 0 ? (
                                <span className="block type-caption text-destructive">
                                  {b.emailsFailedCount} failed
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {b.excludedDuplicates}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setInspectBatchId(b.id)}
                              >
                                <History className="size-3.5" aria-hidden />
                                Details
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="issued" className="grid gap-4 pt-3">
                <div className="flex flex-wrap items-end gap-3">
                  <FilterSelect
                    id="issued-cert-category"
                    label="Category"
                    value={issuedCategory}
                    onChange={setIssuedCategory}
                    options={CATEGORY_OPTIONS}
                  />
                  <SearchBox
                    id="issued-cert-search"
                    placeholder="Student name, email, or certificate ID"
                    onSearch={setIssuedSearch}
                  />
                </div>
                <ListFrame
                  list={issuedList.list}
                  setPage={issuedList.setPage}
                  label="certificates"
                  icon={<Award />}
                  emptyTitle="No issued certificates yet"
                  emptyText="Issued certificates for this quiz will appear here."
                >
                  {(items) => (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Recipient</TableHead>
                          <TableHead>Category / Rank</TableHead>
                          <TableHead>Certificate #</TableHead>
                          <TableHead>Template</TableHead>
                          <TableHead>Email</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((cert) => (
                          <TableRow key={cert.id}>
                            <TableCell>
                              <span className="type-label text-heading">{cert.recipientName}</span>
                              <span className="block type-caption text-muted-foreground">
                                {cert.studentEmail ?? '—'}
                              </span>
                            </TableCell>
                            <TableCell className="type-body-sm">
                              {cert.certificateCategory === 'RANK' && cert.quizRank ? (
                                <Badge variant="accent">
                                  <Trophy className="size-3" aria-hidden /> Rank #{cert.quizRank}
                                </Badge>
                              ) : (
                                <Badge variant="outline">Participation</Badge>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {cert.certificateNumber}
                            </TableCell>
                            <TableCell className="type-body-sm">
                              {cert.templateName ?? '—'}
                            </TableCell>
                            <TableCell className="type-body-sm">
                              {cert.emailStatus ? (
                                <Badge
                                  variant={
                                    cert.emailStatus === 'SENT'
                                      ? 'success'
                                      : cert.emailStatus === 'FAILED'
                                        ? 'destructive'
                                        : 'secondary'
                                  }
                                >
                                  {cert.emailStatus}
                                </Badge>
                              ) : (
                                '—'
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  title="Download PDF"
                                  disabled={downloadingKey === `${cert.id}:pdf`}
                                  onClick={() =>
                                    void handleDownload(cert.id, cert.certificateNumber, 'pdf')
                                  }
                                >
                                  <Download className="size-4" aria-hidden />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  title="Download PNG"
                                  disabled={downloadingKey === `${cert.id}:png`}
                                  onClick={() =>
                                    void handleDownload(cert.id, cert.certificateNumber, 'png')
                                  }
                                >
                                  <FileImage className="size-4" aria-hidden />
                                </Button>
                                <Button asChild size="icon-sm" variant="ghost" title="Verify">
                                  <Link href={`/verify/${cert.certificateNumber}`} target="_blank">
                                    <ExternalLink className="size-4" aria-hidden />
                                  </Link>
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </ListFrame>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </section>

      {wizardOpen && (
        <QuizCertificatesWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          quizId={quiz.id}
          quizTitle={quiz.title}
          canIssue={canIssue}
          onCompleted={refreshAll}
          onViewIssuedCertificates={() => setActiveTab('issued')}
        />
      )}

      <Dialog
        open={Boolean(inspectBatchId)}
        onOpenChange={(open) => !open && setInspectBatchId(null)}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Certificate Issuance Batch Details</DialogTitle>
            <DialogDescription>
              Track certificate generation, Resend email delivery, and retry any failed items.
            </DialogDescription>
          </DialogHeader>
          {inspectBatchId ? (
            <QuizCertificatesProgress
              quizId={quiz.id}
              batchId={inspectBatchId}
              canIssue={canIssue}
              onBatchUpdated={refreshAll}
              onViewIssuedCertificates={() => {
                setInspectBatchId(null);
                setActiveTab('issued');
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryKpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border bg-background p-3.5">
      <p className="type-caption text-muted-foreground">{label}</p>
      <p className="mt-1 type-h3 text-heading tabular-nums">{value}</p>
      <p className="mt-0.5 type-caption text-muted-foreground">{hint}</p>
    </div>
  );
}
