'use client';

import type { CertificateLifecycleStatus } from '@asra/types';
import {
  artworkTemplateForStyle,
  buildCertificateStatementRuns,
  layoutCertificateMetadata,
  layoutCertificateRecipientName,
  layoutCertificateStatement,
  QUIZORA_2026_DEFINITION,
  type ArtworkTemplateDefinition,
  type CertificateTextMeasurer,
  type LaidOutLine,
} from '@asra/validation';
import QRCode from 'qrcode';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Live preview of the artwork certificate templates (ASRA QUIZORA 2026 — Certificate of
 * Participation, Design 1 and Design 2).
 *
 * Mirrors the server renderer (apps/api/src/modules/certificates/quizora-renderer.ts): same
 * reference artwork + statement patch, same font files, same shared layout functions and
 * 1536 × 1024 coordinate space — so name fitting, statement wrapping, metadata, signature slots
 * and QR placement match the downloaded PDF/PNG. Never renders scores.
 */

const ASSET_ROOT = '/certificates';

/** One CSS font family per bundled font file (shared by every template that uses the file). */
function familyFor(file: string): string {
  return `asra-cert-${file.replace(/[^a-z0-9]+/gi, '-')}`;
}

function fontFaceCss(def: ArtworkTemplateDefinition): string {
  return [...new Set(Object.values(def.fonts))]
    .map(
      (file) =>
        `@font-face{font-family:'${familyFor(file)}';src:url('${ASSET_ROOT}/${file}');font-display:swap;}`,
    )
    .join('');
}

function canvasFont(file: string, size: number): string {
  return `${size}px '${familyFor(file)}'`;
}

/** Loads the template's fonts, then measures with canvas (same font files as the server). */
function useArtworkMeasurer(def: ArtworkTemplateDefinition): CertificateTextMeasurer | null {
  const [state, setState] = React.useState<{
    key: string;
    measure: CertificateTextMeasurer;
  } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const files = [...new Set(Object.values(def.fonts))];
    const ready =
      typeof document !== 'undefined' && document.fonts
        ? Promise.all(files.map((f) => document.fonts.load(canvasFont(f, 32)))).catch(() => [])
        : Promise.resolve([]);
    void ready.then(() => {
      if (cancelled) return;
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return;
      const cache = new Map<string, number>();
      const measure: CertificateTextMeasurer = (text, variant, fontSize) => {
        const file = def.fonts[def.variantStyles[variant].face]!;
        const key = `${file}\u0000${text}`;
        let perPx = cache.get(key);
        if (perPx === undefined) {
          ctx.font = canvasFont(file, 100);
          perPx = ctx.measureText(text).width / 100;
          cache.set(key, perPx);
        }
        return perPx * fontSize;
      };
      setState({ key: def.key, measure });
    });
    return () => {
      cancelled = true;
    };
  }, [def]);
  // Never measure one template's text with another template's fonts while switching.
  return state && state.key === def.key ? state.measure : null;
}

export interface QuizoraPreviewSignature {
  key: string;
  fullName: string;
  imageSrc?: string | null;
}

export interface QuizoraCertificatePreviewProps {
  /** Artwork template style (Design 1 or Design 2); defaults to Design 1. */
  style?: string;
  recipientName: string;
  /** Template statement with {title} / {date} / **bold** placeholders. */
  bodyText: string;
  /** Certificate title / subject inserted at {title} (quiz, course or event name). */
  subjectTitle: string;
  completedAt?: string | null;
  issuedAt?: string | null;
  certificateNumber: string;
  verificationUrl: string;
  /** Ordered signatures: [0] Event Coordinator, [1] Director. */
  signatures: QuizoraPreviewSignature[];
  effectiveStatus?: CertificateLifecycleStatus;
  supersededByCertificateNumber?: string | null;
  className?: string;
}

