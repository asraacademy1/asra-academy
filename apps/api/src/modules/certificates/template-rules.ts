import type { CertificateSignatureSnapshotDto, CertificateTemplateStyle } from '@asra/types';
import { artworkTemplateForStyle } from '@asra/validation';
import { AppError, fieldError } from '../../utils/app-error.js';
import { LEGACY_CERTIFICATE_TEMPLATES } from './templates.data.js';

/**
 * Keys of the Phase 13/17 vector templates replaced by the ASRA QUIZORA 2026 artwork template.
 * Retired templates are archived (is_active = false), never deleted: issued certificates keep
 * rendering from their immutable snapshots and verification keeps working.
 */
export const RETIRED_CERTIFICATE_TEMPLATE_KEYS: readonly string[] =
  LEGACY_CERTIFICATE_TEMPLATES.map((tpl) => tpl.key);

export function isRetiredTemplateKey(key: string): boolean {
  return RETIRED_CERTIFICATE_TEMPLATE_KEYS.includes(key);
}

/**
 * Fixed signatory count required by a layout (one per signature area of an artwork template),
 * or null when the generic 2–4 rule applies.
 */
export function requiredSignatureCountForStyle(style: CertificateTemplateStyle): number | null {
  const def = artworkTemplateForStyle(style);
  return def ? def.layout.signatureSlots.length : null;
}

export function artworkSignatureRequirementMessage(
  templateName: string,
  style: CertificateTemplateStyle = 'QUIZORA_PARTICIPATION',
): string {
  const slots = artworkTemplateForStyle(style)?.layout.signatureSlots ?? [];
  const labels = slots.map((slot, i) => `${slot.label} (position ${i + 1})`).join(' and ');
  return `Template "${templateName}" requires exactly ${slots.length} active digital signatures — ${labels}. No certificate can be previewed, generated or issued without them.`;
}

/**
 * Backend enforcement of the mandatory-signature rule for artwork templates: exactly the
 * required number of real (non-fallback) signatures, each backed by a stored image asset.
 * Never substitutes placeholder signatories.
 */
export function assertTemplateSignatureRequirement(
  template: { name: string; style: CertificateTemplateStyle },
  snapshots: CertificateSignatureSnapshotDto[],
): void {
  const required = requiredSignatureCountForStyle(template.style);
  if (required === null) return;
  const valid = snapshots.filter(
    (s) => !s.isFallback && Boolean(s.signatureId) && Boolean(s.storageKey || s.imageUrl),
  );
  if (valid.length !== required || snapshots.length !== required) {
    throw fieldError(
      'VALIDATION_ERROR',
      'signatures',
      artworkSignatureRequirementMessage(template.name, template.style),
    );
  }
}

/** Validates a template row (with its configured signature links) for new issuance. */
export function templateIssuanceProblem(tpl: {
  name: string;
  key: string;
  style: CertificateTemplateStyle;
  isActive: boolean;
  signatures: { signature: { isActive: boolean } }[];
}): string | null {
  if (isRetiredTemplateKey(tpl.key)) {
    return `Template "${tpl.name}" has been archived and cannot be used for new certificates.`;
  }
  if (!tpl.isActive) return `Template "${tpl.name}" is inactive.`;
  const activeCount = tpl.signatures.filter((link) => link.signature.isActive).length;
  const required = requiredSignatureCountForStyle(tpl.style);
  if (required !== null) {
    if (tpl.signatures.length !== required || activeCount !== required) {
      return artworkSignatureRequirementMessage(tpl.name, tpl.style);
    }
    return null;
  }
  if (tpl.signatures.length > 0 && (activeCount < 2 || activeCount > 4)) {
    return `Template "${tpl.name}" must have between 2 and 4 active digital signatures.`;
  }
  return null;
}

/**
 * Render-time guard for artwork templates: returns the signatures ordered by position with their
 * loaded image buffers, or throws — a certificate is never drawn with a blank signature area.
 */
export function requireArtworkSignatureImages(
  templateName: string,
  snapshots: CertificateSignatureSnapshotDto[] | null | undefined,
  buffers: Map<string, Buffer> | undefined,
  style: CertificateTemplateStyle = 'QUIZORA_PARTICIPATION',
): { snapshot: CertificateSignatureSnapshotDto; buffer: Buffer }[] {
  const list = [...(snapshots ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  assertTemplateSignatureRequirement({ name: templateName, style }, list);
  return list.map((snapshot) => {
    const buffer =
      (snapshot.signatureId ? buffers?.get(snapshot.signatureId) : undefined) ??
      (snapshot.storageKey ? buffers?.get(snapshot.storageKey) : undefined);
    if (!buffer || buffer.length === 0) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Digital signature image is temporarily unavailable. Please try again in a moment.',
      );
    }
    return { snapshot, buffer };
  });
}
