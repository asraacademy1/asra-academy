'use client';

import type {
  AdminAcademyParticipantItem,
  AdminAcademyParticipantsPage,
  ParticipantSort,
  ParticipantVerificationFilter,
} from '@asra/types';
import { Download, Users } from 'lucide-react';
import * as React from 'react';

import { EmptyState } from '@/components/public/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
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
import { formatDateTime } from '@/lib/format';

import { SearchBox, Section } from '../admin-kit';
import { ErrorPanel, LoadingPanel, SelectField } from '../admin-ui';
import { errorMessage, useAdminApi, useApiResource } from '../use-admin';

const SORT_OPTIONS: { value: ParticipantSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

const VERIFICATION_OPTIONS: { value: ParticipantVerificationFilter; label: string }[] = [
  { value: 'ALL', label: 'All accounts' },
  { value: 'VERIFIED', label: 'Verified only' },
  { value: 'UNVERIFIED', label: 'Unverified only' },
];

const PAGE_SIZE_OPTIONS = [
  { value: '10', label: '10 per page' },
  { value: '20', label: '20 per page' },
  { value: '50', label: '50 per page' },
];

export interface ParticipantsFilterParams {
  page: number;
  limit: number;
  search: string;
  sort: ParticipantSort;
  verificationStatus: ParticipantVerificationFilter;
}

export function participantsQueryString(params: ParticipantsFilterParams): string {
  const sp = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
    sort: params.sort,
    verificationStatus: params.verificationStatus,
  });
  if (params.search) sp.set('search', params.search);
  return sp.toString();
}

export function participantsExportPath(
  quizId: string,
  params: Pick<ParticipantsFilterParams, 'search' | 'sort' | 'verificationStatus'>,
): string {
  const sp = new URLSearchParams({
    sort: params.sort,
    verificationStatus: params.verificationStatus,
  });
  if (params.search) sp.set('search', params.search);
  return `/admin/academy-quizzes/${encodeURIComponent(quizId)}/participants/export?${sp.toString()}`;
}

