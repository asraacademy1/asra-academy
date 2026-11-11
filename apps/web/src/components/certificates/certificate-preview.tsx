'use client';

import type {
  AdminCertificateListItem,
  CertificateDto,
  CertificateLifecycleStatus,
  CertificateSignatureDto,
  CertificateSignatureSnapshotDto,
  CertificateSourceType,
  CertificateStatus,
  CertificateTemplateConfigDto,
  CertificateTemplateStyle,
} from '@asra/types';
import { SOURCE_TYPE_LABELS } from '@asra/validation';
import QRCode from 'qrcode';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PreviewSignatureItem {
  key: string;
  fullName: string;
  designation: string;
  department?: string | null;
  positionLabel?: string;
  showName: boolean;
  showDesignation: boolean;
  imageSrc?: string | null;
}

export interface CertificatePreviewProps {
  style: CertificateTemplateStyle;
  config: CertificateTemplateConfigDto;
  issuingAuthority: string;
  subtitle?: string | null;
  certificateTitle: string;
  recipientName: string;
  bodyText: string;
  subjectTitle: string;
  achievementDetails?: string | null;
  sourceLabel?: string | null;
  completedAt?: string | null;
  issuedAt?: string | null;
  certificateNumber: string;
  verificationUrl: string;
  signatures: PreviewSignatureItem[];
  status?: CertificateStatus;
  lifecycleStatus?: CertificateLifecycleStatus;
  supersededByCertificateNumber?: string | null;
  compact?: boolean;
  className?: string;
}

function QrMatrixSvg({
  value,
  color = '#012114',
  className,
}: {
  value: string;
  color?: string;
  className?: string;
}) {
  const qr = React.useMemo(() => {
    try {
      return QRCode.create(value || 'https://asraacademy-one.vercel.app/verify', {
        errorCorrectionLevel: 'M',
      });
    } catch {
      return null;
    }
  }, [value]);

  if (!qr) return null;
  const count = qr.modules.size;
  const rects: React.ReactNode[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.modules.get(row, col)) {
        rects.push(
          <rect key={`${row}-${col}`} x={col} y={row} width={1} height={1} fill={color} />,
        );
      }
    }
  }

  return (
    <svg
      viewBox={`-2 -2 ${count + 4} ${count + 4}`}
      className={cn('bg-white', className)}
      role="img"
      aria-label="Certificate verification QR code"
    >
      <rect x={-2} y={-2} width={count + 4} height={count + 4} fill="#FFFFFF" />
      {rects}
    </svg>
  );
}

