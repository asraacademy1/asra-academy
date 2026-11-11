import type { CertificateSignatureDto, Paginated } from '@asra/types';
import {
  CERTIFICATE_SIGNATURE_LIMITS,
  type CertificateSignatureQuery,
  type CreateCertificateSignatureInput,
  type UpdateCertificateSignatureInput,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../lib/logger.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { adminAudit } from '../admin/audit.js';
import { recordCertificateAudit, toSignatureDto } from './bootstrap.js';
import { certificateStorage, validateSignaturePng } from './storage.service.js';

export const signaturesService = {
  async list(query: CertificateSignatureQuery): Promise<Paginated<CertificateSignatureDto>> {
    const { skip, take } = pageArgs(query);
    const where: Prisma.CertificateSignatureWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { designation: { contains: query.search, mode: 'insensitive' } },
              { department: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.certificateSignature.findMany({
        where,
        skip,
        take,
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
        include: { _count: { select: { templates: true } } },
      }),
      prisma.certificateSignature.count({ where }),
    ]);

    const items = await Promise.all(
      rows.map((row) => toSignatureDto(row, row._count.templates, true)),
    );
    return paginated(items, total, query);
  },

  async listActive(): Promise<CertificateSignatureDto[]> {
    const rows = await prisma.certificateSignature.findMany({
      where: { isActive: true },
      orderBy: [{ fullName: 'asc' }, { createdAt: 'desc' }],
      include: { _count: { select: { templates: true } } },
    });
    return Promise.all(rows.map((row) => toSignatureDto(row, row._count.templates, true)));
  },

  async getById(id: string): Promise<CertificateSignatureDto> {
    const row = await prisma.certificateSignature.findUnique({
      where: { id },
      include: { _count: { select: { templates: true } } },
    });
    if (!row) {
      throw new AppError('NOT_FOUND', 'Digital signature not found');
    }
    return toSignatureDto(row, row._count.templates, true);
  },

  async create(
    auth: AuthContext,
    input: CreateCertificateSignatureInput,
    pngBuffer: Buffer,
    contentType?: string,
  ): Promise<CertificateSignatureDto> {
    const sniffed = validateSignaturePng(pngBuffer, contentType);
    const stored = await certificateStorage().storeSignaturePng(pngBuffer);

    try {
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.certificateSignature.create({
          data: {
            fullName: input.fullName,
            designation: input.designation,
            department: input.department ?? null,
            storageProvider: stored.storageProvider,
            storageKey: stored.storageKey,
            imageUrl: stored.imageUrl,
            mimeType: 'image/png',
            width: sniffed.width,
            height: sniffed.height,
            bytes: sniffed.bytes,
            hasTransparency: sniffed.hasTransparency,
            isActive: input.isActive,
            createdById: auth.userId,
            updatedById: auth.userId,
          },
          include: { _count: { select: { templates: true } } },
        });

        await recordCertificateAudit(tx, {
          action: 'signature.created',
          actorId: auth.userId,
          entityType: 'signature',
          entityId: row.id,
          data: {
            fullName: row.fullName,
            designation: row.designation,
            department: row.department,
            isActive: row.isActive,
            hasTransparency: row.hasTransparency,
          },
        });

        await adminAudit(tx, {
          action: 'certificate.signature_created',
          actorId: auth.userId,
          entityType: 'certificate_signature',
          entityId: row.id,
          data: {
            fullName: row.fullName,
            designation: row.designation,
          },
        });

        return row;
      });

      return toSignatureDto(created, created._count.templates, true);
    } catch (error) {
      await certificateStorage()
        .destroySignaturePng(stored.storageProvider, stored.storageKey)
        .catch(() => undefined);
      throw error;
    }
  },

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateCertificateSignatureInput,
    pngBuffer?: Buffer,
    contentType?: string,
  ): Promise<CertificateSignatureDto> {
    const precheck = await prisma.certificateSignature.findUnique({ where: { id } });
    if (!precheck) {
      throw new AppError('NOT_FOUND', 'Digital signature not found');
    }

    let replacementAsset: {
      storageProvider: string;
      storageKey: string;
      imageUrl: string | null;
      width: number;
      height: number;
      bytes: number;
      hasTransparency: boolean;
    } | null = null;

    if (pngBuffer && pngBuffer.length > 0) {
      const sniffed = validateSignaturePng(pngBuffer, contentType);
      const stored = await certificateStorage().storeSignaturePng(pngBuffer);
      replacementAsset = {
        ...stored,
        width: sniffed.width,
        height: sniffed.height,
        bytes: sniffed.bytes,
        hasTransparency: sniffed.hasTransparency,
      };
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('asra_cert_config'))`;

        // Lock templates that reference this signature first, then lock the signature row
        await tx.$queryRaw`
          SELECT "id" FROM "certificate_templates"
          WHERE "id" IN (
            SELECT "template_id" FROM "certificate_template_signatures"
            WHERE "signature_id" = ${id}::uuid
          )
          ORDER BY "id" ASC
          FOR UPDATE
        `;
        const [lockedSig] = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "certificate_signatures" WHERE "id" = ${id}::uuid FOR UPDATE
        `;
        if (!lockedSig) {
          throw new AppError('NOT_FOUND', 'Digital signature not found');
        }

        const existing = await tx.certificateSignature.findUniqueOrThrow({ where: { id } });

        if (input.isActive === false) {
          const activeTemplates = await tx.certificateTemplate.findMany({
            where: {
              isActive: true,
              signatures: { some: { signatureId: id } },
            },
            include: {
              signatures: {
                include: { signature: { select: { id: true, isActive: true } } },
              },
            },
          });

          for (const tpl of activeTemplates) {
            const remainingActive = tpl.signatures.filter(
              (link) => link.signatureId !== id && link.signature.isActive,
            ).length;
            if (remainingActive < CERTIFICATE_SIGNATURE_LIMITS.minSignatures) {
              throw fieldError(
                'VALIDATION_ERROR',
                'isActive',
                `Cannot deactivate "${existing.fullName}" because active template "${tpl.name}" would have fewer than ${CERTIFICATE_SIGNATURE_LIMITS.minSignatures} active signatures. Replace it on the template before deactivating.`,
              );
            }
          }
        }

        const row = await tx.certificateSignature.update({
          where: { id },
          data: {
            ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
            ...(input.designation !== undefined ? { designation: input.designation } : {}),
            ...(input.department !== undefined ? { department: input.department } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(replacementAsset
              ? {
                  storageProvider: replacementAsset.storageProvider,
                  storageKey: replacementAsset.storageKey,
                  imageUrl: replacementAsset.imageUrl,
                  width: replacementAsset.width,
                  height: replacementAsset.height,
                  bytes: replacementAsset.bytes,
                  hasTransparency: replacementAsset.hasTransparency,
                }
              : {}),
            updatedById: auth.userId,
          },
          include: { _count: { select: { templates: true } } },
        });

        const action = replacementAsset
          ? 'signature.replaced'
          : input.isActive !== undefined && input.isActive !== existing.isActive
            ? input.isActive
              ? 'signature.activated'
              : 'signature.deactivated'
            : 'signature.updated';

        await recordCertificateAudit(tx, {
          action,
          actorId: auth.userId,
          entityType: 'signature',
          entityId: row.id,
          data: {
            fullName: row.fullName,
            designation: row.designation,
            isActive: row.isActive,
            imageReplaced: Boolean(replacementAsset),
          },
        });

        await adminAudit(tx, {
          action: 'certificate.signature_updated',
          actorId: auth.userId,
          entityType: 'certificate_signature',
          entityId: row.id,
          data: {
            action,
            fullName: row.fullName,
            designation: row.designation,
            isActive: row.isActive,
          },
        });

        let shouldDestroyOld = false;
        if (replacementAsset && existing.storageKey !== replacementAsset.storageKey) {
          const referencedByHistory = await tx.certificate.findFirst({
            where: {
              signatureSnapshots: {
                path: [],
                array_contains: [{ storageKey: existing.storageKey }],
              },
            },
            select: { id: true },
          });
          shouldDestroyOld = !referencedByHistory;
        }

        return { row, existing, shouldDestroyOld };
      });

      if (result.shouldDestroyOld) {
        await certificateStorage()
          .destroySignaturePng(result.existing.storageProvider, result.existing.storageKey)
          .catch((err) => {
            logger.warn(
              { err, signatureId: id, storageKey: result.existing.storageKey },
              'Failed to destroy replaced signature image from storage',
            );
          });
      }

      return toSignatureDto(result.row, result.row._count.templates, true);
    } catch (error) {
      if (replacementAsset) {
        await certificateStorage()
          .destroySignaturePng(replacementAsset.storageProvider, replacementAsset.storageKey)
          .catch(() => undefined);
      }
      throw error;
    }
  },
};
