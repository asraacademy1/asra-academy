/**
 * ASRA QUIZORA 2026 — Certificate of Participation (Template 1).
 *
 * Covers the replacement of the legacy templates (archive, never delete), the artwork renderer
 * (dynamic name / statement / dates / certificate ID / verification QR), the mandatory
 * Event Coordinator + Director signatures enforced on every backend path, and the rule that
 * participation certificates never display scores, marks, percentages or ranks.
 * Real HTTP endpoints, real database, real PDFKit / Sharp rendering.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type {
  CertificateDto,
  CertificateTemplateDto,
  PublicCertificateVerificationDto,
} from '@asra/types';
import {
  buildCertificateStatementRuns,
  formatCertificateLongDate,
  layoutCertificateRecipientName,
  layoutCertificateStatement,
  QUIZORA_2026_DEFAULT_BODY_TEXT,
  QUIZORA_2026_LAYOUT,
  QUIZORA_2026_DESIGN_2_TEMPLATE_KEY,
  QUIZORA_2026_TEMPLATE_KEY,
} from '@asra/validation';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { disconnectRedis } from '../src/lib/redis.js';
import {
  buildVerificationUrl,
  parseTemplateSnapshot,
  resolveCertificateSignatureSnapshots,
} from '../src/modules/certificates/bootstrap.js';
import { loadSignatureBuffers } from '../src/modules/certificates/certificates.service.js';
import { isValidCertificateNumber } from '../src/modules/certificates/id-generator.js';
import { quizoraTextMeasurer } from '../src/modules/certificates/quizora-assets.js';
import {
  buildQuizoraOverlaySvg,
  buildQuizoraRenderModel,
  quizoraVisibleText,
} from '../src/modules/certificates/quizora-renderer.js';
import { LEGACY_CERTIFICATE_TEMPLATES } from '../src/modules/certificates/templates.data.js';
import { login, registerVerifiedStudent, resetAuthState, uniqueEmail } from './support/auth.js';
import { apiAs, expectStatus, tokenFor } from './support/catalog.js';
import { uniqueSuffix } from './support/fixtures.js';
import { startServer, TestClient } from './support/http.js';
import {
  clearQuizoraTemplateSignatures,
  configureQuizoraTemplate,
  createTestSignature,
} from './support/quizora-template.js';

let baseUrl: string;
let close: () => Promise<void>;
let quizoraId: string;
let signatureIds: [string, string];

before(async () => {
  ({ baseUrl, close } = await startServer(createApp()));
});

after(async () => {
  await close();
  await Promise.all([disconnectPrisma(), disconnectRedis()]);
});

beforeEach(async () => {
  await resetAuthState();
  ({ templateId: quizoraId, signatureIds } = await configureQuizoraTemplate());
});

const placements = (ids: string[]) =>
  ids.map((signatureId, sortOrder) => ({
    signatureId,
    sortOrder,
    positionLabel: sortOrder === 0 ? 'Event Coordinator' : 'Director',
    showName: true,
    showDesignation: true,
  }));

async function adminApi() {
  const client = new TestClient(baseUrl);
  const token = await tokenFor(client, 'ADMIN');
  return { client, token, api: apiAs(client, token) };
}

async function student() {
  const client = new TestClient(baseUrl);
  const email = await registerVerifiedStudent(client, uniqueEmail('quizora'));
  await prisma.user.update({ where: { email }, data: { fullName: 'Ayesha Siddiqui' } });
  const session = await login(client, email);
  return {
    client,
    token: session.accessToken,
    api: apiAs(client, session.accessToken),
    userId: session.user.id,
  };
}

/** Published Academy Quiz whose results are released, with one evaluated passing attempt. */
async function quizWithPassingAttempt(userId: string, percent = 87) {
  const now = new Date();
  const submittedAt = new Date('2026-11-14T04:15:00Z'); // 09:45 IST, 14 Nov 2026
  const quiz = await prisma.academyQuiz.create({
    data: {
      slug: `asra-quizora-${uniqueSuffix()}`,
      title: 'ASRA QUIZORA – 2026',
      startsAt: new Date(now.getTime() - 3600_000),
      endsAt: new Date(now.getTime() - 600_000),
      durationMinutes: 30,
      status: 'PUBLISHED',
      publishedAt: new Date(now.getTime() - 7200_000),
      resultsPublishedAt: new Date(now.getTime() - 300_000),
      resultRelease: 'IMMEDIATE',
      passPercent: 0,
    },
  });
  await prisma.assessmentAttempt.create({
    data: {
      academyQuizId: quiz.id,
      userId,
      attemptNumber: 1,
      status: 'SUBMITTED',
      startedAt: new Date(submittedAt.getTime() - 1200_000),
      submittedAt,
      finalizedAt: submittedAt,
      evaluationStatus: 'EVALUATED',
      evaluatedAt: submittedAt,
      maxScore: 100,
      rawScore: percent,
      score: percent,
      percent,
      passed: true,
    },
  });
  return { quiz, submittedAt };
}

