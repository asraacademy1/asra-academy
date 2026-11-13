/**
 * ASRA QUIZORA 2026 — Certificate of Participation (Design 2) — Template 2.
 *
 * Template 2 coexists with Template 1 on the same engine: independent selection, its own
 * reference artwork / fonts / layout, mandatory Event Coordinator + Director signatures, dynamic
 * bottom-centre verification QR, metadata, bulk issuance, and no scores. Template 1 must remain
 * unchanged. Real HTTP endpoints, real database, real PDFKit / Sharp rendering.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type {
  CertificateDto,
  CertificateTemplateDto,
  PublicCertificateVerificationDto,
} from '@asra/types';
import {
  artworkTemplateForStyle,
  buildCertificateStatementRuns,
  formatCertificateLongDate,
  layoutCertificateRecipientName,
  layoutCertificateStatement,
  QUIZORA_2026_DEFAULT_BODY_TEXT,
  QUIZORA_2026_DEFINITION,
  QUIZORA_2026_DESIGN_2_DEFAULT_BODY_TEXT,
  QUIZORA_2026_DESIGN_2_DEFINITION,
  QUIZORA_2026_DESIGN_2_TEMPLATE_KEY,
  QUIZORA_2026_TEMPLATE_KEY,
} from '@asra/validation';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { settleQuizCertificateDispatch } from '../src/modules/academy-quizzes/quiz-certificates.worker.js';
import {
  buildVerificationUrl,
  parseTemplateSnapshot,
  resolveCertificateSignatureSnapshots,
} from '../src/modules/certificates/bootstrap.js';
import { loadSignatureBuffers } from '../src/modules/certificates/certificates.service.js';
import { isValidCertificateNumber } from '../src/modules/certificates/id-generator.js';
import {
  loadArtworkAssets,
  quizoraTextMeasurer,
} from '../src/modules/certificates/quizora-assets.js';
import {
  buildQuizoraOverlaySvg,
  buildQuizoraRenderModel,
  quizoraVisibleText,
} from '../src/modules/certificates/quizora-renderer.js';
import { login, registerVerifiedStudent, resetAuthState, uniqueEmail } from './support/auth.js';
import { apiAs, expectStatus, tokenFor } from './support/catalog.js';
import { uniqueSuffix } from './support/fixtures.js';
import { startServer, TestClient } from './support/http.js';
import {
  clearQuizoraTemplateSignatures,
  configureQuizoraTemplate,
} from './support/quizora-template.js';

let baseUrl: string;
let close: () => Promise<void>;
let design1Id: string;
let design2Id: string;
let design2Signatures: [string, string];

before(async () => {
  ({ baseUrl, close } = await startServer(createApp()));
});

after(async () => {
  await close();
  await Promise.all([disconnectPrisma(), disconnectRedis()]);
});

beforeEach(async () => {
  await resetAuthState();
  ({ templateId: design1Id } = await configureQuizoraTemplate());
  ({ templateId: design2Id, signatureIds: design2Signatures } = await configureQuizoraTemplate(
    ['Design2 Coordinator', 'Design2 Director'],
    QUIZORA_2026_DESIGN_2_TEMPLATE_KEY,
  ));
});

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');
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

async function download(path: string, token: string) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

/** Ended, published quiz with released results and one evaluated attempt by a new student. */
async function endedQuizWithParticipant() {
  const client = new TestClient(baseUrl);
  const email = await registerVerifiedStudent(client, uniqueEmail('design2'));
  await prisma.user.update({ where: { email }, data: { fullName: 'Ayesha Siddiqui' } });
  const session = await login(client, email);
  const now = new Date();
  const submittedAt = new Date('2026-11-14T04:15:00Z');
  const quiz = await prisma.academyQuiz.create({
    data: {
      slug: `quizora-d2-${uniqueSuffix()}`,
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
      userId: session.user.id,
      attemptNumber: 1,
      status: 'SUBMITTED',
      startedAt: new Date(submittedAt.getTime() - 1200_000),
      submittedAt,
      finalizedAt: submittedAt,
      evaluationStatus: 'EVALUATED',
      evaluatedAt: submittedAt,
      maxScore: 100,
      rawScore: 87,
      score: 87,
      percent: 87,
      passed: true,
    },
  });
  return { quiz, submittedAt, userId: session.user.id, token: session.accessToken, client };
}

