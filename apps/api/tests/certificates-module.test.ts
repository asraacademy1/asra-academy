/**
 * Generic Certificate Management Module — Comprehensive Integration & Unit Tests
 * Covers:
 * - PNG signature upload, magic-byte/IHDR/tRNS transparency validation, custom designations,
 *   replacement, deactivation, and audit logging.
 * - Cloudinary storage integration (mocked fetchImpl) and production credential enforcement.
 * - All 3 initial templates (Classic / Institutional, Modern / Minimal, Premium / Achievement),
 *   sample PDFs, long recipient names, and 2–4 signature validation rules.
 * - Historical snapshot integrity when templates or signatures are later updated/deactivated.
 * - Generic issuance engine across COURSE, ACADEMY_QUIZ, COMPETITION, EXAM, EVENT, WORKSHOP,
 *   TRAINING, MANUAL, CUSTOM + idempotency + Option A (student search) / Option B (manual) +
 *   reissue + revocation + settings toggles + public privacy + granular RBAC.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  PERMISSIONS,
  type AdminCertificateListItem,
  type CertificateAuditLogItemDto,
  type CertificateDto,
  type CertificateOverviewStatsDto,
  type CertificateSettingsDto,
  type CertificateSignatureDto,
  type CertificateSourceOptionDto,
  type CertificateStudentLookupDto,
  type CertificateTemplateDto,
  type Paginated,
  type PublicCertificateVerificationDto,
} from '@asra/types';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { prisma } from '../src/database/prisma.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { generateCertificatePdf } from '../src/modules/certificates/pdf.service.js';
import { generateCertificatePng } from '../src/modules/certificates/png.service.js';
import {
  CertificateStorageService,
  setCertificateStorageForTests,
  validateSignaturePng,
} from '../src/modules/certificates/storage.service.js';
import {
  login,
  PASSWORD,
  provision,
  registerVerifiedStudent,
  resetAuthState,
  uniqueEmail,
} from './support/auth.js';
import { apiAs, expectStatus, tokenFor } from './support/catalog.js';
import { uniqueSuffix } from './support/fixtures.js';
import { startServer, TestClient, WEB_ORIGIN } from './support/http.js';

let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  ({ baseUrl, close } = await startServer(createApp()));
});

after(async () => {
  await close();
  await Promise.all([prisma.$disconnect(), disconnectRedis()]);
});

beforeEach(async () => {
  await resetAuthState();
});

// ---------------------------------------------------------------------------
// Minimal deterministic PNG generator (CRC32 + IHDR + optional tRNS/acTL + IDAT + IEND)
// ---------------------------------------------------------------------------
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'latin1');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeTestPng(
  width: number,
  height: number,
  options: { colorType?: 2 | 6; animated?: boolean } = {},
): Buffer {
  const colorType = options.colorType ?? 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const channels = colorType === 6 ? 4 : 3;
  const rowSize = 1 + width * channels;
  const raw = Buffer.alloc(rowSize * height);
  // Paint a small dark stroke so the signature is non-empty when PDFKit embeds it
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0;
    if (y === Math.floor(height / 2)) {
      for (let x = 10; x < Math.min(width - 10, width); x++) {
        const px = rowStart + 1 + x * channels;
        raw[px] = 10;
        raw[px + 1] = 25;
        raw[px + 2] = 45;
        if (channels === 4) raw[px + 3] = 255;
      }
    }
  }
  const idat = deflateSync(raw);

  const chunks: Buffer[] = [sig, pngChunk('IHDR', ihdr)];
  if (options.animated) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(2, 0);
    actl.writeUInt32BE(0, 4);
    chunks.push(pngChunk('acTL', actl));
  }
  chunks.push(pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

async function uploadSignatureMultipart(
  token: string,
  fields: { fullName: string; designation: string; department?: string; isActive?: boolean },
  png: Buffer,
) {
  const form = new FormData();
  form.append('fullName', fields.fullName);
  form.append('designation', fields.designation);
  if (fields.department) form.append('department', fields.department);
  if (fields.isActive !== undefined) form.append('isActive', String(fields.isActive));
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'signature.png');

  const res = await fetch(`${baseUrl}/api/v1/admin/certificates/signatures`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      origin: WEB_ORIGIN,
    },
    body: form,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: JSON.parse(text) as {
      success: boolean;
      data: CertificateSignatureDto;
      error?: { code: string };
    },
  };
}

describe('Signature PNG validator & Cloudinary storage adapter', () => {
  it('validates transparent RGBA vs opaque RGB and rejects invalid PNGs', () => {
    const validTransparent = makeTestPng(320, 110, { colorType: 6 });
    const sniffed = validateSignaturePng(validTransparent, 'image/png');
    assert.equal(sniffed.width, 320);
    assert.equal(sniffed.height, 110);
    assert.equal(sniffed.hasTransparency, true);

    const validOpaque = makeTestPng(320, 110, { colorType: 2 });
    assert.equal(validateSignaturePng(validOpaque, 'image/png').hasTransparency, false);

    assert.throws(
      () => validateSignaturePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/png'),
      /valid PNG/,
    );
    assert.throws(() => validateSignaturePng(validTransparent, 'image/jpeg'), /transparent PNG/);
    assert.throws(() => validateSignaturePng(makeTestPng(20, 10), 'image/png'), /dimensions/);
    assert.throws(
      () => validateSignaturePng(makeTestPng(320, 110, { animated: true }), 'image/png'),
      /Animated PNG/,
    );
  });

  it('requires Cloudinary credentials in production and integrates with Cloudinary for original signature assets only', async () => {
    const prodNoCreds = new CertificateStorageService({
      isProduction: true,
      cloudinaryCloudName: '',
      cloudinaryApiKey: '',
      cloudinaryApiSecret: '',
    });
    const png = makeTestPng(300, 100);
    await assert.rejects(
      () => prodNoCreds.storeSignaturePng(png),
      /Cloudinary storage is required/,
    );
    assert.equal('storeCertificatePdf' in prodNoCreds, false);
    assert.equal('readCertificatePdf' in prodNoCreds, false);
    assert.equal('destroyCertificatePdf' in prodNoCreds, false);

    const calls: { url: string; method: string }[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/image/upload')) {
        return new Response(
          JSON.stringify({
            secure_url: 'https://res.cloudinary.com/asra-test/image/upload/v1/sig.png',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/image/destroy')) {
        return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
      }
      if (url === 'https://res.cloudinary.com/asra-test/image/upload/v1/sig.png') {
        return new Response(new Uint8Array(png), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const cloudStorage = new CertificateStorageService({
      isProduction: true,
      cloudinaryCloudName: 'asra-test',
      cloudinaryApiKey: 'key123',
      cloudinaryApiSecret: 'secret123',
      fetchImpl: mockFetch,
    });

    const sigStored = await cloudStorage.storeSignaturePng(png);
    assert.equal(sigStored.storageProvider, 'cloudinary');
    assert.equal(
      sigStored.imageUrl,
      'https://res.cloudinary.com/asra-test/image/upload/v1/sig.png',
    );

    const sigLoaded = await cloudStorage.readSignaturePng(
      sigStored.storageProvider,
      sigStored.storageKey,
      sigStored.imageUrl,
    );
    assert.ok(sigLoaded && sigLoaded.equals(png));

    await cloudStorage.destroySignaturePng(sigStored.storageProvider, sigStored.storageKey);
    assert.equal(calls.length, 3);
    assert.equal(
      calls.some((c) => c.url.includes('/raw/upload') || c.url.includes('/raw/destroy')),
      false,
    );

    // Cloudinary destroy failures surface explicitly for signature cleanup
    const failingDestroyStorage = new CertificateStorageService({
      isProduction: true,
      cloudinaryCloudName: 'asra-test',
      cloudinaryApiKey: 'key123',
      cloudinaryApiSecret: 'secret123',
      fetchImpl: async () => new Response(JSON.stringify({ result: 'denied' }), { status: 500 }),
    });
    await assert.rejects(
      () =>
        failingDestroyStorage.destroySignaturePng('cloudinary', 'asra/certificate-signatures/x'),
      /Cloudinary signature destroy failed/,
    );

    // Ensure singleton hook works safely without leaving dirty global state
    const prev = setCertificateStorageForTests(cloudStorage);
    setCertificateStorageForTests(prev);
  });
});

describe('Generic Certificate Management Module — End-to-End', () => {
  it('manages digital signatures, enforces 2-4 active unique rules on templates, and generates sample PDFs for all 3 templates', async () => {
    const client = new TestClient(baseUrl);
    const adminToken = await tokenFor(client, 'ADMIN');
    const api = apiAs(client, adminToken);
    const png = makeTestPng(340, 120, { colorType: 6 });

    // Upload 3 custom-designation signatures via real multipart/form-data
    const sig1Res = await uploadSignatureMultipart(
      adminToken,
      {
        fullName: 'Dr.Tariq Mahmood',
        designation: 'Founder & Patron',
        department: 'Executive Board',
      },
      png,
    );
    assert.equal(sig1Res.status, 201);
    const sig1 = sig1Res.body.data;
    assert.equal(sig1.designation, 'Founder & Patron');
    assert.equal(sig1.hasTransparency, true);
    assert.ok(sig1.previewDataUrl?.startsWith('data:image/png;base64,'));

    // Same designation text for a second distinct person must be distinguishable
    const sig2Res = await uploadSignatureMultipart(
      adminToken,
      { fullName: 'Prof. Nadia Khalid', designation: 'Academic Director' },
      png,
    );
    const sig3Res = await uploadSignatureMultipart(
      adminToken,
      { fullName: 'Imran Siddiqui', designation: 'Examination Controller' },
      png,
    );
    const sig4Res = await uploadSignatureMultipart(
      adminToken,
      { fullName: 'Zainab Farooq', designation: "Head of Qur'anic Studies", isActive: false },
      png,
    );
    const sig5Res = await uploadSignatureMultipart(
      adminToken,
      { fullName: 'Bilal Qureshi', designation: 'Workshop Convener' },
      png,
    );
    const sig2 = sig2Res.body.data;
    const sig3 = sig3Res.body.data;
    const sig4Inactive = sig4Res.body.data;
    const sig5 = sig5Res.body.data;

    // Fetch all 3 seeded initial templates
    const tplList = await api<CertificateTemplateDto[]>('GET', '/admin/certificates/templates');
    expectStatus(tplList, 200);
    assert.equal(tplList.body.data.length, 3);
    assert.deepEqual(tplList.body.data.map((t) => t.style).sort(), [
      'CLASSIC_INSTITUTIONAL',
      'MODERN_MINIMAL',
      'PREMIUM_ACHIEVEMENT',
    ]);

    const classic = tplList.body.data.find((t) => t.style === 'CLASSIC_INSTITUTIONAL')!;
    const modern = tplList.body.data.find((t) => t.style === 'MODERN_MINIMAL')!;
    const premium = tplList.body.data.find((t) => t.style === 'PREMIUM_ACHIEVEMENT')!;

    // Reject < 2 signatures
    const tooFew = await api('PATCH', `/admin/certificates/templates/${classic.id}`, {
      signatures: [
        {
          signatureId: sig1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
      ],
    });
    assert.equal(tooFew.status, 422);

    // Reject > 4 signatures
    const sig4Active = await uploadSignatureMultipart(
      adminToken,
      { fullName: 'Hana Mansoor', designation: 'Dean of Faculty' },
      png,
    );
    const tooMany = await api('PATCH', `/admin/certificates/templates/${classic.id}`, {
      signatures: [sig1, sig2, sig3, sig5, sig4Active.body.data].map((s, i) => ({
        signatureId: s.id,
        sortOrder: i,
        positionLabel: `Slot ${i + 1}`,
        showName: true,
        showDesignation: true,
      })),
    });
    assert.equal(tooMany.status, 422);

    // Reject duplicate signature ID
    const duplicateSig = await api('PATCH', `/admin/certificates/templates/${classic.id}`, {
      signatures: [
        {
          signatureId: sig1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
        {
          signatureId: sig1.id,
          sortOrder: 1,
          positionLabel: 'Right',
          showName: true,
          showDesignation: true,
        },
      ],
    });
    assert.equal(duplicateSig.status, 422);

    // Reject inactive signature
    const inactiveSigErr = await api('PATCH', `/admin/certificates/templates/${classic.id}`, {
      signatures: [
        {
          signatureId: sig1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
        {
          signatureId: sig4Inactive.id,
          sortOrder: 1,
          positionLabel: 'Right',
          showName: true,
          showDesignation: true,
        },
      ],
    });
    assert.equal(inactiveSigErr.status, 422);

    // Valid configuration with 3 active unique signatures + custom title/colors increments version
    const updatedClassic = await api<CertificateTemplateDto>(
      'PATCH',
      `/admin/certificates/templates/${classic.id}`,
      {
        defaultTitle: 'DIPLOMA OF INSTITUTIONAL EXCELLENCE',
        defaultBodyText: 'is hereby conferred this distinction upon completing',
        signatures: [
          {
            signatureId: sig1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: sig2.id,
            sortOrder: 1,
            positionLabel: 'Center',
            showName: true,
            showDesignation: false,
          },
          {
            signatureId: sig3.id,
            sortOrder: 2,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      },
    );
    expectStatus(updatedClassic, 200);
    assert.equal(updatedClassic.body.data.version, classic.version + 1);
    assert.equal(updatedClassic.body.data.signatures.length, 3);

    // Download live sample PDFs & PNGs for all 3 initial templates dynamically
    for (const tpl of [classic, modern, premium]) {
      const pdfRes = await fetch(
        `${baseUrl}/api/v1/admin/certificates/templates/${tpl.id}/preview`,
        {
          headers: { authorization: `Bearer ${adminToken}` },
        },
      );
      assert.equal(pdfRes.status, 200);
      assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
      const buf = Buffer.from(await pdfRes.arrayBuffer());
      assert.ok(buf.subarray(0, 5).equals(Buffer.from('%PDF-')));
      assert.ok(buf.length > 2500, `Expected real rendered PDF for ${tpl.style}`);

      const pngRes = await fetch(
        `${baseUrl}/api/v1/admin/certificates/templates/${tpl.id}/preview/png`,
        {
          headers: { authorization: `Bearer ${adminToken}` },
        },
      );
      assert.equal(pngRes.status, 200);
      assert.equal(pngRes.headers.get('content-type'), 'image/png');
      assert.equal(pngRes.headers.get('cache-control'), 'no-store');
      const pngBuf = Buffer.from(await pngRes.arrayBuffer());
      assert.equal(
        pngBuf.subarray(0, 8).toString('hex'),
        '89504e470d0a1a0a',
        `Expected PNG magic bytes for ${tpl.style}`,
      );
      const pngMeta = await sharp(pngBuf).metadata();
      assert.equal(pngMeta.width, 1684);
      assert.equal(pngMeta.height, 1190);
    }

    // Verify long names + 4 signature buffers across all 3 templates directly
    for (const tpl of [classic, modern, premium]) {
      const pdf = await generateCertificatePdf({
        certificateNumber: 'ASRA-2026-LONG-9999',
        recipientName: 'Abdullah Muhammad Al-Qurtubi Al-Andalusi Ibn Hayyan Extra Long Name',
        certificateTitle: tpl.defaultTitle,
        courseTitle: 'Advanced Classical Arabic Rhetoric, Balaghah and Literary Criticism Seminar',
        description: tpl.defaultBodyText,
        achievementDetails: 'Distinction Honor Roll — Rank #1 Overall',
        sourceLabel: 'Competition',
        completedAt: new Date('2026-10-15T00:00:00Z'),
        issuedAt: new Date('2026-10-16T00:00:00Z'),
        verificationUrl: 'https://asraacademy.org/verify/ASRA-2026-LONG-9999',
        status: 'ISSUED',
        templateSnapshot: {
          templateId: tpl.id,
          key: tpl.key,
          name: tpl.name,
          style: tpl.style,
          version: tpl.version,
          certificateTitle: tpl.defaultTitle,
          subtitle: tpl.defaultSubtitle,
          bodyText: tpl.defaultBodyText,
          issuingAuthority: tpl.issuingAuthority,
          config: tpl.config,
        },
        signatureSnapshots: [sig1, sig2, sig3, sig5].map((s, idx) => ({
          signatureId: s.id,
          fullName: s.fullName,
          designation: s.designation,
          department: s.department,
          positionLabel: `Slot ${idx + 1}`,
          sortOrder: idx,
          showName: true,
          showDesignation: true,
          imageUrl: null,
        })),
        signatureBuffers: new Map([
          [sig1.id, png],
          [sig2.id, png],
          [sig3.id, png],
          [sig5.id, png],
        ]),
      });
      assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
      assert.ok(pdf.length > 4000);
    }
  });

  it('preserves immutable template and signature snapshots even after signature replacement, renaming, and deactivation', async () => {
    const client = new TestClient(baseUrl);
    const adminToken = await tokenFor(client, 'ADMIN');
    const api = apiAs(client, adminToken);
    const png1 = makeTestPng(300, 100);
    const png2 = makeTestPng(350, 120);

    const s1 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Person Alpha', designation: 'Original Founder Title' },
        png1,
      )
    ).body.data;
    const s2 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Person Beta', designation: 'Original Director Title' },
        png1,
      )
    ).body.data;

    const templates = (await api<CertificateTemplateDto[]>('GET', '/admin/certificates/templates'))
      .body.data;
    const premium = templates.find((t) => t.style === 'PREMIUM_ACHIEVEMENT')!;

    await api('PATCH', `/admin/certificates/templates/${premium.id}`, {
      defaultTitle: 'EXCELLENCE HONOR v1',
      signatures: [
        {
          signatureId: s1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
        {
          signatureId: s2.id,
          sortOrder: 1,
          positionLabel: 'Right',
          showName: true,
          showDesignation: true,
        },
      ],
    });

    // Issue manual Option B certificate (external awardee without userId)
    const issued = await api<CertificateDto>('POST', '/admin/certificates/manual', {
      recipientMode: 'MANUAL_RECIPIENT',
      sourceType: 'COMPETITION',
      sourceLabel: 'Annual Essay Award',
      recipientName: 'Hafsa Guest Winner',
      certificateTitle: 'EXCELLENCE HONOR v1',
      subjectTitle: 'ASRA National Arabic Essay Competition',
      achievementDetails: 'First Prize Laureate',
      templateId: premium.id,
      completedAt: new Date('2026-10-10T00:00:00Z').toISOString(),
      signatures: [
        {
          signatureId: s1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
        {
          signatureId: s2.id,
          sortOrder: 1,
          positionLabel: 'Right',
          showName: true,
          showDesignation: true,
        },
      ],
    });
    expectStatus(issued, 201);
    const cert = issued.body.data;
    assert.equal(cert.userId, null);

    // Mutate registered signatures & template afterwards
    const patchSig1 = await api<CertificateSignatureDto>(
      'PATCH',
      `/admin/certificates/signatures/${s1.id}`,
      {
        fullName: 'Person Alpha Updated',
        designation: 'Changed Emeritus Title',
        imageBase64: png2.toString('base64'),
      },
    );
    expectStatus(patchSig1, 200);

    // Direct deactivation must be blocked while s2 is needed to keep active template >= 2 signatures
    const blockedDeactivate = await api('PATCH', `/admin/certificates/signatures/${s2.id}`, {
      isActive: false,
    });
    assert.equal(blockedDeactivate.status, 422);

    // Replace s2 on premium template with s3 first, then deactivate s2 cleanly
    const s3 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Person Gamma', designation: 'Replacement Signatory' },
        png2,
      )
    ).body.data;
    const swapRes = await api('PATCH', `/admin/certificates/templates/${premium.id}`, {
      signatures: [
        {
          signatureId: s1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
        {
          signatureId: s3.id,
          sortOrder: 1,
          positionLabel: 'Right',
          showName: true,
          showDesignation: true,
        },
      ],
    });
    expectStatus(swapRes, 200);

    const deactivateSig2 = await api<CertificateSignatureDto>(
      'PATCH',
      `/admin/certificates/signatures/${s2.id}`,
      { isActive: false },
    );
    expectStatus(deactivateSig2, 200);

    // Original issued certificate MUST keep its frozen snapshots intact
    const fetched = await api<AdminCertificateListItem>('GET', `/admin/certificates/${cert.id}`);
    expectStatus(fetched, 200);
    assert.equal(fetched.body.data.certificateTitle, 'EXCELLENCE HONOR v1');
    assert.deepEqual(
      fetched.body.data.signatureSnapshots?.map((x) => `${x.fullName}|${x.designation}`),
      ['Person Alpha|Original Founder Title', 'Person Beta|Original Director Title'],
    );

    const verify = await client.request<PublicCertificateVerificationDto>(
      'GET',
      `/certificates/verify/${cert.certificateNumber}`,
    );
    expectStatus(verify, 200);
    assert.deepEqual(
      verify.body.data.signatories.map((x) => `${x.fullName}|${x.designation}`),
      ['Person Alpha|Original Founder Title', 'Person Beta|Original Director Title'],
    );
  });

  it('supports Academy Quiz eligibility/idempotency, all generic sources, student code search, reissue, revoke, overview, and settings', async () => {
    const client = new TestClient(baseUrl);
    const adminToken = await tokenFor(client, 'ADMIN');
    const adminApi = apiAs(client, adminToken);

    const email = await registerVerifiedStudent(client, uniqueEmail('quizwinner'));
    const session = await login(client, email);
    const studentApi = apiAs(client, session.accessToken);
    const student = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { studentProfile: true },
    });
    const studentCode = `ASRA-STU-${uniqueSuffix().toUpperCase()}`;
    await prisma.studentProfile.update({
      where: { userId: student.id },
      data: { studentCode },
    });

    // Upload 2 active signatures and configure Modern template
    const png = makeTestPng(300, 100);
    const s1 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Dr. Ayesha', designation: 'Principal' },
        png,
      )
    ).body.data;
    const s2 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Tariq Khan', designation: 'Quiz Director' },
        png,
      )
    ).body.data;
    const templates = (
      await adminApi<CertificateTemplateDto[]>('GET', '/admin/certificates/templates')
    ).body.data;
    const modern = templates.find((t) => t.style === 'MODERN_MINIMAL')!;

    await adminApi('PATCH', `/admin/certificates/templates/${modern.id}`, {
      signatures: [
        {
          signatureId: s1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
        {
          signatureId: s2.id,
          sortOrder: 1,
          positionLabel: 'Right',
          showName: true,
          showDesignation: true,
        },
      ],
    });

    // Create published Academy Quiz with released results
    const now = new Date();
    const quiz = await prisma.academyQuiz.create({
      data: {
        slug: `qiraat-olympiad-${uniqueSuffix()}`,
        title: 'National Qiraat & Tajweed Quiz',
        startsAt: new Date(now.getTime() - 3600_000),
        endsAt: new Date(now.getTime() - 600_000),
        durationMinutes: 30,
        status: 'PUBLISHED',
        publishedAt: new Date(now.getTime() - 7200_000),
        resultsPublishedAt: new Date(now.getTime() - 300_000),
        resultRelease: 'IMMEDIATE',
        passPercent: 50,
      },
    });

    // Before passing attempt -> rejected
    const ineligibleClaim = await studentApi(
      'POST',
      `/student/academy-quizzes/${quiz.id}/certificate`,
    );
    assert.equal(ineligibleClaim.status, 400);

    // Record evaluated passing attempt
    await prisma.assessmentAttempt.create({
      data: {
        academyQuizId: quiz.id,
        userId: student.id,
        attemptNumber: 1,
        status: 'SUBMITTED',
        startedAt: new Date(now.getTime() - 2400_000),
        submittedAt: new Date(now.getTime() - 1200_000),
        finalizedAt: new Date(now.getTime() - 1200_000),
        evaluationStatus: 'EVALUATED',
        evaluatedAt: new Date(now.getTime() - 1100_000),
        maxScore: 100,
        rawScore: 92,
        score: 92,
        percent: 92,
        passed: true,
      },
    });

    const quizClaim1 = await studentApi<CertificateDto>(
      'POST',
      `/student/academy-quizzes/${quiz.id}/certificate`,
    );
    expectStatus(quizClaim1, 201);
    assert.equal(quizClaim1.body.data.sourceType, 'ACADEMY_QUIZ');
    assert.equal(quizClaim1.body.data.academyQuizId, quiz.id);
    assert.match(quizClaim1.body.data.achievementDetails ?? '', /92%/);

    // Idempotent second claim returns exact same certificateNumber
    const quizClaim2 = await studentApi<CertificateDto>(
      'POST',
      `/student/academy-quizzes/${quiz.id}/certificate`,
    );
    expectStatus(quizClaim2, 201);
    assert.equal(quizClaim2.body.data.certificateNumber, quizClaim1.body.data.certificateNumber);

    // Check /admin/certificates/sources & /students/search?q=studentCode
    const sourcesRes = await adminApi<{ academyQuizzes: CertificateSourceOptionDto[] }>(
      'GET',
      '/admin/certificates/sources',
    );
    expectStatus(sourcesRes, 200);
    assert.ok(sourcesRes.body.data.academyQuizzes.some((q) => q.id === quiz.id));

    const studentSearchRes = await adminApi<CertificateStudentLookupDto[]>(
      'GET',
      `/admin/certificates/students/search?q=${encodeURIComponent(studentCode)}`,
    );
    expectStatus(studentSearchRes, 200);
    assert.equal(studentSearchRes.body.data[0]?.userId, student.id);
    assert.equal(studentSearchRes.body.data[0]?.studentCode, studentCode);

    // Issue remaining generic source types for Option A student
    for (const src of [
      'COMPETITION',
      'EXAM',
      'EVENT',
      'WORKSHOP',
      'TRAINING',
      'MANUAL',
      'CUSTOM',
    ] as const) {
      const issued = await adminApi<CertificateDto>('POST', '/admin/certificates/issue', {
        sourceType: src,
        sourceLabel: src === 'CUSTOM' ? 'Summer Fellowship' : undefined,
        userId: student.id,
        recipientName: student.fullName,
        recipientEmail: student.email,
        recipientStudentCode: studentCode,
        certificateTitle: `${src} CREDENTIAL`,
        subjectTitle: `ASRA ${src} 2026`,
        templateId: modern.id,
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s2.id,
            sortOrder: 1,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      });
      expectStatus(issued, 201);
      assert.equal(issued.body.data.sourceType, src);
    }

    // Student portal filtering by sourceType & search
    const filteredQuizzes = await studentApi<Paginated<CertificateDto>>(
      'GET',
      '/student/certificates?sourceType=ACADEMY_QUIZ',
    );
    expectStatus(filteredQuizzes, 200);
    assert.equal(filteredQuizzes.body.data.items.length, 1);

    const filteredCompetition = await studentApi<Paginated<CertificateDto>>(
      'GET',
      '/student/certificates?sourceType=COMPETITION&search=COMPETITION',
    );
    expectStatus(filteredCompetition, 200);
    assert.equal(filteredCompetition.body.data.items.length, 1);

    // Reissue and Revoke
    const compCert = filteredCompetition.body.data.items[0]!;
    const reissued = await adminApi<CertificateDto>(
      'POST',
      `/admin/certificates/${compCert.id}/reissue`,
      {
        reason: 'Updated competition medal title',
      },
    );
    expectStatus(reissued, 201);
    assert.equal(reissued.body.data.reissuedFromId, compCert.id);

    const oldCertCheck = await client.request<PublicCertificateVerificationDto>(
      'GET',
      `/certificates/verify/${compCert.certificateNumber}`,
    );
    expectStatus(oldCertCheck, 200);
    assert.equal(oldCertCheck.body.data.status, 'REVOKED');

    // Public verification privacy check on active certificate
    const publicVerify = await client.request<PublicCertificateVerificationDto>(
      'GET',
      `/certificates/verify/${quizClaim1.body.data.certificateNumber}`,
    );
    expectStatus(publicVerify, 200);
    const verifyText = JSON.stringify(publicVerify.body.data);
    assert.ok(!verifyText.includes(email), 'Student email must never appear on public verify');
    assert.ok(
      !verifyText.includes(student.id),
      'Internal userId must never appear on public verify',
    );
    assert.ok(!verifyText.includes(studentCode), 'Student code must never appear on public verify');

    // Overview KPIs & audit logs
    const overview = await adminApi<CertificateOverviewStatsDto>(
      'GET',
      '/admin/certificates/overview',
    );
    expectStatus(overview, 200);
    assert.equal(overview.body.data.academyQuizzesCount, 1);
    assert.equal(overview.body.data.competitionsCount >= 2, true);
    assert.equal(overview.body.data.activeTemplates, 3);
    assert.equal(overview.body.data.activeSignatures, 2);

    const settingsUpdate = await adminApi<CertificateSettingsDto>(
      'PATCH',
      '/admin/certificates/settings',
      {
        autoIssueOnCourseCompletion: false,
        showQrOnCertificates: true,
      },
    );
    expectStatus(settingsUpdate, 200);
    assert.equal(settingsUpdate.body.data.autoIssueOnCourseCompletion, false);

    const audits = await adminApi<Paginated<CertificateAuditLogItemDto>>(
      'GET',
      '/admin/certificates/audit-logs',
    );
    expectStatus(audits, 200);
    assert.ok(audits.body.data.items.length >= 4);
  });

  it('enforces granular certificate RBAC permissions and denies FACULTY and STUDENT access', async () => {
    const client = new TestClient(baseUrl);
    const facultyToken = await tokenFor(client, 'FACULTY');
    const studentToken = await tokenFor(client, 'STUDENT');

    for (const token of [facultyToken, studentToken]) {
      const api = apiAs(client, token);
      assert.equal((await api('GET', '/admin/certificates/overview')).status, 403);
      assert.equal((await api('GET', '/admin/certificates/signatures')).status, 403);
      assert.equal((await api('POST', '/admin/certificates/manual', {})).status, 403);
    }

    // Custom admin role with ONLY certificates.view
    const viewerUser = await provision('ADMIN');
    const suffix = uniqueSuffix()
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase();
    const viewOnlyRole = await prisma.role.create({
      data: {
        key: `CERT_VIEW_${suffix}`,
        name: 'Certificate Viewer Only',
        isSystem: false,
      },
    });
    try {
      const viewPerm = await prisma.permission.findUniqueOrThrow({
        where: { key: PERMISSIONS.CERTIFICATES_VIEW },
      });
      await prisma.userRole.deleteMany({ where: { userId: viewerUser.id } });
      await prisma.rolePermission.create({
        data: { roleId: viewOnlyRole.id, permissionId: viewPerm.id },
      });
      await prisma.userRole.create({
        data: { userId: viewerUser.id, roleId: viewOnlyRole.id },
      });

      const viewerSession = await login(client, viewerUser.email, PASSWORD);
      const viewerApi = apiAs(client, viewerSession.accessToken);
      assert.equal((await viewerApi('GET', '/admin/certificates/overview')).status, 200);
      assert.equal((await viewerApi('GET', '/admin/certificates/templates')).status, 200);
      assert.equal((await viewerApi('POST', '/admin/certificates/manual', {})).status, 403);
      assert.equal((await viewerApi('PATCH', '/admin/certificates/settings', {})).status, 403);
      const sigCreateRes = await uploadSignatureMultipart(
        viewerSession.accessToken,
        { fullName: 'Blocked', designation: 'Director' },
        makeTestPng(300, 100),
      );
      assert.equal(sigCreateRes.status, 403);
    } finally {
      await prisma.userRole.deleteMany({ where: { roleId: viewOnlyRole.id } });
      await prisma.rolePermission.deleteMany({ where: { roleId: viewOnlyRole.id } });
      await prisma.role.delete({ where: { id: viewOnlyRole.id } });
    }
  });
});

describe('Phase 17 Blocker Fixes — Concurrency, Idempotency, 2–4 Rules & Cloudinary Recovery', () => {
  it('BLOCKER 1: handles concurrent generic issuance and concurrent reissue idempotently and preserves domain idempotency keys', async () => {
    const client = new TestClient(baseUrl);
    const adminToken = await tokenFor(client, 'ADMIN');
    const adminApi = apiAs(client, adminToken);
    const png = makeTestPng(300, 100);

    const s1 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Sig One', designation: 'Founder' },
        png,
      )
    ).body.data;
    const s2 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Sig Two', designation: 'Director' },
        png,
      )
    ).body.data;
    const templates = (
      await adminApi<CertificateTemplateDto[]>('GET', '/admin/certificates/templates')
    ).body.data;
    const classic = templates.find((t) => t.style === 'CLASSIC_INSTITUTIONAL')!;
    expectStatus(
      await adminApi('PATCH', `/admin/certificates/templates/${classic.id}`, {
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s2.id,
            sortOrder: 1,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      }),
      200,
    );

    const email = await registerVerifiedStudent(client, uniqueEmail('concur'));
    const session = await login(client, email);
    const studentApi = apiAs(client, session.accessToken);
    const studentId = session.user.id;

    // 1) Concurrent generic issuance (5 simultaneous requests with same sourceReferenceId) -> 0 duplicates, 0 409s
    const genericBody = {
      sourceType: 'COMPETITION',
      sourceReferenceId: `comp-${uniqueSuffix()}`,
      userId: studentId,
      recipientName: session.user.fullName,
      recipientEmail: session.user.email,
      certificateTitle: 'COMPETITION HONOUR',
      subjectTitle: 'Annual Debate Tournament',
      templateId: classic.id,
      signatures: [
        {
          signatureId: s1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
        {
          signatureId: s2.id,
          sortOrder: 1,
          positionLabel: 'Right',
          showName: true,
          showDesignation: true,
        },
      ],
    };

    const concurrentGeneric = await Promise.all(
      Array.from({ length: 5 }, () =>
        adminApi<CertificateDto>('POST', '/admin/certificates/issue', genericBody),
      ),
    );
    for (const r of concurrentGeneric) expectStatus(r, 201);
    const uniqueNums = new Set(concurrentGeneric.map((r) => r.body.data.certificateNumber));
    assert.equal(uniqueNums.size, 1, 'Concurrent generic issuance must return one certificate');

    // 2) Academy Quiz issuance -> 5 concurrent reissues -> exactly ONE active replacement + preserves QUIZ idempotencyKey
    const now = new Date();
    const quiz = await prisma.academyQuiz.create({
      data: {
        slug: `quiz-conc-${uniqueSuffix()}`,
        title: 'Concurrent Quiz Award',
        startsAt: new Date(now.getTime() - 3600_000),
        endsAt: new Date(now.getTime() - 600_000),
        durationMinutes: 20,
        status: 'PUBLISHED',
        publishedAt: new Date(now.getTime() - 7200_000),
        resultsPublishedAt: new Date(now.getTime() - 300_000),
        resultRelease: 'IMMEDIATE',
        passPercent: 40,
      },
    });
    await prisma.assessmentAttempt.create({
      data: {
        academyQuizId: quiz.id,
        userId: studentId,
        attemptNumber: 1,
        status: 'SUBMITTED',
        startedAt: new Date(now.getTime() - 2400_000),
        submittedAt: new Date(now.getTime() - 1200_000),
        finalizedAt: new Date(now.getTime() - 1200_000),
        evaluationStatus: 'EVALUATED',
        evaluatedAt: new Date(now.getTime() - 1100_000),
        maxScore: 50,
        rawScore: 45,
        score: 45,
        percent: 90,
        passed: true,
      },
    });

    const quizClaim = await studentApi<CertificateDto>(
      'POST',
      `/student/academy-quizzes/${quiz.id}/certificate`,
    );
    expectStatus(quizClaim, 201);
    const origId = quizClaim.body.data.id;

    const concurrentReissues = await Promise.all(
      Array.from({ length: 5 }, () =>
        adminApi<CertificateDto>('POST', `/admin/certificates/${origId}/reissue`, {
          reason: 'Name spelling fix',
        }),
      ),
    );
    for (const r of concurrentReissues) expectStatus(r, 201);
    const reissuedIds = new Set(concurrentReissues.map((r) => r.body.data.id));
    assert.equal(
      reissuedIds.size,
      1,
      'Concurrent reissue must produce exactly one active replacement',
    );
    const replacementId = [...reissuedIds][0]!;

    const activeQuizCerts = await prisma.certificate.findMany({
      where: { academyQuizId: quiz.id, userId: studentId, status: 'ISSUED' },
    });
    assert.equal(activeQuizCerts.length, 1);
    assert.equal(activeQuizCerts[0]!.id, replacementId);
    assert.equal(activeQuizCerts[0]!.idempotencyKey, `ACADEMY_QUIZ:${quiz.id}:${studentId}`);

    // Re-claiming quiz certificate after reissue must return the active replacement, NOT issue a duplicate!
    const reclaimAfterReissue = await studentApi<CertificateDto>(
      'POST',
      `/student/academy-quizzes/${quiz.id}/certificate`,
    );
    expectStatus(reclaimAfterReissue, 201);
    assert.equal(reclaimAfterReissue.body.data.id, replacementId);

    // 3) Course reissue preserves enrollment 1:1 uniqueness & prevents duplicate course issuance
    const course = await prisma.course.create({
      data: {
        title: `Course Reissue ${uniqueSuffix()}`,
        slug: `cr-${uniqueSuffix()}`,
        status: 'PUBLISHED',
        publishedAt: now,
        modules: {
          create: {
            title: 'M1',
            position: 0,
            chapters: {
              create: {
                title: 'C1',
                position: 0,
                lessons: {
                  create: {
                    title: 'L1',
                    contentType: 'TEXT',
                    position: 0,
                    status: 'PUBLISHED',
                    publishedAt: now,
                    body: 'Text',
                  },
                },
              },
            },
          },
        },
      },
      include: { modules: { include: { chapters: { include: { lessons: true } } } } },
    });
    const enrollment = await prisma.enrollment.create({
      data: {
        userId: studentId,
        courseId: course.id,
        status: 'ACTIVE',
        source: 'FREE',
        completedAt: now,
      },
    });
    await prisma.lessonProgress.create({
      data: {
        userId: studentId,
        lessonId: course.modules[0]!.chapters[0]!.lessons[0]!.id,
        completedAt: now,
      },
    });

    const courseCert1 = await studentApi<CertificateDto>(
      'POST',
      `/student/courses/${course.id}/certificate`,
    );
    expectStatus(courseCert1, 201);
    const courseReissue = await adminApi<CertificateDto>(
      'POST',
      `/admin/certificates/${courseCert1.body.data.id}/reissue`,
      { reason: 'Course title formatting correction' },
    );
    expectStatus(courseReissue, 201);
    assert.equal(courseReissue.body.data.enrollmentId, enrollment.id);

    const courseCertAgain = await studentApi<CertificateDto>(
      'POST',
      `/student/courses/${course.id}/certificate`,
    );
    expectStatus(courseCertAgain, 201);
    assert.equal(courseCertAgain.body.data.id, courseReissue.body.data.id);
  });

  it('BLOCKER 2: enforces 2–4 signatures uniformly across all pathways and serializes concurrent template updates', async () => {
    const client = new TestClient(baseUrl);
    const adminToken = await tokenFor(client, 'ADMIN');
    const adminApi = apiAs(client, adminToken);
    const png = makeTestPng(300, 100);

    const s1 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Sign A', designation: 'Founder' },
        png,
      )
    ).body.data;
    const s2 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Sign B', designation: 'Director' },
        png,
      )
    ).body.data;
    const s3 = (
      await uploadSignatureMultipart(adminToken, { fullName: 'Sign C', designation: 'Dean' }, png)
    ).body.data;

    const templates = (
      await adminApi<CertificateTemplateDto[]>('GET', '/admin/certificates/templates')
    ).body.data;
    const modern = templates.find((t) => t.style === 'MODERN_MINIMAL')!;
    const classic = templates.find((t) => t.style === 'CLASSIC_INSTITUTIONAL')!;

    // Unconfigured 0-signature template cannot be used for /admin/certificates/issue without explicit 2-4 signatures
    const unconfiguredAdminIssue = await adminApi('POST', '/admin/certificates/issue', {
      sourceType: 'COMPETITION',
      recipientName: 'External Competitor',
      subjectTitle: 'Coding Contest',
      templateId: modern.id,
    });
    assert.equal(unconfiguredAdminIssue.status, 422);

    // Passing 1 signature is rejected across manual, admin generic, and reissue paths
    const singleManual = await adminApi('POST', '/admin/certificates/manual', {
      recipientMode: 'MANUAL_RECIPIENT',
      sourceType: 'EVENT',
      recipientName: 'Guest Attendee',
      certificateTitle: 'EVENT PASS',
      subjectTitle: 'Symposium',
      templateId: modern.id,
      signatures: [
        {
          signatureId: s1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
      ],
    });
    assert.equal(singleManual.status, 422);

    const singleAdminGeneric = await adminApi('POST', '/admin/certificates/issue', {
      sourceType: 'EXAM',
      recipientName: 'Candidate',
      subjectTitle: 'Board Exam',
      templateId: modern.id,
      signatures: [
        {
          signatureId: s1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
      ],
    });
    assert.equal(singleAdminGeneric.status, 422);

    // Concurrent template updates (4 parallel PATCH requests) must serialize without 409 or corrupted state
    const concurrentTplUpdates = await Promise.all([
      adminApi<CertificateTemplateDto>('PATCH', `/admin/certificates/templates/${classic.id}`, {
        defaultTitle: 'TITLE A',
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s2.id,
            sortOrder: 1,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      }),
      adminApi<CertificateTemplateDto>('PATCH', `/admin/certificates/templates/${classic.id}`, {
        defaultTitle: 'TITLE B',
        signatures: [
          {
            signatureId: s2.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s3.id,
            sortOrder: 1,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      }),
      adminApi<CertificateTemplateDto>('PATCH', `/admin/certificates/templates/${classic.id}`, {
        defaultTitle: 'TITLE C',
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s2.id,
            sortOrder: 1,
            positionLabel: 'Center',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s3.id,
            sortOrder: 2,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      }),
      adminApi<CertificateTemplateDto>('PATCH', `/admin/certificates/templates/${classic.id}`, {
        defaultTitle: 'TITLE D',
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s3.id,
            sortOrder: 1,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      }),
    ]);
    for (const r of concurrentTplUpdates) expectStatus(r, 200);
    const savedLinks = await prisma.certificateTemplateSignature.findMany({
      where: { templateId: classic.id },
    });
    assert.ok(savedLinks.length >= 2 && savedLinks.length <= 3);

    // Also configure modern with [s1, s2], verify s1 deactivation is blocked until swapped
    expectStatus(
      await adminApi('PATCH', `/admin/certificates/templates/${modern.id}`, {
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s2.id,
            sortOrder: 1,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      }),
      200,
    );
    const blockedDeact = await adminApi('PATCH', `/admin/certificates/signatures/${s1.id}`, {
      isActive: false,
    });
    assert.equal(blockedDeact.status, 422);

    // Issue certificate using modern -> attempt reissue with 1 signature must fail 422
    const validManual = await adminApi<CertificateDto>('POST', '/admin/certificates/manual', {
      recipientMode: 'MANUAL_RECIPIENT',
      sourceType: 'TRAINING',
      recipientName: 'Trainee One',
      certificateTitle: 'TRAINING CREDENTIAL',
      subjectTitle: 'Instructor Bootcamp',
      templateId: modern.id,
      signatures: [
        {
          signatureId: s1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
        {
          signatureId: s2.id,
          sortOrder: 1,
          positionLabel: 'Right',
          showName: true,
          showDesignation: true,
        },
      ],
    });
    expectStatus(validManual, 201);
    const singleReissue = await adminApi(
      'POST',
      `/admin/certificates/${validManual.body.data.id}/reissue`,
      {
        reason: 'Attempt invalid single signature',
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
        ],
      },
    );
    assert.equal(singleReissue.status, 422);
  });

  it('DATA-ONLY ARCHITECTURE & BLOCKER 3/4: renders ephemeral PNGs/PDFs on demand, handles REVOKED & SUPERSEDED watermarks, never persists generated files, blocks blank-signature exports on Cloudinary outage, and preserves Phase 13 legacy compatibility', async () => {
    const png = makeTestPng(300, 100);
    let failSigDownload = false;
    const cloudinaryCalls: { url: string; method: string }[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      cloudinaryCalls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/image/upload')) {
        return new Response(
          JSON.stringify({
            secure_url: `https://res.cloudinary.com/asra-test/image/upload/v1/${crypto.randomUUID()}.png`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/image/destroy')) {
        return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
      }
      if (url.includes('/image/upload/')) {
        if (failSigDownload) {
          return new Response('upstream unavailable', { status: 503 });
        }
        return new Response(new Uint8Array(png), { status: 200 });
      }
      if (url.includes('/raw/')) {
        throw new Error(`Unexpected /raw/ Cloudinary call (${url}) in data-only architecture`);
      }
      return new Response('not found', { status: 404 });
    };

    const previousStorage = setCertificateStorageForTests(
      new CertificateStorageService({
        isProduction: true,
        cloudinaryCloudName: 'asra-test',
        cloudinaryApiKey: 'key123',
        cloudinaryApiSecret: 'secret123',
        fetchImpl: mockFetch,
      }),
    );

    try {
      const client = new TestClient(baseUrl);
      const adminToken = await tokenFor(client, 'ADMIN');
      const adminApi = apiAs(client, adminToken);

      const s1 = (
        await uploadSignatureMultipart(
          adminToken,
          { fullName: 'Cloud Sig 1', designation: 'Founder' },
          png,
        )
      ).body.data;
      const s2 = (
        await uploadSignatureMultipart(
          adminToken,
          { fullName: 'Cloud Sig 2', designation: 'Director' },
          png,
        )
      ).body.data;
      const templates = (
        await adminApi<CertificateTemplateDto[]>('GET', '/admin/certificates/templates')
      ).body.data;
      const classic = templates.find((t) => t.style === 'CLASSIC_INSTITUTIONAL')!;
      const premium = templates.find((t) => t.style === 'PREMIUM_ACHIEVEMENT')!;

      const email = await registerVerifiedStudent(client, uniqueEmail('cloudstu'));
      const session = await login(client, email);
      const studentApi = apiAs(client, session.accessToken);

      // Even during Cloudinary signature asset outage, structured data issuance succeeds cleanly
      // without rendering or uploading any generated file
      failSigDownload = true;
      const issueDuringOutage = await adminApi<CertificateDto>(
        'POST',
        '/admin/certificates/manual',
        {
          recipientMode: 'EXISTING_STUDENT',
          userId: session.user.id,
          recipientName: session.user.fullName,
          sourceType: 'COMPETITION',
          certificateTitle: 'CLOUD TEST AWARD',
          subjectTitle: 'Transient Recovery Check',
          templateId: classic.id,
          signatures: [
            {
              signatureId: s1.id,
              sortOrder: 0,
              positionLabel: 'Left',
              showName: true,
              showDesignation: true,
            },
            {
              signatureId: s2.id,
              sortOrder: 1,
              positionLabel: 'Right',
              showName: true,
              showDesignation: true,
            },
          ],
        },
      );
      expectStatus(issueDuringOutage, 201);
      const cert = issueDuringOutage.body.data;

      assert.equal('pdfUrl' in cert, false, 'DTO must never expose pdfUrl');
      assert.equal(cert.lifecycleStatus, 'ISSUED');
      assert.equal(
        cloudinaryCalls.some((c) => c.url.includes('/raw/')),
        false,
        'Cloudinary must NEVER receive generated certificate uploads',
      );

      const dbRowBeforeDownload = await prisma.certificate.findUniqueOrThrow({
        where: { id: cert.id },
      });
      assert.equal('pdfStorageProvider' in dbRowBeforeDownload, false);
      assert.equal('pdfStorageKey' in dbRowBeforeDownload, false);
      assert.equal('pdfUrl' in dbRowBeforeDownload, false);

      // Dynamic preview endpoint returns immutable template + signature snapshots
      const stuDetail = await studentApi<CertificateDto>('GET', `/student/certificates/${cert.id}`);
      expectStatus(stuDetail, 200);
      assert.equal(stuDetail.body.data.templateSnapshot?.key, classic.key);
      assert.equal(stuDetail.body.data.signatureSnapshots?.length, 2);
      assert.equal(
        stuDetail.body.data.pngDownloadUrl,
        `/api/v1/student/certificates/${cert.id}/download/png`,
      );

      // Download BOTH PNG & PDF while Cloudinary signature PNG is failing -> controlled 503 retryable error!
      for (const path of [
        `/api/v1/student/certificates/${cert.id}/download`,
        `/api/v1/student/certificates/${cert.id}/download/pdf`,
        `/api/v1/student/certificates/${cert.id}/download/png`,
        `/api/v1/student/certificates/${cert.id}/download?format=png`,
        `/api/v1/admin/certificates/${cert.id}/download/png`,
      ]) {
        const failRes = await fetch(`${baseUrl}${path}`, {
          headers: {
            authorization: `Bearer ${path.includes('/admin/') ? adminToken : session.accessToken}`,
          },
        });
        assert.equal(failRes.status, 503, `Expected 503 on outage for ${path}`);
      }

      // Recover Cloudinary signature PNG fetches -> PNG and PDF both generate dynamically in memory!
      failSigDownload = false;
      const pdfRes = await fetch(`${baseUrl}/api/v1/student/certificates/${cert.id}/download/pdf`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      assert.equal(pdfRes.status, 200);
      assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
      assert.equal(pdfRes.headers.get('cache-control'), 'no-store');
      assert.match(
        pdfRes.headers.get('content-disposition') ?? '',
        new RegExp(`ASRA-Certificate-${cert.certificateNumber}\\.pdf`),
      );
      const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
      assert.ok(pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
      assert.ok(pdfBytes.length > 3000);

      const pngRes = await fetch(`${baseUrl}/api/v1/student/certificates/${cert.id}/download/png`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      assert.equal(pngRes.status, 200);
      assert.equal(pngRes.headers.get('content-type'), 'image/png');
      assert.equal(pngRes.headers.get('cache-control'), 'no-store');
      assert.match(
        pngRes.headers.get('content-disposition') ?? '',
        new RegExp(`ASRA-Certificate-${cert.certificateNumber}\\.png`),
      );
      const issuedPngBytes = Buffer.from(await pngRes.arrayBuffer());
      assert.equal(issuedPngBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

      // Inspect actual rendered PNG pixels: dimensions 1684x1190, Classic ivory center/corner, non-empty QR & signature pixels
      const issuedMeta = await sharp(issuedPngBytes).metadata();
      assert.equal(issuedMeta.width, 1684);
      assert.equal(issuedMeta.height, 1190);
      const { data: issuedRaw } = await sharp(issuedPngBytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const sampleRgb = (raw: Buffer, x: number, y: number) => {
        const idx = (y * 1684 + x) * 4;
        return [raw[idx]!, raw[idx + 1]!, raw[idx + 2]!] as const;
      };
      // Top-left ivory border area (~x:12, y:12) for Classic = #FDFBF7
      const cornerRgb = sampleRgb(issuedRaw, 12, 12);
      assert.ok(cornerRgb[0] > 245 && cornerRgb[1] > 245 && cornerRgb[2] > 240);

      // Center pixels of ISSUED cert must NOT contain diagonal crimson watermark ink
      const countRedTintPixels = (raw: Buffer) => {
        let count = 0;
        for (let py = 460; py < 730; py += 2) {
          for (let px = 620; px < 1060; px += 2) {
            const [r, g, b] = sampleRgb(raw, px, py);
            if (r - g > 12 && r - b > 12) count++;
          }
        }
        return count;
      };
      const issuedCenterRedCount = countRedTintPixels(issuedRaw);

      // Confirm DB still has ZERO generated file persistence fields after downloads!
      const dbRowAfterDownloads = await prisma.certificate.findUniqueOrThrow({
        where: { id: cert.id },
      });
      assert.equal('pdfStorageProvider' in dbRowAfterDownloads, false);
      assert.equal('pdfStorageKey' in dbRowAfterDownloads, false);
      assert.equal('pdfUrl' in dbRowAfterDownloads, false);
      assert.equal(
        cloudinaryCalls.some((c) => c.url.includes('/raw/')),
        false,
      );

      // Revoke certificate -> subsequent verification, PNG, and PDF IMMEDIATELY reflect REVOKED dynamically!
      const revokeRes = await adminApi<CertificateDto>(
        'POST',
        `/admin/certificates/${cert.id}/revoke`,
        { reason: 'Testing dynamic revoked status rendering' },
      );
      expectStatus(revokeRes, 200);
      assert.equal(revokeRes.body.data.status, 'REVOKED');
      assert.equal(revokeRes.body.data.lifecycleStatus, 'REVOKED');

      const verifyRevoked = await client.request<PublicCertificateVerificationDto>(
        'GET',
        `/certificates/verify/${cert.certificateNumber}`,
      );
      expectStatus(verifyRevoked, 200);
      assert.equal(verifyRevoked.body.data.valid, false);
      assert.equal(verifyRevoked.body.data.status, 'REVOKED');
      assert.equal(verifyRevoked.body.data.lifecycleStatus, 'REVOKED');

      const revokedPngRes = await fetch(
        `${baseUrl}/api/v1/student/certificates/${cert.id}/download?format=png`,
        { headers: { authorization: `Bearer ${session.accessToken}` } },
      );
      assert.equal(revokedPngRes.status, 200);
      const revokedPngBytes = Buffer.from(await revokedPngRes.arrayBuffer());
      const { data: revokedRaw } = await sharp(revokedPngBytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const revokedCenterRedCount = countRedTintPixels(revokedRaw);
      assert.ok(
        revokedCenterRedCount > issuedCenterRedCount + 300,
        `Expected visible crimson REVOKED stamp pixels in center (issued=${issuedCenterRedCount}, revoked=${revokedCenterRedCount})`,
      );

      const revokedPdfRes = await fetch(
        `${baseUrl}/api/v1/student/certificates/${cert.id}/download/pdf`,
        { headers: { authorization: `Bearer ${session.accessToken}` } },
      );
      assert.equal(revokedPdfRes.status, 200);
      assert.ok(
        Buffer.from(await revokedPdfRes.arrayBuffer())
          .subarray(0, 5)
          .equals(Buffer.from('%PDF-')),
      );

      // Issue a second certificate, then reissue it -> old certificate MUST render SUPERSEDED in verify, PNG & PDF!
      const secondCertRes = await adminApi<CertificateDto>('POST', '/admin/certificates/manual', {
        recipientMode: 'MANUAL_RECIPIENT',
        sourceType: 'WORKSHOP',
        recipientName: 'External Workshop Guest',
        certificateTitle: 'WORKSHOP AWARD',
        subjectTitle: 'Fiqh Workshop',
        templateId: premium.id,
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s2.id,
            sortOrder: 1,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      });
      expectStatus(secondCertRes, 201);
      const activePngRes = await fetch(
        `${baseUrl}/api/v1/admin/certificates/${secondCertRes.body.data.id}/download/png`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      );
      assert.equal(activePngRes.status, 200);
      const { data: premRaw } = await sharp(Buffer.from(await activePngRes.arrayBuffer()))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      // Premium top crest bar (~x:400, y:40) is deep forest green #012114 (distinct from Classic #FDFBF7)
      const premHeaderRgb = sampleRgb(premRaw, 400, 40);
      assert.ok(
        premHeaderRgb[0] < 20 && premHeaderRgb[1] < 50 && premHeaderRgb[2] < 35,
        `Expected deep forest header in Premium PNG, got ${premHeaderRgb.join(',')}`,
      );

      const reissueSecond = await adminApi<CertificateDto>(
        'POST',
        `/admin/certificates/${secondCertRes.body.data.id}/reissue`,
        { reason: 'Spelling correction on certificate' },
      );
      expectStatus(reissueSecond, 201);

      const verifySuperseded = await client.request<PublicCertificateVerificationDto>(
        'GET',
        `/certificates/verify/${secondCertRes.body.data.certificateNumber}`,
      );
      expectStatus(verifySuperseded, 200);
      assert.equal(verifySuperseded.body.data.valid, false);
      assert.equal(verifySuperseded.body.data.status, 'REVOKED');
      assert.equal(verifySuperseded.body.data.lifecycleStatus, 'SUPERSEDED');
      assert.equal(
        verifySuperseded.body.data.supersededByCertificateNumber,
        reissueSecond.body.data.certificateNumber,
      );

      const supersededAdminDetail = await adminApi<AdminCertificateListItem>(
        'GET',
        `/admin/certificates/${secondCertRes.body.data.id}`,
      );
      expectStatus(supersededAdminDetail, 200);
      assert.equal(supersededAdminDetail.body.data.lifecycleStatus, 'SUPERSEDED');

      const supersededPngRes = await fetch(
        `${baseUrl}/api/v1/admin/certificates/${secondCertRes.body.data.id}/download/png`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      );
      assert.equal(supersededPngRes.status, 200);
      const supersededPngBytes = Buffer.from(await supersededPngRes.arrayBuffer());
      const { data: supRaw } = await sharp(supersededPngBytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.ok(countRedTintPixels(supRaw) > countRedTintPixels(premRaw) + 250);

      // Legacy Phase 13 compatibility: row with null Phase 17 snapshots
      // renders preview, PNG, and PDF dynamically on demand!
      const legacyCode = `ASRA-2025-LEGC-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
      const legacyRow = await prisma.certificate.create({
        data: {
          certificateNumber: legacyCode,
          userId: session.user.id,
          sourceType: 'COURSE',
          sourceLabel: 'Course',
          recipientName: session.user.fullName,
          certificateTitle: 'Certificate of Completion',
          courseTitle: 'Legacy Phase 13 Course Record',
          description: null,
          templateId: null,
          templateSnapshot: Prisma.DbNull,
          signatureSnapshots: Prisma.DbNull,
          completedAt: new Date('2025-11-01T00:00:00Z'),
          issuedAt: new Date('2025-11-02T00:00:00Z'),
          status: 'ISSUED',
        },
      });

      const legacyPreviewRes = await studentApi<CertificateDto>(
        'GET',
        `/student/certificates/${legacyRow.id}`,
      );
      expectStatus(legacyPreviewRes, 200);
      assert.equal('pdfUrl' in legacyPreviewRes.body.data, false);
      assert.equal(legacyPreviewRes.body.data.templateSnapshot?.style, 'CLASSIC_INSTITUTIONAL');
      assert.equal(legacyPreviewRes.body.data.signatureSnapshots?.length, 2);

      const legacyPngRes = await fetch(
        `${baseUrl}/api/v1/student/certificates/${legacyRow.id}/download/png`,
        { headers: { authorization: `Bearer ${session.accessToken}` } },
      );
      assert.equal(legacyPngRes.status, 200);
      const legacyPngMeta = await sharp(Buffer.from(await legacyPngRes.arrayBuffer())).metadata();
      assert.equal(legacyPngMeta.width, 1684);
      assert.equal(legacyPngMeta.height, 1190);

      const legacyPdfRes = await fetch(
        `${baseUrl}/api/v1/student/certificates/${legacyRow.id}/download/pdf`,
        { headers: { authorization: `Bearer ${session.accessToken}` } },
      );
      assert.equal(legacyPdfRes.status, 200);
      assert.ok(
        Buffer.from(await legacyPdfRes.arrayBuffer())
          .subarray(0, 5)
          .equals(Buffer.from('%PDF-')),
      );

      // Also verify in-memory PNG generation directly produces distinct buffers across active vs superseded
      const directPng = await generateCertificatePng({
        certificateNumber: 'ASRA-2026-DIRC-7777',
        recipientName: 'Direct Test',
        courseTitle: 'Modern Course',
        completedAt: new Date('2026-10-01T00:00:00Z'),
        issuedAt: new Date('2026-10-02T00:00:00Z'),
        status: 'REVOKED',
        lifecycleStatus: 'SUPERSEDED',
        supersededByCertificateNumber: 'ASRA-2026-DIRC-8888',
        verificationUrl: 'https://asraacademy-one.vercel.app/verify/ASRA-2026-DIRC-7777',
      });
      assert.equal((await sharp(directPng).metadata()).width, 1684);

      assert.equal(
        cloudinaryCalls.some((c) => c.url.includes('/raw/')),
        false,
        'Zero /raw/ Cloudinary upload or destroy requests allowed anywhere',
      );
    } finally {
      setCertificateStorageForTests(previousStorage);
    }
  });

  it('ADDITIONAL IMPROVEMENTS: aligns admin PDF download RBAC with route permissions and handles max-length overflow + footerNote + showSourceLabel PDFs', async () => {
    const client = new TestClient(baseUrl);
    const adminToken = await tokenFor(client, 'ADMIN');
    const adminApi = apiAs(client, adminToken);
    const png = makeTestPng(300, 100);

    const s1 = (
      await uploadSignatureMultipart(adminToken, { fullName: 'Sign X', designation: 'Chair' }, png)
    ).body.data;
    const s2 = (
      await uploadSignatureMultipart(
        adminToken,
        { fullName: 'Sign Y', designation: 'Registrar' },
        png,
      )
    ).body.data;
    const templates = (
      await adminApi<CertificateTemplateDto[]>('GET', '/admin/certificates/templates')
    ).body.data;
    const classic = templates.find((t) => t.style === 'CLASSIC_INSTITUTIONAL')!;

    // Enable showSourceLabel and set footerNote on Classic
    expectStatus(
      await adminApi('PATCH', `/admin/certificates/templates/${classic.id}`, {
        config: {
          showSourceLabel: true,
          footerNote: 'Accredited Institutional Verification · Seal Required',
        },
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s2.id,
            sortOrder: 1,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      }),
      200,
    );

    const issued = await adminApi<CertificateDto>('POST', '/admin/certificates/manual', {
      recipientMode: 'MANUAL_RECIPIENT',
      sourceType: 'COMPETITION',
      sourceLabel: 'International Rhetoric Award',
      recipientName: 'A'.repeat(120),
      certificateTitle: 'SPECIAL CERTIFICATE OF INSTITUTIONAL DISTINCTION AND EXCELLENCE',
      subjectTitle: 'B'.repeat(180),
      description: 'C'.repeat(900),
      achievementDetails: 'First Place Honor · Gold Distinction',
      templateId: classic.id,
      signatures: [
        {
          signatureId: s1.id,
          sortOrder: 0,
          positionLabel: 'Left',
          showName: true,
          showDesignation: true,
        },
        {
          signatureId: s2.id,
          sortOrder: 1,
          positionLabel: 'Right',
          showName: true,
          showDesignation: true,
        },
      ],
    });
    expectStatus(issued, 201);

    // Custom role holding ONLY certificates.issue (without ADMIN role or certificates.view) must download admin PDF
    const issuerUser = await provision('ADMIN');
    const suffix = uniqueSuffix()
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase();
    const issueOnlyRole = await prisma.role.create({
      data: { key: `CERT_ISSUE_${suffix}`, name: 'Cert Issuer Only', isSystem: false },
    });
    try {
      const issuePerm = await prisma.permission.findUniqueOrThrow({
        where: { key: PERMISSIONS.CERTIFICATES_ISSUE },
      });
      await prisma.userRole.deleteMany({ where: { userId: issuerUser.id } });
      await prisma.rolePermission.create({
        data: { roleId: issueOnlyRole.id, permissionId: issuePerm.id },
      });
      await prisma.userRole.create({
        data: { userId: issuerUser.id, roleId: issueOnlyRole.id },
      });

      const issuerSession = await login(client, issuerUser.email, PASSWORD);
      const dlRes = await fetch(
        `${baseUrl}/api/v1/admin/certificates/${issued.body.data.id}/download`,
        { headers: { authorization: `Bearer ${issuerSession.accessToken}` } },
      );
      assert.equal(dlRes.status, 200);
      const dlBuf = Buffer.from(await dlRes.arrayBuffer());
      assert.ok(dlBuf.subarray(0, 5).equals(Buffer.from('%PDF-')));
      assert.ok(dlBuf.length > 3000);

      const dlPngRes = await fetch(
        `${baseUrl}/api/v1/admin/certificates/${issued.body.data.id}/download/png`,
        { headers: { authorization: `Bearer ${issuerSession.accessToken}` } },
      );
      assert.equal(dlPngRes.status, 200);
      assert.equal(dlPngRes.headers.get('content-type'), 'image/png');
      const dlPngBuf = Buffer.from(await dlPngRes.arrayBuffer());
      assert.equal((await sharp(dlPngBuf).metadata()).width, 1684);

      // Admin generic issuance with unknown linked courseId returns 422 VALIDATION_ERROR cleanly
      const badLinkedCourse = await adminApi('POST', '/admin/certificates/issue', {
        sourceType: 'COURSE',
        courseId: '00000000-0000-4000-8000-000000000099',
        recipientName: 'Validation Check Recipient',
        subjectTitle: 'Missing Course Link Check',
        templateId: classic.id,
        signatures: [
          {
            signatureId: s1.id,
            sortOrder: 0,
            positionLabel: 'Left',
            showName: true,
            showDesignation: true,
          },
          {
            signatureId: s2.id,
            sortOrder: 1,
            positionLabel: 'Right',
            showName: true,
            showDesignation: true,
          },
        ],
      });
      assert.equal(badLinkedCourse.status, 422);
    } finally {
      await prisma.userRole.deleteMany({ where: { roleId: issueOnlyRole.id } });
      await prisma.rolePermission.deleteMany({ where: { roleId: issueOnlyRole.id } });
      await prisma.role.delete({ where: { id: issueOnlyRole.id } });
    }
  });
});