async function download(path: string, token: string) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    buf: Buffer.from(await res.arrayBuffer()),
  };
}

const SCORE_PATTERN = /%|score|marks?\b|percent|accuracy|rank|\b87\b/i;

describe('ASRA QUIZORA 2026 — template replacement', () => {
  it('offers only the QUIZORA template for new issuance, archives legacy templates and keeps historical certificates working', async () => {
    const { api, client, token } = await adminApi();
    const stu = await student();

    // A production database that pre-dates the replacement: legacy Classic template still active
    // and a certificate issued on it (with its immutable snapshot).
    const classicSeed = LEGACY_CERTIFICATE_TEMPLATES[0]!;
    const classic = await prisma.certificateTemplate.create({
      data: {
        key: classicSeed.key,
        name: classicSeed.name,
        style: classicSeed.style,
        defaultTitle: classicSeed.defaultTitle,
        defaultSubtitle: classicSeed.defaultSubtitle,
        defaultBodyText: classicSeed.defaultBodyText,
        issuingAuthority: classicSeed.issuingAuthority,
        config: classicSeed.config as unknown as object,
        isActive: true,
      },
    });
    const historicalNumber = `ASRA-2025-HIST-${uniqueSuffix()
      .slice(-4)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, 'X')}`;
    const historical = await prisma.certificate.create({
      data: {
        certificateNumber: historicalNumber,
        userId: stu.userId,
        sourceType: 'COURSE',
        sourceLabel: 'Course',
        templateId: classic.id,
        recipientName: 'Ayesha Siddiqui',
        certificateTitle: classicSeed.defaultTitle,
        courseTitle: 'Tajweed Fundamentals',
        description: classicSeed.defaultBodyText,
        templateSnapshot: {
          templateId: classic.id,
          key: classic.key,
          name: classic.name,
          style: classic.style,
          version: 1,
          certificateTitle: classicSeed.defaultTitle,
          subtitle: classicSeed.defaultSubtitle,
          bodyText: classicSeed.defaultBodyText,
          issuingAuthority: 'ASRA Academy',
          config: classicSeed.config as unknown as object,
        },
        completedAt: new Date('2025-10-01T00:00:00Z'),
        issuedAt: new Date('2025-10-02T00:00:00Z'),
        status: 'ISSUED',
        verification: {
          create: {
            verificationCode: historicalNumber,
            qrPayloadUrl: buildVerificationUrl(historicalNumber),
          },
        },
      },
    });

    // 1. Template selector: QUIZORA active + default; Classic archived (not deleted)
    const list = await api<CertificateTemplateDto[]>('GET', '/admin/certificates/templates');
    expectStatus(list, 200);
    const quizora = list.body.data.find((t) => t.key === QUIZORA_2026_TEMPLATE_KEY)!;
    assert.equal(quizora.name, 'ASRA QUIZORA 2026 — Certificate of Participation');
    assert.equal(quizora.category, 'QUIZ_PARTICIPATION');
    assert.equal(quizora.isActive, true);
    assert.equal(quizora.isDefault, true);
    assert.equal(quizora.requiredSignatureCount, 2);
    const archived = list.body.data.find((t) => t.id === classic.id)!;
    assert.equal(archived.isActive, false);
    assert.equal(archived.isRetired, true);
    assert.equal(archived.issuedCount, 1);
    assert.deepEqual(
      list.body.data
        .filter((t) => t.isActive)
        .map((t) => t.key)
        .sort(),
      [QUIZORA_2026_TEMPLATE_KEY, QUIZORA_2026_DESIGN_2_TEMPLATE_KEY].sort(),
    );

    // 2. Old templates cannot be re-activated or used for new issuance
    assert.equal(
      (await api('PATCH', `/admin/certificates/templates/${classic.id}`, { isActive: true }))
        .status,
      422,
    );
    assert.equal(
      (await api('PATCH', `/admin/certificates/templates/${classic.id}`, { isDefault: true }))
        .status,
      422,
    );
    const legacyIssue = await api('POST', '/admin/certificates/manual', {
      recipientMode: 'MANUAL_RECIPIENT',
      sourceType: 'EVENT',
      recipientName: 'Guest',
      subjectTitle: 'Event',
      templateId: classic.id,
      signatures: placements(signatureIds),
    });
    assert.equal(legacyIssue.status, 422);

    // 3. Historical certificate: still downloadable (legacy layout) and verifiable
    const histPdf = await download(
      `/student/certificates/${historical.id}/download/pdf`,
      stu.token,
    );
    assert.equal(histPdf.status, 200);
    assert.ok(histPdf.buf.subarray(0, 5).equals(Buffer.from('%PDF-')));
    const histPng = await download(
      `/student/certificates/${historical.id}/download/png`,
      stu.token,
    );
    assert.equal(histPng.status, 200);
    assert.equal((await sharp(histPng.buf).metadata()).width, 1684);
    const histVerify = await client.request<PublicCertificateVerificationDto>(
      'GET',
      `/certificates/verify/${historicalNumber}`,
    );
    expectStatus(histVerify, 200);
    assert.equal(histVerify.body.data.valid, true);
    assert.ok(token);
  });
});

