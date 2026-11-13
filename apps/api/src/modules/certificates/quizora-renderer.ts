import type { CertificateLifecycleStatus } from '@asra/types';
import {
  artworkTemplateForStyle,
  buildCertificateStatementRuns,
  layoutCertificateMetadata,
  layoutCertificateRecipientName,
  layoutCertificateStatement,
  QUIZORA_2026_DEFINITION,
  type ArtworkTemplateDefinition,
  type CertificateTextBlockLayout,
  type LaidOutLine,
  type LaidOutSegment,
} from '@asra/validation';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { loadArtworkAssets, quizoraTextMeasurer, type QuizoraAssets } from './quizora-assets.js';
import {
  resolveEffectiveRenderStatus,
  resolveRenderTemplate,
  type CertificateRenderData,
} from './render-helpers.js';
import { requireArtworkSignatureImages } from './template-rules.js';

/**
 * ASRA QUIZORA 2026 — Certificate of Participation renderer for every artwork template
 * (Design 1 and Design 2, see `ARTWORK_TEMPLATE_DEFINITIONS`).
 *
 * The approved reference artwork (1536 × 1024) is the certificate background; only dynamic
 * content is drawn on top: recipient name, statement (template body with {title}/{date}),
 * the two mandatory signatures, verification QR code and the metadata lines. Scores, marks,
 * percentages, ranks and `achievementDetails` are never part of the render model.
 *
 *   PDF: 1152 × 768 pt page (exact 3:2 artwork ratio, 16 × 10.67 in), original JPEG embedded
 *        without recompression, fonts embedded, QR drawn as vectors.
 *   PNG: 3072 × 2048 px (2× artwork), artwork upscaled with Lanczos3, all text rendered from the
 *        same font outlines as the PDF, QR rendered crisply at 2×.
 */
export const QUIZORA_PDF_SCALE = 0.75;
export const QUIZORA_PNG_SCALE = 2;

export interface QuizoraSignaturePlacement {
  label: string;
  box: { x: number; y: number; width: number; height: number };
  buffer: Buffer;
}

export interface QuizoraRenderModel {
  /** Artwork template the certificate was issued with (from its immutable snapshot). */
  def: ArtworkTemplateDefinition;
  name: CertificateTextBlockLayout;
  statement: CertificateTextBlockLayout;
  metadata: LaidOutLine[];
  qrPayload: string;
  qrCaption: LaidOutLine;
  signatures: QuizoraSignaturePlacement[];
  status: CertificateLifecycleStatus;
  supersededByCertificateNumber: string | null;
}

/** Artwork definition for the certificate's template snapshot (Design 1 when not artwork). */
export function artworkDefinitionFor(data: CertificateRenderData): ArtworkTemplateDefinition {
  return artworkTemplateForStyle(resolveRenderTemplate(data).style) ?? QUIZORA_2026_DEFINITION;
}

export function buildQuizoraRenderModel(
  data: CertificateRenderData,
  assets?: QuizoraAssets,
): QuizoraRenderModel {
  const tpl = resolveRenderTemplate(data);
  const def = artworkTemplateForStyle(tpl.style) ?? QUIZORA_2026_DEFINITION;
  const resolvedAssets = assets ?? loadArtworkAssets(def);
  const measure = quizoraTextMeasurer(resolvedAssets, def);
  const L = def.layout;

  const signatures = requireArtworkSignatureImages(
    tpl.name,
    data.signatureSnapshots,
    data.signatureBuffers,
    def.style,
  ).map(({ buffer }, i) => {
    const slot = L.signatureSlots[i]!;
    return { label: slot.label, box: { ...slot.box }, buffer };
  });

  const statement = layoutCertificateStatement(
    buildCertificateStatementRuns(tpl.bodyText, {
      title: data.courseTitle,
      date: data.completedAt,
    }),
    measure,
    def,
  );
  const name = layoutCertificateRecipientName(data.recipientName, measure, def);
  const metadata = layoutCertificateMetadata(
    {
      completedAt: data.completedAt,
      issuedAt: data.issuedAt,
      certificateNumber: data.certificateNumber,
      verificationUrl: data.verificationUrl,
    },
    measure,
    def,
  );

  const caption = L.qr.caption;
  const captionWidth = caption ? measure(caption, 'caption', L.qr.captionSize) : 0;
  const qrCaption: LaidOutLine = {
    width: captionWidth,
    baselineY: L.qr.y + L.qr.size + L.qr.captionHeight - 5,
    segments: caption
      ? [
          {
            text: caption,
            variant: 'caption',
            x: L.qr.x + L.qr.size / 2 - captionWidth / 2,
            width: captionWidth,
            fontSize: L.qr.captionSize,
            dy: 0,
          },
        ]
      : [],
  };

  return {
    def,
    name,
    statement,
    metadata,
    qrPayload: data.verificationUrl,
    qrCaption,
    signatures,
    status: resolveEffectiveRenderStatus(data),
    supersededByCertificateNumber: data.supersededByCertificateNumber ?? null,
  };
}