export function AcademyParticipantsSection({
  quizId,
  quizSlug,
  timeZone,
}: {
  quizId: string;
  quizSlug: string;
  timeZone?: string;
}) {
  const api = useAdminApi();
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState<ParticipantSort>('newest');
  const [verificationStatus, setVerificationStatus] =
    React.useState<ParticipantVerificationFilter>('ALL');
  const [limit, setLimit] = React.useState(20);
  const [page, setPage] = React.useState(1);
  const [exporting, setExporting] = React.useState(false);

  const query = participantsQueryString({ page, limit, search, sort, verificationStatus });
  const path = `/admin/academy-quizzes/${encodeURIComponent(quizId)}/participants?${query}`;
  const resource = useApiResource(path, () => api.get<AdminAcademyParticipantsPage>(path));

  const data = resource.data;
  const totalRegistered = data?.totalRegistered ?? 0;
  const filteredTotal = data?.total ?? 0;
  const hasFilters = Boolean(search) || verificationStatus !== 'ALL';

  function updateSearch(next: string) {
    setSearch(next);
    setPage(1);
  }

  function clearFilters() {
    setSearch('');
    setVerificationStatus('ALL');
    setPage(1);
  }

  async function handleExport() {
    if (exporting || filteredTotal === 0) return;
    setExporting(true);
    try {
      const exportUrl = participantsExportPath(quizId, { search, sort, verificationStatus });
      const blob = await api.download(exportUrl);
      const safeSlug =
        quizSlug
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'quiz';
      triggerBlobDownload(blob, `participants-${safeSlug}.csv`);
      toast.success('Participants exported');
    } catch (error) {
      toast.error('Could not export participants', { description: errorMessage(error) });
    } finally {
      setExporting(false);
    }
  }

  const startIndex = filteredTotal === 0 ? 0 : (page - 1) * limit + 1;
  const endIndex = Math.min(filteredTotal, (page - 1) * limit + (data?.items.length ?? 0));

  return (
    <Section
      title="Participants"
      description="Registered student accounts for this quiz (tracked from registrations, independent of quiz attempts)."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="tabular-nums">
            {totalRegistered} registered student{totalRegistered === 1 ? '' : 's'}
          </Badge>
          {data && hasFilters ? (
            <span className="type-caption text-muted-foreground tabular-nums">
              Showing {filteredTotal} matching filter{filteredTotal === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={exporting}
          loadingText="Exporting…"
          disabled={!data || filteredTotal === 0}
          onClick={() => void handleExport()}
        >
          <Download aria-hidden /> Export Participants
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <SearchBox
          id="participants-search"
          placeholder="Search student name or email"
          onSearch={updateSearch}
          label="Search participants"
        />
        <div className="w-44">
          <SelectField
            id="participants-sort"
            label="Sort by"
            value={sort}
            onValueChange={(next) => {
              setSort(next as ParticipantSort);
              setPage(1);
            }}
            options={SORT_OPTIONS}
          />
        </div>
        <div className="w-44">
          <SelectField
            id="participants-verification"
            label="Verification"
            value={verificationStatus}
            onValueChange={(next) => {
              setVerificationStatus(next as ParticipantVerificationFilter);
              setPage(1);
            }}
            options={VERIFICATION_OPTIONS}
          />
        </div>
        <div className="w-36">
          <SelectField
            id="participants-limit"
            label="Rows"
            value={String(limit)}
            onValueChange={(next) => {
              setLimit(Number(next));
              setPage(1);
            }}
            options={PAGE_SIZE_OPTIONS}
          />
        </div>
      </div>

      {resource.error && !data ? (
        <ErrorPanel message={errorMessage(resource.error)} onRetry={resource.reload} />
      ) : !data ? (
        <LoadingPanel rows={4} label="Loading participants…" />
      ) : data.totalRegistered === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No students have registered for this quiz yet."
          description="Registered students appear here as soon as they confirm registration, even before starting an attempt."
        />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No participants match these filters"
          description="Try a different search query or reset the verification filter."
          action={
            <Button type="button" variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4" aria-busy={resource.loading || undefined}>
          <ParticipantsTable
            items={data.items}
            page={data.page}
            limit={data.limit}
            timeZone={timeZone}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="type-caption text-muted-foreground tabular-nums">
              Showing {startIndex}–{endIndex} of {data.total} participant
              {data.total === 1 ? '' : 's'}
            </p>
            {data.totalPages > 1 ? (
              <Pagination
                page={data.page}
                pageCount={data.totalPages}
                onPageChange={setPage}
                label="participants pages"
              />
            ) : null}
          </div>
        </div>
      )}
    </Section>
  );
}

export function ParticipantsTable({
  items,
  page,
  limit,
  timeZone = 'Asia/Kolkata',
}: {
  items: readonly AdminAcademyParticipantItem[];
  page: number;
  limit: number;
  timeZone?: string;
}) {
  return (
    <Table scrollLabel="Quiz participants">
      <TableHeader>
        <TableRow>
          <TableHead className="w-14">#</TableHead>
          <TableHead>Student Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Phone</TableHead>
          <TableHead>Registration Date</TableHead>
          <TableHead>Verification</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item, index) => {
          const serial = (page - 1) * limit + index + 1;
          const dateLabel = formatDateTime(item.registeredAt, timeZone);
          return (
            <TableRow key={item.id}>
              <TableCell className="text-muted-foreground tabular-nums">{serial}</TableCell>
              <TableCell className="type-label text-heading">{item.studentName}</TableCell>
              <TableCell className="type-body-sm text-foreground">{item.email}</TableCell>
              <TableCell className="type-body-sm whitespace-nowrap text-muted-foreground">
                {item.phone ?? '—'}
              </TableCell>
              <TableCell className="type-body-sm whitespace-nowrap">
                {dateLabel ? `${dateLabel} IST` : '—'}
              </TableCell>
              <TableCell>
                <Badge variant={item.emailVerified ? 'success' : 'warning'}>
                  {item.emailVerified ? 'Verified' : 'Unverified'}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant="info">Registered</Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
