import {
  certificateTemplateCategoryOf,
  type AdminCertificateListItem,
  type CertificateDto,
  type CertificateLifecycleStatus,
  type CertificateSettingsDto,
  type CertificateSignatureDto,
  type CertificateSignatureSnapshotDto,
  type CertificateTemplateConfigDto,
  type CertificateTemplateDto,
  type CertificateTemplateSignatureDto,
  type CertificateTemplateSnapshotDto,
  type CertificateTemplateStyle,
} from '@asra/types';
import { isArtworkCertificateStyle } from '@asra/validation';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { SEED_TRANSACTION_OPTIONS } from '../../database/seed/access-control.seed.js';
import type { DbClient } from '../../database/types.js';
import type {
  Certificate,
  CertificateSettings,
  CertificateSignature,
  CertificateTemplate,
  CertificateTemplateSignature,
  Prisma,
  PrismaClient,
} from '../../generated/prisma/client.js';
import { certificateStorage } from './storage.service.js';
import { isRetiredTemplateKey, requiredSignatureCountForStyle } from './template-rules.js';
import { ACTIVE_CERTIFICATE_TEMPLATES, LEGACY_CERTIFICATE_TEMPLATES } from './templates.data.js';

export const DEFAULT_FALLBACK_SIGNATURES: CertificateSignatureSnapshotDto[] = [
  {
    signatureId: null,
    fullName: 'Office of Academic Affairs',
    designation: 'Academic Director, ASRA Academy',
    positionLabel: 'left',
    sortOrder: 0,
    showName: true,
    showDesignation: true,
    isFallback: true,
  },
  {
    signatureId: null,
    fullName: 'Examination & Certification Office',
    designation: 'Authorized Signatory, ASRA Academy',
    positionLabel: 'right',
    sortOrder: 1,
    showName: true,
    showDesignation: true,
    isFallback: true,
  },
];

export type TemplateWithSignatures = CertificateTemplate & {
  signatures: (CertificateTemplateSignature & { signature: CertificateSignature })[];
  _count?: { certificates: number };
};

/**
 * Idempotent certificate bootstrap (runs before template listing / issuance):
 *  1. seeds the active templates (ASRA QUIZORA 2026 — Certificate of Participation) if missing;
 *  2. retires the legacy Phase 13/17 templates by ARCHIVING them (is_active = false,
 *     is_default = false) — never deleting: issued certificates, their template & signature
 *     snapshots, verification records and audit history are untouched;
 *  3. guarantees an active default template and points the settings default at it.
 * Every write is conditional, so steady-state calls perform reads only.
 */
