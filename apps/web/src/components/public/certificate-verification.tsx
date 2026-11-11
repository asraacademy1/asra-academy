'use client';

import type { CertificateSourceType, PublicCertificateVerificationDto } from '@asra/types';
import { SOURCE_TYPE_LABELS } from '@asra/validation';
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  Copy,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import * as React from 'react';

import { CertificateSourceBadge } from '@/components/certificates/certificate-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { lookupCertificate, type CertificateLookup } from '@/lib/certificates';
import { formatDate } from '@/lib/format';

interface Props {
  initialCode?: string;
  /** Server-side lookup for `/verify/<id>`; omitted on the empty search page. */
  initialLookup?: CertificateLookup | null;
}

const SUBJECT_FIELD_LABELS: Record<CertificateSourceType, string> = {
  COURSE: 'Course',
  ACADEMY_QUIZ: 'Academy Quiz',
  COMPETITION: 'Competition',
  EXAM: 'Examination',
  EVENT: 'Event',
  WORKSHOP: 'Workshop',
  TRAINING: 'Training Program',
  MANUAL: 'Program / Recognition',
  CUSTOM: 'Program / Recognition',
};

export function CertificateVerificationView({ initialCode = '', initialLookup = null }: Props) {
  const [code, setCode] = React.useState(initialCode);
  const [lookup, setLookup] = React.useState<CertificateLookup | null>(initialLookup);
  const [loading, setLoading] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const data: PublicCertificateVerificationDto | null =
    lookup?.status === 'found' ? lookup.data : null;
  const isNotFound = lookup?.status === 'not-found';
  const isUnavailable = lookup?.status === 'unavailable';

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;

    setLoading(true);
    setLookup(null);
    try {
      const result = await lookupCertificate(trimmed);
      setLookup(result);
      if (result.status === 'found') {
        // Update URL without full page reload
        window.history.replaceState(null, '', `/verify/${encodeURIComponent(trimmed)}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    if (!data?.certificateNumber) return;
    navigator.clipboard.writeText(data.certificateNumber);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="container mx-auto max-w-4xl space-y-8 px-4 py-12">
      {/* Header */}
      <div className="space-y-3 text-center">
        <div className="mb-2 inline-flex items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">
          <Award className="h-8 w-8 text-emerald-700" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          Certificate Verification
        </h1>
        <p className="mx-auto max-w-2xl text-base text-muted-foreground sm:text-lg">
          Verify the authenticity and academic standing of any credential issued by ASRA Academy.
        </p>
      </div>

      {/* Lookup Bar */}
      <Card className="border-border shadow-sm">
        <CardContent className="p-4 sm:p-6">
          <form onSubmit={handleSearch} className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute top-3 left-3.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Certificate ID"
                placeholder="Enter Certificate ID (e.g. ASRA-2026-F9KC-M28V)"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="pl-10 font-mono tracking-wide uppercase"
              />
            </div>
            <Button
              type="submit"
              disabled={loading}
              className="bg-emerald-800 text-white hover:bg-emerald-900"
            >
              {loading ? 'Verifying...' : 'Verify Certificate'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Verification Result */}
      {data && (
        <Card className="overflow-hidden border-2 border-emerald-600/30 shadow-md">
          {/* Status Banner */}
          {(() => {
            const effective = data.lifecycleStatus ?? data.status;
            const isValid = effective === 'ISSUED' && data.valid;
            const isSuperseded = effective === 'SUPERSEDED';
            return (
              <div
                className={`flex items-center gap-3 p-4 text-white ${
                  isValid ? 'bg-emerald-800' : isSuperseded ? 'bg-amber-800' : 'bg-red-800'
                }`}
              >
                {isValid ? (
                  <>
                    <ShieldCheck className="h-6 w-6 flex-shrink-0 text-emerald-300" />
                    <div>
                      <h3 className="text-lg font-semibold">Authentic & Verified Certificate</h3>
                      <p className="text-xs text-emerald-100 sm:text-sm">
                        This official credential was issued by ASRA Academy and is in good standing.
                      </p>
                    </div>
                  </>
                ) : isSuperseded ? (
                  <>
                    <ShieldAlert className="h-6 w-6 flex-shrink-0 text-amber-200" />
                    <div>
                      <h3 className="text-lg font-semibold">
                        Certificate Superseded (No Longer Valid)
                      </h3>
                      <p className="text-xs text-amber-100 sm:text-sm">
                        This credential has been replaced by a newer reissued certificate and is no
                        longer valid.
                        {data.supersededByCertificateNumber && (
                          <>
                            {' '}
                            Replacement ID:{' '}
                            <a
                              href={`/verify/${encodeURIComponent(data.supersededByCertificateNumber)}`}
                              className="font-mono font-semibold underline"
                            >
                              {data.supersededByCertificateNumber}
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-6 w-6 flex-shrink-0 text-red-200" />
                    <div>
                      <h3 className="text-lg font-semibold">Certificate Revoked</h3>
                      <p className="text-xs text-red-200 sm:text-sm">
                        This credential was officially revoked by academy administration.
                      </p>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          <CardContent className="space-y-6 p-6 sm:p-8">
            {/* Certificate Header Branding */}
            <div className="flex flex-col justify-between gap-4 border-b pb-6 sm:flex-row sm:items-center">
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold tracking-wider text-amber-700 uppercase">
                    {data.academyName}
                  </span>
                  <CertificateSourceBadge
                    sourceType={data.sourceType}
                    sourceLabel={data.sourceLabel}
                  />
                </div>
                <h2 className="text-2xl font-bold text-slate-900">
                  {data.certificateTitle || 'Certificate of Completion'}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded border bg-slate-100 px-3 py-1.5 font-mono text-sm text-slate-800">
                  {data.certificateNumber}
                </span>
                <Button size="icon" variant="outline" onClick={copyToClipboard} title="Copy ID">
                  {copied ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Recipient and Program Details */}
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase">
                  Presented To
                </span>
                <p className="text-xl font-bold text-slate-900">{data.recipientName}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase">
                  {SUBJECT_FIELD_LABELS[data.sourceType] ?? SOURCE_TYPE_LABELS[data.sourceType]}
                </span>
                <p className="text-xl font-bold text-emerald-900">{data.courseTitle}</p>
              </div>
              {data.achievementDetails && (
                <div className="space-y-1 sm:col-span-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase">
                    Recognition / Achievement
                  </span>
                  <p className="text-base font-semibold text-amber-900">
                    {data.achievementDetails}
                  </p>
                </div>
              )}
              {data.description && (
                <div className="space-y-1 sm:col-span-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase">
                    Credential Statement
                  </span>
                  <p className="text-sm text-slate-700">{data.description}</p>
                </div>
              )}
              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase">
                  {data.sourceType === 'COURSE' ? 'Completion Date' : 'Achievement Date'}
                </span>
                <p className="text-base font-medium text-slate-800">
                  {formatDate(data.completedAt)}
                </p>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase">
                  Issue Date
                </span>
                <p className="text-base font-medium text-slate-800">{formatDate(data.issuedAt)}</p>
              </div>
            </div>

            {data.signatories && data.signatories.length > 0 && (
              <div className="space-y-2 border-t pt-4">
                <span className="text-xs font-semibold text-muted-foreground uppercase">
                  Authorized Signatories
                </span>
                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
                  {data.signatories.map((sig, idx) => (
                    <div
                      key={`${sig.fullName}-${sig.designation}-${idx}`}
                      className="rounded-md border bg-slate-50/70 px-3 py-2"
                    >
                      <p className="text-sm font-semibold text-slate-900">{sig.fullName}</p>
                      <p className="text-xs text-slate-600">{sig.designation}</p>
                      {sig.department && (
                        <p className="text-[11px] text-slate-500">{sig.department}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Revocation / Superseded Details */}
            {(data.status !== 'ISSUED' || !data.valid) && (
              <div
                className={`space-y-1 rounded-lg border p-4 ${
                  (data.lifecycleStatus ?? data.status) === 'SUPERSEDED'
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-red-200 bg-red-50 text-red-900'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <AlertTriangle
                    className={`h-4 w-4 ${
                      (data.lifecycleStatus ?? data.status) === 'SUPERSEDED'
                        ? 'text-amber-700'
                        : 'text-red-600'
                    }`}
                  />
                  {(data.lifecycleStatus ?? data.status) === 'SUPERSEDED'
                    ? 'Superseded Credential Notice'
                    : 'Revocation Notice'}
                </div>
                {data.revokedAt && (
                  <p className="text-xs opacity-90">Recorded on: {formatDate(data.revokedAt)}</p>
                )}
                {data.revokedReason && (
                  <p className="mt-1 text-xs opacity-95">Reason: {data.revokedReason}</p>
                )}
                {data.supersededByCertificateNumber && (
                  <p className="mt-1 text-xs font-medium">
                    Active replacement:{' '}
                    <span className="font-mono font-semibold">
                      {data.supersededByCertificateNumber}
                    </span>
                  </p>
                )}
              </div>
            )}

            {/* Footer Trust Note */}
            <div className="flex flex-col items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground sm:flex-row">
              <span className="text-center sm:text-left">
                Tamper-resistant credential registered in ASRA Academy central database.
              </span>
              <Badge
                variant="outline"
                className="border-emerald-300 bg-emerald-50 text-emerald-800"
              >
                Official Credential
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Not Found State */}
      {isNotFound && (
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="space-y-3 p-8 text-center">
            <div className="mb-1 inline-flex items-center justify-center rounded-full bg-red-100 p-3 text-red-700">
              <AlertTriangle className="h-7 w-7" />
            </div>
            <h3 className="text-xl font-bold text-red-900">Certificate Not Found</h3>
            <p className="mx-auto max-w-md text-sm text-red-700">
              No matching certificate was found for identifier{' '}
              <span className="font-mono font-semibold">{code}</span>. Please verify the code and
              try again.
            </p>
          </CardContent>
        </Card>
      )}

      {isUnavailable && (
        <Card className="border-amber-200 bg-amber-50/50" role="status">
          <CardContent className="space-y-3 p-8 text-center">
            <div className="mb-1 inline-flex items-center justify-center rounded-full bg-amber-100 p-3 text-amber-800">
              <AlertTriangle className="h-7 w-7" />
            </div>
            <h3 className="text-xl font-bold text-amber-900">Verification unavailable</h3>
            <p className="mx-auto max-w-md text-sm text-amber-800">
              The verification service could not be reached, so this certificate could not be
              checked. This does not mean it is invalid — please try again in a moment.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