/** Mean absolute RGB difference of the top band (static artwork only) against an artwork file. */
async function topBandDifference(png: Buffer, artwork: Buffer): Promise<number> {
  const region = { left: 0, top: 0, width: 1536, height: 400 };
  const a = await sharp(png).resize(1536, 1024).extract(region).removeAlpha().raw().toBuffer();
  const b = await sharp(artwork).extract(region).removeAlpha().raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

const SCORE_PATTERN = /%|score|marks?\b|percent|accuracy|rank|\b87\b/i;

describe('Template 2 — registration & coexistence', () => {
  it('registers Design 2 as an independently selectable template while Template 1 stays unchanged', async () => {
    const { api } = await adminApi();
    const list = await api<CertificateTemplateDto[]>('GET', '/admin/certificates/templates');
    expectStatus(list, 200);
    const d1 = list.body.data.find((t) => t.key === QUIZORA_2026_TEMPLATE_KEY)!;
    const d2 = list.body.data.find((t) => t.key === QUIZORA_2026_DESIGN_2_TEMPLATE_KEY)!;

    assert.equal(d2.name, 'ASRA QUIZORA 2026 — Certificate of Participation (Design 2)');
    assert.equal(d2.style, 'QUIZORA_PARTICIPATION_DESIGN_2');
    assert.equal(d2.category, 'QUIZ_PARTICIPATION');
    assert.equal(d2.isActive, true);
    assert.equal(d2.isDefault, false);
    assert.equal(d2.requiredSignatureCount, 2);
    assert.equal(d2.defaultBodyText, QUIZORA_2026_DESIGN_2_DEFAULT_BODY_TEXT);
    assert.deepEqual(
      d2.signatures.map((s) => s.signatureId),
      design2Signatures,
    );

    // Template 1: same row semantics, still the default, own signatures and statement
    assert.equal(d1.name, 'ASRA QUIZORA 2026 — Certificate of Participation');
    assert.equal(d1.style, 'QUIZORA_PARTICIPATION');
    assert.equal(d1.isDefault, true);
    assert.equal(d1.defaultBodyText, QUIZORA_2026_DEFAULT_BODY_TEXT);
    assert.notEqual(d1.id, d2.id);
    assert.ok(d1.signatures.every((s) => !design2Signatures.includes(s.signatureId)));

    // Template 1 artwork, statement patch and layout are untouched
    const d1Assets = loadArtworkAssets(QUIZORA_2026_DEFINITION);
    assert.equal(
      sha256(d1Assets.artwork),
      '178913bcbd6267c94e4302c8abb028c7b298d4754ab1fd74a93aa7d8f799ee46',
    );
    assert.equal(
      sha256(d1Assets.statementPatch),
      '3d93d47f4e2850c740b80bf0f9cc68ddc7ef145c395d60ac8d749a892d8519e5',
    );
    assert.deepEqual(QUIZORA_2026_DEFINITION.layout.qr, {
      x: 1258,
      y: 744,
      size: 108,
      captionHeight: 15,
      caption: 'SCAN TO VERIFY',
      captionSize: 9,
      padding: 3,
      quietZoneModules: 4,
      frame: 'card',
    });
    // Design 2 ships its own reference artwork
    assert.equal(
      sha256(loadArtworkAssets(QUIZORA_2026_DESIGN_2_DEFINITION).artwork),
      '94bfdce1bb6a55742adc6608f7185aacc884cb67fc548268a2017e8f3e83fccf',
    );
    assert.equal(
      artworkTemplateForStyle('QUIZORA_PARTICIPATION_DESIGN_2'),
      QUIZORA_2026_DESIGN_2_DEFINITION,
    );

    // Each template previews with its own artwork (sample PNG compared with the artwork files)
    const { token } = await adminApi();
    const d1Png = await download(`/admin/certificates/templates/${d1.id}/preview/png`, token);
    const d2Png = await download(`/admin/certificates/templates/${d2.id}/preview/png`, token);
    assert.equal(d1Png.status, 200);
    assert.equal(d2Png.status, 200);
    const art1 = loadArtworkAssets(QUIZORA_2026_DEFINITION).artwork;
    const art2 = loadArtworkAssets(QUIZORA_2026_DESIGN_2_DEFINITION).artwork;
    assert.ok(
      (await topBandDifference(d2Png.buf, art2)) < 8,
      'Design 2 preview uses Design 2 artwork',
    );
    assert.ok((await topBandDifference(d2Png.buf, art1)) > 30, 'Design 2 preview is not Design 1');
    assert.ok(
      (await topBandDifference(d1Png.buf, art1)) < 8,
      'Design 1 preview uses Design 1 artwork',
    );
    const d2Pdf = await download(`/admin/certificates/templates/${d2.id}/preview`, token);
    assert.equal(d2Pdf.status, 200);
    assert.match(d2Pdf.buf.toString('latin1'), /\/MediaBox \[0 0 1152 768\]/);
  });
});

describe('Template 2 — issuance, rendering & verification', () => {
  it('issues Design 2 certificates with script name, statement, metadata and a per-certificate QR — and no scores', async () => {
    const { api, client } = await adminApi();
    const issued = await api<CertificateDto>('POST', '/admin/certificates/manual', {
      recipientMode: 'MANUAL_RECIPIENT',
      sourceType: 'EVENT',
      recipientName: 'Fatima Zahra Al-Khatib',
      certificateTitle: 'Certificate of Participation',
      subjectTitle: 'ASRA QUIZORA – 2026',
      achievementDetails: 'Score: 87% · Rank #1',
      templateId: design2Id,
      completedAt: '2026-11-14T00:00:00.000Z',
      signatures: placements(design2Signatures),
    });
    expectStatus(issued, 201);
    const cert = issued.body.data;
    assert.ok(isValidCertificateNumber(cert.certificateNumber));
    assert.equal(cert.templateSnapshot?.style, 'QUIZORA_PARTICIPATION_DESIGN_2');
    assert.equal(cert.templateId, design2Id);
    assert.equal(cert.description, QUIZORA_2026_DESIGN_2_DEFAULT_BODY_TEXT);
    assert.equal(cert.achievementDetails, null);
    assert.equal(cert.verificationUrl, buildVerificationUrl(cert.certificateNumber));

    const verify = await client.request<PublicCertificateVerificationDto>(
      'GET',
      `/certificates/verify/${cert.certificateNumber}`,
    );
    expectStatus(verify, 200);
    assert.equal(verify.body.data.valid, true);
    assert.equal(verify.body.data.achievementDetails, null);

    const row = await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } });
    const snapshots = resolveCertificateSignatureSnapshots(row.signatureSnapshots);
    const { buffers } = await loadSignatureBuffers(snapshots);
    const model = buildQuizoraRenderModel({
      certificateNumber: row.certificateNumber,
      recipientName: row.recipientName,
      certificateTitle: row.certificateTitle,
      courseTitle: row.courseTitle,
      description: row.description,
      achievementDetails: 'Score: 87% · Rank #1',
      completedAt: row.completedAt,
      issuedAt: row.issuedAt,
      status: row.status,
      verificationUrl: buildVerificationUrl(row.certificateNumber),
      templateSnapshot: parseTemplateSnapshot(row.templateSnapshot),
      signatureSnapshots: snapshots,
      signatureBuffers: buffers,
    });
    assert.equal(model.def, QUIZORA_2026_DESIGN_2_DEFINITION);
    const text = quizoraVisibleText(model);
    const joined = text.join(' ');
    assert.ok(joined.includes('Fatima Zahra Al-Khatib'));
    assert.equal(model.name.lines[0]!.segments[0]!.variant, 'name');
    assert.ok(joined.includes('has successfully attempted the'));
    assert.ok(joined.includes('ASRA QUIZORA – 2026'));
    assert.ok(joined.includes('a National Level Quiz Competition organized by'));
    assert.ok(joined.includes('ASRA Academy'));
    assert.equal(model.statement.lines.length, 4, 'four centred lines as in the reference');
    assert.ok(joined.includes(formatCertificateLongDate(row.completedAt)));
    assert.ok(joined.includes(formatCertificateLongDate(row.issuedAt)));
    assert.ok(joined.includes(row.certificateNumber));
    assert.ok(joined.includes(buildVerificationUrl(row.certificateNumber)));
    assert.ok(!text.includes('SCAN TO VERIFY'), 'Design 2 keeps the reference QR without caption');
    for (const t of text) assert.ok(!SCORE_PATTERN.test(t), `no scores on certificate: "${t}"`);

    // Bottom-centre QR encoding this certificate's verification URL
    const qrCfg = model.def.layout.qr;
    assert.ok(Math.abs(qrCfg.x + qrCfg.size / 2 - 768) < 10);
    assert.equal(model.qrPayload, `http://localhost:3000/verify/${row.certificateNumber}`);
    const modules = QRCode.create(model.qrPayload, { errorCorrectionLevel: 'M' }).modules;
    let runs = 0;
    for (let r = 0; r < modules.size; r++) {
      for (let c = 0; c < modules.size; c++) {
        if (modules.get(r, c) && (c === 0 || !modules.get(r, c - 1))) runs++;
      }
    }
    const svg = buildQuizoraOverlaySvg(model);
    const qrGroup =
      /<g fill="#000000" shape-rendering="crispEdges">(.*?)<\/g>/.exec(svg)?.[1] ?? '';
    assert.equal((qrGroup.match(/<rect /g) ?? []).length, runs);
    assert.deepEqual(
      model.signatures.map((s) => [s.label, s.box.y]),
      [
        ['Event Coordinator', 774],
        ['Director', 774],
      ],
    );

    // Downloads (admin): PDF 3:2 page with original artwork, PNG 3072×2048 with Design 2 artwork
    const { token } = await adminApi();
    const pdf = await download(`/admin/certificates/${cert.id}/download/pdf`, token);
    assert.equal(pdf.status, 200);
    assert.match(pdf.buf.toString('latin1'), /\/MediaBox \[0 0 1152 768\]/);
    const png = await download(`/admin/certificates/${cert.id}/download/png`, token);
    assert.equal(png.status, 200);
    const meta = await sharp(png.buf).metadata();
    assert.equal(meta.width, 3072);
    assert.equal(meta.height, 2048);
    assert.ok(
      (await topBandDifference(
        png.buf,
        loadArtworkAssets(QUIZORA_2026_DESIGN_2_DEFINITION).artwork,
      )) < 8,
    );
  });

  it('fits long names (script) and long titles inside the Design 2 artwork', () => {
    const def = QUIZORA_2026_DESIGN_2_DEFINITION;
    const measure = quizoraTextMeasurer(loadArtworkAssets(def), def);
    for (const name of [
      'Ali',
      'Fatima Zahra Al-Khatib',
      'Muhammad Abdur-Rahman Ibn Sulaiman Al-Hashimi Al-Qurashi Al-Madani Bin Abdullah Al-Farooqi',
      'A'.repeat(150),
    ]) {
      const layout = layoutCertificateRecipientName(name, measure, def);
      assert.ok(layout.lines.length >= 1 && layout.lines.length <= 2);
      for (const line of layout.lines) {
        assert.ok(line.width <= def.layout.name.maxWidth + 0.01);
        // below "This is to certify that" (ink ends y 472) and above the gold divider (y 584)
        assert.ok(line.baselineY - layout.fontSize * 0.76 >= 474);
        assert.ok(line.baselineY <= 580);
      }
    }
    for (const title of [
      'ASRA QUIZORA – 2026',
      'Advanced Certificate Programme in Classical Arabic Grammar, Morphology, Rhetoric and Quranic Exegesis (Batch 2026 – Weekend Cohort)',
      'B'.repeat(200),
    ]) {
      const layout = layoutCertificateStatement(
        buildCertificateStatementRuns(def.defaultBodyText, {
          title,
          date: new Date('2026-11-14T05:00:00Z'),
        }),
        measure,
        def,
      );
      const first = layout.lines[0]!;
      const last = layout.lines[layout.lines.length - 1]!;
      assert.ok(layout.lines.every((l) => l.width <= def.layout.statement.maxWidth + 0.01));
      assert.ok(first.baselineY - layout.fontSize * 1.29 * 0.75 >= 588, 'clear of the divider');
      assert.ok(last.baselineY + layout.fontSize * 0.3 <= 772, 'clear of signatures and QR');
    }
  });

  it('issues Design 2 certificates through bulk quiz issuance and student downloads', async () => {
    const { api } = await adminApi();
    const p = await endedQuizWithParticipant();
    const res = await api('POST', `/admin/academy-quizzes/${p.quiz.id}/certificates/issue`, {
      recipientMode: 'ALL_PARTICIPANTS',
      templates: { participationTemplateId: design2Id },
    });
    expectStatus(res, 202);
    await settleQuizCertificateDispatch();

    const cert = await prisma.certificate.findFirstOrThrow({
      where: { academyQuizId: p.quiz.id, userId: p.userId },
    });
    assert.equal(cert.templateId, design2Id);
    assert.equal(
      (cert.templateSnapshot as { style?: string } | null)?.style,
      'QUIZORA_PARTICIPATION_DESIGN_2',
    );
    assert.equal(cert.achievementDetails, null);
    assert.equal(cert.completedAt.toISOString(), p.submittedAt.toISOString());

    for (const fmt of ['pdf', 'png']) {
      const dl = await download(`/student/certificates/${cert.id}/download/${fmt}`, p.token);
      assert.equal(dl.status, 200, `student ${fmt} download`);
    }
  });
});