/** Every text string drawn on the certificate (used by tests to assert no score leakage). */
export function quizoraVisibleText(model: QuizoraRenderModel): string[] {
  return [
    ...model.name.lines,
    ...model.statement.lines,
    ...model.metadata,
    model.qrCaption,
  ].flatMap((line) => line.segments.map((s) => s.text));
}

interface QrRun {
  row: number;
  col: number;
  length: number;
}

/** QR modules as horizontal runs (fewer primitives, no hairline seams between modules). */
function qrRuns(payload: string): { count: number; runs: QrRun[] } {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const count = qr.modules.size;
  const runs: QrRun[] = [];
  for (let row = 0; row < count; row++) {
    let col = 0;
    while (col < count) {
      if (!qr.modules.get(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < count && qr.modules.get(row, col)) col += 1;
      runs.push({ row, col: start, length: col - start });
    }
  }
  return { count, runs };
}

function qrGeometry(payload: string, def: ArtworkTemplateDefinition) {
  const { x, y, size, padding, quietZoneModules } = def.layout.qr;
  const { count, runs } = qrRuns(payload);
  const inner = size - padding * 2;
  const cell = inner / (count + quietZoneModules * 2);
  const originX = x + padding + quietZoneModules * cell;
  const originY = y + padding + quietZoneModules * cell;
  return { count, runs, cell, originX, originY };
}

function watermarkLabel(
  def: ArtworkTemplateDefinition,
  status: CertificateLifecycleStatus,
  supersededBy: string | null,
) {
  if (status === 'ISSUED') return null;
  const superseded = status === 'SUPERSEDED';
  return {
    title: superseded ? 'SUPERSEDED' : 'REVOKED',
    subtitle: superseded
      ? supersededBy
        ? `REPLACED BY ${supersededBy}`
        : 'REPLACED BY NEWER CREDENTIAL · INVALID'
      : null,
    color: superseded ? def.colors.watermarkSuperseded : def.colors.watermarkRevoked,
  };
}

// ---------------------------------------------------------------------------------------------
// PDF (PDFKit)
// ---------------------------------------------------------------------------------------------

export function quizoraPdfPageSize(
  def: ArtworkTemplateDefinition = QUIZORA_2026_DEFINITION,
): [number, number] {
  return [def.layout.width * QUIZORA_PDF_SCALE, def.layout.height * QUIZORA_PDF_SCALE];
}

export function renderQuizoraPdfPage(
  doc: PDFKit.PDFDocument,
  model: QuizoraRenderModel,
  assets: QuizoraAssets = loadArtworkAssets(model.def),
): void {
  const s = QUIZORA_PDF_SCALE;
  const def = model.def;
  const L = def.layout;
  const P = L.statementPatch;

  for (const face of Object.keys(def.fonts)) {
    doc.registerFont(`quizora-${face}`, assets.fonts[face]!.buffer);
  }

  doc.image(assets.artwork, 0, 0, { width: L.width * s, height: L.height * s });
  doc.image(assets.statementPatch, P.x * s, P.y * s, { width: P.width * s, height: P.height * s });

  const drawSegment = (seg: LaidOutSegment, baselineY: number) => {
    const style = def.variantStyles[seg.variant];
    doc
      .font(`quizora-${style.face}`)
      .fontSize(seg.fontSize * s)
      .fillColor(style.color);
    if (style.strokeEm) {
      // Heavier lettering (Design 2): fill + outline in the same colour, as in the PNG.
      doc.save();
      doc
        .lineWidth(style.strokeEm * seg.fontSize * s)
        .lineJoin('round')
        .strokeColor(style.color);
      doc.text(seg.text, seg.x * s, (baselineY + seg.dy) * s, {
        lineBreak: false,
        baseline: 'alphabetic',
        fill: true,
        stroke: true,
      });
      doc.restore();
      return;
    }
    doc.text(seg.text, seg.x * s, (baselineY + seg.dy) * s, {
      lineBreak: false,
      baseline: 'alphabetic',
    });
  };
  for (const line of [...model.name.lines, ...model.statement.lines, ...model.metadata]) {
    for (const seg of line.segments) drawSegment(seg, line.baselineY);
  }

  for (const sig of model.signatures) {
    doc.image(sig.buffer, sig.box.x * s, sig.box.y * s, {
      fit: [sig.box.width * s, sig.box.height * s],
      align: 'center',
      valign: 'bottom',
    });
  }

  // Verification QR (white quiet zone; Design 1 adds a gold-framed card) — vector modules.
  const { x, y, size, captionHeight } = L.qr;
  doc.save();
  if (L.qr.frame === 'card') {
    doc
      .roundedRect(x * s, y * s, size * s, (size + captionHeight) * s, 5 * s)
      .lineWidth(1.2 * s)
      .fillAndStroke('#FFFFFF', def.colors.qrBorder);
  } else {
    doc.rect(x * s, y * s, size * s, size * s).fill('#FFFFFF');
  }
  doc.restore();
  for (const seg of model.qrCaption.segments) drawSegment(seg, model.qrCaption.baselineY);
  const qr = qrGeometry(model.qrPayload, def);
  doc.save();
  doc.fillColor(def.colors.qrDark);
  for (const run of qr.runs) {
    doc
      .rect(
        (qr.originX + run.col * qr.cell) * s,
        (qr.originY + run.row * qr.cell) * s,
        run.length * qr.cell * s,
        qr.cell * s + 0.05,
      )
      .fill();
  }
  doc.restore();

  const mark = watermarkLabel(def, model.status, model.supersededByCertificateNumber);
  if (mark) {
    const measure = quizoraTextMeasurer(assets, def);
    doc.save();
    doc.translate((L.width / 2) * s, (L.height / 2) * s).rotate(-24);
    const titleSize = mark.subtitle ? 110 : 128;
    const tw = measure(mark.title, 'caption', titleSize);
    doc
      .font('quizora-bold')
      .fontSize(titleSize * s)
      .fillOpacity(0.18)
      .fillColor(mark.color)
      .text(mark.title, (-tw / 2) * s, 20 * s, { lineBreak: false, baseline: 'alphabetic' });
    if (mark.subtitle) {
      const sw = measure(mark.subtitle, 'caption', 24);
      doc
        .fontSize(24 * s)
        .fillOpacity(0.3)
        .text(mark.subtitle, (-sw / 2) * s, 70 * s, { lineBreak: false, baseline: 'alphabetic' });
    }
    doc.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// PNG (Sharp + SVG overlay with font outlines)
// ---------------------------------------------------------------------------------------------

/** Compact SVG number (7 significant digits — glyph scale factors are ~0.03, so fixed decimals lose width). */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(7)));
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function segmentOutlineSvg(
  assets: QuizoraAssets,
  def: ArtworkTemplateDefinition,
  text: string,
  variant: LaidOutSegment['variant'],
  fontSize: number,
  x: number,
  baselineY: number,
  extraAttrs = '',
): string {
  const style = def.variantStyles[variant];
  const font = assets.fonts[style.face]!.font;
  const run = font.layout(text);
  const k = fontSize / font.unitsPerEm;
  let pen = 0;
  const paths: string[] = [];
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i]!;
    const d = glyph.path.toSVG();
    if (d) {
      paths.push(
        `<path transform="translate(${fmt(pen + pos.xOffset)} ${fmt(pos.yOffset)})" d="${d}"/>`,
      );
    }
    pen += pos.xAdvance;
  });
  const stroke = style.strokeEm
    ? `stroke="${style.color}" stroke-width="${fmt(style.strokeEm * font.unitsPerEm)}" stroke-linejoin="round" `
    : '';
  return `<g fill="${style.color}" ${stroke}${extraAttrs} transform="translate(${fmt(x)} ${fmt(baselineY)}) scale(${fmt(k)} ${fmt(-k)})">${paths.join('')}</g>`;
}

