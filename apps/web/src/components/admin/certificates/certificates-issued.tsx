'use client';

import {
  CERTIFICATE_SOURCE_TYPES,
  PERMISSIONS,
  type AdminCertificateListItem,
  type CertificateDto,
} from '@asra/types';
import { SOURCE_TYPE_LABELS } from '@asra/validation';
import { Award, Download, ExternalLink, Eye, FileImage, RotateCcw, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import {
  CertificateLifecycleBadge,
  CertificatePreview,
  certificateToPreviewProps,
} from '@/components/certificates/certificate-preview';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { triggerBlobDownload } from '@/lib/certificates';
import { formatDate } from '@/lib/format';
import { FilterSelect, ListFrame, SearchBox, usePagedList } from '../admin-kit';
import { hasPermission, errorMessage, useAdminApi } from '../use-admin';
import { CertificatesHeader, SourceTypeBadge } from './certificates-shell';

const SOURCE_OPTIONS = CERTIFICATE_SOURCE_TYPES.map((s) => ({
  value: s,
  label: SOURCE_TYPE_LABELS[s],
}));

export function CertificatesIssuedAdmin() {
  const searchParams = useSearchParams();
  const initialSource = searchParams.get('sourceType') ?? '';
  const { user } = useAuth();
  const api = useAdminApi();

  const canRevoke =
    hasPermission(user, PERMISSIONS.CERTIFICATES_REVOKE) ||
    hasPermission(user, PERMISSIONS.CERTIFICATES_MANAGE);
  const canIssue =
    hasPermission(user, PERMISSIONS.CERTIFICATES_ISSUE) ||
    hasPermission(user, PERMISSIONS.CERTIFICATES_MANAGE);

  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [sourceType, setSourceType] = React.useState(initialSource);
  const [downloadingKey, setDownloadingKey] = React.useState<string | null>(null);

  const [previewCert, setPreviewCert] = React.useState<AdminCertificateListItem | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<AdminCertificateListItem | null>(null);
  const [revokeReason, setRevokeReason] = React.useState('');
  const [revoking, setRevoking] = React.useState(false);

  const [reissueTarget, setReissueTarget] = React.useState<AdminCertificateListItem | null>(null);
  const [reissueReason, setReissueReason] = React.useState('');
  const [reissuing, setReissuing] = React.useState(false);

  const { list, setPage } = usePagedList<AdminCertificateListItem>('/admin/certificates', {
    search,
    status,
    sourceType,
  });

  const handleDownload = async (cert: AdminCertificateListItem, format: 'pdf' | 'png') => {
    const key = `${cert.id}:${format}`;
    try {
      setDownloadingKey(key);
      const blob = await api.download(`/api/v1/admin/certificates/${cert.id}/download/${format}`);
      triggerBlobDownload(blob, `ASRA-Certificate-${cert.certificateNumber}.${format}`);
    } catch (err) {
      toast.error(`${format.toUpperCase()} download failed`, { description: errorMessage(err) });
    } finally {
      setDownloadingKey(null);
    }
  };

  const openPreview = async (cert: AdminCertificateListItem) => {
    setPreviewCert(cert);
    try {
      const detail = await api.get<AdminCertificateListItem>(`/admin/certificates/${cert.id}`);
      setPreviewCert(detail);
    } catch {
      // Keep list row preview on transient fetch error
    }
  };

  const handleRevokeConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!revokeTarget) return;
    const trimmed = revokeReason.trim();
    if (trimmed.length < 3) {
      toast.error('Reason required', {
        description: 'Enter a revocation reason of at least 3 characters.',
      });
      return;
    }
    setRevoking(true);
    try {
      await api.post(`/admin/certificates/${revokeTarget.id}/revoke`, { reason: trimmed });
      toast.success('Certificate revoked', {
        description: `${revokeTarget.certificateNumber} is now marked REVOKED.`,
      });
      setRevokeTarget(null);
      setRevokeReason('');
      list.reload();
    } catch (err) {
      toast.error('Revocation failed', { description: errorMessage(err) });
    } finally {
      setRevoking(false);
    }
  };

  const handleReissueConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reissueTarget) return;
    const trimmed = reissueReason.trim();
    if (trimmed.length < 3) {
      toast.error('Reason required', {
        description: 'Enter a reissue reason of at least 3 characters.',
      });
      return;
    }
    setReissuing(true);
    try {
      const created = await api.post<CertificateDto>(
        `/admin/certificates/${reissueTarget.id}/reissue`,
        { reason: trimmed },
      );
      toast.success('Certificate reissued', {
        description: `New credential ${created.certificateNumber} issued.`,
      });
      setReissueTarget(null);
      setReissueReason('');
      list.reload();
    } catch (err) {
      toast.error('Reissue failed', { description: errorMessage(err) });
    } finally {
      setReissuing(false);
    }
  };

  return (
    <>
      <CertificatesHeader
        title="Issued Certificates"
        description="Search, inspect, download, reissue, and revoke credentials across all platform sources."
      />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <SearchBox
          id="cert-search"
          placeholder="Certificate ID, recipient, email, student ID, or title…"
          onSearch={setSearch}
        />
        <FilterSelect
          id="cert-source"
          label="Source"
          value={sourceType}
          onChange={setSourceType}
          options={SOURCE_OPTIONS}
        />
        <FilterSelect
          id="cert-status"
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'ISSUED', label: 'Issued' },
            { value: 'REVOKED', label: 'Revoked' },
          ]}
        />
      </div>

      <ListFrame list={list} setPage={setPage} label="certificates" icon={<Award />}>
        {(items: AdminCertificateListItem[]) => (
          <Table scrollLabel="Issued certificates">
            <TableHeader>
              <TableRow>
                <TableHead>Certificate ID</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Source & Title</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const isIssued = item.status === 'ISSUED';
                return (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs font-semibold text-heading">
                      <div>{item.certificateNumber}</div>
                      {item.templateName && (
                        <div className="font-sans font-normal text-muted-foreground">
                          {item.templateName}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-heading">{item.recipientName}</div>
                      <div className="type-caption text-muted-foreground">
                        {item.studentEmail ?? 'No email'}
                        {item.recipientStudentCode ? ` · ${item.recipientStudentCode}` : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <SourceTypeBadge
                          sourceType={item.sourceType}
                          sourceLabel={item.sourceLabel}
                        />
                        {item.reissuedFromId && <Badge variant="secondary">Reissued</Badge>}
                      </div>
                      <div className="line-clamp-1 font-medium text-heading">
                        {item.courseTitle}
                      </div>
                      <div className="type-caption text-muted-foreground">
                        Issuer: {item.issuedByName ?? 'Platform Engine'}
                      </div>
                    </TableCell>
                    <TableCell className="space-y-0.5 text-xs">
                      <div>Completed: {formatDate(item.completedAt)}</div>
                      <div className="text-muted-foreground">
                        Issued: {formatDate(item.issuedAt)}
                      </div>
                      {item.revokedAt && (
                        <div className="font-medium text-destructive">
                          Revoked: {formatDate(item.revokedAt)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <CertificateLifecycleBadge
                        status={item.status}
                        lifecycleStatus={item.lifecycleStatus}
                        reason={item.revokedReason}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => void openPreview(item)}
                          title="Preview Certificate"
                          aria-label={`Preview ${item.certificateNumber}`}
                        >
                          <Eye className="size-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={downloadingKey === `${item.id}:png`}
                          onClick={() => void handleDownload(item, 'png')}
                          title="Download PNG"
                          aria-label={`Download PNG ${item.certificateNumber}`}
                        >
                          <FileImage className="size-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={downloadingKey === `${item.id}:pdf`}
                          onClick={() => void handleDownload(item, 'pdf')}
                          title="Download PDF"
                          aria-label={`Download PDF ${item.certificateNumber}`}
                        >
                          <Download className="size-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          asChild
                          title="Public Verification Link"
                        >
                          <Link
                            href={`/verify/${item.certificateNumber}`}
                            target="_blank"
                            aria-label={`Verify ${item.certificateNumber}`}
                          >
                            <ExternalLink className="size-4" />
                          </Link>
                        </Button>
                        {canIssue && (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => {
                              setReissueTarget(item);
                              setReissueReason('');
                            }}
                            title="Reissue Certificate"
                            aria-label={`Reissue ${item.certificateNumber}`}
                          >
                            <RotateCcw className="size-4" />
                          </Button>
                        )}
                        {isIssued && canRevoke && (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-destructive hover:bg-destructive/10"
                            onClick={() => {
                              setRevokeTarget(item);
                              setRevokeReason('');
                            }}
                            title="Revoke Certificate"
                            aria-label={`Revoke ${item.certificateNumber}`}
                          >
                            <XCircle className="size-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </ListFrame>

      {/* Live Preview Modal */}
      <Dialog open={Boolean(previewCert)} onOpenChange={(open) => !open && setPreviewCert(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Certificate Snapshot · {previewCert?.certificateNumber}</DialogTitle>
            <DialogDescription>
              Dynamically rendered preview from the template, signature snapshots, and live validity
              status recorded in PostgreSQL.
            </DialogDescription>
          </DialogHeader>
          {previewCert && (
            <div className="grid gap-4">
              <CertificatePreview {...certificateToPreviewProps(previewCert)} />
              <DialogFooter>
                <Button variant="outline" asChild>
                  <Link href={`/verify/${previewCert.certificateNumber}`} target="_blank">
                    <ExternalLink className="size-4" /> Open Verification Page
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  disabled={downloadingKey === `${previewCert.id}:png`}
                  onClick={() => void handleDownload(previewCert, 'png')}
                >
                  <FileImage className="size-4" />
                  {downloadingKey === `${previewCert.id}:png` ? 'Rendering…' : 'Download PNG'}
                </Button>
                <Button
                  disabled={downloadingKey === `${previewCert.id}:pdf`}
                  onClick={() => void handleDownload(previewCert, 'pdf')}
                >
                  <Download className="size-4" />
                  {downloadingKey === `${previewCert.id}:pdf` ? 'Rendering…' : 'Download PDF'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke Certificate Modal */}
      <Dialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => !revoking && !open && setRevokeTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke Certificate</DialogTitle>
            <DialogDescription>
              Revoking{' '}
              <span className="font-mono font-semibold">{revokeTarget?.certificateNumber}</span>{' '}
              immediately invalidates it on public verification pages and writes an audit record.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRevokeConfirm} className="grid gap-4">
            <Field id="revoke-reason" label="Mandatory Revocation Reason">
              <Textarea
                rows={3}
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                placeholder="Explain why this credential is being revoked…"
                minLength={3}
                maxLength={500}
                required
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRevokeTarget(null)}
                disabled={revoking}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                loading={revoking}
                loadingText="Revoking…"
              >
                Confirm Revocation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Reissue Certificate Modal */}
      <Dialog
        open={Boolean(reissueTarget)}
        onOpenChange={(open) => !reissuing && !open && setReissueTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reissue Certificate</DialogTitle>
            <DialogDescription>
              Creates a new active credential linked to{' '}
              <span className="font-mono font-semibold">{reissueTarget?.certificateNumber}</span>.
              If the prior certificate is active, it will be superseded cleanly.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleReissueConfirm} className="grid gap-4">
            <Field id="reissue-reason" label="Reason for Reissue">
              <Textarea
                rows={3}
                value={reissueReason}
                onChange={(e) => setReissueReason(e.target.value)}
                placeholder="e.g. Updated signatory list / name spelling correction…"
                minLength={3}
                maxLength={500}
                required
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setReissueTarget(null)}
                disabled={reissuing}
              >
                Cancel
              </Button>
              <Button type="submit" loading={reissuing} loadingText="Reissuing…">
                Confirm Reissue
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
