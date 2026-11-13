import type {
  CertificateLifecycleStatus,
  CertificateSignatureSnapshotDto,
  CertificateTemplateSnapshotDto,
} from '@asra/types';
import { isArtworkCertificateStyle, SOURCE_TYPE_LABELS } from '@asra/validation';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { renderQuizoraCertificatePng } from './quizora-renderer.js';
import {
  formatCertificateDate,
  readEmblemDataUri,
  resolveEffectiveRenderStatus,
  resolveRenderSignatures,
  resolveRenderTemplate,
  type CertificateRenderData,
} from './render-helpers.js';

const SVG_WIDTH = 842;
const SVG_HEIGHT = 595;
const PNG_PIXEL_WIDTH = 1684;
const PNG_PIXEL_HEIGHT = 1190;

const FONT_SERIF = `'Georgia', 'Liberation Serif', 'Times New Roman', Times, serif`;
const FONT_SANS = `'Helvetica Neue', 'Liberation Sans', 'DejaVu Sans', Helvetica, Arial, sans-serif`;
const FONT_MONO = `'Courier New', 'Liberation Mono', monospace`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let units = 0;
  for (const ch of text) {
    if (ch === ' ' || ch === 'i' || ch === 'l' || ch === 'I' || ch === '.' || ch === ',') {
      units += 0.34;
    } else if (ch === 'W' || ch === 'M' || (ch >= 'A' && ch <= 'Z')) {
      units += 0.7;
    } else {
      units += 0.52;
    }
  }
  return units * fontSize * (bold ? 1.06 : 1);
}

function truncateToWidth(text: string, maxWidth: number, fontSize: number, bold = false): string {
  if (estimateTextWidth(text, fontSize, bold) <= maxWidth) return text;
  const suffix = '…';
  let end = text.length;
  while (
    end > 1 &&
    estimateTextWidth(`${text.slice(0, end)}${suffix}`, fontSize, bold) > maxWidth
  ) {
    end -= 1;
  }
  return `${text.slice(0, end).trimEnd()}${suffix}`;
}

function wrapToLines(
  text: string,
  maxWidth: number,
  fontSize: number,
  maxLines: number,
  bold = false,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize, bold) <= maxWidth) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
        current = word;
      } else {
        lines.push(truncateToWidth(word, maxWidth, fontSize, bold));
        current = '';
      }
      if (lines.length === maxLines) {
        const remaining = [current, ...words.slice(i + 1)].filter(Boolean).join(' ');
        if (remaining) {
          lines[maxLines - 1] = truncateToWidth(
            `${lines[maxLines - 1]!} ${remaining}`,
            maxWidth,
            fontSize,
            bold,
          );
        }
        return lines;
      }
    }
  }

  if (current) {
    lines.push(truncateToWidth(current, maxWidth, fontSize, bold));
  }
  return lines.slice(0, maxLines);
}

function fitFontSizeSingle(
  text: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
  bold = false,
): number {
  let size = startSize;
  while (size > minSize && estimateTextWidth(text, size, bold) > maxWidth) {
    size -= 1;
  }
  return size;
}

function renderMultilineSvg(
  text: string,
  options: {
    x: number;
    y: number;
    maxWidth: number;
    fontSize: number;
    minFontSize?: number;
    maxLines: number;
    lineHeight: number;
    fontFamily: string;
    fontWeight?: string;
    fontStyle?: string;
    fill: string;
    anchor?: 'start' | 'middle';
    letterSpacing?: number;
  },
): { svg: string; nextY: number } {
  const bold = options.fontWeight === 'bold' || options.fontWeight === '700';
  let size = options.fontSize;
  const minSize = options.minFontSize ?? options.fontSize;

  let lines = wrapToLines(text, options.maxWidth, size, options.maxLines, bold);
  while (
    size > minSize &&
    estimateTextWidth(text, size, bold) > options.maxWidth * Math.max(1, options.maxLines - 0.15)
  ) {
    size -= 1;
    lines = wrapToLines(text, options.maxWidth, size, options.maxLines, bold);
  }

  const lineStep = size * options.lineHeight;
  const spans = lines
    .map((line, index) => {
      const ly = options.y + index * lineStep;
      const attrs = [
        `x="${options.x}"`,
        `y="${ly}"`,
        `font-family="${escapeXml(options.fontFamily)}"`,
        `font-size="${size}"`,
        options.fontWeight ? `font-weight="${options.fontWeight}"` : '',
        options.fontStyle ? `font-style="${options.fontStyle}"` : '',
        options.letterSpacing ? `letter-spacing="${options.letterSpacing}"` : '',
        options.anchor ? `text-anchor="${options.anchor}"` : '',
        `fill="${options.fill}"`,
      ]
        .filter(Boolean)
        .join(' ');
      return `<text ${attrs}>${escapeXml(line)}</text>`;
    })
    .join('\n');

  return { svg: spans, nextY: options.y + Math.max(1, lines.length) * lineStep };
}