describe('ASRA QUIZORA 2026 — rendering & verification', () => {
  it('issues a participation certificate with dynamic name, statement, dates, ID and verification QR — and no scores', async () => {
    const stu = await student();
    const { quiz, submittedAt } = await quizWithPassingAttempt(stu.userId, 87);

    const claim = await stu.api<CertificateDto>(
      'POST',
      `/student/academy-quizzes/${quiz.id}/certificate`,
    );
    expectStatus(claim, 201);
    const cert = claim.body.data;

    // Certificate ID from the existing numbering system
    assert.ok(isValidCertificateNumber(cert.certificateNumber), cert.certificateNumber);
    assert.equal(cert.templateSnapshot?.style, 'QUIZORA_PARTICIPATION');
    assert.equal(cert.certificateTitle, 'Certificate of Participation');
    assert.equal(cert.description, QUIZORA_2026_DEFAULT_BODY_TEXT);
    assert.equal(cert.verificationUrl, buildVerificationUrl(cert.certificateNumber));
    assert.deepEqual(
      cert.signatureSnapshots?.map((s) => [s.sortOrder, s.signatureId, s.isFallback]),
      [
        [0, signatureIds[0], false],
        [1, signatureIds[1], false],
      ],
    );
    // Dates: completion = attempt submission (quiz completion), issued = issuance time
    assert.equal(cert.completedAt, submittedAt.toISOString());

    // No score anywhere: DTO, database, student list, public verification
    assert.equal(cert.achievementDetails, null);
    const row = await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } });
    assert.equal(row.achievementDetails, null);
    const listed = await stu.api<{ items: CertificateDto[] }>('GET', '/student/certificates');
    expectStatus(listed, 200);
    assert.ok(!JSON.stringify(listed.body.data.items[0]).match(/Score|87%/));
    const verify = await stu.client.request<PublicCertificateVerificationDto>(
      'GET',
      `/certificates/verify/${cert.certificateNumber}`,
    );
    expectStatus(verify, 200);
    assert.equal(verify.body.data.valid, true);
    assert.equal(verify.body.data.achievementDetails, null);
    assert.ok(!JSON.stringify(verify.body.data).includes('87'));

    // Render model built exactly as the download path builds it
    const signatureSnapshots = resolveCertificateSignatureSnapshots(row.signatureSnapshots);
    const { buffers } = await loadSignatureBuffers(signatureSnapshots);
    const model = buildQuizoraRenderModel({
      certificateNumber: row.certificateNumber,
      recipientName: row.recipientName,
      certificateTitle: row.certificateTitle,
      courseTitle: row.courseTitle,
      description: row.description,
      achievementDetails: 'Score: 87% · Rank #1', // even if present, never rendered
      completedAt: row.completedAt,
      issuedAt: row.issuedAt,
      status: row.status,
      verificationUrl: buildVerificationUrl(row.certificateNumber),
      templateSnapshot: parseTemplateSnapshot(row.templateSnapshot),
      signatureSnapshots,
      signatureBuffers: buffers,
    });
    const text = quizoraVisibleText(model);
    const joined = text.join(' ');
    assert.ok(joined.includes('Ayesha Siddiqui'));
    assert.ok(joined.includes('ASRA QUIZORA – 2026'));
    assert.ok(joined.includes('has successfully attempted the'));
    assert.ok(joined.includes('ASRA Academy'));
    assert.ok(joined.includes(formatCertificateLongDate(row.completedAt)));
    assert.equal(formatCertificateLongDate(row.completedAt), 'November 14, 2026');
    assert.ok(joined.includes(formatCertificateLongDate(row.issuedAt)));
    assert.ok(joined.includes(row.certificateNumber));
    assert.ok(joined.includes(buildVerificationUrl(row.certificateNumber)));
    assert.ok(text.includes('COMPLETION DATE:') && text.includes('ISSUED DATE:'));
    assert.ok(text.includes('CERTIFICATE ID:') && text.includes('VERIFY AT:'));
    for (const t of text) {
      assert.ok(!SCORE_PATTERN.test(t), `Visible certificate text must not show scores: "${t}"`);
    }

    // Per-certificate QR encoding the real public verification URL
    assert.equal(model.qrPayload, `http://localhost:3000/verify/${row.certificateNumber}`);
    const svg = buildQuizoraOverlaySvg(model);
    const expectedModules = QRCode.create(model.qrPayload, { errorCorrectionLevel: 'M' }).modules;
    let darkRuns = 0;
    for (let r = 0; r < expectedModules.size; r++) {
      for (let c = 0; c < expectedModules.size; c++) {
        if (expectedModules.get(r, c) && (c === 0 || !expectedModules.get(r, c - 1))) darkRuns++;
      }
    }
    const qrGroup =
      /<g fill="#0B1638" shape-rendering="crispEdges">(.*?)<\/g>/.exec(svg)?.[1] ?? '';
    assert.equal((qrGroup.match(/<rect /g) ?? []).length, darkRuns);
    // Two signature images in their slots
    assert.equal(model.signatures.length, 2);
    assert.deepEqual(
      model.signatures.map((s) => s.label),
      ['Event Coordinator', 'Director'],
    );

    // PDF: exact 3:2 page with the original JPEG artwork embedded; PNG: 3072x2048
    const pdf = await download(`/student/certificates/${cert.id}/download/pdf`, stu.token);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    assert.ok(pdf.buf.subarray(0, 5).equals(Buffer.from('%PDF-')));
    const pdfText = pdf.buf.toString('latin1');
    assert.match(pdfText, /\/MediaBox \[0 0 1152 768\]/);
    assert.match(pdfText, /\/DCTDecode/);
    const png = await download(`/student/certificates/${cert.id}/download/png`, stu.token);
    assert.equal(png.status, 200);
    const meta = await sharp(png.buf).metadata();
    assert.equal(meta.width, QUIZORA_2026_LAYOUT.width * 2);
    assert.equal(meta.height, QUIZORA_2026_LAYOUT.height * 2);
  });

  it('fits long recipient names and long titles inside the artwork without overlap', () => {
    const measure = quizoraTextMeasurer();
    const N = QUIZORA_2026_LAYOUT.name;
    for (const name of [
      'Ali',
      'Fatima Zahra Al-Khatib',
      'Muhammad Abdur-Rahman Ibn Sulaiman Al-Hashimi Al-Qurashi Al-Madani Bin Abdullah Al-Farooqi',
      'A'.repeat(150),
      Array.from({ length: 30 }, () => 'Abdullah').join(' '),
    ]) {
      const layout = layoutCertificateRecipientName(name, measure);
      assert.ok(layout.lines.length >= 1 && layout.lines.length <= 2);
      for (const line of layout.lines) {
        assert.ok(line.width <= N.maxWidth + 0.01, `name line too wide (${line.width})`);
        // cap height stays below the gold ribbon (≈ y 525) and baseline above the rule (y 594)
        assert.ok(line.baselineY - layout.fontSize * 0.72 >= 525);
        assert.ok(line.baselineY <= 592);
      }
    }

    const S = QUIZORA_2026_LAYOUT.statement;
    for (const title of [
      'ASRA QUIZORA – 2026',
      'Advanced Certificate Programme in Classical Arabic Grammar, Morphology, Rhetoric and Quranic Exegesis (Batch 2026 – Weekend Cohort)',
      'B'.repeat(200),
    ]) {
      const layout = layoutCertificateStatement(
        buildCertificateStatementRuns(QUIZORA_2026_DEFAULT_BODY_TEXT, {
          title,
          date: new Date('2026-11-14T05:00:00Z'),
        }),
        measure,
      );
      const first = layout.lines[0]!;
      const last = layout.lines[layout.lines.length - 1]!;
      assert.ok(layout.lines.every((l) => l.width <= S.maxWidth + 0.01));
      assert.ok(
        first.baselineY - layout.fontSize * 0.75 >= 600,
        'statement overlaps the name rule',
      );
      assert.ok(last.baselineY + layout.fontSize * 0.3 <= 750, 'statement overlaps signatures');
    }
  });
});

