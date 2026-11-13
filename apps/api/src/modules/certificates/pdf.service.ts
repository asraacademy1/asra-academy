import type {
  CertificateLifecycleStatus,
  CertificateSignatureSnapshotDto,
  CertificateTemplateSnapshotDto,
} from '@asra/types';
import { isArtworkCertificateStyle, SOURCE_TYPE_LABELS } from '@asra/validation';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { loadArtworkAssets } from './quizora-assets.js';
import {
  artworkDefinitionFor,
  buildQuizoraRenderModel,
  quizoraPdfPageSize,
  renderQuizoraPdfPage,
} from './quizora-renderer.js';
import {
  findEmblemPath,
  formatCertificateDate,
  resolveEffectiveRenderStatus,
  resolveRenderSignatures,
  resolveRenderTemplate,
  type CertificateRenderData,
} from './render-helpers.js';

export type CertificatePdfData = CertificateRenderData;

/**
 * Computes a font size that fits text cleanly within `maxWidth` (and optional `maxHeight`)
 * so long student names or long titles never overlap borders or adjacent blocks.
 */
function fitFontSize(
  doc: PDFKit.PDFDocument,
  text: string,
  font: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
  maxHeight?: number,
): number {
  let size = startSize;
  while (size > minSize) {
    doc.font(font).fontSize(size);
    const singleLineWidth = doc.widthOfString(text);
    const wrappedHeight = doc.heightOfString(text, { width: maxWidth });
    if (maxHeight !== undefined) {
      if (wrappedHeight <= maxHeight && singleLineWidth <= maxWidth * 1.95) {
        return size;
      }
    } else if (singleLineWidth <= maxWidth) {
      return size;
    }
    size -= 1;
  }
  return minSize;
}

/**
 * Draws a crisp vector QR code inside a white quiet-zone card using PDFKit primitives.
 */
function drawQrCode(
  doc: PDFKit.PDFDocument,
  payload: string,
  x: number,
  y: number,
  boxSize: number,
  darkColor: string,
  borderColor: string,
): void {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const modules = qr.modules;
  const count = modules.size;
  const padding = 4;
  const innerSize = boxSize - padding * 2;
  const cell = innerSize / count;

  doc.save();
  doc.roundedRect(x, y, boxSize, boxSize, 4).fillAndStroke('#FFFFFF', borderColor);

  doc.fillColor(darkColor);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (modules.get(row, col)) {
        doc
          .rect(x + padding + col * cell, y + padding + row * cell, cell + 0.15, cell + 0.15)
          .fill();
      }
    }
  }
  doc.restore();
}

/**
 * Draws the ASRA Academy circular seal graphic.
 */
function drawAcademySeal(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  radius: number,
  primaryColor: string,
  goldColor: string,
): void {
  doc.save();
  doc.circle(cx, cy, radius).fillOpacity(0.06).fill(goldColor);
  doc.fillOpacity(1);
  doc.circle(cx, cy, radius).lineWidth(1.6).strokeColor(goldColor).stroke();
  doc
    .circle(cx, cy, radius - 4)
    .lineWidth(0.7)
    .strokeColor(primaryColor)
    .stroke();

  doc
    .font('Helvetica-Bold')
    .fontSize(6.5)
    .fillColor(primaryColor)
    .text('OFFICIAL', cx - radius, cy - 10, { width: radius * 2, align: 'center' })
    .text('SEAL', cx - radius, cy - 1, { width: radius * 2, align: 'center' })
    .font('Helvetica')
    .fontSize(5.5)
    .fillColor(goldColor)
    .text('ASRA ACADEMY', cx - radius, cy + 9, { width: radius * 2, align: 'center' });
  doc.restore();
}

/**
 * Renders 1–4 digital signatures evenly across a horizontal band.
 * Applies subtle soft glow and controlled shadow treatment during rendering without
 * modifying or distorting the stored original transparent PNG signature.
 */