function renderQrSvg(
  payload: string,
  x: number,
  y: number,
  boxSize: number,
  darkColor: string,
  borderColor: string,
): string {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const count = qr.modules.size;
  const padding = 4;
  const innerSize = boxSize - padding * 2;
  const cell = innerSize / count;
  const rects: string[] = [];

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.modules.get(row, col)) {
        const rx = (x + padding + col * cell).toFixed(2);
        const ry = (y + padding + row * cell).toFixed(2);
        const rw = (cell + 0.15).toFixed(2);
        rects.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rw}" fill="${darkColor}" />`);
      }
    }
  }

  return `
    <g>
      <rect x="${x}" y="${y}" width="${boxSize}" height="${boxSize}" rx="4" fill="#FFFFFF" stroke="${borderColor}" stroke-width="1" />
      ${rects.join('')}
    </g>
  `;
}

function renderSealSvg(
  cx: number,
  cy: number,
  radius: number,
  primaryColor: string,
  goldColor: string,
): string {
  return `
    <g>
      <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${goldColor}" fill-opacity="0.08" stroke="${goldColor}" stroke-width="1.6" />
      <circle cx="${cx}" cy="${cy}" r="${radius - 4}" fill="none" stroke="${primaryColor}" stroke-width="0.7" />
      <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="6.5" font-weight="700" fill="${primaryColor}">OFFICIAL</text>
      <text x="${cx}" y="${cy + 3}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="6.5" font-weight="700" fill="${primaryColor}">SEAL</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="5.5" fill="${goldColor}">ASRA ACADEMY</text>
    </g>
  `;
}

function renderSignatureBandSvg(
  signatures: CertificateSignatureSnapshotDto[],
  buffers: Map<string, Buffer> | undefined,
  bandX: number,
  bandY: number,
  bandWidth: number,
  options: {
    nameFont: string;
    roleFont: string;
    nameColor: string;
    roleColor: string;
    lineColor: string;
    glowColor: string;
  },
): string {
  const list = resolveRenderSignatures(signatures);
  const count = list.length;
  const gap = count === 4 ? 18 : count === 3 ? 28 : 48;
  const maxColWidth = count === 1 ? 210 : count === 2 ? 230 : count === 3 ? 200 : 155;
  const rawColWidth = (bandWidth - gap * (count - 1)) / count;
  const colWidth = Math.min(maxColWidth, rawColWidth);
  const totalUsedWidth = colWidth * count + gap * (count - 1);
  const startX = bandX + (bandWidth - totalUsedWidth) / 2;

  const sigImgHeight = 40;
  const lineY = bandY + sigImgHeight + 4;

  return list
    .map((sig, index) => {
      const colX = startX + index * (colWidth + gap);
      const centerX = colX + colWidth / 2;
      const pngBuffer =
        (sig.signatureId ? buffers?.get(sig.signatureId) : undefined) ??
        (sig.storageKey ? buffers?.get(sig.storageKey) : undefined);

      const imageMarkup = pngBuffer
        ? `<image href="data:image/png;base64,${pngBuffer.toString('base64')}" x="${colX + 10}" y="${bandY + 2}" width="${colWidth - 20}" height="${sigImgHeight - 4}" preserveAspectRatio="xMidYMax meet" />`
        : '';

      let labelsMarkup = '';
      let textY = lineY + 13;
      if (sig.showName) {
        const nameSize = fitFontSizeSingle(sig.fullName, colWidth - 6, 9.5, 7, true);
        const safeName = truncateToWidth(sig.fullName, colWidth - 6, nameSize, true);
        labelsMarkup += `<text x="${centerX}" y="${textY}" text-anchor="middle" font-family="${escapeXml(options.nameFont)}" font-size="${nameSize}" font-weight="700" fill="${options.nameColor}">${escapeXml(safeName)}</text>`;
        textY += 12;
      }

      if (sig.showDesignation) {
        const roleText = sig.department
          ? `${sig.designation} · ${sig.department}`
          : sig.designation;
        const roleSize = fitFontSizeSingle(roleText, colWidth - 4, 8, 6, false);
        const safeRole = truncateToWidth(roleText, colWidth - 4, roleSize, false);
        labelsMarkup += `<text x="${centerX}" y="${textY}" text-anchor="middle" font-family="${escapeXml(options.roleFont)}" font-size="${roleSize}" fill="${options.roleColor}">${escapeXml(safeRole)}</text>`;
      }

      return `
        <g>
          <rect x="${colX + 8}" y="${bandY + 2}" width="${colWidth - 16}" height="${sigImgHeight - 2}" rx="8" fill="${options.glowColor}" fill-opacity="0.45" />
          <line x1="${colX + 12}" y1="${lineY + 1.2}" x2="${colX + colWidth - 12}" y2="${lineY + 1.2}" stroke="#012114" stroke-opacity="0.14" stroke-width="1.5" />
          ${imageMarkup}
          <line x1="${colX + 8}" y1="${lineY}" x2="${colX + colWidth - 8}" y2="${lineY}" stroke="${options.lineColor}" stroke-width="0.85" />
          ${labelsMarkup}
        </g>
      `;
    })
    .join('\n');
}

function renderStatusWatermarkSvg(
  effectiveStatus: CertificateLifecycleStatus,
  supersededBy?: string | null,
): string {
  if (effectiveStatus === 'ISSUED') return '';
  const isSuperseded = effectiveStatus === 'SUPERSEDED';
  const label = isSuperseded ? 'SUPERSEDED' : 'REVOKED';
  const tint = isSuperseded ? '#B45309' : '#B42318';
  const subText = supersededBy
    ? `REPLACED BY ${supersededBy}`
    : 'REPLACED BY NEWER CREDENTIAL · INVALID';

  return `
    <g transform="translate(${SVG_WIDTH / 2}, ${SVG_HEIGHT / 2}) rotate(-24)">
      <text x="0" y="10" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="${isSuperseded ? 56 : 64}" font-weight="700" fill="${tint}" fill-opacity="0.18" letter-spacing="4">${label}</text>
      ${
        isSuperseded
          ? `<text x="0" y="34" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="12" font-weight="700" fill="${tint}" fill-opacity="0.28" letter-spacing="1.5">${escapeXml(subText)}</text>`
          : ''
      }
    </g>
  `;
}