describe('Template 2 — mandatory signatures (backend enforcement)', () => {
  it('blocks preview, generation and bulk issuance when Design 2 signatures are missing (Template 1 unaffected)', async () => {
    const { api, token } = await adminApi();
    const p = await endedQuizWithParticipant();
    await clearQuizoraTemplateSignatures(QUIZORA_2026_DESIGN_2_TEMPLATE_KEY);

    for (const suffix of ['preview', 'preview/png']) {
      const res = await download(`/admin/certificates/templates/${design2Id}/${suffix}`, token);
      assert.equal(res.status, 422);
      assert.match(res.buf.toString('utf8'), /requires exactly 2 active digital signatures/);
    }
    assert.equal(
      (
        await api('POST', '/admin/certificates/issue', {
          sourceType: 'EVENT',
          recipientName: 'Guest',
          subjectTitle: 'ASRA QUIZORA – 2026',
          templateId: design2Id,
        })
      ).status,
      422,
    );
    const body = {
      recipientMode: 'ALL_PARTICIPANTS',
      templates: { participationTemplateId: design2Id },
    };
    assert.equal(
      (await api('POST', `/admin/academy-quizzes/${p.quiz.id}/certificates/preview`, body)).status,
      422,
    );
    assert.equal(
      (await api('POST', `/admin/academy-quizzes/${p.quiz.id}/certificates/issue`, body)).status,
      422,
    );
    const sample = await download(
      `/admin/academy-quizzes/${p.quiz.id}/certificates/sample-preview?templateId=${design2Id}&category=PARTICIPATION&format=png`,
      token,
    );
    assert.equal(sample.status, 422);
    assert.equal(await prisma.certificate.count({ where: { academyQuizId: p.quiz.id } }), 0);

    // Template 1 keeps working independently
    const d1Preview = await download(`/admin/certificates/templates/${design1Id}/preview`, token);
    assert.equal(d1Preview.status, 200);
  });
});
