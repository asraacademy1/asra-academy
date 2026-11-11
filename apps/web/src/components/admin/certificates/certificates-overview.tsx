'use client';

import {
  PERMISSIONS,
  type AdminCertificateListItem,
  type CertificateOverviewStatsDto,
} from '@asra/types';
import {
  Award,
  BookOpen,
  CalendarDays,
  Download,
  ExternalLink,
  FileCheck2,
  FileImage,
  LayoutTemplate,
  PenTool,
  Plus,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { CertificateLifecycleBadge } from '@/components/certificates/certificate-preview';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { triggerBlobDownload } from '@/lib/certificates';
import { formatDate } from '@/lib/format';
import { KpiCard, Section } from '../admin-kit';
import { ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, hasPermission, useAdminApi, useApiResource } from '../use-admin';
import { CertificatesHeader, SourceTypeBadge } from './certificates-shell';

export function CertificatesOverview() {
  const { user } = useAuth();
  const api = useAdminApi();
  const canIssue =
    hasPermission(user, PERMISSIONS.CERTIFICATES_ISSUE) ||
    hasPermission(user, PERMISSIONS.CERTIFICATES_MANAGE);

  const { data, error, loading, reload } = useApiResource<CertificateOverviewStatsDto>(
    '/admin/certificates/overview',
    () => api.get<CertificateOverviewStatsDto>('/admin/certificates/overview'),
  );

  const [downloadingKey, setDownloadingKey] = React.useState<string | null>(null);

  const handleDownload = async (cert: AdminCertificateListItem, format: 'pdf' | 'png') => {
    const key = `${cert.id}:${format}`;
    try {
      setDownloadingKey(key);
      const blob = await api.download(`/admin/certificates/${cert.id}/download/${format}`);
      triggerBlobDownload(blob, `ASRA-Certificate-${cert.certificateNumber}.${format}`);
    } catch (err) {
      toast.error(`${format.toUpperCase()} download failed`, { description: errorMessage(err) });
    } finally {
      setDownloadingKey(null);
    }
  };

  return (
    <>
      <CertificatesHeader
        title="Certificate Management"
        description="Centralized platform credential hub for courses, Academy Quizzes, competitions, exams, events, and manual issuance."
        actions={
          canIssue ? (
            <Button asChild>
              <Link href="/admin/certificates/generate">
                <Plus className="size-4" aria-hidden /> Generate Certificate
              </Link>
            </Button>
          ) : undefined
        }
      />

      {loading && !data ? (
        <LoadingPanel label="Loading certificate overview…" rows={5} />
      ) : error && !data ? (
        <ErrorPanel
          title="Could not load certificate overview"
          message={errorMessage(error)}
          onRetry={reload}
        />
      ) : data ? (
        <div className="grid gap-6">
          {/* Primary KPIs */}
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              title="Total Certificates Issued"
              value={data.totalIssued}
              hint={`${data.totalRevoked} revoked`}
              icon={<Award />}
              href="/admin/certificates/issued"
            />
            <KpiCard
              title="Issued This Month"
              value={data.issuedThisMonth}
              hint="Current calendar month (UTC)"
              icon={<CalendarDays />}
              href="/admin/certificates/issued"
            />
            <KpiCard
              title="Active Templates"
              value={data.activeTemplates}
              hint="Classic, Modern & Premium PDF layouts"
              icon={<LayoutTemplate />}
              href="/admin/certificates/templates"
            />
            <KpiCard
              title="Registered Signatures"
              value={data.totalSignatures}
              hint={`${data.activeSignatures} active for selection`}
              icon={<PenTool />}
              href="/admin/certificates/signatures"
            />
          </dl>

          {/* Module Breakdown KPIs */}
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard
              title="Issued by Courses"
              value={data.coursesCount}
              hint="Course completion credentials"
              icon={<BookOpen />}
              href="/admin/certificates/issued?sourceType=COURSE"
            />
            <KpiCard
              title="Issued by Academy Quizzes"
              value={data.academyQuizzesCount}
              hint="Quiz achievement credentials"
              icon={<FileCheck2 />}
              href="/admin/certificates/issued?sourceType=ACADEMY_QUIZ"
            />
            <KpiCard
              title="Issued by Competitions"
              value={data.competitionsCount}
              hint="Competition & distinction awards"
              icon={<Trophy />}
              href="/admin/certificates/issued?sourceType=COMPETITION"
            />
          </dl>

          {/* All Source Breakdown */}
          {data.bySource.length > 0 && (
            <Section
              title="Issuance by Source Module"
              description="Distribution across all ASRA Academy credential sources."
              href="/admin/certificates/issued"
              hrefLabel="Browse all issued"
            >
              <div className="flex flex-wrap gap-3">
                {data.bySource.map((entry) => (
                  <div
                    key={entry.sourceType}
                    className="flex items-center gap-2 rounded-xl border bg-background/60 px-3.5 py-2"
                  >
                    <SourceTypeBadge sourceType={entry.sourceType} />
                    <span className="font-semibold text-heading tabular-nums">{entry.count}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Recently Generated Certificates */}
          <Section
            title="Recently Generated Certificates"
            description="Latest credentials issued across the academy."
            href="/admin/certificates/issued"
            hrefLabel="View all certificates"
          >
            {data.recentCertificates.length === 0 ? (
              <p className="type-body-sm text-muted-foreground">
                No certificates have been issued yet.
              </p>
            ) : (
              <Table scrollLabel="Recently generated certificates">
                <TableHeader>
                  <TableRow>
                    <TableHead>Certificate ID</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Source & Achievement</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentCertificates.map((cert) => (
                    <TableRow key={cert.id}>
                      <TableCell className="font-mono text-xs font-semibold text-heading">
                        {cert.certificateNumber}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-heading">{cert.recipientName}</div>
                        <div className="type-caption text-muted-foreground">
                          {cert.studentEmail ?? 'External recipient'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <SourceTypeBadge
                            sourceType={cert.sourceType}
                            sourceLabel={cert.sourceLabel}
                          />
                          <span className="line-clamp-1 font-medium text-heading">
                            {cert.courseTitle}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="type-caption text-muted-foreground">
                        {formatDate(cert.issuedAt)}
                      </TableCell>
                      <TableCell>
                        <CertificateLifecycleBadge
                          status={cert.status}
                          lifecycleStatus={cert.lifecycleStatus}
                          reason={cert.revokedReason}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={downloadingKey === `${cert.id}:png`}
                            onClick={() => void handleDownload(cert, 'png')}
                            aria-label={`Download PNG for ${cert.certificateNumber}`}
                            title="Download PNG"
                          >
                            <FileImage className="size-4" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={downloadingKey === `${cert.id}:pdf`}
                            onClick={() => void handleDownload(cert, 'pdf')}
                            aria-label={`Download PDF for ${cert.certificateNumber}`}
                            title="Download PDF"
                          >
                            <Download className="size-4" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            asChild
                            title="Open verification page"
                          >
                            <Link
                              href={`/verify/${cert.certificateNumber}`}
                              target="_blank"
                              aria-label={`Verify ${cert.certificateNumber}`}
                            >
                              <ExternalLink className="size-4" />
                            </Link>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </div>
      ) : null}
    </>
  );
}
