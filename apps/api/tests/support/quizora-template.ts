/**
 * Test fixture: configures an ASRA QUIZORA 2026 — Certificate of Participation template (Design 1
 * by default, or Design 2 via `templateKey`)
 * with its two mandatory signatures (Event Coordinator at position 0, Director at position 1).
 * Signature PNGs are stored through the real certificate storage adapter (memory in tests).
 */
import { QUIZORA_2026_TEMPLATE_KEY } from '@asra/validation';
import sharp from 'sharp';
import { prisma } from '../../src/database/prisma.js';
import { ensureCertificateDefaults } from '../../src/modules/certificates/bootstrap.js';
import { certificateStorage } from '../../src/modules/certificates/storage.service.js';

export async function makeSignaturePng(label: string): Promise<Buffer> {
  const safe = label.replace(/[<&>"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160"><path d="M16 120 C 70 30, 120 150, 170 80 S 270 20, 300 110 S 400 140, 464 50" stroke="#1b2a6b" stroke-width="6" fill="none" stroke-linecap="round"/><text x="240" y="150" font-size="16" text-anchor="middle" fill="#1b2a6b">${safe}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function createTestSignature(fullName: string, designation: string) {
  const png = await makeSignaturePng(fullName);
  const meta = await sharp(png).metadata();
  const stored = await certificateStorage().storeSignaturePng(png);
  return prisma.certificateSignature.create({
    data: {
      fullName,
      designation,
      storageProvider: stored.storageProvider,
      storageKey: stored.storageKey,
      imageUrl: stored.imageUrl,
      width: meta.width ?? 480,
      height: meta.height ?? 160,
      bytes: png.length,
      hasTransparency: true,
      isActive: true,
    },
  });
}

export async function quizoraTemplateId(templateKey = QUIZORA_2026_TEMPLATE_KEY): Promise<string> {
  await ensureCertificateDefaults(prisma);
  const tpl = await prisma.certificateTemplate.findUniqueOrThrow({
    where: { key: templateKey },
    select: { id: true },
  });
  return tpl.id;
}

/** Links two fresh active signatures to the QUIZORA template (replacing any previous links). */
export async function configureQuizoraTemplate(
  names: [string, string] = ['Test Event Coordinator', 'Test Director'],
  templateKey = QUIZORA_2026_TEMPLATE_KEY,
): Promise<{ templateId: string; signatureIds: [string, string] }> {
  const templateId = await quizoraTemplateId(templateKey);
  const coordinator = await createTestSignature(names[0], 'Event Coordinator');
  const director = await createTestSignature(names[1], 'Director');
  await prisma.certificateTemplateSignature.deleteMany({ where: { templateId } });
  await prisma.certificateTemplateSignature.createMany({
    data: [coordinator, director].map((sig, i) => ({
      templateId,
      signatureId: sig.id,
      sortOrder: i,
      positionLabel: i === 0 ? 'Event Coordinator' : 'Director',
      showName: true,
      showDesignation: true,
    })),
  });
  await prisma.certificateTemplate.update({
    where: { id: templateId },
    data: { isActive: true },
  });
  return { templateId, signatureIds: [coordinator.id, director.id] };
}

/** Removes all signature links from the QUIZORA template (for missing-signature tests). */
export async function clearQuizoraTemplateSignatures(
  templateKey = QUIZORA_2026_TEMPLATE_KEY,
): Promise<void> {
  const templateId = await quizoraTemplateId(templateKey);
  await prisma.certificateTemplateSignature.deleteMany({ where: { templateId } });
}
