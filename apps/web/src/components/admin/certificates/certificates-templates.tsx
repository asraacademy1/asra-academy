'use client';

import {
  PERMISSIONS,
  type CertificateSignatureDto,
  type CertificateTemplateConfigDto,
  type CertificateTemplateDto,
} from '@asra/types';
import {
  CERTIFICATE_SIGNATURE_LIMITS,
  isArtworkCertificateStyle,
  artworkTemplateForStyle,
  type CertificateSignaturePlacementInput,
} from '@asra/validation';
import { CheckCircle2, Eye, FileDown, FileImage, Save, Settings2 } from 'lucide-react';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { Alert } from '@/components/ui/alert';
import {
  CertificatePreview,
  type PreviewSignatureItem,
} from '@/components/certificates/certificate-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { triggerBlobDownload } from '@/lib/certificates';
import { CheckboxField, ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, hasPermission, useAdminApi, useApiResource } from '../use-admin';
import { CertificatesHeader, signatureImageSrc } from './certificates-shell';
import { SignaturePicker } from './signature-picker';

export function CertificatesTemplatesAdmin() {
  const { user } = useAuth();
  const api = useAdminApi();
  const canManage =
    hasPermission(user, PERMISSIONS.CERTIFICATES_TEMPLATES_MANAGE) ||
    hasPermission(user, PERMISSIONS.CERTIFICATES_MANAGE);

  const templatesRes = useApiResource<CertificateTemplateDto[]>(
    '/admin/certificates/templates',
    () => api.get<CertificateTemplateDto[]>('/admin/certificates/templates'),
  );
  const sigsRes = useApiResource<CertificateSignatureDto[]>(
    '/admin/certificates/signatures/active',
    () => api.get<CertificateSignatureDto[]>('/admin/certificates/signatures/active'),
  );

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [previewingFormat, setPreviewingFormat] = React.useState<'pdf' | 'png' | null>(null);

  const [draftState, setDraftState] = React.useState<{
    templateId: string;
    name: string;
    description: string;
    defaultTitle: string;
    defaultSubtitle: string;
    defaultBodyText: string;
    issuingAuthority: string;
    isDefault: boolean;
    isActive: boolean;
    config: CertificateTemplateConfigDto;
    signatures: CertificateSignaturePlacementInput[];
  } | null>(null);

  // Active templates first; archived (retired) templates stay listed for issued-certificate history.
  const templates = [...(templatesRes.data ?? [])].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive),
  );
  const activeSignatures = sigsRes.data ?? [];

  const activeTemplate =
    templates.find((t) => t.id === selectedId) ??
    templates.find((t) => t.isDefault) ??
    templates[0] ??
    null;

  const templateToDraft = (tpl: CertificateTemplateDto) => ({
    templateId: tpl.id,
    name: tpl.name,
    description: tpl.description ?? '',
    defaultTitle: tpl.defaultTitle,
    defaultSubtitle: tpl.defaultSubtitle ?? '',
    defaultBodyText: tpl.defaultBodyText,
    issuingAuthority: tpl.issuingAuthority,
    isDefault: tpl.isDefault,
    isActive: tpl.isActive,
    config: tpl.config,
    signatures: tpl.signatures.map((link) => ({
      signatureId: link.signatureId,
      sortOrder: link.sortOrder,
      positionLabel: link.positionLabel,
      showName: link.showName,
      showDesignation: link.showDesignation,
    })),
  });

  const currentDraft = activeTemplate
    ? draftState?.templateId === activeTemplate.id
      ? draftState
      : templateToDraft(activeTemplate)
    : null;

  const name = currentDraft?.name ?? '';
  const description = currentDraft?.description ?? '';
  const defaultTitle = currentDraft?.defaultTitle ?? '';
  const defaultSubtitle = currentDraft?.defaultSubtitle ?? '';
  const defaultBodyText = currentDraft?.defaultBodyText ?? '';
  const issuingAuthority = currentDraft?.issuingAuthority ?? 'ASRA Academy';
  const isDefault = currentDraft?.isDefault ?? false;
  const isActive = currentDraft?.isActive ?? true;
  const config = currentDraft?.config ?? null;
  const signatures = currentDraft?.signatures ?? [];

  const updateDraft = (partial: Partial<Omit<NonNullable<typeof currentDraft>, 'templateId'>>) => {
    if (!activeTemplate || !currentDraft) return;
    setDraftState({ ...currentDraft, ...partial, templateId: activeTemplate.id });
  };

  const setName = (next: string) => updateDraft({ name: next });
  const setDescription = (next: string) => updateDraft({ description: next });
  const setDefaultTitle = (next: string) => updateDraft({ defaultTitle: next });
  const setDefaultSubtitle = (next: string) => updateDraft({ defaultSubtitle: next });
  const setDefaultBodyText = (next: string) => updateDraft({ defaultBodyText: next });
  const setIssuingAuthority = (next: string) => updateDraft({ issuingAuthority: next });
  const setIsDefault = (next: boolean) => updateDraft({ isDefault: next });
  const setIsActive = (next: boolean) => updateDraft({ isActive: next });
  const setConfig = (next: CertificateTemplateConfigDto) => updateDraft({ config: next });
  const setSignatures = (next: CertificateSignaturePlacementInput[]) =>
    updateDraft({ signatures: next });

  const populateEditor = React.useCallback((tpl: CertificateTemplateDto) => {
    setSelectedId(tpl.id);
    setDraftState({
      templateId: tpl.id,
      name: tpl.name,
      description: tpl.description ?? '',
      defaultTitle: tpl.defaultTitle,
      defaultSubtitle: tpl.defaultSubtitle ?? '',
      defaultBodyText: tpl.defaultBodyText,
      issuingAuthority: tpl.issuingAuthority,
      isDefault: tpl.isDefault,
      isActive: tpl.isActive,
      config: tpl.config,
      signatures: tpl.signatures.map((link) => ({
        signatureId: link.signatureId,
        sortOrder: link.sortOrder,
        positionLabel: link.positionLabel,
        showName: link.showName,
        showDesignation: link.showDesignation,
      })),
    });
  }, []);

  const isArtwork = activeTemplate ? isArtworkCertificateStyle(activeTemplate.style) : false;
  const isRetired = activeTemplate?.isRetired ?? false;
  const slotLabels = isArtwork
    ? artworkTemplateForStyle(activeTemplate?.style)?.layout.signatureSlots.map(
        (slot) => slot.label,
      )
    : undefined;
  const requiredCount = activeTemplate?.requiredSignatureCount ?? null;

  const sigById = new Map<string, CertificateSignatureDto>();
  for (const s of activeSignatures) sigById.set(s.id, s);
  for (const link of activeTemplate?.signatures ?? [])
    sigById.set(link.signature.id, link.signature);

  const previewSignatures: PreviewSignatureItem[] = signatures.map((placement) => {
    const sig = sigById.get(placement.signatureId);
    return {
      key: placement.signatureId,
      fullName: sig?.fullName ?? 'Signatory',
      designation: sig?.designation ?? 'Official Title',
      department: sig?.department,
      positionLabel: placement.positionLabel,
      showName: placement.showName,
      showDesignation: placement.showDesignation,
      imageSrc: sig ? signatureImageSrc(sig) : null,
    };
  });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTemplate || !config) return;

    if (requiredCount !== null && signatures.length > 0 && signatures.length !== requiredCount) {
      toast.error('Invalid signature count', {
        description: `This template requires exactly ${requiredCount} signatures (${slotLabels?.join(' and ')}).`,
      });
      return;
    }
    if (
      requiredCount === null &&
      signatures.length > 0 &&
      (signatures.length < CERTIFICATE_SIGNATURE_LIMITS.minSignatures ||
        signatures.length > CERTIFICATE_SIGNATURE_LIMITS.maxSignatures)
    ) {
      toast.error('Invalid signature count', {
        description: 'Select between 2 and 4 digital signatures, or clear all to configure later.',
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        defaultTitle: defaultTitle.trim(),
        defaultSubtitle: defaultSubtitle.trim() || null,
        defaultBodyText: defaultBodyText.trim(),
        issuingAuthority: issuingAuthority.trim(),
        isActive,
        isDefault,
        config,
        ...(signatures.length >= CERTIFICATE_SIGNATURE_LIMITS.minSignatures ? { signatures } : {}),
      };
      const updated = await api.patch<CertificateTemplateDto>(
        `/admin/certificates/templates/${activeTemplate.id}`,
        payload,
      );
      toast.success('Template saved', {
        description: `${updated.name} updated to version ${updated.version}.`,
      });
      templatesRes.reload();
      populateEditor(updated);
    } catch (err) {
      toast.error('Could not save template', { description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadSample = async (format: 'pdf' | 'png') => {
    if (!activeTemplate) return;
    setPreviewingFormat(format);
    try {
      const blob = await api.download(
        `/admin/certificates/templates/${activeTemplate.id}/preview${format === 'png' ? '/png' : ''}`,
      );
      triggerBlobDownload(blob, `ASRA-Template-${activeTemplate.key}-Preview.${format}`);
    } catch (err) {
      toast.error(`Preview ${format.toUpperCase()} failed`, { description: errorMessage(err) });
    } finally {
      setPreviewingFormat(null);
    }
  };

  return (
    <>
      <CertificatesHeader
        title="Certificate Templates"
        description="Two ASRA QUIZORA 2026 — Certificate of Participation artwork designs are available (Design 1 and Design 2). Select one, assign its Event Coordinator and Director signatures, preview the exact PDF/PNG output, and review archived templates kept for previously issued certificates."
      />

      {templatesRes.loading && templates.length === 0 ? (
        <LoadingPanel label="Loading certificate templates…" rows={4} />
      ) : templatesRes.error && templates.length === 0 ? (
        <ErrorPanel
          title="Could not load certificate templates"
          message={errorMessage(templatesRes.error)}
          onRetry={templatesRes.reload}
        />
      ) : (
        <div className="grid gap-6">
          {/* 3 Template Selection Cards */}
          <div className="grid gap-4 md:grid-cols-3">
            {templates.map((tpl) => {
              const isSelected = activeTemplate?.id === tpl.id;
              return (
                <Card
                  key={tpl.id}
                  className={
                    isSelected ? 'border-2 border-primary shadow-raised' : 'cursor-pointer'
                  }
                >
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base">{tpl.name}</CardTitle>
                      <div className="flex items-center gap-1.5">
                        {tpl.isDefault && <Badge variant="accent">Default</Badge>}
                        <Badge variant={tpl.isActive ? 'success' : 'secondary'}>
                          {tpl.isRetired ? 'Archived' : tpl.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                    </div>
                    <CardDescription className="line-clamp-2 text-xs">
                      {tpl.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <CertificatePreview
                      compact
                      style={tpl.style}
                      config={tpl.config}
                      issuingAuthority={tpl.issuingAuthority}
                      subtitle={tpl.defaultSubtitle}
                      certificateTitle={tpl.defaultTitle}
                      recipientName="Fatima Zahra"
                      bodyText={tpl.defaultBodyText}
                      subjectTitle={
                        isArtworkCertificateStyle(tpl.style)
                          ? 'ASRA QUIZORA – 2026'
                          : 'Tajweed & Classical Arabic'
                      }
                      sourceLabel="Course"
                      certificateNumber="ASRA-2026-DEMO-0001"
                      verificationUrl="https://asraacademy-one.vercel.app/verify/ASRA-2026-DEMO-0001"
                      signatures={tpl.signatures.map((link) => ({
                        key: link.id,
                        fullName: link.signature.fullName,
                        designation: link.signature.designation,
                        department: link.signature.department,
                        showName: link.showName,
                        showDesignation: link.showDesignation,
                        imageSrc: signatureImageSrc(link.signature),
                      }))}
                    />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        v{tpl.version} · {tpl.signatures.length} signatures
                      </span>
                      <span>{tpl.issuedCount ?? 0} issued</span>
                    </div>
                    <Button
                      type="button"
                      variant={isSelected ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => populateEditor(tpl)}
                    >
                      {isSelected ? (
                        <>
                          <CheckCircle2 className="size-4" /> Editing Template
                        </>
                      ) : (
                        <>
                          <Settings2 className="size-4" /> Configure & Preview
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Active Template Editor & Live Preview */}
          {activeTemplate && config && (
            <form
              onSubmit={handleSave}
              className="grid gap-6 rounded-2xl border bg-card p-5 shadow-card xl:grid-cols-[1.05fr_1fr]"
            >
              <div className="grid gap-5">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                  <div>
                    <h2 className="type-h3 text-heading">Configure {activeTemplate.name}</h2>
                    <p className="type-caption text-muted-foreground">
                      Changes increment the template version ({activeTemplate.version} →{' '}
                      {activeTemplate.version + 1}). Previously issued certificates preserve their
                      original snapshot.
                    </p>
                  </div>
                </div>

                {isArtwork && (
                  <Alert tone="info" title="Artwork template (category QUIZ_PARTICIPATION)">
                    <p>
                      The approved ASRA QUIZORA 2026 artwork is the certificate background: logo,
                      emblem, heading, borders, badge and the Event Coordinator / Director captions
                      are fixed. Dynamic content: recipient name, statement, completion & issue
                      dates, certificate ID and the verification QR code. Exactly 2 signatures are
                      required — certificates cannot be previewed, generated or issued without them.
                      Scores, marks, percentages and ranks are never displayed.
                    </p>
                  </Alert>
                )}
                {isRetired && (
                  <Alert tone="warning" title="Archived template">
                    <p>
                      Replaced by ASRA QUIZORA 2026 — Certificate of Participation. It cannot be
                      re-activated or used for new certificates; certificates already issued with it
                      keep rendering and verifying from their saved snapshots.
                    </p>
                  </Alert>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="tpl-name" label="Template Name">
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={!canManage}
                      required
                    />
                  </Field>
                  <Field id="tpl-auth" label="Issuing Authority">
                    <Input
                      value={issuingAuthority}
                      onChange={(e) => setIssuingAuthority(e.target.value)}
                      disabled={!canManage}
                      required
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    id="tpl-title"
                    label="Default Certificate Title"
                    hint={isArtwork ? 'Fixed by the approved artwork.' : undefined}
                  >
                    <Input
                      value={defaultTitle}
                      onChange={(e) => setDefaultTitle(e.target.value)}
                      disabled={!canManage || isArtwork}
                      required
                    />
                  </Field>
                  {!isArtwork && (
                    <Field id="tpl-subtitle" label="Subtitle / Eyebrow" optional>
                      <Input
                        value={defaultSubtitle}
                        onChange={(e) => setDefaultSubtitle(e.target.value)}
                        disabled={!canManage}
                      />
                    </Field>
                  )}
                </div>

                <Field
                  id="tpl-body"
                  label={
                    isArtwork
                      ? 'Certificate Statement'
                      : 'Default Achievement / Completion Description'
                  }
                  hint={
                    isArtwork
                      ? 'Placeholders: {title} = certificate title (quiz, course or event name), {date} = completion date (e.g. 14th November 2026). Wrap text in **double asterisks** for bold; press Enter for a line break. Max 400 characters.'
                      : undefined
                  }
                >
                  <Textarea
                    rows={isArtwork ? 3 : 2}
                    value={defaultBodyText}
                    onChange={(e) => setDefaultBodyText(e.target.value)}
                    disabled={!canManage}
                    maxLength={isArtwork ? 400 : undefined}
                    required
                  />
                </Field>

                <Field id="tpl-desc" label="Admin Template Notes" optional>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={!canManage}
                  />
                </Field>

                {/* Styling & Field Visibility */}
                <div className="grid gap-3 rounded-xl border bg-background/50 p-4">
                  <h3 className="type-label text-heading">
                    {isArtwork ? 'Availability' : 'Layout & Field Visibility'}
                  </h3>
                  {!isArtwork && (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field id="tpl-accent" label="Primary Accent Color">
                          <Input
                            type="color"
                            value={config.accentColor}
                            onChange={(e) => setConfig({ ...config, accentColor: e.target.value })}
                            disabled={!canManage}
                            className="h-10 cursor-pointer p-1"
                          />
                        </Field>
                        <Field id="tpl-gold" label="Secondary Highlight Color">
                          <Input
                            type="color"
                            value={config.secondaryColor}
                            onChange={(e) =>
                              setConfig({ ...config, secondaryColor: e.target.value })
                            }
                            disabled={!canManage}
                            className="h-10 cursor-pointer p-1"
                          />
                        </Field>
                      </div>

                      <div className="grid gap-2.5 pt-1 sm:grid-cols-2">
                        <CheckboxField
                          id="cfg-logo"
                          label="Show Academy Logo"
                          checked={config.showLogo}
                          onChange={(v) => setConfig({ ...config, showLogo: v })}
                          disabled={!canManage}
                        />
                        <CheckboxField
                          id="cfg-seal"
                          label="Show Official Seal"
                          checked={config.showSeal}
                          onChange={(v) => setConfig({ ...config, showSeal: v })}
                          disabled={!canManage}
                        />
                        <CheckboxField
                          id="cfg-qr"
                          label="Show QR Verification Code"
                          checked={config.showQrCode}
                          onChange={(v) => setConfig({ ...config, showQrCode: v })}
                          disabled={!canManage}
                        />
                        <CheckboxField
                          id="cfg-source"
                          label="Show Source Badge"
                          checked={config.showSourceLabel}
                          onChange={(v) => setConfig({ ...config, showSourceLabel: v })}
                          disabled={!canManage}
                        />
                        <CheckboxField
                          id="cfg-comp-date"
                          label="Show Completion Date"
                          checked={config.showCompletionDate}
                          onChange={(v) => setConfig({ ...config, showCompletionDate: v })}
                          disabled={!canManage}
                        />
                        <CheckboxField
                          id="cfg-issue-date"
                          label="Show Issue Date"
                          checked={config.showIssueDate}
                          onChange={(v) => setConfig({ ...config, showIssueDate: v })}
                          disabled={!canManage}
                        />
                        <CheckboxField
                          id="cfg-id"
                          label="Show Certificate ID"
                          checked={config.showCertificateNumber}
                          onChange={(v) => setConfig({ ...config, showCertificateNumber: v })}
                          disabled={!canManage}
                        />
                      </div>
                    </>
                  )}

                  <div className="flex flex-wrap gap-5 border-t pt-3">
                    <CheckboxField
                      id="tpl-default"
                      label="Set as platform default template"
                      checked={isDefault}
                      onChange={setIsDefault}
                      disabled={!canManage || isRetired}
                    />
                    <CheckboxField
                      id="tpl-active"
                      label="Template is active"
                      checked={isActive}
                      onChange={setIsActive}
                      disabled={!canManage || isDefault || isRetired}
                    />
                  </div>
                </div>

                {/* Phase 4 Signature Picker */}
                <div className="rounded-xl border bg-background/50 p-4">
                  <SignaturePicker
                    availableSignatures={activeSignatures}
                    value={signatures}
                    onChange={setSignatures}
                    disabled={!canManage}
                    slotLabels={slotLabels}
                  />
                </div>

                {canManage && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="submit" loading={saving} loadingText="Saving template…">
                      <Save className="size-4" aria-hidden /> Save Template Configuration
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={previewingFormat !== null}
                      loading={previewingFormat === 'png'}
                      loadingText="Rendering PNG…"
                      onClick={() => void handleDownloadSample('png')}
                    >
                      <FileImage className="size-4" aria-hidden /> Sample PNG
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={previewingFormat !== null}
                      loading={previewingFormat === 'pdf'}
                      loadingText="Rendering PDF…"
                      onClick={() => void handleDownloadSample('pdf')}
                    >
                      <FileDown className="size-4" aria-hidden /> Sample PDF
                    </Button>
                  </div>
                )}
              </div>

              {/* Live Preview Column */}
              <div className="grid content-start gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 type-label text-heading">
                    <Eye className="size-4 text-primary" aria-hidden /> Live Certificate Preview
                  </h3>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={previewingFormat !== null}
                      loading={previewingFormat === 'png'}
                      onClick={() => void handleDownloadSample('png')}
                    >
                      <FileImage className="size-3.5" aria-hidden /> Sample PNG
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={previewingFormat !== null}
                      loading={previewingFormat === 'pdf'}
                      onClick={() => void handleDownloadSample('pdf')}
                    >
                      <FileDown className="size-3.5" aria-hidden /> Sample PDF
                    </Button>
                  </div>
                </div>

                <CertificatePreview
                  style={activeTemplate.style}
                  config={config}
                  issuingAuthority={issuingAuthority}
                  subtitle={defaultSubtitle}
                  certificateTitle={defaultTitle}
                  recipientName="Fatima Zahra Al-Khatib"
                  bodyText={defaultBodyText}
                  subjectTitle={
                    isArtwork ? 'ASRA QUIZORA – 2026' : 'Foundations of Classical Arabic & Tajweed'
                  }
                  achievementDetails={
                    activeTemplate.style === 'PREMIUM_ACHIEVEMENT'
                      ? 'First Class Distinction · Top Performer'
                      : null
                  }
                  sourceLabel="Course"
                  completedAt={new Date().toISOString()}
                  issuedAt={new Date().toISOString()}
                  certificateNumber="ASRA-2026-SMPL-DEMO"
                  verificationUrl="https://asraacademy-one.vercel.app/verify/ASRA-2026-SMPL-DEMO"
                  signatures={previewSignatures}
                />

                <p className="type-caption text-muted-foreground">
                  {isArtwork
                    ? 'Preview updates live with the same artwork, fonts and layout as the downloaded certificate. Sample PNG / Sample PDF render the exact final output on the server (refused until both signatures are saved).'
                    : 'Preview updates live as you configure headings, visibility toggles, and 2–4 digital signatures. Sample PNG and Sample PDF are generated dynamically in memory without storing certificate files.'}
                </p>
              </div>
            </form>
          )}
        </div>
      )}
    </>
  );
}