function buildClassicSvg(
  data: CertificateRenderData,
  tpl: CertificateTemplateSnapshotDto,
  emblemUri: string | null,
): string {
  const primary = tpl.config.accentColor || '#034729';
  const gold = tpl.config.secondaryColor || '#C88717';
  const deepGreen = '#012114';

  const cornerDiamonds = [
    [24, 24],
    [SVG_WIDTH - 24, 24],
    [24, SVG_HEIGHT - 24],
    [SVG_WIDTH - 24, SVG_HEIGHT - 24],
  ]
    .map(
      ([cx, cy]) =>
        `<g transform="translate(${cx}, ${cy}) rotate(45)"><rect x="-4" y="-4" width="8" height="8" fill="${gold}" stroke="${deepGreen}" stroke-width="1" /></g>`,
    )
    .join('');

  let y = 42;
  let headerSvg = '';
  if (tpl.config.showLogo && emblemUri) {
    headerSvg += `<image href="${emblemUri}" x="${SVG_WIDTH / 2 - 22}" y="${y}" width="44" height="44" preserveAspectRatio="xMidYMid meet" />`;
    y += 48;
  } else {
    y += 6;
  }

  y += 16;
  headerSvg += `<text x="${SVG_WIDTH / 2}" y="${y}" text-anchor="middle" font-family="${escapeXml(FONT_SERIF)}" font-size="20" font-weight="700" letter-spacing="2" fill="${deepGreen}">${escapeXml(truncateToWidth((tpl.issuingAuthority || 'ASRA ACADEMY').toUpperCase(), SVG_WIDTH - 120, 20, true))}</text>`;
  y += 14;

  if (tpl.subtitle) {
    headerSvg += `<text x="${SVG_WIDTH / 2}" y="${y}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="8.5" letter-spacing="1.8" fill="${gold}">${escapeXml(truncateToWidth(tpl.subtitle.toUpperCase(), SVG_WIDTH - 120, 8.5, false))}</text>`;
    y += 14;
  } else {
    y += 6;
  }

  if (tpl.config.showSourceLabel && (data.sourceLabel || data.sourceType)) {
    const sourceBadge = (
      data.sourceLabel || (data.sourceType ? SOURCE_TYPE_LABELS[data.sourceType] : 'Credential')
    ).toUpperCase();
    const pillW = Math.min(200, Math.max(88, estimateTextWidth(sourceBadge, 7, true) + 22));
    const pillX = (SVG_WIDTH - pillW) / 2;
    headerSvg += `
      <rect x="${pillX}" y="${y - 6}" width="${pillW}" height="14" rx="7" fill="#F4EFE2" stroke="${gold}" stroke-width="0.7" />
      <text x="${SVG_WIDTH / 2}" y="${y + 3.5}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="7" font-weight="700" fill="${primary}">${escapeXml(truncateToWidth(sourceBadge, pillW - 12, 7, true))}</text>
    `;
    y += 18;
  }

  const titleText = (
    data.certificateTitle ||
    tpl.certificateTitle ||
    'CERTIFICATE OF COMPLETION'
  ).toUpperCase();
  const titleRendered = renderMultilineSvg(titleText, {
    x: SVG_WIDTH / 2,
    y: y + 14,
    maxWidth: SVG_WIDTH - 150,
    fontSize: 21,
    minFontSize: 12,
    maxLines: 2,
    lineHeight: 1.15,
    fontFamily: FONT_SERIF,
    fontWeight: '700',
    fill: primary,
    anchor: 'middle',
    letterSpacing: 1.8,
  });
  y = titleRendered.nextY + 2;

  headerSvg += `
    ${titleRendered.svg}
    <line x1="${SVG_WIDTH / 2 - 125}" y1="${y}" x2="${SVG_WIDTH / 2 + 125}" y2="${y}" stroke="${gold}" stroke-width="1" />
    <circle cx="${SVG_WIDTH / 2}" cy="${y}" r="2.8" fill="${primary}" />
  `;
  y += 18;

  headerSvg += `<text x="${SVG_WIDTH / 2}" y="${y}" text-anchor="middle" font-family="${escapeXml(FONT_SERIF)}" font-size="12" font-style="italic" fill="#4A5568">This is to certify that</text>`;
  y += 24;

  const nameRendered = renderMultilineSvg(data.recipientName, {
    x: SVG_WIDTH / 2,
    y,
    maxWidth: SVG_WIDTH - 150,
    fontSize: 27,
    minFontSize: 13,
    maxLines: 2,
    lineHeight: 1.15,
    fontFamily: FONT_SERIF,
    fontWeight: '700',
    fill: deepGreen,
    anchor: 'middle',
  });
  y = nameRendered.nextY - 6;
  headerSvg += `
    ${nameRendered.svg}
    <line x1="${SVG_WIDTH / 2 - 170}" y1="${y}" x2="${SVG_WIDTH / 2 + 170}" y2="${y}" stroke="#D89E34" stroke-width="1" />
  `;
  y += 15;

  const sigBandTop = 366;
  const bodyText =
    data.description?.trim() ||
    tpl.bodyText ||
    'has successfully completed the curriculum and all required assessments for';
  const bodyRendered = renderMultilineSvg(bodyText, {
    x: SVG_WIDTH / 2,
    y,
    maxWidth: SVG_WIDTH - 180,
    fontSize: 11.5,
    minFontSize: 8.5,
    maxLines: 2,
    lineHeight: 1.25,
    fontFamily: FONT_SERIF,
    fill: '#374151',
    anchor: 'middle',
  });
  y = Math.min(bodyRendered.nextY + 5, sigBandTop - 34);
  headerSvg += bodyRendered.svg;

  const subjectRendered = renderMultilineSvg(data.courseTitle, {
    x: SVG_WIDTH / 2,
    y,
    maxWidth: SVG_WIDTH - 150,
    fontSize: 18,
    minFontSize: 10.5,
    maxLines: 2,
    lineHeight: 1.18,
    fontFamily: FONT_SERIF,
    fontWeight: '700',
    fill: primary,
    anchor: 'middle',
  });
  headerSvg += subjectRendered.svg;
  y = subjectRendered.nextY + 4;

  if (data.achievementDetails && y < sigBandTop - 4) {
    const achRendered = renderMultilineSvg(data.achievementDetails, {
      x: SVG_WIDTH / 2,
      y,
      maxWidth: SVG_WIDTH - 190,
      fontSize: 10.5,
      minFontSize: 8,
      maxLines: 1,
      lineHeight: 1.2,
      fontFamily: FONT_SERIF,
      fontStyle: 'italic',
      fill: '#8A5A0B',
      anchor: 'middle',
    });
    headerSvg += achRendered.svg;
  }

  const sigBandSvg = renderSignatureBandSvg(
    data.signatureSnapshots ?? [],
    data.signatureBuffers,
    65,
    368,
    SVG_WIDTH - 130,
    {
      nameFont: FONT_SANS,
      roleFont: FONT_SANS,
      nameColor: deepGreen,
      roleColor: '#4A5568',
      lineColor: '#94A3B8',
      glowColor: '#FFFFFF',
    },
  );

  const footerTop = 456;
  const leftX = 62;
  let metaY = footerTop + 18;
  let footerSvg = `<line x1="56" y1="${footerTop}" x2="${SVG_WIDTH - 56}" y2="${footerTop}" stroke="#E2E8F0" stroke-width="0.5" />`;

  if (tpl.config.showCompletionDate) {
    footerSvg += `<text x="${leftX}" y="${metaY}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5"><tspan font-weight="700" fill="${deepGreen}">COMPLETION / ACHIEVEMENT DATE: </tspan><tspan fill="#2D3748">${escapeXml(formatCertificateDate(data.completedAt))}</tspan></text>`;
    metaY += 12;
  }
  if (tpl.config.showIssueDate) {
    footerSvg += `<text x="${leftX}" y="${metaY}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5"><tspan font-weight="700" fill="${deepGreen}">ISSUED DATE: </tspan><tspan fill="#2D3748">${escapeXml(formatCertificateDate(data.issuedAt))}</tspan></text>`;
    metaY += 12;
  }
  if (tpl.config.showCertificateNumber) {
    footerSvg += `<text x="${leftX}" y="${metaY}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5"><tspan font-weight="700" fill="${deepGreen}">CERTIFICATE ID: </tspan><tspan font-family="${escapeXml(FONT_MONO)}" font-weight="700" fill="${primary}">${escapeXml(data.certificateNumber)}</tspan></text>`;
    metaY += 12;
  }
  footerSvg += `<text x="${leftX}" y="${metaY}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5" fill="#4A5568">${escapeXml(truncateToWidth(`Verify at: ${data.verificationUrl}`, 420, 7.5))}</text>`;
  metaY += 11;
  if (tpl.config.footerNote?.trim()) {
    footerSvg += `<text x="${leftX}" y="${metaY}" font-family="${escapeXml(FONT_SERIF)}" font-size="7.5" font-style="italic" fill="#64748B">${escapeXml(truncateToWidth(tpl.config.footerNote.trim(), 420, 7.5))}</text>`;
  }

  if (tpl.config.showSeal) {
    const sealX = tpl.config.showQrCode ? SVG_WIDTH - 175 : SVG_WIDTH - 95;
    footerSvg += renderSealSvg(sealX, footerTop + 42, 26, primary, gold);
  }
  if (tpl.config.showQrCode) {
    const qrSize = 54;
    const qrX = SVG_WIDTH - 62 - qrSize;
    footerSvg += renderQrSvg(
      data.verificationUrl,
      qrX,
      footerTop + 10,
      qrSize,
      deepGreen,
      '#CBD5E1',
    );
    footerSvg += `<text x="${qrX + qrSize / 2}" y="${footerTop + 72}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="6" font-weight="700" fill="#64748B">SCAN TO VERIFY</text>`;
  }

  return `
    <rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#FDFBF7" />
    <rect x="18" y="18" width="${SVG_WIDTH - 36}" height="${SVG_HEIGHT - 36}" fill="none" stroke="${gold}" stroke-width="3" />
    <rect x="24" y="24" width="${SVG_WIDTH - 48}" height="${SVG_HEIGHT - 48}" fill="none" stroke="${deepGreen}" stroke-width="1" />
    <rect x="28" y="28" width="${SVG_WIDTH - 56}" height="${SVG_HEIGHT - 56}" fill="none" stroke="#D89E34" stroke-width="0.5" />
    ${cornerDiamonds}
    ${headerSvg}
    ${sigBandSvg}
    ${footerSvg}
  `;
}

