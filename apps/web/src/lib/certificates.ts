import type { PublicCertificateVerificationDto } from '@asra/types';
import { certificateVerifyParamsSchema } from '@asra/validation';
import { unstable_rethrow } from 'next/navigation';

import { ApiClientError, apiRequest } from '@/lib/api';

/**
 * Public certificate verification (PHASE 13, fixed in PHASE 14). Goes through `apiRequest`, whose
 * base URL (`NEXT_PUBLIC_API_URL`) already ends in `/api/v1`. "Not found" and "unavailable" stay
 * distinct: a verifier must never be told a genuine certificate does not exist because the API
 * was briefly unreachable.
 */
export type CertificateLookup =
  | { status: 'found'; data: PublicCertificateVerificationDto }
  | { status: 'not-found' }
  | { status: 'unavailable' };

const VERIFY_TIMEOUT_MS = 5_000;

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(objectUrl);
}

/** Normalises user input the same way the API validates it; `null` when it cannot be an id. */
export function normaliseCertificateNumber(value: string): string | null {
  const parsed = certificateVerifyParamsSchema.safeParse({
    certificateNumber: value.toUpperCase(),
  });
  return parsed.success ? parsed.data.certificateNumber : null;
}

export async function lookupCertificate(value: string): Promise<CertificateLookup> {
  const code = normaliseCertificateNumber(value);
  if (!code) return { status: 'not-found' };
  try {
    const data = await apiRequest<PublicCertificateVerificationDto>(
      `/certificates/verify/${encodeURIComponent(code)}`,
      { timeoutMs: VERIFY_TIMEOUT_MS },
    );
    return { status: 'found', data };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiClientError && (error.status === 404 || error.status === 422)) {
      return { status: 'not-found' };
    }
    return { status: 'unavailable' };
  }
}