function SignatureColumn({
  sig,
  compact,
  lineColor,
  nameClass,
  roleClass,
}: {
  sig: PreviewSignatureItem;
  compact?: boolean;
  lineColor: string;
  nameClass: string;
  roleClass: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center text-center">
      <div
        className={cn(
          'relative flex w-full items-end justify-center px-2',
          compact ? 'h-7' : 'h-12',
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-2 bottom-1 h-4/5 rounded-full bg-white/60 blur-[2px]"
        />
        {sig.imageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- signature PNG with preserved original transparency and visual enhancement
          <img
            src={sig.imageSrc}
            alt={`${sig.fullName} signature`}
            className="relative z-10 max-h-full max-w-full object-contain select-none"
            style={{
              filter:
                'drop-shadow(0 2px 5px rgba(1, 33, 20, 0.16)) drop-shadow(0 0 6px rgba(255, 255, 255, 0.8)) contrast(1.06)',
            }}
          />
        ) : (
          <span
            className={cn(
              'relative z-10 pb-0.5 font-serif text-slate-400 italic select-none',
              compact ? 'text-[8px]' : 'text-xs',
            )}
          >
            Signature
          </span>
        )}
      </div>
      <div className="mt-0.5 h-px w-full max-w-[165px]" style={{ backgroundColor: lineColor }} />
      {sig.showName && (
        <p
          className={cn(
            'mt-1 w-full truncate font-semibold',
            compact ? 'text-[7px] leading-tight' : 'text-[11px] leading-tight',
            nameClass,
          )}
          title={sig.fullName}
        >
          {sig.fullName}
        </p>
      )}
      {sig.showDesignation && (
        <p
          className={cn(
            'w-full truncate',
            compact ? 'text-[6px] leading-tight' : 'text-[9.5px] leading-tight',
            roleClass,
          )}
          title={sig.department ? `${sig.designation} · ${sig.department}` : sig.designation}
        >
          {sig.department ? `${sig.designation} · ${sig.department}` : sig.designation}
        </p>
      )}
    </div>
  );
}

function safeFormat(dateStr?: string | null): string {
  const fallback = formatDate(new Date().toISOString()) ?? '—';
  if (!dateStr) return fallback;
  const parsed = new Date(dateStr);
  return Number.isNaN(parsed.getTime()) ? fallback : (formatDate(dateStr) ?? fallback);
}

export function CertificatePreview({
  style,
  config,
  issuingAuthority,
  subtitle,
  certificateTitle,
  recipientName,
  bodyText,
  subjectTitle,
  achievementDetails,
  sourceLabel,
  completedAt,
  issuedAt,
  certificateNumber,
  verificationUrl,
  signatures,
  status = 'ISSUED',
  lifecycleStatus,
  supersededByCertificateNumber,
  compact = false,
  className,
}: CertificatePreviewProps) {
  const effectiveStatus: CertificateLifecycleStatus = lifecycleStatus ?? status;
  const sigList =
    signatures.length > 0
      ? signatures.slice(0, 4)
      : [
          {
            key: 'fallback-1',
            fullName: 'Authorized Signatory',
            designation: 'Academic Director, ASRA Academy',
            showName: true,
            showDesignation: true,
            imageSrc: null,
          },
        ];

  const displayName = recipientName.trim() || 'Student Full Name';
  const displaySubject = subjectTitle.trim() || 'Course or Achievement Title';
  const displayTitle = (certificateTitle.trim() || 'CERTIFICATE OF COMPLETION').toUpperCase();
  const displayBody = bodyText.trim() || 'has successfully fulfilled all requirements for';
  const nameLength = displayName.length;

  const recipientSizeClass = compact
    ? nameLength > 34
      ? 'text-[11px]'
      : 'text-sm'
    : nameLength > 42
      ? 'text-lg sm:text-xl'
      : nameLength > 28
        ? 'text-xl sm:text-2xl'
        : 'text-2xl sm:text-3xl';

  const primary = config.accentColor || '#034729';
  const gold = config.secondaryColor || '#C88717';

  return (
    <div
      data-slot="certificate-preview"
      data-template-style={style}
      className={cn(
        'relative aspect-[842/595] w-full overflow-hidden rounded-xl border shadow-raised select-none',
        className,
      )}
    >
      {/* Template 01: Classic / Institutional */}
      {style === 'CLASSIC_INSTITUTIONAL' && (
        <div
          className="relative flex h-full w-full flex-col justify-between bg-[#FDFBF7]"
          style={{ padding: compact ? '12px' : '22px' }}
        >
          <div
            className="relative flex h-full w-full flex-col justify-between border-[3px]"
            style={{ borderColor: gold, padding: compact ? '3px' : '5px' }}
          >
            <div
              className="relative flex h-full w-full flex-col justify-between border"
              style={{ borderColor: '#012114', padding: compact ? '10px 14px' : '18px 28px' }}
            >
              {/* Header */}
              <div className="flex flex-col items-center text-center">
                {config.showLogo && (
                  // eslint-disable-next-line @next/next/no-img-element -- static brand emblem
                  <img
                    src="/brand/asra-academy-emblem.png"
                    alt="ASRA Academy"
                    className={cn('object-contain', compact ? 'mb-1 h-5 w-5' : 'mb-1.5 h-10 w-10')}
                  />
                )}
                <p
                  className={cn(
                    'font-serif font-bold tracking-[0.18em] text-[#012114] uppercase',
                    compact ? 'text-[9px]' : 'text-base sm:text-lg',
                  )}
                >
                  {issuingAuthority || 'ASRA Academy'}
                </p>
                {subtitle && (
                  <p
                    className={cn(
                      'tracking-[0.16em] uppercase',
                      compact ? 'text-[5.5px]' : 'text-[9px]',
                    )}
                    style={{ color: gold }}
                  >
                    {subtitle}
                  </p>
                )}
                {config.showSourceLabel && sourceLabel && (
                  <span
                    className={cn(
                      'mt-1 inline-block rounded-full border bg-[#F4EFE2] font-semibold tracking-wider uppercase',
                      compact ? 'px-1.5 py-0 text-[5px]' : 'px-2.5 py-0.5 text-[8.5px]',
                    )}
                    style={{ borderColor: gold, color: primary }}
                  >
                    {sourceLabel}
                  </span>
                )}
                <h3
                  className={cn(
                    'mt-1.5 font-serif font-bold tracking-[0.16em] uppercase',
                    compact ? 'text-[9px]' : 'text-base sm:text-xl',
                  )}
                  style={{ color: primary }}
                >
                  {displayTitle}
                </h3>
                <div className={cn('mt-1 flex items-center gap-2', compact ? 'w-20' : 'w-44')}>
                  <div className="h-px flex-1" style={{ backgroundColor: gold }} />
                  <div className="size-1.5 rounded-full" style={{ backgroundColor: primary }} />
                  <div className="h-px flex-1" style={{ backgroundColor: gold }} />
                </div>
              </div>

              {/* Body */}
              <div className="my-auto flex flex-col items-center px-4 text-center">
                <p
                  className={cn(
                    'font-serif text-slate-600 italic',
                    compact ? 'text-[7px]' : 'text-xs',
                  )}
                >
                  This is to certify that
                </p>
                <p
                  className={cn(
                    'mt-0.5 max-w-full font-serif font-bold break-words text-[#012114]',
                    recipientSizeClass,
                  )}
                >
                  {displayName}
                </p>
                <div
                  className={cn('mt-1 h-px', compact ? 'w-28' : 'w-64')}
                  style={{ backgroundColor: '#D89E34' }}
                />
                <p
                  className={cn(
                    'mt-1.5 max-w-xl font-serif text-slate-700',
                    compact ? 'line-clamp-2 text-[6.5px]' : 'text-xs',
                  )}
                >
                  {displayBody}
                </p>
                <p
                  className={cn(
                    'mt-1 max-w-xl font-serif font-bold break-words',
                    compact ? 'line-clamp-1 text-[8.5px]' : 'text-base sm:text-lg',
                  )}
                  style={{ color: primary }}
                >
                  {displaySubject}
                </p>
                {achievementDetails && (
                  <p
                    className={cn(
                      'mt-0.5 font-serif text-[#8A5A0B] italic',
                      compact ? 'text-[6.5px]' : 'text-xs',
                    )}
                  >
                    {achievementDetails}
                  </p>
                )}
              </div>

              {/* Signatures */}
              <div
                className={cn(
                  'flex items-end justify-center gap-4 px-2',
                  compact ? 'mb-1' : 'mb-2',
                )}
              >
                {sigList.map((sig) => (
                  <SignatureColumn
                    key={sig.key}
                    sig={sig}
                    compact={compact}
                    lineColor="#94A3B8"
                    nameClass="text-[#012114]"
                    roleClass="text-slate-600"
                  />
                ))}
              </div>

              {/* Footer */}
              <div className="flex items-end justify-between border-t border-slate-200 pt-1.5">
                <div
                  className={cn('space-y-0.5 text-left', compact ? 'text-[5.5px]' : 'text-[9.5px]')}
                >
                  {config.showCompletionDate && (
                    <p className="text-slate-700">
                      <span className="font-semibold text-[#012114]">Completed:</span>{' '}
                      {safeFormat(completedAt)}
                    </p>
                  )}
                  {config.showIssueDate && (
                    <p className="text-slate-700">
                      <span className="font-semibold text-[#012114]">Issued:</span>{' '}
                      {safeFormat(issuedAt)}
                    </p>
                  )}
                  {config.showCertificateNumber && (
                    <p className="font-mono font-semibold" style={{ color: primary }}>
                      ID: {certificateNumber}
                    </p>
                  )}
                  {config.footerNote && !compact && (
                    <p className="font-serif text-[8.5px] text-slate-500 italic">
                      {config.footerNote}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  {config.showSeal && !compact && (
                    <div
                      className="flex size-12 flex-col items-center justify-center rounded-full border-2 text-center"
                      style={{ borderColor: gold }}
                    >
                      <span
                        className="text-[6px] font-bold tracking-wider"
                        style={{ color: primary }}
                      >
                        OFFICIAL
                      </span>
                      <span
                        className="text-[6px] font-bold tracking-wider"
                        style={{ color: primary }}
                      >
                        SEAL
                      </span>
                      <span className="text-[4.5px] font-semibold" style={{ color: gold }}>
                        ASRA
                      </span>
                    </div>
                  )}
                  {config.showQrCode && (
                    <div className="flex flex-col items-center">
                      <QrMatrixSvg
                        value={verificationUrl}
                        color="#012114"
                        className={cn(
                          'rounded border border-slate-300 p-0.5',
                          compact ? 'size-6' : 'size-12',
                        )}
                      />
                      {!compact && (
                        <span className="mt-0.5 text-[6.5px] font-semibold tracking-wider text-slate-500">
                          SCAN TO VERIFY
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Template 02: Modern / Minimal */}
      {style === 'MODERN_MINIMAL' && (
        <div className="relative flex h-full w-full bg-white">
          <div className="h-full w-3 shrink-0" style={{ backgroundColor: primary }} />
          <div className="h-full w-1 shrink-0 bg-[#E4A735]" />
          <div
            className={cn(
              'flex flex-1 flex-col justify-between border border-l-0 border-slate-200',
              compact ? 'm-2 p-3' : 'm-4 p-6 sm:p-7',
            )}
          >
            {/* Top row */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                {config.showLogo && (
                  // eslint-disable-next-line @next/next/no-img-element -- static brand emblem
                  <img
                    src="/brand/asra-academy-emblem.png"
                    alt="ASRA Academy"
                    className={cn('object-contain', compact ? 'size-5' : 'size-8')}
                  />
                )}
                <div>
                  <p
                    className={cn(
                      'font-bold tracking-wider text-[#13211A] uppercase',
                      compact ? 'text-[8px]' : 'text-xs sm:text-sm',
                    )}
                  >
                    {issuingAuthority || 'ASRA Academy'}
                  </p>
                  {subtitle && (
                    <p
                      className={cn(
                        'tracking-wider text-[#6B8577] uppercase',
                        compact ? 'text-[5px]' : 'text-[8.5px]',
                      )}
                    >
                      {subtitle}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-start gap-2.5">
                {config.showSourceLabel && sourceLabel && (
                  <Badge
                    variant="outline"
                    className={cn(
                      'border-emerald-200 bg-emerald-50 font-semibold text-emerald-900 uppercase',
                      compact ? 'px-1.5 py-0 text-[5.5px]' : 'text-[9px]',
                    )}
                  >
                    {sourceLabel}
                  </Badge>
                )}
                {config.showQrCode && (
                  <div className="flex flex-col items-center">
                    <QrMatrixSvg
                      value={verificationUrl}
                      color="#13211A"
                      className={cn(
                        'rounded border border-slate-200 p-0.5',
                        compact ? 'size-6' : 'size-12',
                      )}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="my-auto space-y-2 text-left">
              <div>
                <h3
                  className={cn(
                    'font-bold tracking-wide uppercase',
                    compact ? 'text-[10px]' : 'text-lg sm:text-2xl',
                  )}
                  style={{ color: primary }}
                >
                  {displayTitle}
                </h3>
                <div className={cn('mt-1 bg-[#E4A735]', compact ? 'h-0.5 w-8' : 'h-1 w-16')} />
              </div>

              <div className="pt-1">
                <p
                  className={cn(
                    'font-semibold tracking-[0.2em] text-[#6B8577] uppercase',
                    compact ? 'text-[5.5px]' : 'text-[9px]',
                  )}
                >
                  Presented To
                </p>
                <p
                  className={cn('mt-0.5 font-bold break-words text-[#13211A]', recipientSizeClass)}
                >
                  {displayName}
                </p>
              </div>

              <div>
                <p
                  className={cn(
                    'max-w-xl text-slate-600',
                    compact ? 'line-clamp-2 text-[6.5px]' : 'text-xs',
                  )}
                >
                  {displayBody}
                </p>
                <p
                  className={cn(
                    'mt-0.5 font-bold break-words',
                    compact ? 'line-clamp-1 text-[8.5px]' : 'text-base sm:text-lg',
                  )}
                  style={{ color: primary }}
                >
                  {displaySubject}
                </p>
              </div>

              {achievementDetails && (
                <div
                  className={cn(
                    'inline-block rounded-r border-l-2 bg-emerald-50/70 font-semibold text-emerald-950',
                    compact ? 'px-1.5 py-0.5 text-[6px]' : 'px-3 py-1 text-[10.5px]',
                  )}
                  style={{ borderColor: primary }}
                >
                  {achievementDetails}
                </div>
              )}
            </div>

            {/* Signatures */}
            <div className={cn('flex items-end gap-4', compact ? 'mb-1' : 'mb-2')}>
              {sigList.map((sig) => (
                <SignatureColumn
                  key={sig.key}
                  sig={sig}
                  compact={compact}
                  lineColor="#CBD5E1"
                  nameClass="text-[#13211A]"
                  roleClass="text-slate-500"
                />
              ))}
            </div>

            {/* Footer */}
            <div
              className={cn(
                'flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-1.5',
                compact ? 'text-[5.5px]' : 'text-[9.5px]',
              )}
            >
              <div className="flex flex-wrap gap-x-5 gap-y-0.5">
                {config.showCompletionDate && (
                  <span>
                    <strong className="text-slate-500 uppercase">Completed:</strong>{' '}
                    <span className="font-medium text-slate-900">{safeFormat(completedAt)}</span>
                  </span>
                )}
                {config.showIssueDate && (
                  <span>
                    <strong className="text-slate-500 uppercase">Issued:</strong>{' '}
                    <span className="font-medium text-slate-900">{safeFormat(issuedAt)}</span>
                  </span>
                )}
              </div>
              {config.showCertificateNumber && (
                <span className="font-mono font-bold" style={{ color: primary }}>
                  {certificateNumber}
                </span>
              )}
            </div>
            {config.footerNote && !compact && (
              <p className="truncate text-[8.5px] text-slate-500 italic">{config.footerNote}</p>
            )}
          </div>
        </div>
      )}

      {/* Template 03: Premium / Achievement */}
      {style === 'PREMIUM_ACHIEVEMENT' && (
        <div className="relative flex h-full w-full flex-col justify-between bg-[#FAF6EE]">
          {/* Top Crest Bar */}
          <div
            className={cn(
              'flex items-center justify-between border-b-2 border-[#D89E34]',
              compact ? 'px-3 py-1.5' : 'px-6 py-3',
            )}
            style={{ backgroundColor: primary }}
          >
            <div className="flex items-center gap-2.5">
              {config.showLogo && (
                <div
                  className={cn(
                    'flex items-center justify-center rounded-full bg-[#FDFBF7]',
                    compact ? 'size-5 p-0.5' : 'size-9 p-1',
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- static brand emblem */}
                  <img
                    src="/brand/asra-academy-emblem.png"
                    alt="ASRA Academy"
                    className="size-full object-contain"
                  />
                </div>
              )}
              <div>
                <p
                  className={cn(
                    'font-serif font-bold tracking-[0.16em] uppercase',
                    compact ? 'text-[8px]' : 'text-sm',
                  )}
                  style={{ color: gold }}
                >
                  {issuingAuthority || 'ASRA Academy'}
                </p>
                {subtitle && (
                  <p
                    className={cn(
                      'tracking-[0.14em] text-emerald-100 uppercase',
                      compact ? 'text-[5px]' : 'text-[8px]',
                    )}
                  >
                    {subtitle}
                  </p>
                )}
              </div>
            </div>

            {config.showSourceLabel && sourceLabel && (
              <span
                className={cn(
                  'rounded-full border bg-[#034729] font-semibold tracking-wider text-[#FDFBF7] uppercase',
                  compact ? 'px-1.5 py-0.5 text-[5px]' : 'px-3 py-0.5 text-[9px]',
                )}
                style={{ borderColor: gold }}
              >
                {sourceLabel}
              </span>
            )}
          </div>

          {/* Inner Frame */}
          <div
            className={cn(
              'flex flex-1 flex-col justify-between border border-[#C88717]',
              compact ? 'm-1.5 p-2' : 'm-3 p-4 sm:px-7 sm:py-4',
            )}
          >
            <div className="my-auto flex flex-col items-center text-center">
              <h3
                className={cn(
                  'font-serif font-bold tracking-[0.18em] text-[#012114] uppercase',
                  compact ? 'text-[9px]' : 'text-base sm:text-xl',
                )}
              >
                {displayTitle}
              </h3>
              <div className={cn('my-1 flex items-center gap-2', compact ? 'w-20' : 'w-48')}>
                <div className="h-px flex-1 bg-[#C88717]" />
                <div className="size-1.5 rotate-45 bg-[#D89E34]" />
                <div className="h-px flex-1 bg-[#C88717]" />
              </div>

              <p
                className={cn(
                  'mt-1 font-semibold tracking-[0.2em] text-[#8A5A0B] uppercase',
                  compact ? 'text-[5.5px]' : 'text-[9px]',
                )}
              >
                Proudly Awarded To
              </p>
              <p
                className={cn(
                  'mt-0.5 max-w-full font-serif font-bold break-words text-[#012114]',
                  recipientSizeClass,
                )}
              >
                {displayName}
              </p>

              <p
                className={cn(
                  'mt-1 max-w-xl font-serif text-slate-700',
                  compact ? 'line-clamp-2 text-[6.5px]' : 'text-xs',
                )}
              >
                {displayBody}
              </p>
              <p
                className={cn(
                  'mt-0.5 max-w-xl font-serif font-bold break-words text-[#034729]',
                  compact ? 'line-clamp-1 text-[8.5px]' : 'text-base sm:text-lg',
                )}
              >
                {displaySubject}
              </p>
              {achievementDetails && (
                <div
                  className={cn(
                    'mt-1.5 inline-block rounded-full border border-[#D89E34] bg-[#FFFDF8] font-serif text-[#8A5A0B] italic',
                    compact ? 'px-2 py-0 text-[6px]' : 'px-4 py-0.5 text-[10.5px]',
                  )}
                >
                  {achievementDetails}
                </div>
              )}
            </div>

            {/* Signatures */}
            <div className={cn('flex items-end justify-center gap-4', compact ? 'mb-1' : 'mb-1.5')}>
              {sigList.map((sig) => (
                <SignatureColumn
                  key={sig.key}
                  sig={sig}
                  compact={compact}
                  lineColor="#C88717"
                  nameClass="font-serif text-[#012114]"
                  roleClass="text-slate-600"
                />
              ))}
            </div>

            {/* Metadata + Seal + QR */}
            <div className="flex items-end justify-between pt-1">
              <div className={cn('space-y-0.5 text-left', compact ? 'text-[5.5px]' : 'text-[9px]')}>
                {config.showCompletionDate && (
                  <p className="text-slate-700">
                    <span className="font-semibold text-[#012114]">Achievement Date:</span>{' '}
                    {safeFormat(completedAt)}
                  </p>
                )}
                {config.showIssueDate && (
                  <p className="text-slate-700">
                    <span className="font-semibold text-[#012114]">Issued:</span>{' '}
                    {safeFormat(issuedAt)}
                  </p>
                )}
                {config.showCertificateNumber && (
                  <p className="font-mono font-bold text-[#034729]">ID: {certificateNumber}</p>
                )}
              </div>

              <div className="flex items-center gap-2.5">
                {config.showSeal && !compact && (
                  <div className="flex size-11 flex-col items-center justify-center rounded-full border-2 border-[#C88717] bg-white/70 text-center">
                    <span className="text-[5.5px] font-bold text-[#034729]">OFFICIAL</span>
                    <span className="text-[5.5px] font-bold text-[#034729]">SEAL</span>
                    <span className="text-[4.5px] font-semibold text-[#C88717]">ASRA</span>
                  </div>
                )}
                {config.showQrCode && (
                  <QrMatrixSvg
                    value={verificationUrl}
                    color="#012114"
                    className={cn(
                      'rounded border border-[#C88717] p-0.5',
                      compact ? 'size-6' : 'size-11',
                    )}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Bottom Crest Bar */}
          <div
            className={cn(
              'border-t-2 border-[#D89E34] text-center text-[#F6F1E4]',
              compact ? 'py-0.5 text-[5px]' : 'py-1.5 text-[9px]',
            )}
            style={{ backgroundColor: primary }}
          >
            {config.footerNote ? `${config.footerNote} · ` : ''}Verify credential online:{' '}
            {verificationUrl}
          </div>
        </div>
      )}

      {/* Revoked / Superseded Status Watermark Overlay */}
      {effectiveStatus === 'REVOKED' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-red-950/10">
          <span className="-rotate-12 rounded-lg border-4 border-red-700/70 px-6 py-2 text-2xl font-black tracking-[0.2em] text-red-700/80 uppercase sm:text-4xl">
            Revoked
          </span>
        </div>
      )}
      {effectiveStatus === 'SUPERSEDED' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-amber-950/10">
          <span className="-rotate-12 rounded-lg border-4 border-amber-700/75 bg-amber-50/75 px-6 py-2 text-xl font-black tracking-[0.18em] text-amber-800/90 uppercase sm:text-3xl">
            Superseded
          </span>
          {supersededByCertificateNumber && !compact && (
            <span className="-rotate-12 rounded bg-amber-900/85 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-amber-50">
              Replaced by {supersededByCertificateNumber}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export const DEFAULT_CERTIFICATE_PREVIEW_CONFIG: CertificateTemplateConfigDto = {
  accentColor: '#034729',
  secondaryColor: '#C88717',
  showLogo: true,
  showSeal: true,
  showQrCode: true,
  showCompletionDate: true,
  showIssueDate: true,
  showCertificateNumber: true,
  showSourceLabel: true,
};

export function certificateSignatureImageSrc(
  sig:
    | Pick<CertificateSignatureDto, 'imageUrl' | 'previewDataUrl'>
    | Pick<CertificateSignatureSnapshotDto, 'imageUrl' | 'previewDataUrl'>,
): string | null {
  return sig.imageUrl || sig.previewDataUrl || null;
}

export function certificateToPreviewProps(
  cert: Pick<
    CertificateDto | AdminCertificateListItem,
    | 'certificateNumber'
    | 'certificateTitle'
    | 'recipientName'
    | 'courseTitle'
    | 'description'
    | 'achievementDetails'
    | 'sourceLabel'
    | 'completedAt'
    | 'issuedAt'
    | 'verificationUrl'
    | 'status'
    | 'lifecycleStatus'
    | 'supersededByCertificateNumber'
    | 'templateSnapshot'
    | 'signatureSnapshots'
  >,
): Omit<CertificatePreviewProps, 'compact' | 'className'> {
  return {
    style: cert.templateSnapshot?.style ?? 'CLASSIC_INSTITUTIONAL',
    config: cert.templateSnapshot?.config ?? DEFAULT_CERTIFICATE_PREVIEW_CONFIG,
    issuingAuthority: cert.templateSnapshot?.issuingAuthority ?? 'ASRA Academy',
    subtitle: cert.templateSnapshot?.subtitle,
    certificateTitle: cert.certificateTitle,
    recipientName: cert.recipientName,
    bodyText: cert.description ?? cert.templateSnapshot?.bodyText ?? 'has successfully completed',
    subjectTitle: cert.courseTitle,
    achievementDetails: cert.achievementDetails,
    sourceLabel: cert.sourceLabel,
    completedAt: cert.completedAt,
    issuedAt: cert.issuedAt,
    certificateNumber: cert.certificateNumber,
    verificationUrl: cert.verificationUrl,
    status: cert.status,
    lifecycleStatus: cert.lifecycleStatus,
    supersededByCertificateNumber: cert.supersededByCertificateNumber,
    signatures: (cert.signatureSnapshots ?? []).map((sig, i) => ({
      key: `${sig.signatureId ?? 'fallback'}-${i}`,
      fullName: sig.fullName,
      designation: sig.designation,
      department: sig.department,
      positionLabel: sig.positionLabel,
      showName: sig.showName,
      showDesignation: sig.showDesignation,
      imageSrc: certificateSignatureImageSrc(sig),
    })),
  };
}

export function resolveEffectiveStatus(
  cert: Pick<CertificateDto | AdminCertificateListItem, 'status' | 'lifecycleStatus'>,
): CertificateLifecycleStatus {
  return cert.lifecycleStatus ?? cert.status;
}

export function CertificateLifecycleBadge({
  status,
  lifecycleStatus,
  reason,
}: {
  status: CertificateStatus;
  lifecycleStatus?: CertificateLifecycleStatus;
  reason?: string | null;
}) {
  const effective = lifecycleStatus ?? status;
  if (effective === 'ISSUED') {
    return <Badge variant="success">Issued</Badge>;
  }
  if (effective === 'SUPERSEDED') {
    return (
      <Badge
        variant="outline"
        className="border-amber-400 bg-amber-50 text-amber-900"
        title={reason ?? undefined}
      >
        Superseded
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" title={reason ?? undefined}>
      Revoked
    </Badge>
  );
}

const SOURCE_STYLE: Record<CertificateSourceType, string> = {
  COURSE: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  ACADEMY_QUIZ: 'border-amber-300 bg-amber-50 text-amber-900',
  COMPETITION: 'border-violet-300 bg-violet-50 text-violet-900',
  EXAM: 'border-sky-300 bg-sky-50 text-sky-900',
  EVENT: 'border-teal-300 bg-teal-50 text-teal-900',
  WORKSHOP: 'border-indigo-300 bg-indigo-50 text-indigo-900',
  TRAINING: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  MANUAL: 'border-slate-300 bg-slate-100 text-slate-800',
  CUSTOM: 'border-amber-300 bg-amber-50 text-amber-800',
};

export function CertificateSourceBadge({
  sourceType,
  sourceLabel,
}: {
  sourceType: CertificateSourceType;
  sourceLabel?: string | null;
}) {
  return (
    <Badge variant="outline" className={SOURCE_STYLE[sourceType]}>
      {sourceLabel?.trim() || SOURCE_TYPE_LABELS[sourceType]}
    </Badge>
  );
}