function buildModernSvg(
  data: CertificateRenderData,
  tpl: CertificateTemplateSnapshotDto,
  emblemUri: string | null,
): string {
  const primary = tpl.config.accentColor || '#034729';
  const secondary = tpl.config.secondaryColor || '#13211A';
  const gold = '#E4A735';
  const contentX = 64;
  const contentWidth = SVG_WIDTH - 128;

  const headerY = 44;
  let bodySvg = '';
  if (tpl.config.showLogo && emblemUri) {
    bodySvg += `<image href="${emblemUri}" x="${contentX}" y="${headerY - 2}" width="34" height="34" preserveAspectRatio="xMidYMid meet" />`;
  }
  const brandX = tpl.config.showLogo && emblemUri ? contentX + 44 : contentX;
  const brandMaxW = contentWidth - (brandX - contentX) - 255;
  bodySvg += `<text x="${brandX}" y="${headerY + 14}" font-family="${escapeXml(FONT_SANS)}" font-size="14" font-weight="700" letter-spacing="1.5" fill="${secondary}">${escapeXml(truncateToWidth((tpl.issuingAuthority || 'ASRA ACADEMY').toUpperCase(), brandMaxW, 14, true))}</text>`;
  if (tpl.subtitle) {
    bodySvg += `<text x="${brandX}" y="${headerY + 28}" font-family="${escapeXml(FONT_SANS)}" font-size="8" letter-spacing="1.2" fill="#6B8577">${escapeXml(truncateToWidth(tpl.subtitle.toUpperCase(), brandMaxW, 8))}</text>`;
  }

  if (tpl.config.showSourceLabel) {
    const sourceBadge = (
      data.sourceLabel || (data.sourceType ? SOURCE_TYPE_LABELS[data.sourceType] : 'Credential')
    ).toUpperCase();
    const pillW = Math.min(180, Math.max(85, estimateTextWidth(sourceBadge, 7.5, true) + 22));
    const pillX = tpl.config.showQrCode ? SVG_WIDTH - 64 - 66 - pillW - 14 : SVG_WIDTH - 64 - pillW;
    bodySvg += `
      <rect x="${pillX}" y="${headerY + 4}" width="${pillW}" height="20" rx="10" fill="#EAF5EF" />
      <text x="${pillX + pillW / 2}" y="${headerY + 17}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="7.5" font-weight="700" fill="${primary}">${escapeXml(truncateToWidth(sourceBadge, pillW - 12, 7.5, true))}</text>
    `;
  }

  if (tpl.config.showQrCode) {
    const qrSize = 58;
    const qrX = SVG_WIDTH - 64 - qrSize;
    bodySvg += renderQrSvg(data.verificationUrl, qrX, 38, qrSize, secondary, '#CBD5E1');
    bodySvg += `<text x="${qrX + qrSize / 2}" y="106" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="6" font-weight="700" fill="#64748B">VERIFY ONLINE</text>`;
  }

  let y = 128;
  const titleText = (
    data.certificateTitle ||
    tpl.certificateTitle ||
    'CERTIFICATE OF RECOGNITION'
  ).toUpperCase();
  const titleRendered = renderMultilineSvg(titleText, {
    x: contentX,
    y,
    maxWidth: contentWidth - 80,
    fontSize: 23,
    minFontSize: 13,
    maxLines: 2,
    lineHeight: 1.15,
    fontFamily: FONT_SANS,
    fontWeight: '700',
    fill: primary,
    letterSpacing: 1.4,
  });
  bodySvg += titleRendered.svg;
  y = titleRendered.nextY - 2;

  bodySvg += `<rect x="${contentX}" y="${y}" width="76" height="3" fill="${gold}" />`;
  y += 22;

  bodySvg += `<text x="${contentX}" y="${y}" font-family="${escapeXml(FONT_SANS)}" font-size="8.5" font-weight="700" letter-spacing="2" fill="#6B8577">PRESENTED TO</text>`;
  y += 26;

  const nameRendered = renderMultilineSvg(data.recipientName, {
    x: contentX,
    y,
    maxWidth: contentWidth,
    fontSize: 29,
    minFontSize: 14,
    maxLines: 2,
    lineHeight: 1.15,
    fontFamily: FONT_SANS,
    fontWeight: '700',
    fill: secondary,
  });
  bodySvg += nameRendered.svg;
  y = nameRendered.nextY + 6;

  const bodyText =
    data.description?.trim() ||
    tpl.bodyText ||
    'is hereby recognized for successfully fulfilling all requirements in';
  const descRendered = renderMultilineSvg(bodyText, {
    x: contentX,
    y,
    maxWidth: contentWidth - 40,
    fontSize: 11,
    minFontSize: 8.5,
    maxLines: 2,
    lineHeight: 1.25,
    fontFamily: FONT_SANS,
    fill: '#475569',
  });
  bodySvg += descRendered.svg;
  y = descRendered.nextY + 8;

  const subjectRendered = renderMultilineSvg(data.courseTitle, {
    x: contentX,
    y,
    maxWidth: contentWidth,
    fontSize: 18,
    minFontSize: 11,
    maxLines: 2,
    lineHeight: 1.18,
    fontFamily: FONT_SANS,
    fontWeight: '700',
    fill: primary,
  });
  bodySvg += subjectRendered.svg;
  y = subjectRendered.nextY + 2;

  if (data.achievementDetails && y < 350) {
    const achWidth = Math.min(contentWidth, 560);
    const achSize = fitFontSizeSingle(data.achievementDetails, achWidth - 24, 9.5, 7.5, true);
    const safeAch = truncateToWidth(data.achievementDetails, achWidth - 24, achSize, true);
    bodySvg += `
      <rect x="${contentX}" y="${y}" width="${achWidth}" height="24" rx="5" fill="#F3F8F5" />
      <rect x="${contentX}" y="${y}" width="3.5" height="24" fill="${primary}" />
      <text x="${contentX + 12}" y="${y + 15}" font-family="${escapeXml(FONT_SANS)}" font-size="${achSize}" font-weight="700" fill="${secondary}">${escapeXml(safeAch)}</text>
    `;
  }

  const sigBandSvg = renderSignatureBandSvg(
    data.signatureSnapshots ?? [],
    data.signatureBuffers,
    contentX,
    378,
    contentWidth,
    {
      nameFont: FONT_SANS,
      roleFont: FONT_SANS,
      nameColor: secondary,
      roleColor: '#64748B',
      lineColor: '#CBD5E1',
      glowColor: '#F8FAFC',
    },
  );

  const footerY = 482;
  const col1 = contentX;
  const col2 = contentX + 185;
  const col3 = contentX + 370;

  let footerSvg = `<line x1="${contentX}" y1="${footerY}" x2="${SVG_WIDTH - 64}" y2="${footerY}" stroke="#E2E8F0" stroke-width="0.75" />`;
  if (tpl.config.showCompletionDate) {
    footerSvg += `
      <text x="${col1}" y="${footerY + 18}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5" font-weight="700" fill="#64748B">COMPLETED ON</text>
      <text x="${col1}" y="${footerY + 32}" font-family="${escapeXml(FONT_SANS)}" font-size="9.5" font-weight="700" fill="${secondary}">${escapeXml(formatCertificateDate(data.completedAt))}</text>
    `;
  }
  if (tpl.config.showIssueDate) {
    footerSvg += `
      <text x="${col2}" y="${footerY + 18}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5" font-weight="700" fill="#64748B">ISSUED ON</text>
      <text x="${col2}" y="${footerY + 32}" font-family="${escapeXml(FONT_SANS)}" font-size="9.5" font-weight="700" fill="${secondary}">${escapeXml(formatCertificateDate(data.issuedAt))}</text>
    `;
  }
  if (tpl.config.showCertificateNumber) {
    footerSvg += `
      <text x="${col3}" y="${footerY + 18}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5" font-weight="700" fill="#64748B">CREDENTIAL ID</text>
      <text x="${col3}" y="${footerY + 32}" font-family="${escapeXml(FONT_MONO)}" font-size="9.5" font-weight="700" fill="${primary}">${escapeXml(data.certificateNumber)}</text>
    `;
  }
  footerSvg += `<text x="${contentX}" y="${footerY + 49}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5" fill="#64748B">${escapeXml(truncateToWidth(`Verify authenticity: ${data.verificationUrl}`, contentWidth, 7.5))}</text>`;
  if (tpl.config.footerNote?.trim()) {
    footerSvg += `<text x="${contentX}" y="${footerY + 61}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5" font-style="italic" fill="#64748B">${escapeXml(truncateToWidth(tpl.config.footerNote.trim(), contentWidth, 7.5))}</text>`;
  }

  return `
    <rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#FFFFFF" />
    <rect x="0" y="0" width="18" height="${SVG_HEIGHT}" fill="${primary}" />
    <rect x="18" y="0" width="5" height="${SVG_HEIGHT}" fill="${gold}" />
    <rect x="36" y="22" width="${SVG_WIDTH - 58}" height="${SVG_HEIGHT - 44}" fill="none" stroke="#E2E8F0" stroke-width="0.75" />
    ${bodySvg}
    ${sigBandSvg}
    ${footerSvg}
  `;
}

