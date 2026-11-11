'use client';

import {
  PERMISSIONS,
  type CertificateAuditLogItemDto,
  type CertificateSettingsDto,
  type CertificateTemplateDto,
} from '@asra/types';
import { ExternalLink, Save, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { FilterSelect, ListFrame, usePagedList } from '../admin-kit';
import { CheckboxField, ErrorPanel, LoadingPanel, SelectField } from '../admin-ui';
import { errorMessage, hasPermission, useAdminApi, useApiResource } from '../use-admin';
import { CertificatesHeader } from './certificates-shell';

export function CertificatesSettingsAdmin() {
  const { user } = useAuth();
  const api = useAdminApi();
  const canManageGlobal = hasPermission(user, PERMISSIONS.CERTIFICATES_MANAGE);

  const settingsRes = useApiResource<CertificateSettingsDto>('/admin/certificates/settings', () =>
    api.get<CertificateSettingsDto>('/admin/certificates/settings'),
  );
  const templatesRes = useApiResource<CertificateTemplateDto[]>(
    '/admin/certificates/templates',
    () => api.get<CertificateTemplateDto[]>('/admin/certificates/templates'),
  );

  const [entityTypeFilter, setEntityTypeFilter] = React.useState('');
  const auditList = usePagedList<CertificateAuditLogItemDto>('/admin/certificates/audit-logs', {
    entityType: entityTypeFilter || undefined,
  });

  const [draft, setDraft] = React.useState<
    Partial<{
      academyName: string;
      academyTagline: string;
      defaultTemplateId: string;
      verificationNotice: string;
      showQrOnCertificates: boolean;
      autoCourse: boolean;
      autoQuiz: boolean;
    }>
  >({});
  const [saving, setSaving] = React.useState(false);
  const [lookupCode, setLookupCode] = React.useState('');

  const academyName = draft.academyName ?? settingsRes.data?.academyName ?? 'ASRA Academy';
  const academyTagline = draft.academyTagline ?? settingsRes.data?.academyTagline ?? '';
  const defaultTemplateId = draft.defaultTemplateId ?? settingsRes.data?.defaultTemplateId ?? '';
  const verificationNotice = draft.verificationNotice ?? settingsRes.data?.verificationNotice ?? '';
  const showQrOnCertificates =
    draft.showQrOnCertificates ?? settingsRes.data?.showQrOnCertificates ?? true;
  const autoCourse = draft.autoCourse ?? settingsRes.data?.autoIssueOnCourseCompletion ?? true;
  const autoQuiz = draft.autoQuiz ?? settingsRes.data?.autoIssueOnQuizCompletion ?? false;

  const setAcademyName = (academyNameNext: string) =>
    setDraft((prev) => ({ ...prev, academyName: academyNameNext }));
  const setAcademyTagline = (academyTaglineNext: string) =>
    setDraft((prev) => ({ ...prev, academyTagline: academyTaglineNext }));
  const setDefaultTemplateId = (defaultTemplateIdNext: string) =>
    setDraft((prev) => ({ ...prev, defaultTemplateId: defaultTemplateIdNext }));
  const setVerificationNotice = (verificationNoticeNext: string) =>
    setDraft((prev) => ({ ...prev, verificationNotice: verificationNoticeNext }));
  const setShowQrOnCertificates = (showQrNext: boolean) =>
    setDraft((prev) => ({ ...prev, showQrOnCertificates: showQrNext }));
  const setAutoCourse = (autoCourseNext: boolean) =>
    setDraft((prev) => ({ ...prev, autoCourse: autoCourseNext }));
  const setAutoQuiz = (autoQuizNext: boolean) =>
    setDraft((prev) => ({ ...prev, autoQuiz: autoQuizNext }));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch<CertificateSettingsDto>('/admin/certificates/settings', {
        academyName: academyName.trim(),
        academyTagline: academyTagline.trim(),
        defaultTemplateId: defaultTemplateId || null,
        verificationNotice: verificationNotice.trim(),
        showQrOnCertificates,
        autoIssueOnCourseCompletion: autoCourse,
        autoIssueOnQuizCompletion: autoQuiz,
      });
      toast.success('Settings updated', {
        description: 'Platform certificate branding and automation rules saved.',
      });
      setDraft({});
      settingsRes.reload();
      auditList.list.reload();
    } catch (err) {
      toast.error('Failed to save settings', { description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const activeTemplates = (templatesRes.data ?? []).filter((t) => t.isActive);

  return (
    <>
      <CertificatesHeader
        title="Verification & Settings"
        description="Configure institutional certificate defaults, verification QR rules, and inspect the certificate audit trail."
      />

      <div className="grid gap-6">
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Platform Certificate Settings</CardTitle>
              <CardDescription>
                Defaults applied to newly generated certificates across modules. Existing issued
                certificates are unaffected.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {settingsRes.loading && !settingsRes.data ? (
                <LoadingPanel rows={4} />
              ) : settingsRes.error && !settingsRes.data ? (
                <ErrorPanel
                  message={errorMessage(settingsRes.error)}
                  onRetry={settingsRes.reload}
                />
              ) : (
                <form onSubmit={handleSave} className="grid gap-4">
                  <Field id="set-name" label="Issuing Institution Name">
                    <Input
                      value={academyName}
                      onChange={(e) => setAcademyName(e.target.value)}
                      disabled={!canManageGlobal}
                      required
                    />
                  </Field>
                  <Field id="set-tagline" label="Institutional Tagline">
                    <Input
                      value={academyTagline}
                      onChange={(e) => setAcademyTagline(e.target.value)}
                      disabled={!canManageGlobal}
                      required
                    />
                  </Field>
                  {activeTemplates.length > 0 && (
                    <SelectField
                      id="set-default-tpl"
                      label="Default Template"
                      value={defaultTemplateId || activeTemplates[0]!.id}
                      onValueChange={setDefaultTemplateId}
                      options={activeTemplates.map((t) => ({ value: t.id, label: t.name }))}
                      disabled={!canManageGlobal}
                    />
                  )}
                  <Field id="set-notice" label="Public Verification Notice">
                    <Textarea
                      rows={2}
                      value={verificationNotice}
                      onChange={(e) => setVerificationNotice(e.target.value)}
                      disabled={!canManageGlobal}
                      required
                    />
                  </Field>

                  <div className="grid gap-2.5 pt-1">
                    <CheckboxField
                      id="set-qr"
                      label="Embed verification QR code on generated PDFs"
                      checked={showQrOnCertificates}
                      onChange={setShowQrOnCertificates}
                      disabled={!canManageGlobal}
                    />
                    <CheckboxField
                      id="set-auto-course"
                      label="Auto-issue certificate when student completes 100% of an eligible course"
                      checked={autoCourse}
                      onChange={setAutoCourse}
                      disabled={!canManageGlobal}
                    />
                    <CheckboxField
                      id="set-auto-quiz"
                      label="Allow Academy Quiz certificate claims for passing attempts"
                      checked={autoQuiz}
                      onChange={setAutoQuiz}
                      disabled={!canManageGlobal}
                    />
                  </div>

                  {canManageGlobal && (
                    <div>
                      <Button type="submit" loading={saving} loadingText="Saving…">
                        <Save className="size-4" aria-hidden /> Save Certificate Settings
                      </Button>
                    </div>
                  )}
                </form>
              )}
            </CardContent>
          </Card>

          <Card className="content-start">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4 text-primary" /> Public Verification Portal
              </CardTitle>
              <CardDescription>
                Inspect any credential exactly as employers and verifiers see it at `/verify`.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field id="quick-verify" label="Lookup by Certificate Number">
                <Input
                  value={lookupCode}
                  onChange={(e) => setLookupCode(e.target.value.toUpperCase())}
                  placeholder="ASRA-2026-XXXX-XXXX"
                  className="font-mono uppercase"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link
                    href={
                      lookupCode.trim()
                        ? `/verify/${encodeURIComponent(lookupCode.trim())}`
                        : '/verify'
                    }
                    target="_blank"
                  >
                    <ExternalLink className="size-4" /> Open Public Verification
                  </Link>
                </Button>
              </div>
              <p className="type-caption text-muted-foreground">
                Public verification pages strictly protect learner privacy: emails, phone numbers,
                internal UUIDs, and scores are never exposed.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Certificate Audit Logs */}
        <div className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="type-h3 text-heading">Certificate Audit Trail</h2>
              <p className="type-caption text-muted-foreground">
                Append-only log of template edits, signature uploads/replacements/deactivations,
                issuance, reissues, and revocations.
              </p>
            </div>
            <FilterSelect
              id="audit-entity"
              label="Entity"
              value={entityTypeFilter}
              onChange={setEntityTypeFilter}
              options={[
                { value: 'certificate', label: 'Certificates' },
                { value: 'signature', label: 'Signatures' },
                { value: 'template', label: 'Templates' },
                { value: 'settings', label: 'Settings' },
              ]}
            />
          </div>

          <ListFrame list={auditList.list} setPage={auditList.setPage} label="audit entries">
            {(items: CertificateAuditLogItemDto[]) => (
              <Table scrollLabel="Certificate audit trail">
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="type-caption whitespace-nowrap text-muted-foreground">
                        {formatDateTime(entry.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          {entry.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="type-caption text-muted-foreground uppercase">
                        {entry.entityType}
                      </TableCell>
                      <TableCell className="text-sm font-medium text-heading">
                        {entry.actor?.fullName ?? 'System'}
                      </TableCell>
                      <TableCell className="max-w-xs truncate font-mono text-xs text-muted-foreground">
                        {entry.data ? JSON.stringify(entry.data) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </ListFrame>
        </div>
      </div>
    </>
  );
}
