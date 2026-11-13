'use client';

import type {
  CertificateTemplateDto,
  QuizCertificateBatchDetailDto,
  QuizCertificateCategory,
  QuizCertificateFormat,
  QuizCertificatePreviewResponseDto,
  QuizCertificateRecipientMode,
  QuizEligibleParticipantDto,
  QuizEligibleParticipantsResponseDto,
} from '@asra/types';
import {
  Award,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileDown,
  FileImage,
  Mail,
  Search,
  Trophy,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  CertificatePreview,
  type PreviewSignatureItem,
} from '@/components/certificates/certificate-preview';
import { Alert } from '@/components/ui/alert';
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
import { triggerBlobDownload } from '@/lib/certificates';
import { formatMarksValue } from '@/lib/assessments';
import { cn } from '@/lib/utils';

import { CheckboxField, ErrorPanel, LoadingPanel, SelectField } from '../admin-ui';
import { signatureImageSrc } from '../certificates/certificates-shell';
import { errorMessage, useAdminApi, useApiResource } from '../use-admin';
import { QuizCertificatesProgress } from './quiz-certificates-progress';

const STEPS = [
  { number: 1, title: 'Select Recipients' },
  { number: 2, title: 'Assign Templates' },
  { number: 3, title: 'Configure Delivery' },
  { number: 4, title: 'Review & Confirm' },
] as const;

const MODE_OPTIONS: {
  value: QuizCertificateRecipientMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'ALL_PARTICIPANTS',
    label: 'All Participants',
    description: 'Every student who submitted a valid quiz attempt (excludes registered-only).',
  },
  {
    value: 'RANKERS_ONLY',
    label: 'Rankers Only',
    description: 'Top 3, Top 5, Top 10, or a custom leaderboard rank range (ties preserved).',
  },
  {
    value: 'SELECTED_RANKS',
    label: 'Selected Ranks',
    description: 'Pick specific finalized ranks from the leaderboard.',
  },
  {
    value: 'INDIVIDUAL_PARTICIPANTS',
    label: 'Individual Participants',
    description: 'Select specific eligible participants manually.',
  },
];

function isValidTemplate(tpl: CertificateTemplateDto): { valid: boolean; reason?: string } {
  if (!tpl.isActive) return { valid: false, reason: 'Inactive template' };
  if (tpl.requiredSignatureCount !== null) {
    // Artwork template (ASRA QUIZORA 2026): exactly the Event Coordinator + Director signatures.
    const activeCount = tpl.signatures.filter((s) => s.signature.isActive).length;
    if (
      tpl.signatures.length !== tpl.requiredSignatureCount ||
      activeCount !== tpl.requiredSignatureCount
    ) {
      return {
        valid: false,
        reason: `Requires exactly ${tpl.requiredSignatureCount} active signatures (Event Coordinator & Director)`,
      };
    }
    return { valid: true };
  }
  if (tpl.signatures.length > 0) {
    const activeCount = tpl.signatures.filter((s) => s.signature.isActive).length;
    if (activeCount < 2 || activeCount > 4) {
      return { valid: false, reason: 'Requires 2–4 active signatures' };
    }
  }
  return { valid: true };
}

function previewSignaturesOf(tpl: CertificateTemplateDto): PreviewSignatureItem[] {
  return tpl.signatures
    .filter((s) => s.signature.isActive)
    .map((s) => ({
      key: s.id,
      fullName: s.signature.fullName,
      designation: s.signature.designation,
      department: s.signature.department,
      positionLabel: s.positionLabel,
      showName: s.showName,
      showDesignation: s.showDesignation,
      imageSrc: signatureImageSrc(s.signature),
    }));
}