function drawSignatureBand(
  doc: PDFKit.PDFDocument,
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
): void {
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

  list.forEach((sig, index) => {
    const colX = startX + index * (colWidth + gap);
    const pngBuffer =
      (sig.signatureId ? buffers?.get(sig.signatureId) : undefined) ??
      (sig.storageKey ? buffers?.get(sig.storageKey) : undefined);

    // Subtle soft highlight glow + controlled shadow pedestal behind the transparent PNG
    doc.save();
    doc
      .roundedRect(colX + 8, bandY + 2, colWidth - 16, sigImgHeight - 2, 8)
      .fillOpacity(0.45)
      .fill(options.glowColor);
    doc.fillOpacity(1);

    // Controlled baseline shadow line
    doc
      .moveTo(colX + 12, lineY + 1.2)
      .lineTo(colX + colWidth - 12, lineY + 1.2)
      .lineWidth(1.5)
      .strokeOpacity(0.14)
      .strokeColor('#012114')
      .stroke();
    doc.strokeOpacity(1);

    if (pngBuffer) {
      try {
        doc.image(pngBuffer, colX + 10, bandY + 2, {
          fit: [colWidth - 20, sigImgHeight - 4],
          align: 'center',
          valign: 'bottom',
        });
      } catch {
        // Fallback gracefully if an invalid buffer is ever encountered
      }
    }

    // Crisp metallic/slate signature baseline
    doc
      .moveTo(colX + 8, lineY)
      .lineTo(colX + colWidth - 8, lineY)
      .lineWidth(0.85)
      .strokeColor(options.lineColor)
      .stroke();

    let textY = lineY + 5;
    if (sig.showName) {
      const nameSize = fitFontSize(doc, sig.fullName, options.nameFont, colWidth - 6, 9.5, 7);
      doc
        .font(options.nameFont)
        .fontSize(nameSize)
        .fillColor(options.nameColor)
        .text(sig.fullName, colX + 2, textY, {
          width: colWidth - 4,
          align: 'center',
          lineBreak: false,
        });
      textY += 12;
    }

    if (sig.showDesignation) {
      const roleText = sig.department ? `${sig.designation} · ${sig.department}` : sig.designation;
      const roleSize = fitFontSize(doc, roleText, options.roleFont, colWidth - 4, 8, 6);
      doc
        .font(options.roleFont)
        .fontSize(roleSize)
        .fillColor(options.roleColor)
        .text(roleText, colX + 2, textY, {
          width: colWidth - 4,
          align: 'center',
          lineBreak: false,
        });
    }
    doc.restore();
  });
}

function drawStatusWatermark(
  doc: PDFKit.PDFDocument,
  width: number,
  height: number,
  effectiveStatus: CertificateLifecycleStatus,
  supersededBy?: string | null,
): void {
  if (effectiveStatus === 'ISSUED') return;
  const isSuperseded = effectiveStatus === 'SUPERSEDED';
  const label = isSuperseded ? 'SUPERSEDED' : 'REVOKED';
  const tint = isSuperseded ? '#B45309' : '#B42318';

  doc.save();
  doc.translate(width / 2, height / 2).rotate(-24);
  doc
    .font('Helvetica-Bold')
    .fontSize(isSuperseded ? 56 : 64)
    .fillOpacity(0.16)
    .fillColor(tint)
    .text(label, -240, -34, { width: 480, align: 'center' });
  if (isSuperseded) {
    const sub = supersededBy
      ? `REPLACED BY ${supersededBy}`
      : 'REPLACED BY NEWER CREDENTIAL · INVALID';
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillOpacity(0.24)
      .fillColor(tint)
      .text(sub, -240, 28, { width: 480, align: 'center' });
  }
  doc.restore();
}