function TextLines({ lines, def }: { lines: LaidOutLine[]; def: ArtworkTemplateDefinition }) {
  return (
    <>
      {lines.flatMap((line, li) =>
        line.segments.map((seg, si) => {
          const style = def.variantStyles[seg.variant];
          const file = def.fonts[style.face]!;
          return (
            <text
              key={`${li}-${si}`}
              x={seg.x}
              y={line.baselineY + seg.dy}
              fontFamily={`'${familyFor(file)}', 'Palatino Linotype', Palatino, serif`}
              fontSize={seg.fontSize}
              fill={style.color}
              {...(style.strokeEm
                ? {
                    stroke: style.color,
                    strokeWidth: style.strokeEm * seg.fontSize,
                    strokeLinejoin: 'round' as const,
                  }
                : {})}
              style={{ whiteSpace: 'pre' }}
            >
              {seg.text}
            </text>
          );
        }),
      )}
    </>
  );
}

export function QuizoraCertificatePreview({
  style,
  recipientName,
  bodyText,
  subjectTitle,
  completedAt,
  issuedAt,
  certificateNumber,
  verificationUrl,
  signatures,
  effectiveStatus = 'ISSUED',
  supersededByCertificateNumber,
  className,
}: QuizoraCertificatePreviewProps) {
  const def = artworkTemplateForStyle(style) ?? QUIZORA_2026_DEFINITION;
  const L = def.layout;
  const assetBase = `${ASSET_ROOT}/${def.assetDir}`;
  const measurer = useArtworkMeasurer(def);
  const completed = completedAt || new Date().toISOString();
  const issued = issuedAt || new Date().toISOString();

  const layout = React.useMemo(() => {
    if (!measurer) return null;
    return {
      name: layoutCertificateRecipientName(recipientName || 'Recipient Name', measurer, def),
      statement: layoutCertificateStatement(
        buildCertificateStatementRuns(bodyText, {
          title: subjectTitle || 'Certificate Title',
          date: completed,
        }),
        measurer,
        def,
      ),
      metadata: layoutCertificateMetadata(
        { completedAt: completed, issuedAt: issued, certificateNumber, verificationUrl },
        measurer,
        def,
      ),
    };
  }, [
    measurer,
    def,
    recipientName,
    bodyText,
    subjectTitle,
    completed,
    issued,
    certificateNumber,
    verificationUrl,
  ]);

  const qr = React.useMemo(() => {
    try {
      const code = QRCode.create(verificationUrl, { errorCorrectionLevel: 'M' });
      const count = code.modules.size;
      const quiet = L.qr.quietZoneModules;
      const inner = L.qr.size - L.qr.padding * 2;
      const cell = inner / (count + quiet * 2);
      const ox = L.qr.x + L.qr.padding + quiet * cell;
      const oy = L.qr.y + L.qr.padding + quiet * cell;
      const rects: { x: number; y: number; w: number }[] = [];
      for (let row = 0; row < count; row++) {
        let col = 0;
        while (col < count) {
          if (!code.modules.get(row, col)) {
            col += 1;
            continue;
          }
          const start = col;
          while (col < count && code.modules.get(row, col)) col += 1;
          rects.push({ x: ox + start * cell, y: oy + row * cell, w: (col - start) * cell });
        }
      }
      return { rects, cell };
    } catch {
      return null;
    }
  }, [verificationUrl, L.qr]);

  const mark =
    effectiveStatus === 'ISSUED'
      ? null
      : {
          title: effectiveStatus === 'SUPERSEDED' ? 'SUPERSEDED' : 'REVOKED',
          subtitle:
            effectiveStatus === 'SUPERSEDED'
              ? supersededByCertificateNumber
                ? `REPLACED BY ${supersededByCertificateNumber}`
                : 'REPLACED BY NEWER CREDENTIAL · INVALID'
              : null,
          color:
            effectiveStatus === 'SUPERSEDED'
              ? def.colors.watermarkSuperseded
              : def.colors.watermarkRevoked,
        };

  const P = L.statementPatch;
  const captionX = L.qr.x + L.qr.size / 2;
  const boldFamily = `'${familyFor(def.fonts[def.variantStyles.caption.face]!)}', serif`;

  return (
    <div
      data-slot="certificate-preview"
      data-template-style={def.style}
      className={cn(
        'relative aspect-[3/2] w-full overflow-hidden rounded-xl border shadow-raised select-none',
        className,
      )}
    >
      <style>{fontFaceCss(def)}</style>
      <svg
        viewBox={`0 0 ${L.width} ${L.height}`}
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label={`Certificate of Participation awarded to ${recipientName}`}
      >
        <image href={`${assetBase}/artwork.jpg`} x={0} y={0} width={L.width} height={L.height} />
        <image
          href={`${assetBase}/statement-patch.png`}
          x={P.x}
          y={P.y}
          width={P.width}
          height={P.height}
        />

        {layout && (
          <>
            <TextLines lines={layout.name.lines} def={def} />
            <TextLines lines={layout.statement.lines} def={def} />
            <TextLines lines={layout.metadata} def={def} />
          </>
        )}

        {L.signatureSlots.map((slot, i) => {
          const sig = signatures[i];
          const { x, y, width, height } = slot.box;
          return sig?.imageSrc ? (
            <image
              key={slot.label}
              href={sig.imageSrc}
              x={x}
              y={y}
              width={width}
              height={height}
              preserveAspectRatio="xMidYMax meet"
            >
              <title>{`${slot.label}: ${sig.fullName}`}</title>
            </image>
          ) : (
            <g key={slot.label}>
              <rect
                x={x}
                y={y + 8}
                width={width}
                height={height - 12}
                rx={6}
                fill="#FEF2F2"
                fillOpacity={0.85}
                stroke="#DC2626"
                strokeDasharray="6 4"
              />
              <text
                x={x + width / 2}
                y={y + height / 2 + 6}
                textAnchor="middle"
                fontSize={13}
                fill="#B91C1C"
                fontFamily="system-ui, sans-serif"
              >
                {`${slot.label} signature required`}
              </text>
            </g>
          );
        })}

        {L.qr.frame === 'card' ? (
          <rect
            x={L.qr.x}
            y={L.qr.y}
            width={L.qr.size}
            height={L.qr.size + L.qr.captionHeight}
            rx={5}
            fill="#FFFFFF"
            stroke={def.colors.qrBorder}
            strokeWidth={1.2}
          />
        ) : (
          <rect x={L.qr.x} y={L.qr.y} width={L.qr.size} height={L.qr.size} fill="#FFFFFF" />
        )}
        {qr && (
          <g fill={def.colors.qrDark} shapeRendering="crispEdges">
            {qr.rects.map((r, i) => (
              <rect key={i} x={r.x} y={r.y} width={r.w} height={qr.cell} />
            ))}
          </g>
        )}
        {L.qr.caption && (
          <text
            x={captionX}
            y={L.qr.y + L.qr.size + L.qr.captionHeight - 5}
            textAnchor="middle"
            fontFamily={boldFamily}
            fontSize={L.qr.captionSize}
            fill={def.variantStyles.caption.color}
          >
            {L.qr.caption}
          </text>
        )}

        {mark && (
          <g transform={`translate(${L.width / 2} ${L.height / 2}) rotate(-24)`}>
            <text
              x={0}
              y={20}
              textAnchor="middle"
              fontFamily={boldFamily}
              fontSize={mark.subtitle ? 110 : 128}
              fill={mark.color}
              fillOpacity={0.18}
            >
              {mark.title}
            </text>
            {mark.subtitle && (
              <text
                x={0}
                y={70}
                textAnchor="middle"
                fontFamily={boldFamily}
                fontSize={24}
                fill={mark.color}
                fillOpacity={0.3}
              >
                {mark.subtitle}
              </text>
            )}
          </g>
        )}
      </svg>
    </div>
  );
}
