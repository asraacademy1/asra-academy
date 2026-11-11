import type {
  CertificateSignatureSnapshotDto,
  CertificateTemplateDto,
  CertificateTemplateSnapshotDto,
} from '@asra/types';
import {
  CERTIFICATE_SIGNATURE_LIMITS,
  type CertificateSignaturePlacementInput,
  type UpdateCertificateTemplateInput,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { adminAudit } from '../admin/audit.js';
import {
  buildVerificationUrl,
  DEFAULT_FALLBACK_SIGNATURES,
  ensureCertificateDefaults,
  normalizeTemplateConfig,
  recordCertificateAudit,
  toTemplateDto,
} from './bootstrap.js';
import { generateCertificatePdf } from './pdf.service.js';
import { generateCertificatePng } from './png.service.js';
import { certificateStorage } from './storage.service.js';

const templateInclude = {
  signatures: {
    include: { signature: true },
    orderBy: { sortOrder: 'asc' as const },
  },
  _count: { select: { certificates: true } },
} satisfies Prisma.CertificateTemplateInclude;

export async function lockSignatureRows(db: DbClient, signatureIds: string[]): Promise<void> {
  const sortedIds = [...new Set(signatureIds)].sort();
  if (sortedIds.length === 0) return;
  await db.$queryRaw`
    SELECT "id" FROM "certificate_signatures"
    WHERE "id" IN (${Prisma.join(sortedIds.map((sigId) => Prisma.sql`${sigId}::uuid`))})
    ORDER BY "id" ASC
    FOR SHARE
  `;
}

export async function validateAndBuildSignatureSnapshots(
  db: DbClient,
  placements: CertificateSignaturePlacementInput[],
): Promise<CertificateSignatureSnapshotDto[]> {
  if (
    placements.length < CERTIFICATE_SIGNATURE_LIMITS.minSignatures ||
    placements.length > CERTIFICATE_SIGNATURE_LIMITS.maxSignatures
  ) {
    throw fieldError(
      'VALIDATION_ERROR',
      'signatures',
      `Select between ${CERTIFICATE_SIGNATURE_LIMITS.minSignatures} and ${CERTIFICATE_SIGNATURE_LIMITS.maxSignatures} signatures`,
    );
  }

  const seenOrders = new Set<number>();
  for (const placement of placements) {
    if (
      !Number.isInteger(placement.sortOrder) ||
      placement.sortOrder < 0 ||
      placement.sortOrder >= CERTIFICATE_SIGNATURE_LIMITS.maxSignatures
    ) {
      throw fieldError(
        'VALIDATION_ERROR',
        'signatures',
        'Signature position order must be between 0 and 3.',
      );
    }
    if (seenOrders.has(placement.sortOrder)) {
      throw fieldError(
        'VALIDATION_ERROR',
        'signatures',
        'Signature order positions must be unique.',
      );
    }
    seenOrders.add(placement.sortOrder);
  }

  const ordered = [...placements].sort((a, b) => a.sortOrder - b.sortOrder);
  const ids = ordered.map((p) => p.signatureId);
  await lockSignatureRows(db, ids);
  const rows = await db.certificateSignature.findMany({
    where: { id: { in: ids } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const seen = new Set<string>();
  const snapshots: CertificateSignatureSnapshotDto[] = [];

  for (const placement of ordered) {
    if (seen.has(placement.signatureId)) {
      throw fieldError(
        'VALIDATION_ERROR',
        'signatures',
        'The same signature cannot be selected twice on a single certificate.',
      );
    }
    seen.add(placement.signatureId);

    const sig = byId.get(placement.signatureId);
    if (!sig) {
      throw fieldError('VALIDATION_ERROR', 'signatures', 'Selected signature was not found.');
    }
    if (!sig.isActive) {
      throw fieldError(
        'VALIDATION_ERROR',
        'signatures',
        `Signature "${sig.fullName}" is inactive and cannot be selected.`,
      );
    }

    snapshots.push({
      signatureId: sig.id,
      fullName: sig.fullName,
      designation: sig.designation,
      department: sig.department,
      positionLabel: placement.positionLabel,
      sortOrder: placement.sortOrder,
      showName: placement.showName,
      showDesignation: placement.showDesignation,
      storageProvider: sig.storageProvider,
      storageKey: sig.storageKey,
      imageUrl: sig.imageUrl,
      width: sig.width,
      height: sig.height,
      isFallback: false,
    });
  }

  return snapshots;
}

export const templatesService = {
  async list(): Promise<CertificateTemplateDto[]> {
    await ensureCertificateDefaults(prisma);
    const rows = await prisma.certificateTemplate.findMany({
      include: templateInclude,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return Promise.all(rows.map(toTemplateDto));
  },

  async getById(id: string): Promise<CertificateTemplateDto> {
    await ensureCertificateDefaults(prisma);
    const row = await prisma.certificateTemplate.findUnique({
      where: { id },
      include: templateInclude,
    });
    if (!row) {
      throw new AppError('NOT_FOUND', 'Certificate template not found');
    }
    return toTemplateDto(row);
  },

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateCertificateTemplateInput,
  ): Promise<CertificateTemplateDto> {
    await ensureCertificateDefaults(prisma);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('asra_cert_config'))`;
      const [lockedTpl] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "certificate_templates" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      if (!lockedTpl) {
        throw new AppError('NOT_FOUND', 'Certificate template not found');
      }

      const existing = await tx.certificateTemplate.findUniqueOrThrow({
        where: { id },
        include: { signatures: { include: { signature: true } } },
      });

      if (input.isActive === false && existing.isDefault) {
        throw fieldError(
          'VALIDATION_ERROR',
          'isActive',
          'The default certificate template cannot be deactivated. Choose another default template first.',
        );
      }

      if (input.signatures !== undefined) {
        await validateAndBuildSignatureSnapshots(tx, input.signatures);
        await tx.certificateTemplateSignature.deleteMany({ where: { templateId: id } });
        await tx.certificateTemplateSignature.createMany({
          data: input.signatures.map((sig) => ({
            templateId: id,
            signatureId: sig.signatureId,
            sortOrder: sig.sortOrder,
            positionLabel: sig.positionLabel,
            showName: sig.showName,
            showDesignation: sig.showDesignation,
          })),
        });
      } else if (existing.signatures.length > 0) {
        const activeCount = existing.signatures.filter((s) => s.signature.isActive).length;
        if (activeCount < CERTIFICATE_SIGNATURE_LIMITS.minSignatures) {
          throw fieldError(
            'VALIDATION_ERROR',
            'signatures',
            `Template must have at least ${CERTIFICATE_SIGNATURE_LIMITS.minSignatures} active digital signatures.`,
          );
        }
      }

      if (input.isDefault === true) {
        await tx.certificateTemplate.updateMany({
          where: { id: { not: id }, isDefault: true },
          data: { isDefault: false },
        });
        await tx.certificateSettings.updateMany({
          where: { id: 'default' },
          data: { defaultTemplateId: id, updatedById: auth.userId },
        });
      }

      const currentConfig = normalizeTemplateConfig(existing.config);
      const nextConfig = input.config ? { ...currentConfig, ...input.config } : currentConfig;

      const row = await tx.certificateTemplate.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.defaultTitle !== undefined ? { defaultTitle: input.defaultTitle } : {}),
          ...(input.defaultSubtitle !== undefined
            ? { defaultSubtitle: input.defaultSubtitle }
            : {}),
          ...(input.defaultBodyText !== undefined
            ? { defaultBodyText: input.defaultBodyText }
            : {}),
          ...(input.issuingAuthority !== undefined
            ? { issuingAuthority: input.issuingAuthority }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          config: nextConfig as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
          updatedById: auth.userId,
        },
        include: templateInclude,
      });

      await recordCertificateAudit(tx, {
        action: 'template.updated',
        actorId: auth.userId,
        entityType: 'template',
        entityId: id,
        data: {
          key: row.key,
          version: row.version,
          isActive: row.isActive,
          isDefault: row.isDefault,
          signatureCount: row.signatures.length,
        },
      });

      await adminAudit(tx, {
        action: 'certificate.template_updated',
        actorId: auth.userId,
        entityType: 'certificate_template',
        entityId: id,
        data: { key: row.key, version: row.version },
      });

      return row;
    });

    return toTemplateDto(updated);
  },

  async generateSampleDocument(
    templateId: string,
    format: 'pdf' | 'png' = 'pdf',
  ): Promise<{ buffer: Buffer; filename: string; mimeType: 'application/pdf' | 'image/png' }> {
    const tpl = await templatesService.getById(templateId);
    const buffers = new Map<string, Buffer>();
    const signatureSnapshots: CertificateSignatureSnapshotDto[] = [];

    for (const link of tpl.signatures) {
      if (!link.signature.isActive) continue;
      const buf = await certificateStorage().readSignaturePng(
        link.signature.storageProvider,
        link.signature.storageKey,
        link.signature.imageUrl,
      );
      if (!buf || buf.length === 0) {
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          'Digital signature image is temporarily unavailable. Please try previewing again in a moment.',
        );
      }
      buffers.set(link.signature.id, buf);
      signatureSnapshots.push({
        signatureId: link.signature.id,
        fullName: link.signature.fullName,
        designation: link.signature.designation,
        department: link.signature.department,
        positionLabel: link.positionLabel,
        sortOrder: link.sortOrder,
        showName: link.showName,
        showDesignation: link.showDesignation,
        storageProvider: link.signature.storageProvider,
        storageKey: link.signature.storageKey,
        imageUrl: link.signature.imageUrl,
        width: link.signature.width,
        height: link.signature.height,
        isFallback: false,
      });
    }

    if (signatureSnapshots.length === 0) {
      signatureSnapshots.push(...DEFAULT_FALLBACK_SIGNATURES);
    }

    const sampleSnapshot: CertificateTemplateSnapshotDto = {
      templateId: tpl.id,
      key: tpl.key,
      name: tpl.name,
      style: tpl.style,
      version: tpl.version,
      certificateTitle: tpl.defaultTitle,
      subtitle: tpl.defaultSubtitle,
      bodyText: tpl.defaultBodyText,
      issuingAuthority: tpl.issuingAuthority,
      config: tpl.config,
    };

    const now = new Date();
    const sampleCode = 'ASRA-2026-SMPL-DEMO';
    const renderInput = {
      certificateNumber: sampleCode,
      recipientName: 'Fatima Zahra Al-Khatib',
      certificateTitle: tpl.defaultTitle,
      courseTitle: 'Foundations of Classical Arabic & Tajweed',
      description: tpl.defaultBodyText,
      achievementDetails:
        tpl.style === 'PREMIUM_ACHIEVEMENT' ? 'First Class Distinction · Top Performer' : null,
      sourceType: 'COURSE' as const,
      sourceLabel: 'Sample Preview',
      completedAt: now,
      issuedAt: now,
      status: 'ISSUED' as const,
      lifecycleStatus: 'ISSUED' as const,
      verificationUrl: buildVerificationUrl(sampleCode),
      templateSnapshot: sampleSnapshot,
      signatureSnapshots,
      signatureBuffers: buffers,
    };

    try {
      if (format === 'png') {
        const buffer = await generateCertificatePng(renderInput);
        return {
          buffer,
          filename: `ASRA-Template-${tpl.key}-Preview.png`,
          mimeType: 'image/png',
        };
      }
      const buffer = await generateCertificatePdf(renderInput);
      return {
        buffer,
        filename: `ASRA-Template-${tpl.key}-Preview.pdf`,
        mimeType: 'application/pdf',
      };
    } finally {
      buffers.clear();
    }
  },

  async generateSamplePdf(templateId: string): Promise<{ buffer: Buffer; filename: string }> {
    const doc = await templatesService.generateSampleDocument(templateId, 'pdf');
    return { buffer: doc.buffer, filename: doc.filename };
  },
};