export async function ensureCertificateDefaults(db: DbClient = prisma): Promise<void> {
  const [existingTemplates, existingSettings] = await Promise.all([
    db.certificateTemplate.findMany({
      select: { id: true, key: true, isDefault: true, isActive: true },
    }),
    db.certificateSettings.findUnique({
      where: { id: 'default' },
      select: { id: true, defaultTemplateId: true },
    }),
  ]);

  const existingByKey = new Map(existingTemplates.map((t) => [t.key, t]));
  const activeIds = new Set(
    existingTemplates.filter((t) => t.isActive && !isRetiredTemplateKey(t.key)).map((t) => t.id),
  );
  let defaultId =
    existingTemplates.find((t) => t.isDefault && t.isActive && !isRetiredTemplateKey(t.key))?.id ??
    null;

  for (const tpl of ACTIVE_CERTIFICATE_TEMPLATES) {
    if (existingByKey.has(tpl.key)) continue;
    const created = await db.certificateTemplate.upsert({
      where: { key: tpl.key },
      update: {},
      create: {
        key: tpl.key,
        name: tpl.name,
        style: tpl.style,
        description: tpl.description,
        defaultTitle: tpl.defaultTitle,
        defaultSubtitle: tpl.defaultSubtitle,
        defaultBodyText: tpl.defaultBodyText,
        issuingAuthority: tpl.issuingAuthority,
        config: tpl.config as unknown as Prisma.InputJsonValue,
        isActive: true,
        isDefault: false,
      },
      select: { id: true, isActive: true },
    });
    if (created.isActive) activeIds.add(created.id);
  }

  const toRetire = existingTemplates.filter(
    (t) => isRetiredTemplateKey(t.key) && (t.isActive || t.isDefault),
  );
  if (toRetire.length > 0) {
    const retired = await db.certificateTemplate.updateMany({
      where: {
        id: { in: toRetire.map((t) => t.id) },
        OR: [{ isActive: true }, { isDefault: true }],
      },
      data: { isActive: false, isDefault: false },
    });
    if (retired.count > 0) {
      for (const tpl of toRetire) {
        await recordCertificateAudit(db, {
          action: 'template.archived',
          actorId: null,
          entityType: 'template',
          entityId: tpl.id,
          data: {
            key: tpl.key,
            reason: 'Replaced by ASRA QUIZORA 2026 — Certificate of Participation template.',
          },
        });
      }
    }
  }

  if (!defaultId) {
    const primary =
      ACTIVE_CERTIFICATE_TEMPLATES.find((t) => t.isDefault) ?? ACTIVE_CERTIFICATE_TEMPLATES[0];
    const target = primary
      ? await db.certificateTemplate.findUnique({
          where: { key: primary.key },
          select: { id: true, isActive: true },
        })
      : null;
    if (target?.isActive) {
      await db.certificateTemplate.updateMany({
        where: { id: { not: target.id }, isDefault: true },
        data: { isDefault: false },
      });
      await db.certificateTemplate.update({
        where: { id: target.id },
        data: { isDefault: true },
      });
      defaultId = target.id;
      activeIds.add(target.id);
    }
  }

  if (!existingSettings) {
    await db.certificateSettings.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default', defaultTemplateId: defaultId },
    });
  } else if (
    defaultId &&
    (!existingSettings.defaultTemplateId || !activeIds.has(existingSettings.defaultTemplateId))
  ) {
    await db.certificateSettings.update({
      where: { id: 'default' },
      data: { defaultTemplateId: defaultId },
    });
  }
}

export async function seedCertificateDefaults(
  client: PrismaClient = prisma,
): Promise<{ templates: number; settingsReady: boolean }> {
  return client.$transaction(async (tx) => {
    await ensureCertificateDefaults(tx);
    const [templates, settings] = await Promise.all([
      tx.certificateTemplate.count(),
      tx.certificateSettings.findUnique({ where: { id: 'default' }, select: { id: true } }),
    ]);
    return { templates, settingsReady: Boolean(settings) };
  }, SEED_TRANSACTION_OPTIONS);
}

export async function recordCertificateAudit(
  db: DbClient,
  entry: {
    action: string;
    actorId: string | null;
    entityType: 'template' | 'signature' | 'certificate' | 'settings';
    entityId: string;
    certificateId?: string | null;
    data?: Prisma.InputJsonObject;
  },
): Promise<void> {
  await db.certificateAuditLog.create({
    data: {
      action: entry.action,
      actorId: entry.actorId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      certificateId: entry.certificateId ?? null,
      ...(entry.data ? { data: entry.data } : {}),
    },
  });
}

export function normalizeTemplateConfig(raw: Prisma.JsonValue): CertificateTemplateConfigDto {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    accentColor: typeof obj.accentColor === 'string' ? obj.accentColor : '#034729',
    secondaryColor: typeof obj.secondaryColor === 'string' ? obj.secondaryColor : '#C88717',
    showLogo: typeof obj.showLogo === 'boolean' ? obj.showLogo : true,
    showSeal: typeof obj.showSeal === 'boolean' ? obj.showSeal : true,
    showQrCode: typeof obj.showQrCode === 'boolean' ? obj.showQrCode : true,
    showCompletionDate: typeof obj.showCompletionDate === 'boolean' ? obj.showCompletionDate : true,
    showIssueDate: typeof obj.showIssueDate === 'boolean' ? obj.showIssueDate : true,
    showCertificateNumber:
      typeof obj.showCertificateNumber === 'boolean' ? obj.showCertificateNumber : true,
    showSourceLabel: typeof obj.showSourceLabel === 'boolean' ? obj.showSourceLabel : true,
    footerNote: typeof obj.footerNote === 'string' ? obj.footerNote : null,
  };
}