export function buildQuizoraOverlaySvg(
  model: QuizoraRenderModel,
  assets: QuizoraAssets = loadArtworkAssets(model.def),
): string {
  const def = model.def;
  const L = def.layout;
  const P = L.statementPatch;
  const parts: string[] = [];

  parts.push(
    `<image x="${P.x}" y="${P.y}" width="${P.width}" height="${P.height}" href="data:image/png;base64,${assets.statementPatch.toString('base64')}"/>`,
  );

  for (const line of [...model.name.lines, ...model.statement.lines, ...model.metadata]) {
    for (const seg of line.segments) {
      parts.push(
        segmentOutlineSvg(
          assets,
          def,
          seg.text,
          seg.variant,
          seg.fontSize,
          seg.x,
          line.baselineY + seg.dy,
        ),
      );
    }
  }

  for (const sig of model.signatures) {
    parts.push(
      `<image x="${sig.box.x}" y="${sig.box.y}" width="${sig.box.width}" height="${sig.box.height}" preserveAspectRatio="xMidYMax meet" href="data:image/png;base64,${sig.buffer.toString('base64')}"/>`,
    );
  }

  const { x, y, size, captionHeight } = L.qr;
  parts.push(
    L.qr.frame === 'card'
      ? `<rect x="${x}" y="${y}" width="${size}" height="${size + captionHeight}" rx="5" fill="#FFFFFF" stroke="${def.colors.qrBorder}" stroke-width="1.2"/>`
      : `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="#FFFFFF"/>`,
  );
  const qr = qrGeometry(model.qrPayload, def);
  parts.push(
    `<g fill="${def.colors.qrDark}" shape-rendering="crispEdges">${qr.runs
      .map(
        (run) =>
          `<rect x="${fmt(qr.originX + run.col * qr.cell)}" y="${fmt(qr.originY + run.row * qr.cell)}" width="${fmt(run.length * qr.cell)}" height="${fmt(qr.cell)}"/>`,
      )
      .join('')}</g>`,
  );
  for (const seg of model.qrCaption.segments) {
    parts.push(
      segmentOutlineSvg(
        assets,
        def,
        seg.text,
        seg.variant,
        seg.fontSize,
        seg.x,
        model.qrCaption.baselineY,
      ),
    );
  }

  const mark = watermarkLabel(def, model.status, model.supersededByCertificateNumber);
  if (mark) {
    const measure = quizoraTextMeasurer(assets, def);
    const titleSize = mark.subtitle ? 110 : 128;
    const tw = measure(mark.title, 'caption', titleSize);
    const inner = [
      segmentOutlineSvg(assets, def, mark.title, 'caption', titleSize, -tw / 2, 20).replace(
        `fill="${def.variantStyles.caption.color}"`,
        `fill="${mark.color}" fill-opacity="0.18"`,
      ),
    ];
    if (mark.subtitle) {
      const sw = measure(mark.subtitle, 'caption', 24);
      inner.push(
        segmentOutlineSvg(assets, def, mark.subtitle, 'caption', 24, -sw / 2, 70).replace(
          `fill="${def.variantStyles.caption.color}"`,
          `fill="${mark.color}" fill-opacity="0.3"`,
        ),
      );
    }
    parts.push(
      `<g transform="translate(${L.width / 2} ${L.height / 2}) rotate(-24)">${inner.join('')}</g>`,
    );
  }

  const W = L.width * QUIZORA_PNG_SCALE;
  const H = L.height * QUIZORA_PNG_SCALE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${L.width} ${L.height}"><title>${escapeXmlAttr('ASRA QUIZORA 2026 Certificate overlay')}</title>${parts.join('')}</svg>`;
}

export async function renderQuizoraPng(
  model: QuizoraRenderModel,
  assets: QuizoraAssets = loadArtworkAssets(model.def),
): Promise<Buffer> {
  const L = model.def.layout;
  const overlay = Buffer.from(buildQuizoraOverlaySvg(model, assets), 'utf8');
  return sharp(assets.artwork)
    .resize(L.width * QUIZORA_PNG_SCALE, L.height * QUIZORA_PNG_SCALE, { kernel: 'lanczos3' })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

/** Convenience wrappers used by the PDF/PNG services. */
export function renderQuizoraCertificatePng(data: CertificateRenderData): Promise<Buffer> {
  const assets = loadArtworkAssets(artworkDefinitionFor(data));
  return renderQuizoraPng(buildQuizoraRenderModel(data, assets), assets);
}