function renderClassicInstitutional(
  doc: PDFKit.PDFDocument,
  data: CertificatePdfData,
  tpl: CertificateTemplateSnapshotDto,
  emblemPath: string | null,
): void {
  const width = doc.page.width;
  const height = doc.page.height;
  const primary = tpl.config.accentColor || '#034729';
  const gold = tpl.config.secondaryColor || '#C88717';
  const deepGreen = '#012114';

  // 1. Ivory background & triple borders
  doc.rect(0, 0, width, height).fill('#FDFBF7');
  doc
    .rect(18, 18, width - 36, height - 36)
    .lineWidth(3)
    .strokeColor(gold)
    .stroke();
  doc
    .rect(24, 24, width - 48, height - 48)
    .lineWidth(1)
    .strokeColor(deepGreen)
    .stroke();
  doc
    .rect(28, 28, width - 56, height - 56)
    .lineWidth(0.5)
    .strokeColor('#D89E34')
    .stroke();

  const drawCornerDiamond = (x: number, y: number) => {
    doc
      .save()
      .translate(x, y)
      .rotate(45)
      .rect(-4, -4, 8, 8)
      .fillAndStroke(gold, deepGreen)
      .restore();
  };
  drawCornerDiamond(24, 24);
  drawCornerDiamond(width - 24, 24);
  drawCornerDiamond(24, height - 24);
  drawCornerDiamond(width - 24, height - 24);

  // 2. Header & Emblem
  let y = 42;
  if (tpl.config.showLogo && emblemPath) {
    doc.image(emblemPath, width / 2 - 22, y, { width: 44 });
    y += 48;
  } else {
    y += 6;
  }

  doc
    .font('Times-Bold')
    .fontSize(20)
    .fillColor(deepGreen)
    .text((tpl.issuingAuthority || 'ASRA ACADEMY').toUpperCase(), 60, y, {
      width: width - 120,
      align: 'center',
      characterSpacing: 2,
    });
  y += 23;

  if (tpl.subtitle) {
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(gold)
      .text(tpl.subtitle.toUpperCase(), 60, y, {
        width: width - 120,
        align: 'center',
        characterSpacing: 1.8,
        height: 14,
        ellipsis: true,
      });
    y += 16;
  } else {
    y += 8;
  }

  if (tpl.config.showSourceLabel && (data.sourceLabel || data.sourceType)) {
    const sourceBadge = (
      data.sourceLabel || (data.sourceType ? SOURCE_TYPE_LABELS[data.sourceType] : 'Credential')
    ).toUpperCase();
    const pillW = Math.min(
      200,
      Math.max(88, doc.font('Helvetica-Bold').fontSize(7).widthOfString(sourceBadge) + 22),
    );
    const pillX = (width - pillW) / 2;
    doc.roundedRect(pillX, y, pillW, 14, 7).lineWidth(0.7).fillAndStroke('#F4EFE2', gold);
    doc
      .font('Helvetica-Bold')
      .fontSize(7)
      .fillColor(primary)
      .text(sourceBadge, pillX, y + 3.5, { width: pillW, align: 'center', lineBreak: false });
    y += 18;
  }

  // 3. Certificate Title
  const titleText = (
    data.certificateTitle ||
    tpl.certificateTitle ||
    'CERTIFICATE OF COMPLETION'
  ).toUpperCase();
  const titleMaxH = 34;
  const titleSize = fitFontSize(doc, titleText, 'Times-Bold', width - 150, 21, 12, titleMaxH);
  doc
    .font('Times-Bold')
    .fontSize(titleSize)
    .fillColor(primary)
    .text(titleText, 75, y, {
      width: width - 150,
      height: titleMaxH,
      ellipsis: true,
      align: 'center',
      characterSpacing: 2.0,
    });
  const renderedTitleH = Math.min(titleMaxH, doc.heightOfString(titleText, { width: width - 150 }));
  y += Math.max(titleSize + 4, renderedTitleH) + 5;

  doc
    .moveTo(width / 2 - 125, y)
    .lineTo(width / 2 + 125, y)
    .lineWidth(1)
    .strokeColor(gold)
    .stroke();
  doc
    .circle(width / 2, y, 2.8)
    .fillColor(primary)
    .fill();
  y += 12;

  // 4. Recipient Presentation
  doc
    .font('Times-Italic')
    .fontSize(12)
    .fillColor('#4A5568')
    .text('This is to certify that', 60, y, { width: width - 120, align: 'center' });
  y += 16;

  const nameMaxH = 38;
  const nameSize = fitFontSize(
    doc,
    data.recipientName,
    'Times-Bold',
    width - 150,
    28,
    13,
    nameMaxH,
  );
  doc
    .font('Times-Bold')
    .fontSize(nameSize)
    .fillColor(deepGreen)
    .text(data.recipientName, 75, y, {
      width: width - 150,
      height: nameMaxH,
      ellipsis: true,
      align: 'center',
    });
  const nameHeight = Math.min(
    nameMaxH,
    doc.heightOfString(data.recipientName, { width: width - 150 }),
  );
  y += Math.max(24, nameHeight) + 3;

  doc
    .moveTo(width / 2 - 170, y)
    .lineTo(width / 2 + 170, y)
    .lineWidth(1)
    .strokeColor('#D89E34')
    .stroke();
  y += 9;

  // 5. Body / Achievement text (strictly bounded above signature band at y = 368)
  const signatureBandTop = 366;
  const bodyText =
    data.description?.trim() ||
    tpl.bodyText ||
    'has successfully completed the curriculum and all required assessments for';
  const reserveAfterBody = data.achievementDetails ? 56 : 36;
  const maxBodyH = Math.min(34, Math.max(14, signatureBandTop - y - reserveAfterBody));
  const bodySize = fitFontSize(doc, bodyText, 'Times-Roman', width - 180, 11.5, 8.5, maxBodyH);
  doc
    .font('Times-Roman')
    .fontSize(bodySize)
    .fillColor('#374151')
    .text(bodyText, 90, y, {
      width: width - 180,
      height: maxBodyH,
      ellipsis: true,
      align: 'center',
    });
  const renderedBodyH = Math.min(maxBodyH, doc.heightOfString(bodyText, { width: width - 180 }));
  y += renderedBodyH + 7;

  // 6. Course / Subject / Achievement Title
  const reserveAfterSubject = data.achievementDetails ? 22 : 4;
  const maxSubjectH = Math.min(38, Math.max(15, signatureBandTop - y - reserveAfterSubject));
  const subjectSize = fitFontSize(
    doc,
    data.courseTitle,
    'Times-Bold',
    width - 150,
    19,
    10.5,
    maxSubjectH,
  );
  doc
    .font('Times-Bold')
    .fontSize(subjectSize)
    .fillColor(primary)
    .text(data.courseTitle, 75, y, {
      width: width - 150,
      height: maxSubjectH,
      ellipsis: true,
      align: 'center',
    });
  const renderedSubjectH = Math.min(
    maxSubjectH,
    doc.heightOfString(data.courseTitle, { width: width - 150 }),
  );
  y += renderedSubjectH + 5;

  if (data.achievementDetails && y + 12 < signatureBandTop) {
    const maxAchH = Math.max(12, signatureBandTop - y - 2);
    const achSize = fitFontSize(
      doc,
      data.achievementDetails,
      'Times-Italic',
      width - 190,
      10.5,
      8,
      maxAchH,
    );
    doc
      .font('Times-Italic')
      .fontSize(achSize)
      .fillColor('#8A5A0B')
      .text(data.achievementDetails, 95, y, {
        width: width - 190,
        height: maxAchH,
        ellipsis: true,
        align: 'center',
      });
  }

  // 7. Signature Band (2-4 Signatures)
  drawSignatureBand(
    doc,
    data.signatureSnapshots ?? [],
    data.signatureBuffers,
    65,
    368,
    width - 130,
    {
      nameFont: 'Helvetica-Bold',
      roleFont: 'Helvetica',
      nameColor: deepGreen,
      roleColor: '#4A5568',
      lineColor: '#94A3B8',
      glowColor: '#FFFFFF',
    },
  );

  // 8. Footer Metadata + Seal + QR Code
  const footerTop = 456;
  doc
    .moveTo(56, footerTop)
    .lineTo(width - 56, footerTop)
    .lineWidth(0.5)
    .strokeColor('#E2E8F0')
    .stroke();

  const leftX = 62;
  let metaY = footerTop + 9;
  if (tpl.config.showCompletionDate) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(deepGreen)
      .text('COMPLETION / ACHIEVEMENT DATE: ', leftX, metaY, { continued: true })
      .font('Helvetica')
      .fillColor('#2D3748')
      .text(formatCertificateDate(data.completedAt));
    metaY += 12;
  }
  if (tpl.config.showIssueDate) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(deepGreen)
      .text('ISSUED DATE: ', leftX, metaY, { continued: true })
      .font('Helvetica')
      .fillColor('#2D3748')
      .text(formatCertificateDate(data.issuedAt));
    metaY += 12;
  }
  if (tpl.config.showCertificateNumber) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(deepGreen)
      .text('CERTIFICATE ID: ', leftX, metaY, { continued: true })
      .font('Courier-Bold')
      .fillColor(primary)
      .text(data.certificateNumber);
    metaY += 12;
  }
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor('#4A5568')
    .text(`Verify at: ${data.verificationUrl}`, leftX, metaY, {
      width: 420,
      height: 11,
      ellipsis: true,
    });
  metaY += 11;
  if (tpl.config.footerNote?.trim()) {
    doc
      .font('Times-Italic')
      .fontSize(7.5)
      .fillColor('#64748B')
      .text(tpl.config.footerNote.trim(), leftX, metaY, { width: 420, height: 11, ellipsis: true });
  }

  if (tpl.config.showSeal) {
    const sealX = tpl.config.showQrCode ? width - 175 : width - 95;
    drawAcademySeal(doc, sealX, footerTop + 42, 26, primary, gold);
  }

  if (tpl.config.showQrCode) {
    const qrSize = 54;
    const qrX = width - 62 - qrSize;
    drawQrCode(doc, data.verificationUrl, qrX, footerTop + 10, qrSize, deepGreen, '#CBD5E1');
    doc
      .font('Helvetica-Bold')
      .fontSize(6)
      .fillColor('#64748B')
      .text('SCAN TO VERIFY', qrX - 4, footerTop + 67, { width: qrSize + 8, align: 'center' });
  }
}