export async function toSignatureDto(
  row: CertificateSignature,
  usageCount?: number,
  includePreview = true,
): Promise<CertificateSignatureDto> {
  const previewDataUrl = includePreview
    ? await certificateStorage().getSignaturePreviewDataUrl(
        row.storageProvider,
        row.storageKey,
        row.imageUrl,
      )
    : null;

  return {
    id: row.id,
    fullName: row.fullName,
    designation: row.designation,
    department: row.department,
    storageProvider: row.storageProvider,
    storageKey: row.storageKey,
    imageUrl: row.imageUrl,
    previewDataUrl,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    hasTransparency: row.hasTransparency,
    isActive: row.isActive,
    ...(usageCount !== undefined ? { templateUsageCount: usageCount } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function toTemplateDto(row: TemplateWithSignatures): Promise<CertificateTemplateDto> {
  const sorted = [...row.signatures].sort((a, b) => a.sortOrder - b.sortOrder);
  const signatures: CertificateTemplateSignatureDto[] = await Promise.all(
    sorted.map(async (link) => ({
      id: link.id,
      signatureId: link.signatureId,
      sortOrder: link.sortOrder,
      positionLabel: link.positionLabel,
      showName: link.showName,
      showDesignation: link.showDesignation,
      signature: await toSignatureDto(link.signature, undefined, true),
    })),
  );

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    style: row.style,
    category: certificateTemplateCategoryOf(row.style),
    requiredSignatureCount: requiredSignatureCountForStyle(row.style),
    isRetired: isRetiredTemplateKey(row.key),
    description: row.description,
    defaultTitle: row.defaultTitle,
    defaultSubtitle: row.defaultSubtitle,
    defaultBodyText: row.defaultBodyText,
    issuingAuthority: row.issuingAuthority,
    config: normalizeTemplateConfig(row.config),
    version: row.version,
    isActive: row.isActive,
    isDefault: row.isDefault,
    signatures,
    ...(row._count ? { issuedCount: row._count.certificates } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSettingsDto(row: CertificateSettings): CertificateSettingsDto {
  return {
    academyName: row.academyName,
    academyTagline: row.academyTagline,
    defaultTemplateId: row.defaultTemplateId,
    verificationNotice: row.verificationNotice,
    showQrOnCertificates: row.showQrOnCertificates,
    autoIssueOnCourseCompletion: row.autoIssueOnCourseCompletion,
    autoIssueOnQuizCompletion: row.autoIssueOnQuizCompletion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type CertificateWithReissues = Certificate & {
  reissues?: { certificateNumber: string }[];
};

const VALID_TEMPLATE_STYLES = new Set<CertificateTemplateStyle>([
  'CLASSIC_INSTITUTIONAL',
  'MODERN_MINIMAL',
  'PREMIUM_ACHIEVEMENT',
  'QUIZORA_PARTICIPATION',
  'QUIZORA_PARTICIPATION_DESIGN_2',
]);

export function resolveCertificateLifecycleStatus(
  cert: Pick<CertificateWithReissues, 'status' | 'idempotencyKey' | 'revokedReason' | 'reissues'>,
): {
  lifecycleStatus: CertificateLifecycleStatus;
  supersededByCertificateNumber: string | null;
} {
  const supersededByCertificateNumber = cert.reissues?.[0]?.certificateNumber ?? null;
  const isSuperseded =
    cert.status === 'REVOKED' &&
    (Boolean(supersededByCertificateNumber) ||
      Boolean(cert.idempotencyKey?.startsWith('SUPERSEDED:')) ||
      Boolean(cert.revokedReason?.startsWith('Superseded by reissue:')));
  return {
    lifecycleStatus: isSuperseded ? 'SUPERSEDED' : cert.status,
    supersededByCertificateNumber,
  };
}

export async function hydrateSignatureSnapshots(
  raw: Prisma.JsonValue | null | undefined,
): Promise<CertificateSignatureSnapshotDto[] | null> {
  if (!Array.isArray(raw)) return null;
  const list = raw as unknown as CertificateSignatureSnapshotDto[];
  return Promise.all(
    list.map(async (snap) => {
      if (snap.imageUrl || snap.isFallback || !snap.storageKey) {
        return snap;
      }
      const previewDataUrl = await certificateStorage().getSignaturePreviewDataUrl(
        snap.storageProvider,
        snap.storageKey,
        snap.imageUrl,
      );
      return { ...snap, previewDataUrl };
    }),
  );
}

/**
 * Parses a stored `templateSnapshot` JSON value or synthesizes a safe Classic Institutional
 * compatibility snapshot when rendering legacy Phase 13 rows that predate `template_snapshot`.
 */
export function parseTemplateSnapshot(
  raw: Prisma.JsonValue | null | undefined,
  legacyFallback?: { certificateTitle?: string | null; description?: string | null },
): CertificateTemplateSnapshotDto {
  const classic = LEGACY_CERTIFICATE_TEMPLATES[0]!;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      templateId: null,
      key: classic.key,
      name: classic.name,
      style: classic.style,
      version: 1,
      certificateTitle: legacyFallback?.certificateTitle?.trim() || classic.defaultTitle,
      subtitle: classic.defaultSubtitle,
      bodyText: legacyFallback?.description?.trim() || classic.defaultBodyText,
      issuingAuthority: classic.issuingAuthority,
      config: { ...classic.config, showQrCode: true },
    };
  }
  const obj = raw as Record<string, unknown>;
  const rawStyle =
    typeof obj.style === 'string' &&
    VALID_TEMPLATE_STYLES.has(obj.style as CertificateTemplateStyle)
      ? (obj.style as CertificateTemplateStyle)
      : classic.style;
  const baseConfig = normalizeTemplateConfig((obj.config as Prisma.JsonValue) ?? {});
  return {
    templateId: typeof obj.templateId === 'string' ? obj.templateId : null,
    key: typeof obj.key === 'string' && obj.key.trim() ? obj.key : classic.key,
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name : classic.name,
    style: rawStyle,
    version: typeof obj.version === 'number' && Number.isFinite(obj.version) ? obj.version : 1,
    certificateTitle:
      typeof obj.certificateTitle === 'string' && obj.certificateTitle.trim()
        ? obj.certificateTitle
        : legacyFallback?.certificateTitle?.trim() || classic.defaultTitle,
    subtitle: typeof obj.subtitle === 'string' ? obj.subtitle : classic.defaultSubtitle,
    bodyText:
      typeof obj.bodyText === 'string' && obj.bodyText.trim()
        ? obj.bodyText
        : legacyFallback?.description?.trim() || classic.defaultBodyText,
    issuingAuthority:
      typeof obj.issuingAuthority === 'string' && obj.issuingAuthority.trim()
        ? obj.issuingAuthority
        : classic.issuingAuthority,
    config: { ...baseConfig, showQrCode: true },
  };
}

/**
 * Resolves immutable signature snapshots from JSON or falls back safely to the institutional
 * two-signatory defaults for legacy Phase 13 records created before Phase 17.
 */
export function resolveCertificateSignatureSnapshots(
  raw: Prisma.JsonValue | null | undefined,
): CertificateSignatureSnapshotDto[] {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw as unknown as CertificateSignatureSnapshotDto[];
  }
  return DEFAULT_FALLBACK_SIGNATURES;
}

export function buildVerificationUrl(certificateNumber: string): string {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
  return `${base}/verify/${certificateNumber}`;
}

export function toCertificateDto(
  cert: CertificateWithReissues,
  hydratedSignatures?: CertificateSignatureSnapshotDto[] | null,
): CertificateDto {
  const { lifecycleStatus, supersededByCertificateNumber } =
    resolveCertificateLifecycleStatus(cert);
  const templateSnapshot = parseTemplateSnapshot(cert.templateSnapshot, {
    certificateTitle: cert.certificateTitle,
    description: cert.description,
  });
  const signatureSnapshots =
    hydratedSignatures && hydratedSignatures.length > 0
      ? hydratedSignatures
      : resolveCertificateSignatureSnapshots(cert.signatureSnapshots);

  return {
    id: cert.id,
    certificateNumber: cert.certificateNumber,
    enrollmentId: cert.enrollmentId,
    userId: cert.userId,
    courseId: cert.courseId,
    academyQuizId: cert.academyQuizId,
    examinationId: cert.examinationId,
    sourceType: cert.sourceType,
    sourceReferenceId: cert.sourceReferenceId,
    sourceLabel: cert.sourceLabel,
    templateId: cert.templateId,
    recipientName: cert.recipientName,
    recipientEmail: cert.recipientEmail,
    recipientStudentCode: cert.recipientStudentCode,
    certificateTitle: cert.certificateTitle,
    courseTitle: cert.courseTitle,
    description: cert.description,
    achievementDetails: isArtworkCertificateStyle(templateSnapshot.style)
      ? null
      : cert.achievementDetails,
    completedAt: cert.completedAt.toISOString(),
    issuedAt: cert.issuedAt.toISOString(),
    status: cert.status,
    lifecycleStatus,
    supersededByCertificateNumber,
    revokedAt: cert.revokedAt ? cert.revokedAt.toISOString() : null,
    revokedReason: cert.revokedReason,
    metadata: (cert.metadata as Record<string, unknown>) ?? null,
    templateSnapshot,
    signatureSnapshots,
    reissuedFromId: cert.reissuedFromId,
    certificateCategory:
      cert.certificateCategory === 'PARTICIPATION' || cert.certificateCategory === 'RANK'
        ? cert.certificateCategory
        : null,
    quizRank: cert.quizRank ?? null,
    issuedFormats: (cert.issuedFormats?.length ? cert.issuedFormats : ['PDF', 'PNG']) as (
      'PDF' | 'PNG'
    )[],
    visibleInStudentDashboard: cert.visibleInStudentDashboard,
    verificationUrl: buildVerificationUrl(cert.certificateNumber),
    downloadUrl: `/api/v1/student/certificates/${cert.id}/download`,
    pngDownloadUrl: `/api/v1/student/certificates/${cert.id}/download/png`,
  };
}

export function toAdminCertificateListItem(
  row: CertificateWithReissues & {
    user?: { email: string } | null;
    issuedBy?: { fullName: string } | null;
    template?: { name: string } | null;
  },
  hydratedSignatures?: CertificateSignatureSnapshotDto[] | null,
): AdminCertificateListItem {
  const { lifecycleStatus, supersededByCertificateNumber } = resolveCertificateLifecycleStatus(row);
  const templateSnapshot = parseTemplateSnapshot(row.templateSnapshot, {
    certificateTitle: row.certificateTitle,
    description: row.description,
  });
  const sigs =
    hydratedSignatures && hydratedSignatures.length > 0
      ? hydratedSignatures
      : resolveCertificateSignatureSnapshots(row.signatureSnapshots);

  return {
    id: row.id,
    certificateNumber: row.certificateNumber,
    enrollmentId: row.enrollmentId,
    userId: row.userId,
    recipientName: row.recipientName,
    studentEmail: row.user?.email ?? row.recipientEmail ?? null,
    recipientStudentCode: row.recipientStudentCode,
    courseId: row.courseId,
    academyQuizId: row.academyQuizId,
    examinationId: row.examinationId,
    sourceType: row.sourceType,
    sourceReferenceId: row.sourceReferenceId,
    sourceLabel: row.sourceLabel,
    templateId: row.templateId,
    templateName: row.template?.name ?? templateSnapshot.name,
    certificateTitle: row.certificateTitle,
    courseTitle: row.courseTitle,
    description: row.description,
    achievementDetails: isArtworkCertificateStyle(templateSnapshot.style)
      ? null
      : row.achievementDetails,
    completedAt: row.completedAt.toISOString(),
    issuedAt: row.issuedAt.toISOString(),
    status: row.status,
    lifecycleStatus,
    supersededByCertificateNumber,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedReason: row.revokedReason,
    issuedByName: row.issuedBy?.fullName ?? null,
    reissuedFromId: row.reissuedFromId,
    signatureCount: sigs.filter((s) => !s.isFallback).length || sigs.length,
    templateSnapshot,
    signatureSnapshots: sigs,
    certificateCategory:
      row.certificateCategory === 'PARTICIPATION' || row.certificateCategory === 'RANK'
        ? row.certificateCategory
        : null,
    quizRank: row.quizRank ?? null,
    issuedFormats: (row.issuedFormats?.length ? row.issuedFormats : ['PDF', 'PNG']) as (
      'PDF' | 'PNG'
    )[],
    visibleInStudentDashboard: row.visibleInStudentDashboard,
    verificationUrl: buildVerificationUrl(row.certificateNumber),
    downloadUrl: `/api/v1/admin/certificates/${row.id}/download`,
    pngDownloadUrl: `/api/v1/admin/certificates/${row.id}/download/png`,
  };
}
