'use client';

import {
  CERTIFICATE_SOURCE_TYPES,
  type CertificateDto,
  type CertificateSourceType,
  type Paginated,
  type StudentFeatures,
} from '@asra/types';
import { SOURCE_TYPE_LABELS } from '@asra/validation';
import { Award, Download, ExternalLink, Eye, FileImage, Search, Trophy, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  CertificateLifecycleBadge,
  CertificatePreview,
  CertificateSourceBadge,
  certificateToPreviewProps,
  resolveEffectiveStatus,
} from '@/components/certificates/certificate-preview';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/public/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { triggerBlobDownload } from '@/lib/certificates';
import { formatDate } from '@/lib/format';

import { ErrorPanel, ListPager, LoadingPanel } from './student-ui';
import { errorMessage, useApiResource, useStudentApi, withPage } from './use-student';

const home = { label: 'Dashboard', href: '/student/dashboard' };

/** Upgraded multi-source Student Certificate Gallery (`/student/certificates`). */
export function StudentCertificatesGallery() {
  const api = useStudentApi();
  const features = useApiResource('/student/features', () =>
    api.get<StudentFeatures>('/student/features'),
  );

  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [sourceType, setSourceType] = React.useState<CertificateSourceType | ''>('');
  const [downloadingKey, setDownloadingKey] = React.useState<string | null>(null);
  const [previewCert, setPreviewCert] = React.useState<CertificateDto | null>(null);

  const url = withPage('/student/certificates', page, {
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(sourceType ? { sourceType } : {}),
  });
  const list = useApiResource(url, () => api.get<Paginated<CertificateDto>>(url));

  const handleDownload = async (cert: CertificateDto, format: 'pdf' | 'png') => {
    const key = `${cert.id}:${format}`;
    try {
      setDownloadingKey(key);
      const endpoint =
        format === 'png'
          ? `/api/v1/student/certificates/${cert.id}/download/png`
          : `/api/v1/student/certificates/${cert.id}/download/pdf`;
      const blob = await api.download(endpoint);
      triggerBlobDownload(blob, `ASRA-Certificate-${cert.certificateNumber}.${format}`);
    } catch (err) {
      toast.error(`Certificate ${format.toUpperCase()} download failed`, {
        description: errorMessage(err),
      });
    } finally {
      setDownloadingKey(null);
    }
  };

  const hasFilters = Boolean(search.trim() || sourceType);

  return (
    <>
      <PageHeader
        title="Certificates"
        breadcrumbs={[home, { label: 'Certificates' }]}
        description={
          features.data?.certificates.message ??
          'Official verifiable credentials earned across courses, academy quizzes, competitions, examinations, and events.'
        }
      />

      <Card className="mb-6 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by credential title, program, or certificate ID…"
            aria-label="Search certificates"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter by source category"
            value={sourceType}
            onChange={(e) => {
              setSourceType(e.target.value as CertificateSourceType | '');
              setPage(1);
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs focus:ring-2 focus:ring-ring focus:outline-none"
          >
            <option value="">All Categories</option>
            {CERTIFICATE_SOURCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {SOURCE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          {hasFilters && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setSourceType('');
                setPage(1);
              }}
            >
              <X className="size-4" />
              Clear
            </Button>
          )}
        </div>
      </Card>

      {list.error && !list.data ? (
        <ErrorPanel message={errorMessage(list.error)} onRetry={list.reload} />
      ) : !list.data ? (
        <LoadingPanel label="Loading certificates…" />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          icon={<Award />}
          title={hasFilters ? 'No matching certificates' : 'No certificates earned yet'}
          description={
            hasFilters
              ? 'Try clearing your search or category filter to view all earned credentials.'
              : 'Complete enrolled courses, top academy quizzes, competitions, or accredited workshops to unlock official verifiable certificates here.'
          }
        />
      ) : (
        <div className="grid gap-6">
          <ul className="grid gap-4">
            {list.data.items.map((item) => {
              const effectiveStatus = resolveEffectiveStatus(item);
              const isIssued = effectiveStatus === 'ISSUED';
              return (
                <li key={item.id}>
                  <Card className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <CertificateSourceBadge
                          sourceType={item.sourceType}
                          sourceLabel={item.sourceLabel}
                        />
                        {isIssued ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-300 bg-emerald-50 font-medium text-emerald-700"
                          >
                            Verified Credential
                          </Badge>
                        ) : (
                          <CertificateLifecycleBadge
                            status={item.status}
                            lifecycleStatus={item.lifecycleStatus}
                            reason={item.revokedReason}
                          />
                        )}
                      </div>

                      <div>
                        <p className="type-caption font-semibold tracking-wider text-muted-foreground uppercase">
                          {item.certificateTitle}
                        </p>
                        <h2 className="type-h4 font-semibold text-heading">{item.courseTitle}</h2>
                      </div>

                      {item.achievementDetails && (
                        <p className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-1 text-xs font-medium text-amber-900">
                          <Trophy className="size-3.5 text-amber-700" />
                          {item.achievementDetails}
                        </p>
                      )}

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        <span>Achieved: {formatDate(item.completedAt)}</span>
                        <span>Issued: {formatDate(item.issuedAt)}</span>
                        <span className="flex items-center gap-1 rounded border bg-muted px-2 py-0.5 font-mono text-xs">
                          ID: {item.certificateNumber}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-2 md:pt-0">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setPreviewCert(item)}
                      >
                        <Eye className="size-4" />
                        Preview
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={downloadingKey === `${item.id}:png`}
                        onClick={() => void handleDownload(item, 'png')}
                      >
                        <FileImage className="size-4" />
                        {downloadingKey === `${item.id}:png` ? 'Rendering...' : 'Download PNG'}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={downloadingKey === `${item.id}:pdf`}
                        onClick={() => void handleDownload(item, 'pdf')}
                      >
                        <Download className="size-4" />
                        {downloadingKey === `${item.id}:pdf` ? 'Rendering...' : 'Download PDF'}
                      </Button>
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/verify/${item.certificateNumber}`} target="_blank">
                          <ExternalLink className="size-4" />
                          Verify
                        </Link>
                      </Button>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
          <ListPager
            pagination={list.data.pagination}
            onPageChange={setPage}
            label="certificate pages"
          />
        </div>
      )}

      <Dialog open={Boolean(previewCert)} onOpenChange={(open) => !open && setPreviewCert(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Official Credential · {previewCert?.certificateNumber}</DialogTitle>
            <DialogDescription>
              Verified digital certificate rendered dynamically from the exact template and
              signatories recorded at issuance.
            </DialogDescription>
          </DialogHeader>
          {previewCert && (
            <div className="grid gap-4">
              <CertificatePreview {...certificateToPreviewProps(previewCert)} />
              <DialogFooter>
                <Button variant="outline" asChild>
                  <Link href={`/verify/${previewCert.certificateNumber}`} target="_blank">
                    <ExternalLink className="size-4" /> Public Verification Link
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  disabled={downloadingKey === `${previewCert.id}:png`}
                  onClick={() => void handleDownload(previewCert, 'png')}
                >
                  <FileImage className="size-4" />
                  {downloadingKey === `${previewCert.id}:png` ? 'Rendering...' : 'Download PNG'}
                </Button>
                <Button
                  disabled={downloadingKey === `${previewCert.id}:pdf`}
                  onClick={() => void handleDownload(previewCert, 'pdf')}
                >
                  <Download className="size-4" />
                  {downloadingKey === `${previewCert.id}:pdf`
                    ? 'Rendering...'
                    : 'Download Official PDF'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