export function QuizCertificatesWizard({
  open,
  onOpenChange,
  quizId,
  quizTitle,
  canIssue,
  onCompleted,
  onViewIssuedCertificates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quizId: string;
  quizTitle: string;
  canIssue: boolean;
  onCompleted: () => void;
  onViewIssuedCertificates: () => void;
}) {
  const api = useAdminApi();

  const eligibleRes = useApiResource<QuizEligibleParticipantsResponseDto>(
    open ? `/admin/academy-quizzes/${quizId}/certificates/eligible` : null,
    () =>
      api.get<QuizEligibleParticipantsResponseDto>(
        `/admin/academy-quizzes/${quizId}/certificates/eligible`,
      ),
  );
  const templatesRes = useApiResource<CertificateTemplateDto[]>(
    open ? '/admin/certificates/templates' : null,
    () => api.get<CertificateTemplateDto[]>('/admin/certificates/templates'),
  );

  const [step, setStep] = React.useState<1 | 2 | 3 | 4 | 5>(1);

  // Step 1 state
  const [recipientMode, setRecipientMode] =
    React.useState<QuizCertificateRecipientMode>('ALL_PARTICIPANTS');
  const [rankPreset, setRankPreset] = React.useState<'TOP_3' | 'TOP_5' | 'TOP_10' | 'CUSTOM'>(
    'TOP_3',
  );
  const [rankFrom, setRankFrom] = React.useState('1');
  const [rankTo, setRankTo] = React.useState('3');
  const [selectedRanks, setSelectedRanks] = React.useState<number[]>([1, 2, 3]);
  const [selectedUserIds, setSelectedUserIds] = React.useState<string[]>([]);
  const [individualCategory, setIndividualCategory] =
    React.useState<QuizCertificateCategory>('PARTICIPATION');
  const [participantSearch, setParticipantSearch] = React.useState('');

  // Step 2 state (explicitly selected; never silently chooses invalid template)
  const [participationTemplateId, setParticipationTemplateId] = React.useState('');
  const [issueRankOverridesInAllMode, setIssueRankOverridesInAllMode] = React.useState(false);
  const [rank1TemplateId, setRank1TemplateId] = React.useState('');
  const [rank2TemplateId, setRank2TemplateId] = React.useState('');
  const [rank3TemplateId, setRank3TemplateId] = React.useState('');
  const [otherRankTemplateId, setOtherRankTemplateId] = React.useState('');
  const [previewSlot, setPreviewSlot] = React.useState<
    'PARTICIPATION' | 'RANK_1' | 'RANK_2' | 'RANK_3' | 'OTHER_RANK'
  >('PARTICIPATION');
  const [downloadingSample, setDownloadingSample] = React.useState<'pdf' | 'png' | null>(null);

  // Step 3 state
  const [format, setFormat] = React.useState<QuizCertificateFormat>('BOTH');
  const [sendEmail, setSendEmail] = React.useState(true);
  const [showInStudentDashboard, setShowInStudentDashboard] = React.useState(true);

  // Step 3/4 server preview & submission state
  const [submitting, setSubmitting] = React.useState(false);
  const [activeBatch, setActiveBatch] = React.useState<QuizCertificateBatchDetailDto | null>(null);

  const eligibleItems = React.useMemo(
    () => eligibleRes.data?.items ?? [],
    [eligibleRes.data?.items],
  );
  const availableRanks = React.useMemo(
    () => eligibleRes.data?.availableRanks ?? [],
    [eligibleRes.data?.availableRanks],
  );
  const allTemplates = React.useMemo(() => templatesRes.data ?? [], [templatesRes.data]);
  const validTemplates = React.useMemo(
    () => allTemplates.filter((t) => isValidTemplate(t).valid),
    [allTemplates],
  );

  // Filtered participants based on Step 1 selection
  const topNValue =
    rankPreset === 'TOP_3' ? 3 : rankPreset === 'TOP_5' ? 5 : rankPreset === 'TOP_10' ? 10 : null;

  const selectedParticipants = React.useMemo(() => {
    if (recipientMode === 'ALL_PARTICIPANTS') return eligibleItems;
    if (recipientMode === 'RANKERS_ONLY') {
      if (rankPreset === 'CUSTOM') {
        const from = Number(rankFrom);
        const to = Number(rankTo);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return [];
        return eligibleItems.filter((p) => p.rank >= from && p.rank <= to);
      }
      const limit = topNValue ?? 3;
      return eligibleItems.filter((p) => p.rank <= limit);
    }
    if (recipientMode === 'SELECTED_RANKS') {
      const allowed = new Set(selectedRanks);
      return eligibleItems.filter((p) => allowed.has(p.rank));
    }
    const allowedUsers = new Set(selectedUserIds);
    return eligibleItems.filter((p) => allowedUsers.has(p.userId));
  }, [
    eligibleItems,
    recipientMode,
    rankPreset,
    rankFrom,
    rankTo,
    topNValue,
    selectedRanks,
    selectedUserIds,
  ]);

  const searchableParticipants = React.useMemo(() => {
    const q = participantSearch.trim().toLowerCase();
    if (!q) return eligibleItems;
    return eligibleItems.filter(
      (p) =>
        p.fullName.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        (p.studentCode?.toLowerCase().includes(q) ?? false),
    );
  }, [eligibleItems, participantSearch]);

  // Which template slots are needed based on Step 1 selection
  const selectedRankSet = React.useMemo(
    () => new Set(selectedParticipants.map((p) => p.rank)),
    [selectedParticipants],
  );
  const needsParticipationSlot =
    recipientMode === 'ALL_PARTICIPANTS' ||
    (recipientMode === 'INDIVIDUAL_PARTICIPANTS' && individualCategory === 'PARTICIPATION');
  const needsRankSlots =
    recipientMode === 'RANKERS_ONLY' ||
    recipientMode === 'SELECTED_RANKS' ||
    (recipientMode === 'INDIVIDUAL_PARTICIPANTS' && individualCategory === 'RANK');
  const hasOtherRanks = [...selectedRankSet].some((r) => r > 3);

  // Build request payload
  const buildIssuancePayload = React.useCallback(() => {
    return {
      recipientMode,
      topN: recipientMode === 'RANKERS_ONLY' && rankPreset !== 'CUSTOM' ? topNValue : null,
      rankFrom:
        recipientMode === 'RANKERS_ONLY' && rankPreset === 'CUSTOM' ? Number(rankFrom) : null,
      rankTo: recipientMode === 'RANKERS_ONLY' && rankPreset === 'CUSTOM' ? Number(rankTo) : null,
      selectedRanks: recipientMode === 'SELECTED_RANKS' ? selectedRanks : [],
      selectedUserIds: recipientMode === 'INDIVIDUAL_PARTICIPANTS' ? selectedUserIds : [],
      individualCategory,
      templates: {
        participationTemplateId: participationTemplateId || null,
        rank1TemplateId:
          needsRankSlots || issueRankOverridesInAllMode ? rank1TemplateId || null : null,
        rank2TemplateId:
          needsRankSlots || issueRankOverridesInAllMode ? rank2TemplateId || null : null,
        rank3TemplateId:
          needsRankSlots || issueRankOverridesInAllMode ? rank3TemplateId || null : null,
        otherRankTemplateId: needsRankSlots ? otherRankTemplateId || null : null,
        issueRankCertificatesToTopRankers:
          recipientMode === 'ALL_PARTICIPANTS' ? issueRankOverridesInAllMode : true,
      },
      format,
      sendEmail,
      showInStudentDashboard,
    };
  }, [
    recipientMode,
    rankPreset,
    topNValue,
    rankFrom,
    rankTo,
    selectedRanks,
    selectedUserIds,
    individualCategory,
    participationTemplateId,
    needsRankSlots,
    issueRankOverridesInAllMode,
    rank1TemplateId,
    rank2TemplateId,
    rank3TemplateId,
    otherRankTemplateId,
    format,
    sendEmail,
    showInStudentDashboard,
  ]);

  const step2ValidationError = React.useMemo(() => {
    if (validTemplates.length === 0) {
      return 'No active and valid certificate templates are configured.';
    }
    if (needsParticipationSlot && !participationTemplateId) {
      return 'Select an active template for Participation certificates.';
    }
    if (needsRankSlots) {
      for (const rank of selectedRankSet) {
        if (rank === 1 && !rank1TemplateId && !otherRankTemplateId) {
          return 'Assign a template for Rank 1 or select a General / Other Ranks template.';
        }
        if (rank === 2 && !rank2TemplateId && !otherRankTemplateId) {
          return 'Assign a template for Rank 2 or select a General / Other Ranks template.';
        }
        if (rank === 3 && !rank3TemplateId && !otherRankTemplateId) {
          return 'Assign a template for Rank 3 or select a General / Other Ranks template.';
        }
        if (rank > 3 && !otherRankTemplateId) {
          return `Assign a General / Other Ranks template to cover Rank #${rank}.`;
        }
      }
    }
    return null;
  }, [
    validTemplates.length,
    needsParticipationSlot,
    participationTemplateId,
    needsRankSlots,
    selectedRankSet,
    rank1TemplateId,
    rank2TemplateId,
    rank3TemplateId,
    otherRankTemplateId,
  ]);

  const previewKey =
    open && (step === 3 || step === 4) && !step2ValidationError
      ? JSON.stringify(buildIssuancePayload())
      : null;

  const previewRes = useApiResource<QuizCertificatePreviewResponseDto>(previewKey, () =>
    api.post<QuizCertificatePreviewResponseDto>(
      `/admin/academy-quizzes/${quizId}/certificates/preview`,
      buildIssuancePayload(),
    ),
  );
  const previewData = previewRes.data ?? null;
  const previewLoading = previewRes.loading;
  const previewError = previewRes.error ? errorMessage(previewRes.error) : null;
  const loadServerPreview = previewRes.reload;

  async function handleSampleDownload(fmt: 'pdf' | 'png') {
    const activeTplId =
      previewSlot === 'RANK_1'
        ? rank1TemplateId || otherRankTemplateId
        : previewSlot === 'RANK_2'
          ? rank2TemplateId || otherRankTemplateId
          : previewSlot === 'RANK_3'
            ? rank3TemplateId || otherRankTemplateId
            : previewSlot === 'OTHER_RANK'
              ? otherRankTemplateId
              : participationTemplateId;

    if (!activeTplId) {
      toast.error('Select a template for this category first');
      return;
    }

    setDownloadingSample(fmt);
    try {
      const rankNum =
        previewSlot === 'RANK_1'
          ? 1
          : previewSlot === 'RANK_2'
            ? 2
            : previewSlot === 'RANK_3'
              ? 3
              : previewSlot === 'OTHER_RANK'
                ? 4
                : undefined;
      const category = previewSlot === 'PARTICIPATION' ? 'PARTICIPATION' : 'RANK';
      const params = new URLSearchParams({
        templateId: activeTplId,
        category,
        format: fmt,
        ...(rankNum ? { rank: String(rankNum) } : {}),
      });
      const blob = await api.download(
        `/admin/academy-quizzes/${quizId}/certificates/sample-preview?${params.toString()}`,
      );
      triggerBlobDownload(blob, `ASRA-Quiz-Sample-Preview.${fmt}`);
    } catch (err) {
      toast.error(`Sample ${fmt.toUpperCase()} preview failed`, {
        description: errorMessage(err),
      });
    } finally {
      setDownloadingSample(null);
    }
  }

  async function handleConfirmAndIssue() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const batchDetail = await api.post<QuizCertificateBatchDetailDto>(
        `/admin/academy-quizzes/${quizId}/certificates/issue`,
        buildIssuancePayload(),
      );
      setActiveBatch(batchDetail);
      setStep(5);
      toast.success('Bulk certificate issuance started', {
        description: `Queued ${batchDetail.batch.totalQueued} certificate(s).`,
      });
      onCompleted();
    } catch (err) {
      toast.error('Could not start certificate issuance', {
        description: errorMessage(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const templateOptions = validTemplates.map((t) => ({
    value: t.id,
    label: `${t.name}${t.isDefault ? ' (Default)' : ''}`,
  }));

  const activePreviewTemplate = (() => {
    const id =
      previewSlot === 'RANK_1'
        ? rank1TemplateId || otherRankTemplateId
        : previewSlot === 'RANK_2'
          ? rank2TemplateId || otherRankTemplateId
          : previewSlot === 'RANK_3'
            ? rank3TemplateId || otherRankTemplateId
            : previewSlot === 'OTHER_RANK'
              ? otherRankTemplateId
              : participationTemplateId;
    return validTemplates.find((t) => t.id === id) ?? validTemplates[0] ?? null;
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Award className="size-5 text-primary" aria-hidden />
            {step === 5 ? 'Certificate Issuance Progress' : `Issue Certificates — ${quizTitle}`}
          </DialogTitle>
          <DialogDescription>
            {step === 5
              ? 'Certificates are generated asynchronously and congratulations emails are sent upon completion.'
              : 'Select eligible recipients, assign official templates, configure delivery, and confirm issuance.'}
          </DialogDescription>
        </DialogHeader>

        {step !== 5 && (
          <nav
            aria-label="Certificate issuance steps"
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {STEPS.map((s) => {
              const active = step === s.number;
              const done = step > s.number;
              return (
                <div
                  key={s.number}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : done
                        ? 'border-success/40 bg-success-soft/50 text-success'
                        : 'border-border bg-muted/30 text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : done
                          ? 'bg-success text-white'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {done ? <Check className="size-3" aria-hidden /> : s.number}
                  </span>
                  <span className="truncate">{s.title}</span>
                </div>
              );
            })}
          </nav>
        )}

        {/* STEP 1: SELECT RECIPIENTS */}
        {step === 1 && (
          <div className="grid gap-5">
            {eligibleRes.error && !eligibleRes.data ? (
              <ErrorPanel message={errorMessage(eligibleRes.error)} onRetry={eligibleRes.reload} />
            ) : !eligibleRes.data ? (
              <LoadingPanel label="Loading eligible quiz participants…" rows={4} />
            ) : (
              <>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {MODE_OPTIONS.map((opt) => {
                    const selected = recipientMode === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setRecipientMode(opt.value)}
                        className={cn(
                          'grid gap-1 rounded-xl border p-3.5 text-left transition-colors',
                          selected
                            ? 'border-primary bg-primary/5 ring-1 ring-primary'
                            : 'bg-card hover:border-primary/40',
                        )}
                      >
                        <span className="type-label text-heading">{opt.label}</span>
                        <span className="type-caption text-muted-foreground">
                          {opt.description}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {recipientMode === 'RANKERS_ONLY' && (
                  <div className="grid gap-3 rounded-xl border bg-muted/20 p-4">
                    <p className="type-label text-heading">Ranker range</p>
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          { id: 'TOP_3', label: 'Top 3' },
                          { id: 'TOP_5', label: 'Top 5' },
                          { id: 'TOP_10', label: 'Top 10' },
                          { id: 'CUSTOM', label: 'Custom rank range' },
                        ] as const
                      ).map((preset) => (
                        <Button
                          key={preset.id}
                          type="button"
                          size="sm"
                          variant={rankPreset === preset.id ? 'default' : 'outline'}
                          onClick={() => setRankPreset(preset.id)}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                    {rankPreset === 'CUSTOM' && (
                      <div className="grid max-w-xs grid-cols-2 gap-3">
                        <Field id="rank-from" label="From Rank">
                          <Input
                            id="rank-from"
                            type="number"
                            min={1}
                            value={rankFrom}
                            onChange={(e) => setRankFrom(e.target.value)}
                          />
                        </Field>
                        <Field id="rank-to" label="To Rank">
                          <Input
                            id="rank-to"
                            type="number"
                            min={1}
                            value={rankTo}
                            onChange={(e) => setRankTo(e.target.value)}
                          />
                        </Field>
                      </div>
                    )}
                    <p className="type-caption text-muted-foreground">
                      Uses the finalized leaderboard and preserves tied ranks automatically.
                    </p>
                  </div>
                )}

                {recipientMode === 'SELECTED_RANKS' && (
                  <div className="grid gap-3 rounded-xl border bg-muted/20 p-4">
                    <p className="type-label text-heading">Choose specific leaderboard ranks</p>
                    {availableRanks.length === 0 ? (
                      <p className="type-body-sm text-muted-foreground">
                        No ranked participants found.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {availableRanks.map((rank) => {
                          const checked = selectedRanks.includes(rank);
                          const count = eligibleItems.filter((p) => p.rank === rank).length;
                          return (
                            <Button
                              key={rank}
                              type="button"
                              size="sm"
                              variant={checked ? 'default' : 'outline'}
                              onClick={() =>
                                setSelectedRanks((prev) =>
                                  checked ? prev.filter((r) => r !== rank) : [...prev, rank],
                                )
                              }
                            >
                              Rank #{rank} ({count})
                            </Button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {recipientMode === 'INDIVIDUAL_PARTICIPANTS' && (
                  <div className="grid gap-3 rounded-xl border bg-muted/20 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="relative min-w-[220px] flex-1">
                        <Search
                          aria-hidden
                          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                        />
                        <Input
                          value={participantSearch}
                          onChange={(e) => setParticipantSearch(e.target.value)}
                          placeholder="Search eligible participants by name, email, or student ID…"
                          className="pl-9"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="type-caption text-muted-foreground">
                          Certificate type:
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant={individualCategory === 'PARTICIPATION' ? 'default' : 'outline'}
                          onClick={() => setIndividualCategory('PARTICIPATION')}
                        >
                          Participation
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={individualCategory === 'RANK' ? 'default' : 'outline'}
                          onClick={() => setIndividualCategory('RANK')}
                        >
                          Rank Certificate
                        </Button>
                      </div>
                    </div>
                    <div className="max-h-56 overflow-auto rounded-lg border bg-card">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-10">
                              <span className="sr-only">Select</span>
                            </TableHead>
                            <TableHead>Rank</TableHead>
                            <TableHead>Student</TableHead>
                            <TableHead className="text-right">Score</TableHead>
                            <TableHead>Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {searchableParticipants.map((p) => {
                            const checked = selectedUserIds.includes(p.userId);
                            return (
                              <TableRow key={p.userId}>
                                <TableCell>
                                  <input
                                    type="checkbox"
                                    aria-label={`Select ${p.fullName}`}
                                    checked={checked}
                                    onChange={(e) =>
                                      setSelectedUserIds((prev) =>
                                        e.target.checked
                                          ? [...prev, p.userId]
                                          : prev.filter((id) => id !== p.userId),
                                      )
                                    }
                                    className="size-4 accent-primary"
                                  />
                                </TableCell>
                                <TableCell className="tabular-nums">#{p.rank}</TableCell>
                                <TableCell>
                                  <span className="type-label text-heading">{p.fullName}</span>
                                  <span className="block type-caption text-muted-foreground">
                                    {p.email}
                                  </span>
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {formatMarksValue(p.score)}/{formatMarksValue(p.maxScore)} (
                                  {p.percent}%)
                                </TableCell>
                                <TableCell>
                                  <ParticipantIssuedBadges
                                    participant={p}
                                    category={individualCategory}
                                  />
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}

                {/* Recipient count & preview */}
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 type-label text-heading">
                      <Users className="size-4 text-primary" aria-hidden />
                      Selected Recipients: <strong>{selectedParticipants.length}</strong> unique
                      participant{selectedParticipants.length === 1 ? '' : 's'}
                    </p>
                    <p className="type-caption text-muted-foreground">
                      One best/ranked attempt per student · Registered-only & incomplete attempts
                      excluded
                    </p>
                  </div>
                  {selectedParticipants.length === 0 ? (
                    <Alert tone="warning" title="No recipients selected">
                      Adjust your filter or selection to include at least one eligible participant.
                    </Alert>
                  ) : (
                    <div className="max-h-52 overflow-auto rounded-xl border bg-card">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-16">Rank</TableHead>
                            <TableHead>Student</TableHead>
                            <TableHead className="text-right">Score</TableHead>
                            <TableHead>Existing Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedParticipants.slice(0, 50).map((p) => (
                            <TableRow key={p.userId}>
                              <TableCell className="tabular-nums">
                                {p.rank <= 3 ? (
                                  <Trophy
                                    className="mr-1 inline size-3.5 text-asra-gold-700"
                                    aria-hidden
                                  />
                                ) : null}
                                #{p.rank}
                              </TableCell>
                              <TableCell>
                                <span className="type-label text-heading">{p.fullName}</span>
                                <span className="block type-caption text-muted-foreground">
                                  {p.email}
                                </span>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {formatMarksValue(p.score)}/{formatMarksValue(p.maxScore)} (
                                {p.percent}%)
                              </TableCell>
                              <TableCell>
                                <ParticipantIssuedBadges participant={p} />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      {selectedParticipants.length > 50 && (
                        <p className="border-t px-4 py-2 type-caption text-muted-foreground">
                          Showing first 50 of {selectedParticipants.length} selected recipients.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* STEP 2: ASSIGN CERTIFICATE TEMPLATES */}
        {step === 2 && (
          <div className="grid gap-5">
            {templatesRes.error && !templatesRes.data ? (
              <ErrorPanel
                message={errorMessage(templatesRes.error)}
                onRetry={templatesRes.reload}
              />
            ) : !templatesRes.data ? (
              <LoadingPanel label="Loading certificate templates…" rows={4} />
            ) : validTemplates.length === 0 ? (
              <Alert tone="warning" title="No active & valid certificate templates available">
                <p className="type-body-sm">
                  No certificate can be issued without its required signatures. Open ASRA QUIZORA
                  2026 — Certificate of Participation in the Certificate Templates module and assign
                  both the Event Coordinator and Director signatures first.
                </p>
                <div className="mt-3">
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/certificates/templates">Open Certificate Templates</Link>
                  </Button>
                </div>
              </Alert>
            ) : (
              <div className="grid gap-6 lg:grid-cols-12">
                <div className="grid content-start gap-4 lg:col-span-6">
                  {needsParticipationSlot && (
                    <SelectField
                      id="tpl-participation"
                      label="Participation Certificate Template"
                      value={participationTemplateId}
                      onValueChange={(val) => {
                        setParticipationTemplateId(val);
                        setPreviewSlot('PARTICIPATION');
                      }}
                      options={templateOptions}
                      placeholder="Select participation template…"
                    />
                  )}

                  {recipientMode === 'ALL_PARTICIPANTS' && (
                    <div className="rounded-xl border bg-muted/20 p-3.5">
                      <CheckboxField
                        id="issue-rank-overrides"
                        label="Assign special templates for Top 3 Rankers"
                        checked={issueRankOverridesInAllMode}
                        onChange={setIssueRankOverridesInAllMode}
                        hint="Optional: rankers assigned a template below receive a Rank certificate; all other participants receive the Participation certificate."
                      />
                    </div>
                  )}

                  {(needsRankSlots || issueRankOverridesInAllMode) && (
                    <div className="grid gap-3 rounded-xl border p-4">
                      <p className="type-label text-heading">Rank-Specific Templates</p>
                      {(needsRankSlots ? selectedRankSet.has(1) : true) && (
                        <SelectField
                          id="tpl-rank-1"
                          label="Rank 1 Template"
                          value={rank1TemplateId}
                          onValueChange={(val) => {
                            setRank1TemplateId(val);
                            setPreviewSlot('RANK_1');
                          }}
                          options={templateOptions}
                          placeholder={
                            otherRankTemplateId
                              ? 'Using General Rank template (or pick override)…'
                              : 'Select Rank 1 template…'
                          }
                          optional={Boolean(otherRankTemplateId) || issueRankOverridesInAllMode}
                        />
                      )}
                      {(needsRankSlots ? selectedRankSet.has(2) : true) && (
                        <SelectField
                          id="tpl-rank-2"
                          label="Rank 2 Template"
                          value={rank2TemplateId}
                          onValueChange={(val) => {
                            setRank2TemplateId(val);
                            setPreviewSlot('RANK_2');
                          }}
                          options={templateOptions}
                          placeholder={
                            otherRankTemplateId
                              ? 'Using General Rank template (or pick override)…'
                              : 'Select Rank 2 template…'
                          }
                          optional={Boolean(otherRankTemplateId) || issueRankOverridesInAllMode}
                        />
                      )}
                      {(needsRankSlots ? selectedRankSet.has(3) : true) && (
                        <SelectField
                          id="tpl-rank-3"
                          label="Rank 3 Template"
                          value={rank3TemplateId}
                          onValueChange={(val) => {
                            setRank3TemplateId(val);
                            setPreviewSlot('RANK_3');
                          }}
                          options={templateOptions}
                          placeholder={
                            otherRankTemplateId
                              ? 'Using General Rank template (or pick override)…'
                              : 'Select Rank 3 template…'
                          }
                          optional={Boolean(otherRankTemplateId) || issueRankOverridesInAllMode}
                        />
                      )}
                      {needsRankSlots && (
                        <SelectField
                          id="tpl-other-ranks"
                          label={
                            hasOtherRanks
                              ? 'Other Selected Ranks / General Rank Template'
                              : 'General Rank Template (Reusable fallback for ranks)'
                          }
                          value={otherRankTemplateId}
                          onValueChange={(val) => {
                            setOtherRankTemplateId(val);
                            setPreviewSlot('OTHER_RANK');
                          }}
                          options={templateOptions}
                          placeholder="Select reusable rank template…"
                          hint="Dynamically renders each student's Rank # on the certificate."
                          optional={!hasOtherRanks}
                        />
                      )}
                    </div>
                  )}

                  {step2ValidationError && (
                    <Alert tone="warning" title="Template assignment incomplete">
                      <p className="type-body-sm">{step2ValidationError}</p>
                    </Alert>
                  )}

                  {allTemplates.some((t) => !isValidTemplate(t).valid) && (
                    <p className="type-caption text-muted-foreground">
                      Inactive or unconfigured templates are hidden. Manage templates in{' '}
                      <Link href="/admin/certificates/templates" className="text-primary underline">
                        Certificate Templates
                      </Link>
                      .
                    </p>
                  )}
                </div>

                {/* Live Template Preview & Sample PDF/PNG Export */}
                <div className="grid content-start gap-3 lg:col-span-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 type-label text-heading">
                      <Eye className="size-4 text-primary" aria-hidden />
                      Sample Certificate Preview
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {needsParticipationSlot && (
                        <Button
                          type="button"
                          size="sm"
                          variant={previewSlot === 'PARTICIPATION' ? 'default' : 'outline'}
                          onClick={() => setPreviewSlot('PARTICIPATION')}
                        >
                          Participation
                        </Button>
                      )}
                      {(needsRankSlots || issueRankOverridesInAllMode) && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant={previewSlot === 'RANK_1' ? 'default' : 'outline'}
                            onClick={() => setPreviewSlot('RANK_1')}
                          >
                            Rank 1
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={previewSlot === 'RANK_2' ? 'default' : 'outline'}
                            onClick={() => setPreviewSlot('RANK_2')}
                          >
                            Rank 2
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={previewSlot === 'RANK_3' ? 'default' : 'outline'}
                            onClick={() => setPreviewSlot('RANK_3')}
                          >
                            Rank 3
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {activePreviewTemplate ? (
                    <>
                      <CertificatePreview
                        style={activePreviewTemplate.style}
                        config={activePreviewTemplate.config}
                        issuingAuthority={activePreviewTemplate.issuingAuthority}
                        subtitle={activePreviewTemplate.defaultSubtitle}
                        certificateTitle={activePreviewTemplate.defaultTitle}
                        recipientName="Fatima Zahra Al-Khatib"
                        bodyText={
                          activePreviewTemplate.requiredSignatureCount !== null
                            ? activePreviewTemplate.defaultBodyText
                            : previewSlot === 'PARTICIPATION'
                              ? 'for actively participating and completing the Academy Quiz'
                              : `in recognition of securing Rank #${previewSlot === 'RANK_1' ? 1 : previewSlot === 'RANK_2' ? 2 : previewSlot === 'RANK_3' ? 3 : 4} in the Academy Quiz`
                        }
                        subjectTitle={quizTitle}
                        achievementDetails={
                          previewSlot === 'PARTICIPATION'
                            ? 'Academy Quiz Participant · Score: 92%'
                            : `Rank #${previewSlot === 'RANK_1' ? 1 : previewSlot === 'RANK_2' ? 2 : previewSlot === 'RANK_3' ? 3 : 4} · Score: 96%`
                        }
                        sourceLabel="Academy Quiz"
                        certificateNumber="ASRA-2026-SMPL-DEMO"
                        verificationUrl="https://asraacademy.in/verify/ASRA-2026-SMPL-DEMO"
                        signatures={previewSignaturesOf(activePreviewTemplate)}
                      />
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={downloadingSample !== null}
                          onClick={() => void handleSampleDownload('png')}
                        >
                          <FileImage className="size-4" aria-hidden />
                          {downloadingSample === 'png' ? 'Generating PNG…' : 'Preview Sample PNG'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={downloadingSample !== null}
                          onClick={() => void handleSampleDownload('pdf')}
                        >
                          <FileDown className="size-4" aria-hidden />
                          {downloadingSample === 'pdf' ? 'Generating PDF…' : 'Preview Sample PDF'}
                        </Button>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        )}

        {/* STEP 3: CONFIGURE CERTIFICATE DELIVERY */}
        {step === 3 && (
          <div className="grid gap-5 lg:grid-cols-12">
            <div className="grid content-start gap-4 lg:col-span-5">
              <div className="grid gap-2">
                <p className="type-label text-heading">Certificate Format</p>
                <div className="grid gap-2">
                  {(
                    [
                      {
                        value: 'BOTH',
                        label: 'Both PDF & PNG',
                        hint: 'Students can download printable PDF and shareable PNG image.',
                      },
                      {
                        value: 'PDF',
                        label: 'PDF Only',
                        hint: 'High-resolution printable Landscape A4 PDF document.',
                      },
                      {
                        value: 'PNG',
                        label: 'PNG Image Only',
                        hint: 'High-resolution 1684×1190 PNG credential image.',
                      },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormat(opt.value)}
                      className={cn(
                        'grid gap-0.5 rounded-lg border p-3 text-left transition-colors',
                        format === opt.value
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'bg-card hover:border-primary/40',
                      )}
                    >
                      <span className="type-label text-heading">{opt.label}</span>
                      <span className="type-caption text-muted-foreground">{opt.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 rounded-xl border bg-muted/20 p-4">
                <CheckboxField
                  id="delivery-send-email"
                  label="Send congratulations email"
                  checked={sendEmail}
                  onChange={setSendEmail}
                  hint="Sent via Resend only after each certificate is successfully generated."
                />
                <CheckboxField
                  id="delivery-student-dashboard"
                  label="Make certificates available in student dashboard"
                  checked={showInStudentDashboard}
                  onChange={setShowInStudentDashboard}
                  hint="Students see their issued certificate in /student/certificates."
                />
              </div>
            </div>

            <div className="grid content-start gap-3 lg:col-span-7">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 type-label text-heading">
                  <Mail className="size-4 text-primary" aria-hidden />
                  Congratulations Email Preview
                </span>
                {!sendEmail && <Badge variant="secondary">Email delivery disabled</Badge>}
              </div>
              {previewLoading && !previewData ? (
                <LoadingPanel label="Generating email preview…" rows={4} />
              ) : previewError ? (
                <ErrorPanel message={previewError} onRetry={() => void loadServerPreview()} />
              ) : previewData ? (
                <div className="grid gap-3 rounded-xl border bg-card p-4">
                  <div className="grid gap-1 border-b pb-3 type-body-sm">
                    <p>
                      <span className="text-muted-foreground">Subject:</span>{' '}
                      <strong className="text-heading">{previewData.emailPreview.subject}</strong>
                    </p>
                  </div>
                  <div className="max-h-72 overflow-auto rounded-lg border bg-[#FDFBF5] p-3">
                    <pre className="font-sans text-xs leading-relaxed whitespace-pre-wrap text-foreground">
                      {previewData.emailPreview.text}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {/* STEP 4: FINAL REVIEW AND CONFIRMATION */}
        {step === 4 && (
          <div className="grid gap-5">
            {previewLoading && !previewData ? (
              <LoadingPanel label="Preparing final issuance summary…" rows={4} />
            ) : previewError ? (
              <ErrorPanel message={previewError} onRetry={() => void loadServerPreview()} />
            ) : previewData ? (
              <>
                <div className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-2">
                  <ReviewRow label="Quiz name" value={previewData.quiz.title} />
                  <ReviewRow
                    label="Recipient selection"
                    value={
                      MODE_OPTIONS.find((m) => m.value === previewData.recipientMode)?.label ??
                      previewData.recipientMode
                    }
                  />
                  <ReviewRow
                    label="Total unique recipients"
                    value={String(previewData.totalUniqueRecipients)}
                  />
                  <ReviewRow
                    label="Selected format"
                    value={
                      previewData.format === 'BOTH'
                        ? 'PDF & PNG'
                        : previewData.format === 'PDF'
                          ? 'PDF Only'
                          : 'PNG Only'
                    }
                  />
                  <ReviewRow
                    label="Participation template"
                    value={previewData.participationTemplateName ?? 'Not used'}
                  />
                  <ReviewRow
                    label="Rank template assignments"
                    value={
                      previewData.rankTemplateAssignments.length > 0
                        ? previewData.rankTemplateAssignments
                            .map((r) => `${r.label}: ${r.templateName}`)
                            .join(' · ')
                        : 'None'
                    }
                  />
                  <ReviewRow
                    label="Email delivery"
                    value={previewData.sendEmail ? 'Enabled (after generation)' : 'Disabled'}
                  />
                  <ReviewRow
                    label="Student dashboard"
                    value={
                      previewData.showInStudentDashboard ? 'Visible after generation' : 'Hidden'
                    }
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
                    <p className="type-caption text-muted-foreground">
                      Certificates to be generated
                    </p>
                    <p className="mt-1 type-h2 text-primary tabular-nums">
                      {previewData.toGenerateCount}
                    </p>
                  </div>
                  <div className="rounded-xl border bg-muted/30 p-4">
                    <p className="type-caption text-muted-foreground">
                      Already issued & excluded (duplicates)
                    </p>
                    <p className="mt-1 type-h2 text-heading tabular-nums">
                      {previewData.alreadyIssuedExcludedCount}
                    </p>
                  </div>
                </div>

                {previewData.toGenerateCount === 0 && (
                  <Alert tone="warning" title="Nothing new to issue">
                    <p className="type-body-sm">
                      All {previewData.totalUniqueRecipients} selected recipient(s) already have an
                      active certificate for this quiz and category. No duplicate certificates will
                      be created.
                    </p>
                  </Alert>
                )}

                {previewData.alreadyIssuedExcludedCount > 0 && previewData.toGenerateCount > 0 && (
                  <Alert tone="info" title="Duplicate protection active">
                    <p className="type-body-sm">
                      {previewData.alreadyIssuedExcludedCount} recipient(s) already have an issued
                      certificate for this category and will be skipped automatically.
                    </p>
                  </Alert>
                )}
              </>
            ) : null}
          </div>
        )}

        {/* STEP 5: LIVE PROGRESS & COMPLETION SUMMARY */}
        {step === 5 && activeBatch && (
          <QuizCertificatesProgress
            quizId={quizId}
            batchId={activeBatch.batch.id}
            canIssue={canIssue}
            initialDetail={activeBatch}
            onBatchUpdated={onCompleted}
            onViewIssuedCertificates={() => {
              onOpenChange(false);
              onViewIssuedCertificates();
            }}
          />
        )}

        <DialogFooter className="border-t pt-4">
          {step === 5 ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => {
                  if (step === 1) onOpenChange(false);
                  else setStep((prev) => (prev - 1) as 1 | 2 | 3 | 4);
                }}
              >
                {step === 1 ? (
                  'Cancel'
                ) : (
                  <>
                    <ChevronLeft className="size-4" aria-hidden /> Back
                  </>
                )}
              </Button>

              {step < 4 ? (
                <Button
                  type="button"
                  disabled={
                    (step === 1 && selectedParticipants.length === 0) ||
                    (step === 2 && Boolean(step2ValidationError))
                  }
                  onClick={() => setStep((prev) => (prev + 1) as 1 | 2 | 3 | 4)}
                >
                  Next <ChevronRight className="size-4" aria-hidden />
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={
                    !canIssue ||
                    submitting ||
                    previewLoading ||
                    !previewData ||
                    previewData.toGenerateCount === 0
                  }
                  loading={submitting}
                  loadingText="Starting issuance…"
                  onClick={() => void handleConfirmAndIssue()}
                >
                  <CheckCircle2 className="size-4" aria-hidden />
                  Confirm & Issue Certificates
                </Button>
              )}
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ParticipantIssuedBadges({
  participant,
  category,
}: {
  participant: QuizEligibleParticipantDto;
  category?: QuizCertificateCategory;
}) {
  if (category === 'PARTICIPATION') {
    if (participant.alreadyIssuedParticipation) {
      return <Badge variant="success">Issued ({participant.participationCertificateNumber})</Badge>;
    }
    if (participant.inFlightParticipation) return <Badge variant="info">In progress</Badge>;
    return <Badge variant="outline">Pending</Badge>;
  }
  if (category === 'RANK') {
    if (participant.alreadyIssuedRank) {
      return <Badge variant="success">Rank Issued ({participant.rankCertificateNumber})</Badge>;
    }
    if (participant.inFlightRank) return <Badge variant="info">In progress</Badge>;
    return <Badge variant="outline">Pending</Badge>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {participant.alreadyIssuedParticipation && (
        <Badge variant="success">Participation Issued</Badge>
      )}
      {participant.alreadyIssuedRank && <Badge variant="accent">Rank Issued</Badge>}
      {!participant.alreadyIssuedParticipation && !participant.alreadyIssuedRank && (
        <Badge variant="outline">Not issued</Badge>
      )}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="type-caption text-muted-foreground">{label}</span>
      <span className="type-body-sm font-medium text-heading">{value}</span>
    </div>
  );
}