function buildPremiumSvg(
  data: CertificateRenderData,
  tpl: CertificateTemplateSnapshotDto,
  emblemUri: string | null,
): string {
  const deepGreen = tpl.config.accentColor || '#012114';
  const gold = tpl.config.secondaryColor || '#D89E34';
  const richGold = '#C88717';

  let headerSvg = '';
  if (tpl.config.showLogo && emblemUri) {
    headerSvg += `
      <circle cx="64" cy="34" r="21" fill="#FDFBF7" />
      <image href="${emblemUri}" x="46" y="16" width="36" height="36" preserveAspectRatio="xMidYMid meet" />
    `;
  }
  const brandX = tpl.config.showLogo && emblemUri ? 98 : 42;
  headerSvg += `<text x="${brandX}" y="32" font-family="${escapeXml(FONT_SERIF)}" font-size="17" font-weight="700" letter-spacing="2" fill="${gold}">${escapeXml(truncateToWidth((tpl.issuingAuthority || 'ASRA ACADEMY').toUpperCase(), 460, 17, true))}</text>`;
  if (tpl.subtitle) {
    headerSvg += `<text x="${brandX}" y="48" font-family="${escapeXml(FONT_SANS)}" font-size="8" letter-spacing="1.6" fill="#E6EDE8">${escapeXml(truncateToWidth(tpl.subtitle.toUpperCase(), 460, 8))}</text>`;
  }

  if (tpl.config.showSourceLabel) {
    const sourceBadge = (
      data.sourceLabel || (data.sourceType ? SOURCE_TYPE_LABELS[data.sourceType] : 'Distinction')
    ).toUpperCase();
    const pillW = Math.min(180, Math.max(92, estimateTextWidth(sourceBadge, 7.5, true) + 24));
    const pillX = SVG_WIDTH - 40 - pillW;
    headerSvg += `
      <rect x="${pillX}" y="23" width="${pillW}" height="22" rx="11" fill="#034729" stroke="${gold}" stroke-width="0.8" />
      <text x="${pillX + pillW / 2}" y="37" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="7.5" font-weight="700" fill="#FDFBF7">${escapeXml(truncateToWidth(sourceBadge, pillW - 14, 7.5, true))}</text>
    `;
  }

  let y = 122;
  const titleText = (
    data.certificateTitle ||
    tpl.certificateTitle ||
    'CERTIFICATE OF EXCELLENCE'
  ).toUpperCase();
  const titleRendered = renderMultilineSvg(titleText, {
    x: SVG_WIDTH / 2,
    y,
    maxWidth: SVG_WIDTH - 160,
    fontSize: 22,
    minFontSize: 13,
    maxLines: 2,
    lineHeight: 1.15,
    fontFamily: FONT_SERIF,
    fontWeight: '700',
    fill: deepGreen,
    anchor: 'middle',
    letterSpacing: 2.2,
  });
  headerSvg += titleRendered.svg;
  y = titleRendered.nextY - 2;

  headerSvg += `
    <line x1="${SVG_WIDTH / 2 - 140}" y1="${y}" x2="${SVG_WIDTH / 2 - 14}" y2="${y}" stroke="${richGold}" stroke-width="1" />
    <line x1="${SVG_WIDTH / 2 + 14}" y1="${y}" x2="${SVG_WIDTH / 2 + 140}" y2="${y}" stroke="${richGold}" stroke-width="1" />
    <g transform="translate(${SVG_WIDTH / 2}, ${y}) rotate(45)"><rect x="-4" y="-4" width="8" height="8" fill="${gold}" /></g>
  `;
  y += 18;

  headerSvg += `<text x="${SVG_WIDTH / 2}" y="${y}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="8.5" font-weight="700" letter-spacing="2.2" fill="#8A5A0B">PROUDLY AWARDED TO</text>`;
  y += 26;

  const nameRendered = renderMultilineSvg(data.recipientName, {
    x: SVG_WIDTH / 2,
    y,
    maxWidth: SVG_WIDTH - 140,
    fontSize: 29,
    minFontSize: 14,
    maxLines: 2,
    lineHeight: 1.15,
    fontFamily: FONT_SERIF,
    fontWeight: '700',
    fill: deepGreen,
    anchor: 'middle',
  });
  headerSvg += nameRendered.svg;
  y = nameRendered.nextY + 6;

  const bodyText =
    data.description?.trim() ||
    tpl.bodyText ||
    'is awarded this distinction in recognition of exceptional merit and excellence in';
  const bodyRendered = renderMultilineSvg(bodyText, {
    x: SVG_WIDTH / 2,
    y,
    maxWidth: SVG_WIDTH - 180,
    fontSize: 11.5,
    minFontSize: 8.5,
    maxLines: 2,
    lineHeight: 1.25,
    fontFamily: FONT_SERIF,
    fill: '#374151',
    anchor: 'middle',
  });
  headerSvg += bodyRendered.svg;
  y = bodyRendered.nextY + 6;

  const subjectRendered = renderMultilineSvg(data.courseTitle, {
    x: SVG_WIDTH / 2,
    y,
    maxWidth: SVG_WIDTH - 150,
    fontSize: 18,
    minFontSize: 11,
    maxLines: 2,
    lineHeight: 1.18,
    fontFamily: FONT_SERIF,
    fontWeight: '700',
    fill: '#034729',
    anchor: 'middle',
  });
  headerSvg += subjectRendered.svg;
  y = subjectRendered.nextY + 2;

  if (data.achievementDetails && y < 340) {
    const boxW = Math.min(540, SVG_WIDTH - 180);
    const boxX = (SVG_WIDTH - boxW) / 2;
    const achSize = fitFontSizeSingle(data.achievementDetails, boxW - 24, 10.5, 8, false);
    const safeAch = truncateToWidth(data.achievementDetails, boxW - 24, achSize, false);
    headerSvg += `
      <rect x="${boxX}" y="${y}" width="${boxW}" height="24" rx="12" fill="#FFFDF8" stroke="${gold}" stroke-width="0.9" />
      <text x="${SVG_WIDTH / 2}" y="${y + 15.5}" text-anchor="middle" font-family="${escapeXml(FONT_SERIF)}" font-size="${achSize}" font-style="italic" fill="#8A5A0B">${escapeXml(safeAch)}</text>
    `;
  }

  const sigBandSvg = renderSignatureBandSvg(
    data.signatureSnapshots ?? [],
    data.signatureBuffers,
    62,
    366,
    SVG_WIDTH - 124,
    {
      nameFont: FONT_SERIF,
      roleFont: FONT_SANS,
      nameColor: deepGreen,
      roleColor: '#4A5568',
      lineColor: richGold,
      glowColor: '#FFFFFF',
    },
  );

  const stripY = 468;
  const leftX = 56;
  let dateY = stripY + 18;
  let footerSvg = '';
  if (tpl.config.showCompletionDate) {
    footerSvg += `<text x="${leftX}" y="${dateY}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5"><tspan font-weight="700" fill="${deepGreen}">ACHIEVEMENT DATE: </tspan><tspan fill="#2D3748">${escapeXml(formatCertificateDate(data.completedAt))}</tspan></text>`;
    dateY += 13;
  }
  if (tpl.config.showIssueDate) {
    footerSvg += `<text x="${leftX}" y="${dateY}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5"><tspan font-weight="700" fill="${deepGreen}">ISSUED DATE: </tspan><tspan fill="#2D3748">${escapeXml(formatCertificateDate(data.issuedAt))}</tspan></text>`;
    dateY += 13;
  }
  if (tpl.config.showCertificateNumber) {
    footerSvg += `<text x="${leftX}" y="${dateY}" font-family="${escapeXml(FONT_SANS)}" font-size="7.5"><tspan font-weight="700" fill="${deepGreen}">CREDENTIAL NO: </tspan><tspan font-family="${escapeXml(FONT_MONO)}" font-weight="700" fill="#034729">${escapeXml(data.certificateNumber)}</tspan></text>`;
  }

  if (tpl.config.showSeal) {
    const sealX = tpl.config.showQrCode ? SVG_WIDTH - 172 : SVG_WIDTH - 92;
    footerSvg += renderSealSvg(sealX, stripY + 34, 26, '#034729', richGold);
  }
  if (tpl.config.showQrCode) {
    const qrSize = 52;
    const qrX = SVG_WIDTH - 56 - qrSize;
    footerSvg += renderQrSvg(data.verificationUrl, qrX, stripY + 4, qrSize, deepGreen, richGold);
    footerSvg += `<text x="${qrX + qrSize / 2}" y="${stripY + 64}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="5.8" font-weight="700" fill="#8A5A0B">VERIFY QR</text>`;
  }

  const footerLine = tpl.config.footerNote?.trim()
    ? `${tpl.config.footerNote.trim()} · Verify credential online: ${data.verificationUrl}`
    : `Verify credential online: ${data.verificationUrl}`;

  footerSvg += `<text x="${SVG_WIDTH / 2}" y="${SVG_HEIGHT - 13}" text-anchor="middle" font-family="${escapeXml(FONT_SANS)}" font-size="8" fill="#F6F1E4">${escapeXml(truncateToWidth(footerLine, SVG_WIDTH - 80, 8))}</text>`;

  return `
    <rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#FAF6EE" />
    <rect x="0" y="0" width="${SVG_WIDTH}" height="68" fill="${deepGreen}" />
    <rect x="0" y="68" width="${SVG_WIDTH}" height="3" fill="${gold}" />
    <rect x="0" y="${SVG_HEIGHT - 32}" width="${SVG_WIDTH}" height="32" fill="${deepGreen}" />
    <rect x="0" y="${SVG_HEIGHT - 35}" width="${SVG_WIDTH}" height="3" fill="${gold}" />
    <rect x="20" y="82" width="${SVG_WIDTH - 40}" height="${SVG_HEIGHT - 128}" fill="none" stroke="${richGold}" stroke-width="1.5" />
    <rect x="25" y="87" width="${SVG_WIDTH - 50}" height="${SVG_HEIGHT - 138}" fill="none" stroke="${deepGreen}" stroke-width="0.5" />
    ${headerSvg}
    ${sigBandSvg}
    ${footerSvg}
  `;
}

