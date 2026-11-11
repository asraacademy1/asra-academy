'use client';

import { PERMISSIONS, type CertificateSignatureDto, type Paginated } from '@asra/types';
import { CERTIFICATE_SIGNATURE_LIMITS } from '@asra/validation';
import { CheckCircle2, EyeOff, PenTool, Plus, RefreshCw, ShieldAlert, Upload } from 'lucide-react';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Pagination } from '@/components/ui/pagination';
import { toast } from '@/components/ui/toast';
import { formatDate } from '@/lib/format';
import { FilterSelect, SearchBox, usePagedList } from '../admin-kit';
import { CheckboxField, ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, hasPermission, useAdminApi } from '../use-admin';
import { CertificatesHeader, signatureImageSrc } from './certificates-shell';

const DESIGNATION_SUGGESTIONS = [
  'Founder',
  'Director',
  'Academic Director',
  'Administrative Officer',
  'Head of Department',
  'Faculty',
  'Principal',
  'Course Instructor',
  'Examination Controller',
];

export function CertificatesSignaturesAdmin() {
  const { user } = useAuth();
  const api = useAdminApi();
  const canManage =
    hasPermission(user, PERMISSIONS.CERTIFICATES_SIGNATURES_MANAGE) ||
    hasPermission(user, PERMISSIONS.CERTIFICATES_MANAGE);

  const [search, setSearch] = React.useState('');
  const [isActiveFilter, setIsActiveFilter] = React.useState('');

  const { list, setPage } = usePagedList<CertificateSignatureDto>(
    '/admin/certificates/signatures',
    { search, isActive: isActiveFilter || undefined },
    18,
  );

  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CertificateSignatureDto | null>(null);
  const [fullName, setFullName] = React.useState('');
  const [designation, setDesignation] = React.useState('');
  const [department, setDepartment] = React.useState('');
  const [isActive, setIsActive] = React.useState(true);
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [fileDims, setFileDims] = React.useState<{ width: number; height: number } | null>(null);
  const [saving, setSaving] = React.useState(false);

  const openCreate = () => {
    setEditing(null);
    setFullName('');
    setDesignation('');
    setDepartment('');
    setIsActive(true);
    setSelectedFile(null);
    setPreviewUrl(null);
    setFileError(null);
    setFileDims(null);
    setModalOpen(true);
  };

  const openEdit = (sig: CertificateSignatureDto) => {
    setEditing(sig);
    setFullName(sig.fullName);
    setDesignation(sig.designation);
    setDepartment(sig.department ?? '');
    setIsActive(sig.isActive);
    setSelectedFile(null);
    setPreviewUrl(signatureImageSrc(sig));
    setFileError(null);
    setFileDims({ width: sig.width, height: sig.height });
    setModalOpen(true);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setFileError(null);
    if (!file) return;

    if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) {
      setFileError('Only transparent PNG files (.png) are supported.');
      setSelectedFile(null);
      return;
    }

    if (file.size > CERTIFICATE_SIGNATURE_LIMITS.maxFileBytes) {
      setFileError(
        `File is ${Math.ceil(file.size / 1024)} KB. Maximum allowed is ${CERTIFICATE_SIGNATURE_LIMITS.maxFileBytes / 1024} KB.`,
      );
      setSelectedFile(null);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (
        img.naturalWidth < CERTIFICATE_SIGNATURE_LIMITS.minWidth ||
        img.naturalHeight < CERTIFICATE_SIGNATURE_LIMITS.minHeight ||
        img.naturalWidth > CERTIFICATE_SIGNATURE_LIMITS.maxWidth ||
        img.naturalHeight > CERTIFICATE_SIGNATURE_LIMITS.maxHeight
      ) {
        setFileError(
          `Dimensions (${img.naturalWidth}×${img.naturalHeight}px) must be between ${CERTIFICATE_SIGNATURE_LIMITS.minWidth}×${CERTIFICATE_SIGNATURE_LIMITS.minHeight}px and ${CERTIFICATE_SIGNATURE_LIMITS.maxWidth}×${CERTIFICATE_SIGNATURE_LIMITS.maxHeight}px.`,
        );
        URL.revokeObjectURL(objectUrl);
        setSelectedFile(null);
        return;
      }
      setFileDims({ width: img.naturalWidth, height: img.naturalHeight });
      setSelectedFile(file);
      setPreviewUrl(objectUrl);
    };
    img.onerror = () => {
      setFileError('Could not decode PNG image.');
      URL.revokeObjectURL(objectUrl);
      setSelectedFile(null);
    };
    img.src = objectUrl;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing && !selectedFile) {
      setFileError('Select a transparent PNG signature image.');
      return;
    }
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append('fullName', fullName.trim());
      formData.append('designation', designation.trim());
      formData.append('department', department.trim());
      formData.append('isActive', String(isActive));
      if (selectedFile) {
        formData.append('file', selectedFile);
      }

      if (editing) {
        await api.patch(`/admin/certificates/signatures/${editing.id}`, formData);
        toast.success('Signature updated', {
          description: `${fullName.trim()} (${designation.trim()}) updated.`,
        });
      } else {
        await api.post('/admin/certificates/signatures', formData);
        toast.success('Signature added', {
          description: `${fullName.trim()} (${designation.trim()}) is now registered.`,
        });
      }
      setModalOpen(false);
      list.reload();
    } catch (err) {
      toast.error('Failed to save signature', { description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (sig: CertificateSignatureDto) => {
    try {
      await api.patch(`/admin/certificates/signatures/${sig.id}`, { isActive: !sig.isActive });
      toast.success(sig.isActive ? 'Signature deactivated' : 'Signature activated', {
        description: sig.isActive
          ? 'Previously issued certificates remain intact; inactive signatures cannot be newly selected.'
          : `${sig.fullName} is now available for selection.`,
      });
      list.reload();
    } catch (err) {
      toast.error('Status update failed', { description: errorMessage(err) });
    }
  };

  const data = list.data as Paginated<CertificateSignatureDto> | undefined;

  return (
    <>
      <CertificatesHeader
        title="Digital Signatures"
        description="Register authorized signatory PNG signatures with custom designations. Previously issued certificates preserve their original signature snapshot."
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus className="size-4" aria-hidden /> Add Signature
            </Button>
          ) : undefined
        }
      />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <SearchBox
          id="sig-search"
          placeholder="Search person, designation, or department…"
          onSearch={setSearch}
        />
        <FilterSelect
          id="sig-active"
          label="Status"
          value={isActiveFilter}
          onChange={setIsActiveFilter}
          options={[
            { value: 'true', label: 'Active' },
            { value: 'false', label: 'Inactive' },
          ]}
        />
      </div>

      {list.error && !data ? (
        <ErrorPanel
          title="Could not load signatures"
          message={errorMessage(list.error)}
          onRetry={list.reload}
        />
      ) : !data ? (
        <LoadingPanel label="Loading digital signatures…" rows={4} />
      ) : data.items.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="mx-auto grid max-w-md justify-items-center gap-3">
            <PenTool className="size-10 text-muted-foreground" />
            <h2 className="type-h3 text-heading">No digital signatures registered</h2>
            <p className="type-body-sm text-muted-foreground">
              Upload transparent PNG signatures for your Founder, Director, Faculty, or Examination
              Controller.
            </p>
            {canManage && (
              <Button onClick={openCreate}>
                <Plus className="size-4" /> Register First Signature
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.items.map((sig) => {
              const src = signatureImageSrc(sig);
              return (
                <Card key={sig.id} className="flex flex-col justify-between">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="truncate text-base">{sig.fullName}</CardTitle>
                        <p className="type-label text-primary">{sig.designation}</p>
                        {sig.department && (
                          <p className="type-caption text-muted-foreground">{sig.department}</p>
                        )}
                      </div>
                      <Badge variant={sig.isActive ? 'success' : 'secondary'}>
                        {sig.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <div className="flex h-28 items-center justify-center rounded-xl border bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:12px_12px] p-4">
                      {src ? (
                        // eslint-disable-next-line @next/next/no-img-element -- transparent PNG signature preview
                        <img
                          src={src}
                          alt={`${sig.fullName} signature`}
                          className="max-h-full max-w-full object-contain"
                          style={{
                            filter:
                              'drop-shadow(0 2px 6px rgba(1,33,20,0.16)) drop-shadow(0 0 6px rgba(255,255,255,0.8)) contrast(1.06)',
                          }}
                        />
                      ) : (
                        <span className="type-caption text-muted-foreground">
                          Preview unavailable
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        {sig.width}×{sig.height}px
                      </span>
                      <span>·</span>
                      <span>{Math.max(1, Math.round(sig.bytes / 1024))} KB</span>
                      <span>·</span>
                      <span>{sig.hasTransparency ? 'Transparent PNG' : 'Opaque PNG'}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Used in {sig.templateUsageCount ?? 0} templates</span>
                      <span>Added {formatDate(sig.createdAt)}</span>
                    </div>
                  </CardContent>
                  {canManage && (
                    <CardFooter className="flex items-center justify-between gap-2 border-t pt-3">
                      <Button size="sm" variant="outline" onClick={() => openEdit(sig)}>
                        <RefreshCw className="size-3.5" aria-hidden /> Edit / Replace
                      </Button>
                      <Button
                        size="sm"
                        variant={sig.isActive ? 'ghost' : 'secondary'}
                        onClick={() => void toggleActive(sig)}
                      >
                        {sig.isActive ? (
                          <>
                            <EyeOff className="size-3.5" aria-hidden /> Deactivate
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="size-3.5" aria-hidden /> Activate
                          </>
                        )}
                      </Button>
                    </CardFooter>
                  )}
                </Card>
              );
            })}
          </div>

          {data.pagination.pageCount > 1 && (
            <Pagination
              page={data.pagination.page}
              pageCount={data.pagination.pageCount}
              onPageChange={setPage}
              label="Signature pages"
            />
          )}
        </div>
      )}

      {/* Add / Edit Signature Dialog */}
      <Dialog open={modalOpen} onOpenChange={(open) => !saving && setModalOpen(open)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Edit / Replace Digital Signature' : 'Add Digital Signature'}
            </DialogTitle>
            <DialogDescription>
              Upload a transparent-background PNG signature. The original PNG is preserved
              untouched; visual glow and contrast are applied only during certificate rendering.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="grid gap-4">
            <Field id="sig-fullname" label="Person's Full Name">
              <Input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Dr. Tariq Al-Mansoor"
                maxLength={150}
                required
              />
            </Field>

            <div className="grid gap-2">
              <Field
                id="sig-designation"
                label="Official Designation / Title"
                hint="Enter any designation (quick picks below, or type your own)."
              >
                <Input
                  value={designation}
                  onChange={(e) => setDesignation(e.target.value)}
                  placeholder="e.g. Founder, Academic Director, Head of Department…"
                  maxLength={150}
                  required
                />
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {DESIGNATION_SUGGESTIONS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setDesignation(item)}
                    className="rounded-full border bg-muted/60 px-2.5 py-0.5 text-xs text-foreground transition-colors hover:bg-secondary"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            <Field id="sig-dept" label="Department" optional>
              <Input
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="e.g. Islamic Studies, Computer Science"
                maxLength={150}
              />
            </Field>

            <div className="grid gap-2">
              <Field
                id="sig-file"
                label={editing ? 'Replace Signature PNG (optional)' : 'Signature Image (PNG)'}
                hint={`Transparent PNG up to ${CERTIFICATE_SIGNATURE_LIMITS.maxFileBytes / 1024} KB (${CERTIFICATE_SIGNATURE_LIMITS.minWidth}×${CERTIFICATE_SIGNATURE_LIMITS.minHeight}px to ${CERTIFICATE_SIGNATURE_LIMITS.maxWidth}×${CERTIFICATE_SIGNATURE_LIMITS.maxHeight}px).`}
                error={fileError ?? undefined}
              >
                <Input
                  type="file"
                  accept="image/png"
                  onChange={handleFileChange}
                  className="cursor-pointer file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-xs file:font-semibold file:text-secondary-foreground"
                />
              </Field>

              {previewUrl && (
                <div className="grid gap-1.5 rounded-xl border bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:12px_12px] p-4 text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element -- signature preview before upload */}
                  <img
                    src={previewUrl}
                    alt="Signature preview"
                    className="mx-auto max-h-24 max-w-full object-contain"
                    style={{
                      filter:
                        'drop-shadow(0 2px 6px rgba(1,33,20,0.16)) drop-shadow(0 0 8px rgba(255,255,255,0.85)) contrast(1.06)',
                    }}
                  />
                  {fileDims && (
                    <span className="type-caption text-muted-foreground">
                      Preview · {fileDims.width}×{fileDims.height}px
                    </span>
                  )}
                </div>
              )}
            </div>

            <CheckboxField
              id="sig-active-toggle"
              label="Active (available for selection on templates and manual certificates)"
              checked={isActive}
              onChange={setIsActive}
            />

            {editing && (
              <Alert tone="info" title="Historical Integrity">
                <p className="flex items-start gap-2 text-xs">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  Replacing or deactivating this signature only affects future certificates. All
                  previously issued certificates retain their original signature snapshots.
                </p>
              </Alert>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setModalOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" loading={saving} loadingText="Saving signature…">
                <Upload className="size-4" aria-hidden />{' '}
                {editing ? 'Save Changes' : 'Upload Signature'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
