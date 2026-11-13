import fs from 'node:fs';
import path from 'node:path';
import type {
  CertificateLifecycleStatus,
  CertificateSignatureSnapshotDto,
  CertificateSourceType,
  CertificateStatus,
  CertificateTemplateSnapshotDto,
} from '@asra/types';
import { LEGACY_CERTIFICATE_TEMPLATES } from './templates.data.js';

export interface CertificateRenderData {
  certificateNumber: string;
  recipientName: string;
  certificateTitle?: string;
  courseTitle: string;
  description?: string | null;
  achievementDetails?: string | null;
  sourceType?: CertificateSourceType;
  sourceLabel?: string | null;
  completedAt: Date;
  issuedAt: Date;
  status?: CertificateStatus;
  lifecycleStatus?: CertificateLifecycleStatus;
  supersededByCertificateNumber?: string | null;
  verificationUrl: string;
  templateSnapshot?: CertificateTemplateSnapshotDto | null;
  signatureSnapshots?: CertificateSignatureSnapshotDto[] | null;
  signatureBuffers?: Map<string, Buffer>;
}

const FALLBACK_RENDER_SIGNATURES: CertificateSignatureSnapshotDto[] = [
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

let cachedEmblemPath: string | null | undefined;
let cachedEmblemDataUri: string | null | undefined;

/**
 * Searches for the ASRA Academy emblem PNG across likely workspace paths.
 */
export function findEmblemPath(): string | null {
  if (cachedEmblemPath !== undefined) return cachedEmblemPath;
  const candidates = [
    path.resolve(process.cwd(), 'apps/web/public/brand/asra-academy-emblem.png'),
    path.resolve(process.cwd(), '../web/public/brand/asra-academy-emblem.png'),
    path.resolve(process.cwd(), '../../apps/web/public/brand/asra-academy-emblem.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedEmblemPath = candidate;
      return candidate;
    }
  }
  cachedEmblemPath = null;
  return null;
}

export function readEmblemDataUri(): string | null {
  if (cachedEmblemDataUri !== undefined) return cachedEmblemDataUri;
  const emblemPath = findEmblemPath();
  if (!emblemPath) {
    cachedEmblemDataUri = null;
    return null;
  }
  try {
    const raw = fs.readFileSync(emblemPath);
    cachedEmblemDataUri = `data:image/png;base64,${raw.toString('base64')}`;
    return cachedEmblemDataUri;
  } catch {
    cachedEmblemDataUri = null;
    return null;
  }
}

export function formatCertificateDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function resolveRenderTemplate(data: CertificateRenderData): CertificateTemplateSnapshotDto {
  if (data.templateSnapshot) {
    return data.templateSnapshot;
  }
  const classic = LEGACY_CERTIFICATE_TEMPLATES[0]!;
  return {
    templateId: null,
    key: classic.key,
    name: classic.name,
    style: classic.style,
    version: 1,
    certificateTitle: data.certificateTitle || classic.defaultTitle,
    subtitle: classic.defaultSubtitle,
    bodyText: data.description || classic.defaultBodyText,
    issuingAuthority: classic.issuingAuthority,
    config: { ...classic.config, showQrCode: true },
  };
}

export function resolveRenderSignatures(
  signatures: CertificateSignatureSnapshotDto[] | null | undefined,
): CertificateSignatureSnapshotDto[] {
  if (signatures && signatures.length > 0) {
    return signatures.slice(0, 4);
  }
  return FALLBACK_RENDER_SIGNATURES;
}

export function resolveEffectiveRenderStatus(
  data: Pick<CertificateRenderData, 'status' | 'lifecycleStatus'>,
): CertificateLifecycleStatus {
  if (data.lifecycleStatus) return data.lifecycleStatus;
  return data.status === 'REVOKED' ? 'REVOKED' : 'ISSUED';
}