function renderModernMinimal(
  doc: PDFKit.PDFDocument,
  data: CertificatePdfData,
  tpl: CertificateTemplateSnapshotDto,
  emblemPath: string | null,
): void {
  const width = doc.page.width;
  const height = doc.page.height;
  const primary = tpl.config.accentColor || '#034729';
  const secondary = tpl.config.secondaryColor || '#13211A';
  const gold = '#E4A735';

  // 1. Clean Warm-White Canvas + Left Spine
  doc.rect(0, 0, width, height).fill('#FFFFFF');
  doc.rect(0, 0, 18, height).fill(primary);
  doc.rect(18, 0, 5, height).fill(gold);
  doc
    .rect(36, 22, width - 58, height - 44)
    .lineWidth(0.75)
    .strokeColor('#E2E8F0')
    .stroke();

  const contentX = 64;
  const contentWidth = width - 128;

  // 2. Top Brand Row + QR Badge top-right
  const headerY = 44;
  if (tpl.config.showLogo && emblemPath) {
    doc.image(emblemPath, contentX, headerY - 2, { width: 34 });
  }
  const brandX = tpl.config.showLogo && emblemPath ? contentX + 44 : contentX;
  const brandMaxW = contentWidth - (brandX - contentX) - 255;
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(secondary)
    .text((tpl.issuingAuthority || 'ASRA ACADEMY').toUpperCase(), brandX, headerY + 2, {
      characterSpacing: 1.5,
      width: brandMaxW,
      height: 18,
      ellipsis: true,
    });
  if (tpl.subtitle) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#6B8577')
      .text(tpl.subtitle.toUpperCase(), brandX, headerY + 20, {
        characterSpacing: 1.2,
        width: brandMaxW,
        height: 14,
        ellipsis: true,
      });
  }

  // Source Pill
  if (tpl.config.showSourceLabel) {
    const sourceBadge = (
      data.sourceLabel || (data.sourceType ? SOURCE_TYPE_LABELS[data.sourceType] : 'Credential')
    ).toUpperCase();
    const pillW = Math.min(
      180,
      Math.max(85, doc.font('Helvetica-Bold').fontSize(7.5).widthOfString(sourceBadge) + 22),
    );
    const pillX = tpl.config.showQrCode ? width - 64 - 66 - pillW - 14 : width - 64 - pillW;
    doc.roundedRect(pillX, headerY + 4, pillW, 20, 10).fill('#EAF5EF');
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(primary)
      .text(sourceBadge, pillX, headerY + 10, { width: pillW, align: 'center', lineBreak: false });
  }

  if (tpl.config.showQrCode) {
    const qrSize = 58;
    const qrX = width - 64 - qrSize;
    drawQrCode(doc, data.verificationUrl, qrX, 38, qrSize, secondary, '#CBD5E1');
    doc
      .font('Helvetica-Bold')
      .fontSize(6)
      .fillColor('#64748B')
      .text('VERIFY ONLINE', qrX - 2, 100, { width: qrSize + 4, align: 'center' });
  }

  // 3. Title & Recipient Hierarchy
  let y = 112;
  const titleText = (
    data.certificateTitle ||
    tpl.certificateTitle ||
    'CERTIFICATE OF RECOGNITION'
  ).toUpperCase();
  const titleSize = fitFontSize(doc, titleText, 'Helvetica-Bold', contentWidth - 80, 24, 14);
  doc
    .font('Helvetica-Bold')
    .fontSize(titleSize)
    .fillColor(primary)
    .text(titleText, contentX, y, { width: contentWidth - 80, characterSpacing: 1.4 });
  y += titleSize + 10;

  doc.rect(contentX, y, 76, 3).fill(gold);
  y += 18;

  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor('#6B8577')
    .text('PRESENTED TO', contentX, y, { characterSpacing: 2 });
  y += 15;

  const nameMaxH = 42;
  const nameSize = fitFontSize(
    doc,
    data.recipientName,
    'Helvetica-Bold',
    contentWidth,
    30,
    14,
    nameMaxH,
  );
  doc
    .font('Helvetica-Bold')
    .fontSize(nameSize)
    .fillColor(secondary)
    .text(data.recipientName, contentX, y, {
      width: contentWidth,
      height: nameMaxH,
      ellipsis: true,
    });
  y +=
    Math.max(
      26,
      Math.min(nameMaxH, doc.heightOfString(data.recipientName, { width: contentWidth })),
    ) + 10;

  // 4. Body & Subject (strictly bounded above signature band at y = 378)
  const modernSigTop = 376;
  const bodyText =
    data.description?.trim() ||
    tpl.bodyText ||
    'is hereby recognized for successfully fulfilling all requirements in';
  const maxModernBodyH = Math.min(34, Math.max(14, modernSigTop - y - 62));
  const bodySize = fitFontSize(
    doc,
    bodyText,
    'Helvetica',
    contentWidth - 40,
    11,
    8.5,
    maxModernBodyH,
  );
  doc
    .font('Helvetica')
    .fontSize(bodySize)
    .fillColor('#475569')
    .text(bodyText, contentX, y, {
      width: contentWidth - 40,
      height: maxModernBodyH,
      ellipsis: true,
    });
  y += Math.min(maxModernBodyH, doc.heightOfString(bodyText, { width: contentWidth - 40 })) + 8;

  const maxModernSubjectH = Math.min(
    42,
    Math.max(15, modernSigTop - y - (data.achievementDetails ? 34 : 4)),
  );
  const subjectSize = fitFontSize(
    doc,
    data.courseTitle,
    'Helvetica-Bold',
    contentWidth,
    18,
    11,
    maxModernSubjectH,
  );
  doc
    .font('Helvetica-Bold')
    .fontSize(subjectSize)
    .fillColor(primary)
    .text(data.courseTitle, contentX, y, {
      width: contentWidth,
      height: maxModernSubjectH,
      ellipsis: true,
    });
  y +=
    Math.min(maxModernSubjectH, doc.heightOfString(data.courseTitle, { width: contentWidth })) + 10;

  if (data.achievementDetails) {
    const achWidth = Math.min(contentWidth, 560);
    doc.roundedRect(contentX, y, achWidth, 24, 5).fill('#F3F8F5');
    doc.rect(contentX, y, 3.5, 24).fill(primary);
    const achSize = fitFontSize(
      doc,
      data.achievementDetails,
      'Helvetica-Bold',
      achWidth - 20,
      9.5,
      7.5,
    );
    doc
      .font('Helvetica-Bold')
      .fontSize(achSize)
      .fillColor(secondary)
      .text(data.achievementDetails, contentX + 12, y + 7, {
        width: achWidth - 20,
        lineBreak: false,
      });
  }

  // 5. Signatures Band
  drawSignatureBand(
    doc,
    data.signatureSnapshots ?? [],
    data.signatureBuffers,
    contentX,
    378,
    contentWidth,
    {
      nameFont: 'Helvetica-Bold',
      roleFont: 'Helvetica',
      nameColor: secondary,
      roleColor: '#64748B',
      lineColor: '#CBD5E1',
      glowColor: '#F8FAFC',
    },
  );

  // 6. Clean Metadata Footer
  const footerY = 482;
  doc
    .moveTo(contentX, footerY)
    .lineTo(width - 64, footerY)
    .lineWidth(0.75)
    .strokeColor('#E2E8F0')
    .stroke();

  const col1 = contentX;
  const col2 = contentX + 185;
  const col3 = contentX + 370;

  if (tpl.config.showCompletionDate) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor('#64748B')
      .text('COMPLETED ON', col1, footerY + 12);
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor(secondary)
      .text(formatCertificateDate(data.completedAt), col1, footerY + 24);
  }
  if (tpl.config.showIssueDate) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor('#64748B')
      .text('ISSUED ON', col2, footerY + 12);
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor(secondary)
      .text(formatCertificateDate(data.issuedAt), col2, footerY + 24);
  }
  if (tpl.config.showCertificateNumber) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor('#64748B')
      .text('CREDENTIAL ID', col3, footerY + 12);
    doc
      .font('Courier-Bold')
      .fontSize(9.5)
      .fillColor(primary)
      .text(data.certificateNumber, col3, footerY + 24);
  }

  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor('#64748B')
    .text(`Verify authenticity: ${data.verificationUrl}`, contentX, footerY + 42, {
      width: contentWidth,
      height: 11,
      ellipsis: true,
    });
  if (tpl.config.footerNote?.trim()) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(7.5)
      .fillColor('#64748B')
      .text(tpl.config.footerNote.trim(), contentX, footerY + 54, {
        width: contentWidth,
        height: 11,
        ellipsis: true,
      });
  }
}