/**
 * Generates an official, high-resolution landscape PNG certificate (1684x1190) purely in memory
 * from immutable template & signature snapshots without persisting any output files.
 */
export async function generateCertificatePng(data: CertificateRenderData): Promise<Buffer> {
  const tpl = resolveRenderTemplate(data);
  if (isArtworkCertificateStyle(tpl.style)) {
    // ASRA QUIZORA 2026 artwork template: 3072 × 2048 PNG (see quizora-renderer.ts).
    return renderQuizoraCertificatePng(data);
  }
  const emblemUri = readEmblemDataUri();

  let contentSvg: string;
  switch (tpl.style) {
    case 'MODERN_MINIMAL':
      contentSvg = buildModernSvg(data, tpl, emblemUri);
      break;
    case 'PREMIUM_ACHIEVEMENT':
      contentSvg = buildPremiumSvg(data, tpl, emblemUri);
      break;
    case 'CLASSIC_INSTITUTIONAL':
    default:
      contentSvg = buildClassicSvg(data, tpl, emblemUri);
      break;
  }

  const watermarkSvg = renderStatusWatermarkSvg(
    resolveEffectiveRenderStatus(data),
    data.supersededByCertificateNumber,
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PNG_PIXEL_WIDTH}" height="${PNG_PIXEL_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}">${contentSvg}${watermarkSvg}</svg>`;

  return sharp(Buffer.from(svg, 'utf8')).png({ compressionLevel: 9 }).toBuffer();
}