describe('ASRA QUIZORA 2026 — mandatory signatures (backend enforcement)', () => {
  it('blocks preview, generation and issuance on every path when the required signatures are missing', async () => {
    const { api, token } = await adminApi();
    const stu = await student();
    const { quiz } = await quizWithPassingAttempt(stu.userId);

    await clearQuizoraTemplateSignatures();

    // Template sample previews (PDF + PNG)
    for (const suffix of ['preview', 'preview/png']) {
      const res = await download(`/admin/certificates/templates/${quizoraId}/${suffix}`, token);
      assert.equal(res.status, 422, `${suffix} must be refused without signatures`);
      assert.match(res.buf.toString('utf8'), /requires exactly 2 active digital signatures/);
    }

    // Student self-claim, admin generic issue (no signatures), manual issue (1 and 3 signatures)
    assert.equal(
      (await stu.api('POST', `/student/academy-quizzes/${quiz.id}/certificate`)).status,
      422,
    );
    assert.equal(
      (
        await api('POST', '/admin/certificates/issue', {
          sourceType: 'EVENT',
          recipientName: 'Guest',
          subjectTitle: 'ASRA QUIZORA – 2026',
          templateId: quizoraId,
        })
      ).status,
      422,
    );
    const third = await createTestSignature('Third Signatory', 'Dean');
    for (const ids of [[signatureIds[0]], [signatureIds[0], signatureIds[1], third.id]]) {
      const res = await api('POST', '/admin/certificates/manual', {
        recipientMode: 'MANUAL_RECIPIENT',
        sourceType: 'EVENT',
        recipientName: 'Guest',
        subjectTitle: 'ASRA QUIZORA – 2026',
        templateId: quizoraId,
        signatures: placements(ids),
      });
      assert.equal(res.status, 422);
    }

    // Bulk quiz issuance: summary, preview, sample preview and issue all refuse the template
    const summary = await api<{ activeValidTemplatesCount: number }>(
      'GET',
      `/admin/academy-quizzes/${quiz.id}/certificates/summary`,
    );
    expectStatus(summary, 200);
    assert.equal(summary.body.data.activeValidTemplatesCount, 0);
    const bulkBody = {
      recipientMode: 'ALL_PARTICIPANTS',
      templates: { participationTemplateId: quizoraId },
    };
    assert.equal(
      (await api('POST', `/admin/academy-quizzes/${quiz.id}/certificates/preview`, bulkBody))
        .status,
      422,
    );
    assert.equal(
      (await api('POST', `/admin/academy-quizzes/${quiz.id}/certificates/issue`, bulkBody)).status,
      422,
    );
    const sample = await download(
      `/admin/academy-quizzes/${quiz.id}/certificates/sample-preview?templateId=${quizoraId}&category=PARTICIPATION&format=pdf`,
      token,
    );
    assert.equal(sample.status, 422);

    assert.equal(await prisma.certificate.count({ where: { academyQuizId: quiz.id } }), 0);
    assert.equal(
      await prisma.quizCertificateIssuanceBatch.count({ where: { quizId: quiz.id } }),
      0,
    );
  });

  it('never substitutes a different signature when a configured signatory is deactivated', async () => {
    const stu = await student();
    const { quiz } = await quizWithPassingAttempt(stu.userId);
    // Another active signature exists that could be "borrowed" — it must not be.
    await createTestSignature('Spare Signatory', 'Registrar');
    await prisma.certificateSignature.update({
      where: { id: signatureIds[1] },
      data: { isActive: false },
    });
    const claim = await stu.api('POST', `/student/academy-quizzes/${quiz.id}/certificate`);
    assert.equal(claim.status, 422);
    assert.equal(await prisma.certificate.count({ where: { academyQuizId: quiz.id } }), 0);
  });

  it('refuses to render a QUIZORA certificate whose signature snapshot is not the two real signatures', async () => {
    const stu = await student();
    const number = `ASRA-2026-NSIG-${uniqueSuffix()
      .slice(-4)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, 'X')}`;
    const tpl = await prisma.certificateTemplate.findUniqueOrThrow({ where: { id: quizoraId } });
    const tampered = await prisma.certificate.create({
      data: {
        certificateNumber: number,
        userId: stu.userId,
        sourceType: 'EVENT',
        templateId: quizoraId,
        recipientName: 'Ayesha Siddiqui',
        certificateTitle: tpl.defaultTitle,
        courseTitle: 'ASRA QUIZORA – 2026',
        templateSnapshot: {
          templateId: tpl.id,
          key: tpl.key,
          name: tpl.name,
          style: tpl.style,
          version: tpl.version,
          certificateTitle: tpl.defaultTitle,
          bodyText: tpl.defaultBodyText,
          issuingAuthority: 'ASRA Academy',
          config: {},
        },
        signatureSnapshots: [], // → resolves to placeholder fallback signatories
        status: 'ISSUED',
      },
    });
    for (const fmt of ['pdf', 'png']) {
      const res = await download(`/student/certificates/${tampered.id}/download/${fmt}`, stu.token);
      assert.equal(res.status, 422, `${fmt} must not render with placeholder signatures`);
    }
  });
});