function renderPremiumAchievement(
  doc: PDFKit.PDFDocument,
  data: CertificatePdfData,
  tpl: CertificateTemplateSnapshotDto,
  emblemPath: string | null,
): void {
  const width = doc.page.width;
  const height = doc.page.height;
  const deepGreen = tpl.config.accentColor || '#012114';
  const gold = tpl.config.secondaryColor || '#D89E34';
  const richGold = '#C88717';

  // 1. Warm Parchment Canvas + Deep Forest Crest Bands
  doc.rect(0, 0, width, height).fill('#FAF6EE');
  doc.rect(0, 0, width, 68).fill(deepGreen);
  doc.rect(0, 68, width, 3).fill(gold);
  doc.rect(0, height - 32, width, 32).fill(deepGreen);
  doc.rect(0, height - 35, width, 3).fill(gold);

  // Inner metallic frame
  doc
    .rect(20, 82, width - 40, height - 128)
    .lineWidth(1.5)
    .strokeColor(richGold)
    .stroke();
  doc
    .rect(25, 87, width - 50, height - 138)
    .lineWidth(0.5)
    .strokeColor(deepGreen)
    .stroke();

  // Top Header Band content
  if (tpl.config.showLogo && emblemPath) {
    doc.circle(64, 34, 21).fill('#FDFBF7');
    doc.image(emblemPath, 46, 16, { width: 36 });
  }
  const brandX = tpl.config.showLogo && emblemPath ? 98 : 42;
  doc
    .font('Times-Bold')
    .fontSize(17)
    .fillColor(gold)
    .text((tpl.issuingAuthority || 'ASRA ACADEMY').toUpperCase(), brandX, 17, {
      characterSpacing: 2,
    });
  if (tpl.subtitle) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#E6EDE8')
      .text(tpl.subtitle.toUpperCase(), brandX, 39, { characterSpacing: 1.6 });
  }

  if (tpl.config.showSourceLabel) {
    const sourceBadge = (
      data.sourceLabel || (data.sourceType ? SOURCE_TYPE_LABELS[data.sourceType] : 'Distinction')
    ).toUpperCase();
    const pillW = Math.min(
      180,
      Math.max(92, doc.font('Helvetica-Bold').fontSize(7.5).widthOfString(sourceBadge) + 24),
    );
    const pillX = width - 40 - pillW;
    doc.roundedRect(pillX, 23, pillW, 22, 11).lineWidth(0.8).fillAndStroke('#034729', gold);
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor('#FDFBF7')
      .text(sourceBadge, pillX, 30, { width: pillW, align: 'center', lineBreak: false });
  }

  // 2. Centerpiece Typography
  let y = 104;
  const titleText = (
    data.certificateTitle ||
    tpl.certificateTitle ||
    'CERTIFICATE OF EXCELLENCE'
  ).toUpperCase();
  const titleSize = fitFontSize(doc, titleText, 'Times-Bold', width - 160, 22, 14);
  doc
    .font('Times-Bold')
    .fontSize(titleSize)
    .fillColor(deepGreen)
    .text(titleText, 80, y, { width: width - 160, align: 'center', characterSpacing: 2.5 });
  y += titleSize + 8;

  // Decorative gold filigree divider
  doc
    .moveTo(width / 2 - 140, y)
    .lineTo(width / 2 - 14, y)
    .lineWidth(1)
    .strokeColor(richGold)
    .stroke();
  doc
    .moveTo(width / 2 + 14, y)
    .lineTo(width / 2 + 140, y)
    .lineWidth(1)
    .strokeColor(richGold)
    .stroke();
  doc
    .save()
    .translate(width / 2, y)
    .rotate(45)
    .rect(-4, -4, 8, 8)
    .fill(gold)
    .restore();
  y += 14;

  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor('#8A5A0B')
    .text('PROUDLY AWARDED TO', 60, y, {
      width: width - 120,
      align: 'center',
      characterSpacing: 2.2,
    });
  y += 16;

  const nameSize = fitFontSize(doc, data.recipientName, 'Times-Bold', width - 140, 30, 16, 40);
  doc
    .font('Times-Bold')
    .fontSize(nameSize)
    .fillColor(deepGreen)
    .text(data.recipientName, 70, y, { width: width - 140, align: 'center' });
  y += Math.max(28, doc.heightOfString(data.recipientName, { width: width - 140 })) + 8;

  const premSigTop = 364;
  const bodyText =
    data.description?.trim() ||
    tpl.bodyText ||
    'is awarded this distinction in recognition of exceptional merit and excellence in';
  const maxPremBodyH = Math.min(32, Math.max(14, premSigTop - y - 56));
  const bodySize = fitFontSize(doc, bodyText, 'Times-Roman', width - 180, 11.5, 8.5, maxPremBodyH);
  doc
    .font('Times-Roman')
    .fontSize(bodySize)
    .fillColor('#374151')
    .text(bodyText, 90, y, {
      width: width - 180,
      height: maxPremBodyH,
      ellipsis: true,
      align: 'center',
    });
  y += Math.min(maxPremBodyH, doc.heightOfString(bodyText, { width: width - 180 })) + 8;

  const maxPremSubjectH = Math.min(
    40,
    Math.max(15, premSigTop - y - (data.achievementDetails ? 28 : 4)),
  );
  const subjectSize = fitFontSize(
    doc,
    data.courseTitle,
    'Times-Bold',
    width - 150,
    19,
    11,
    maxPremSubjectH,
  );
  doc
    .font('Times-Bold')
    .fontSize(subjectSize)
    .fillColor('#034729')
    .text(data.courseTitle, 75, y, {
      width: width - 150,
      height: maxPremSubjectH,
      ellipsis: true,
      align: 'center',
    });
  y += Math.min(maxPremSubjectH, doc.heightOfString(data.courseTitle, { width: width - 150 })) + 8;

  if (data.achievementDetails) {
    const boxW = Math.min(540, width - 180);
    const boxX = (width - boxW) / 2;
    doc.roundedRect(boxX, y, boxW, 24, 12).lineWidth(0.9).fillAndStroke('#FFFDF8', gold);
    const achSize = fitFontSize(doc, data.achievementDetails, 'Times-Italic', boxW - 24, 10.5, 8);
    doc
      .font('Times-Italic')
      .fontSize(achSize)
      .fillColor('#8A5A0B')
      .text(data.achievementDetails, boxX + 12, y + 7, {
        width: boxW - 24,
        align: 'center',
        lineBreak: false,
      });
  }

  // 3. Elevated Signature Band
  drawSignatureBand(
    doc,
    data.signatureSnapshots ?? [],
    data.signatureBuffers,
    62,
    366,
    width - 124,
    {
      nameFont: 'Times-Bold',
      roleFont: 'Helvetica',
      nameColor: deepGreen,
      roleColor: '#4A5568',
      lineColor: richGold,
      glowColor: '#FFFFFF',
    },
  );

  // 4. Seal + Dates + QR strip above bottom green bar
  const stripY = 468;
  const leftX = 56;
  let dateY = stripY + 10;
  if (tpl.config.showCompletionDate) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(deepGreen)
      .text('ACHIEVEMENT DATE: ', leftX, dateY, { continued: true })
      .font('Helvetica')
      .fillColor('#2D3748')
      .text(formatCertificateDate(data.completedAt));
    dateY += 13;
  }
  if (tpl.config.showIssueDate) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(deepGreen)
      .text('ISSUED DATE: ', leftX, dateY, { continued: true })
      .font('Helvetica')
      .fillColor('#2D3748')
      .text(formatCertificateDate(data.issuedAt));
    dateY += 13;
  }
  if (tpl.config.showCertificateNumber) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(deepGreen)
      .text('CREDENTIAL NO: ', leftX, dateY, { continued: true })
      .font('Courier-Bold')
      .fillColor('#034729')
      .text(data.certificateNumber);
  }

  if (tpl.config.showSeal) {
    const sealX = tpl.config.showQrCode ? width - 172 : width - 92;
    drawAcademySeal(doc, sealX, stripY + 34, 26, '#034729', richGold);
  }

  if (tpl.config.showQrCode) {
    const qrSize = 52;
    const qrX = width - 56 - qrSize;
    drawQrCode(doc, data.verificationUrl, qrX, stripY + 4, qrSize, deepGreen, richGold);
    doc
      .font('Helvetica-Bold')
      .fontSize(5.8)
      .fillColor('#8A5A0B')
      .text('VERIFY QR', qrX, stripY + 58, { width: qrSize, align: 'center' });
  }

  // 5. Bottom Deep Green Band
  const footerLine = tpl.config.footerNote?.trim()
    ? `${tpl.config.footerNote.trim()} · Verify credential online: ${data.verificationUrl}`
    : `Verify credential online: ${data.verificationUrl}`;
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#F6F1E4')
    .text(footerLine, 40, height - 21, {
      width: width - 80,
      height: 12,
      ellipsis: true,
      align: 'center',
    });
}

/**
 * ASRA QUIZORA 2026 artwork template: 1152 × 768 pt page matching the reference artwork's exact
 * 3:2 aspect ratio. Signature / asset problems throw before any byte is produced.
 */
function generateQuizoraPdf(data: CertificatePdfData, author: string): Promise<Buffer> {
  const def = artworkDefinitionFor(data);
  const assets = loadArtworkAssets(def);
  const model = buildQuizoraRenderModel(data, assets);
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: quizoraPdfPageSize(def),
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: true,
        info: {
          Title: `Certificate of Participation - ${data.recipientName} - ${data.courseTitle}`,
          Author: author || 'ASRA Academy',
          Subject: `Certificate ${data.certificateNumber}`,
          Keywords: 'ASRA Academy, ASRA QUIZORA 2026, Certificate of Participation, Verification',
          Creator: 'ASRA Academy Certificate Management Engine',
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));
      renderQuizoraPdfPage(doc, model, assets);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Generates an official, publication-grade landscape A4 PDF certificate using the
 * configured template style (Classic / Institutional, Modern / Minimal, or Premium / Achievement),
 * or the reference-artwork page for the ASRA QUIZORA 2026 template.
 */
export async function generateCertificatePdf(data: CertificatePdfData): Promise<Buffer> {
  const tpl = resolveRenderTemplate(data);
  if (isArtworkCertificateStyle(tpl.style)) {
    return generateQuizoraPdf(data, tpl.issuingAuthority);
  }
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const emblemPath = findEmblemPath();

      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: {
          Title: `${data.certificateTitle || tpl.certificateTitle} - ${data.recipientName} - ${data.courseTitle}`,
          Author: tpl.issuingAuthority || 'ASRA Academy',
          Subject: `Certificate ${data.certificateNumber}`,
          Keywords: 'ASRA Academy, Certificate, Verification',
          Creator: 'ASRA Academy Certificate Management Engine',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      switch (tpl.style) {
        case 'MODERN_MINIMAL':
          renderModernMinimal(doc, data, tpl, emblemPath);
          break;
        case 'PREMIUM_ACHIEVEMENT':
          renderPremiumAchievement(doc, data, tpl, emblemPath);
          break;
        case 'CLASSIC_INSTITUTIONAL':
        default:
          renderClassicInstitutional(doc, data, tpl, emblemPath);
          break;
      }

      const effectiveStatus = resolveEffectiveRenderStatus(data);
      if (effectiveStatus !== 'ISSUED') {
        drawStatusWatermark(
          doc,
          doc.page.width,
          doc.page.height,
          effectiveStatus,
          data.supersededByCertificateNumber,
        );
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
