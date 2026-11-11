/**
 * Regression Tests (Unit + HTTP Express, no live PostgreSQL migrations required):
 * 1. Certificate template sample preview (PNG & PDF) headers, in-memory rendering, and 404 on `/api/v1/api/v1/...`.
 * 2. Recruitment applicant resume download endpoint (`GET /api/v1/admin/recruitment/applications/:id/resume`),
 *    legacy & dynamic Cloudinary path resolution, 404 vs 503 differentiation, and RBAC enforcement.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it, type TestContext } from 'node:test';
import { PERMISSIONS } from '@asra/types';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { INITIAL_CERTIFICATE_TEMPLATES } from '../src/modules/certificates/templates.data.js';
import { DEFAULT_FALLBACK_SIGNATURES } from '../src/modules/certificates/bootstrap.js';
import { resumeStorageService } from '../src/modules/recruitment/resume-storage.service.js';
import { tokenService } from '../src/services/token.service.js';
import { AppError } from '../src/utils/app-error.js';

const VALID_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n168\n%%EOF',
);

const ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE_ID = '3a111111-1111-4111-8111-111111111111';
const APPLICATION_ID = '27191f2a-befc-47db-8caf-efa4b6c93166';

function stubDelegateMethod<T extends object, K extends keyof T>(
  t: TestContext,
  delegate: T,
  method: K,
  impl: T[K],
): void {
  const prevDesc = Object.getOwnPropertyDescriptor(delegate, method);
  Object.defineProperty(delegate, method, {
    value: impl,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (prevDesc) {
      Object.defineProperty(delegate, method, prevDesc);
    } else {
      delete (delegate as Record<PropertyKey, unknown>)[method];
    }
  });
}

function buildMockSession(permissions: string[], roleKey = 'ADMIN') {
  return {
    id: ADMIN_SESSION_ID,
    userId: ADMIN_USER_ID,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    user: {
      id: ADMIN_USER_ID,
      email: 'admin@asraacademy.in',
      fullName: 'ASRA Administrator',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: [
        {
          role: {
            key: roleKey,
            permissions: permissions.map((key) => ({ permission: { key } })),
          },
        },
      ],
    },
  };
}

let server: Server;
let baseUrl: string;

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([disconnectPrisma(), disconnectRedis()]);
});

describe('Production Bug Regressions — Certificates & Recruitment Resumes', () => {
  it('streams in-memory template sample PNG and PDF with correct headers and rejects duplicated /api/v1/api/v1 paths', async (t) => {
    stubDelegateMethod(t, prisma.authSession, 'findUnique', (async () =>
      buildMockSession([
        PERMISSIONS.CERTIFICATES_VIEW,
        PERMISSIONS.CERTIFICATES_TEMPLATES_MANAGE,
      ])) as unknown as typeof prisma.authSession.findUnique);
    stubDelegateMethod(t, prisma.certificateTemplate, 'findMany', (async () =>
      INITIAL_CERTIFICATE_TEMPLATES.map((tpl, idx) => ({
        id: idx === 0 ? TEMPLATE_ID : `3a111111-1111-4111-8111-11111111111${idx + 2}`,
        key: tpl.key,
        isDefault: tpl.isDefault,
      }))) as unknown as typeof prisma.certificateTemplate.findMany);
    stubDelegateMethod(t, prisma.certificateSettings, 'findUnique', (async () => ({
      id: 'default',
    })) as unknown as typeof prisma.certificateSettings.findUnique);
    stubDelegateMethod(t, prisma.certificateTemplate, 'findUnique', (async () => ({
      id: TEMPLATE_ID,
      key: 'classic-institutional',
      name: 'Classic Institutional',
      style: 'CLASSIC_INSTITUTIONAL',
      description: 'Traditional academic certificate',
      defaultTitle: 'CERTIFICATE OF COMPLETION',
      defaultSubtitle: 'Academy of Islamic & Contemporary Studies',
      defaultBodyText: 'has successfully completed the curriculum and all required assessments',
      issuingAuthority: 'ASRA Academy',
      config: {
        accentColor: '#034729',
        secondaryColor: '#C88717',
        showLogo: true,
        showSeal: true,
        showQrCode: true,
        showCompletionDate: true,
        showIssueDate: true,
        showCertificateNumber: true,
        showSourceLabel: false,
        footerNote: null,
      },
      isActive: true,
      isDefault: true,
      version: 1,
      signatures: [],
      _count: { certificates: 0 },
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
    })) as unknown as typeof prisma.certificateTemplate.findUnique);

    const token = await tokenService.signAccessToken({
      sub: ADMIN_USER_ID,
      sid: ADMIN_SESSION_ID,
    });

    // Duplicated /api/v1/api/v1 path must 404 (confirms why the frontend bug failed in production)
    const duplicateRes = await fetch(
      `${baseUrl}/api/v1/api/v1/admin/certificates/templates/${TEMPLATE_ID}/preview`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(duplicateRes.status, 404);

    // Valid PDF preview endpoint renders dynamically in memory with exact headers
    const pdfRes = await fetch(
      `${baseUrl}/api/v1/admin/certificates/templates/${TEMPLATE_ID}/preview`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    assert.equal(
      pdfRes.headers.get('content-disposition'),
      'inline; filename="ASRA-Template-classic-institutional-Preview.pdf"',
    );
    assert.equal(pdfRes.headers.get('cache-control'), 'no-store');
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    assert.ok(pdfBuf.subarray(0, 5).equals(Buffer.from('%PDF-')));

    // Valid PNG preview endpoint renders dynamically in memory with exact headers
    const pngRes = await fetch(
      `${baseUrl}/api/v1/admin/certificates/templates/${TEMPLATE_ID}/preview/png`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('content-type'), 'image/png');
    assert.equal(
      pngRes.headers.get('content-disposition'),
      'inline; filename="ASRA-Template-classic-institutional-Preview.png"',
    );
    assert.equal(pngRes.headers.get('cache-control'), 'no-store');
    const pngBuf = Buffer.from(await pngRes.arrayBuffer());
    assert.equal(pngBuf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const meta = await sharp(pngBuf).metadata();
    assert.equal(meta.width, 1684);
    assert.equal(meta.height, 1190);
  });

  it('streams admin and student issued certificate PDFs & PNGs in memory with attachment headers', async (t) => {
    const certId = '4b111111-1111-4111-8111-111111111111';
    const studentId = '5c111111-1111-4111-8111-111111111111';
    const studentSessionId = '6d111111-1111-4111-8111-111111111111';

    stubDelegateMethod(t, prisma.certificate, 'findUnique', (async () => ({
      id: certId,
      certificateNumber: 'ASRA-2026-DEMO-1234',
      enrollmentId: null,
      userId: studentId,
      courseId: null,
      academyQuizId: null,
      examinationId: null,
      sourceType: 'COURSE',
      sourceReferenceId: null,
      sourceLabel: 'Course',
      templateId: TEMPLATE_ID,
      recipientName: 'Fatima Zahra',
      recipientEmail: 'fatima@example.com',
      recipientStudentCode: 'ASRA-STU-001',
      certificateTitle: 'CERTIFICATE OF COMPLETION',
      courseTitle: 'Classical Arabic Level 1',
      description: 'has successfully completed the course',
      achievementDetails: null,
      completedAt: new Date('2026-10-15T00:00:00Z'),
      issuedAt: new Date('2026-10-16T00:00:00Z'),
      status: 'ISSUED',
      revokedAt: null,
      revokedReason: null,
      metadata: null,
      templateSnapshot: null,
      signatureSnapshots: DEFAULT_FALLBACK_SIGNATURES,
      reissuedFromId: null,
      reissues: [],
    })) as unknown as typeof prisma.certificate.findUnique);

    // 1. Admin download (PNG & PDF)
    stubDelegateMethod(t, prisma.authSession, 'findUnique', (async () =>
      buildMockSession(
        [PERMISSIONS.CERTIFICATES_VIEW],
        'ADMIN',
      )) as unknown as typeof prisma.authSession.findUnique);
    const adminToken = await tokenService.signAccessToken({
      sub: ADMIN_USER_ID,
      sid: ADMIN_SESSION_ID,
    });

    const adminPdfRes = await fetch(`${baseUrl}/api/v1/admin/certificates/${certId}/download/pdf`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminPdfRes.status, 200);
    assert.equal(adminPdfRes.headers.get('content-type'), 'application/pdf');
    assert.equal(
      adminPdfRes.headers.get('content-disposition'),
      'attachment; filename="ASRA-Certificate-ASRA-2026-DEMO-1234.pdf"',
    );
    assert.equal(adminPdfRes.headers.get('cache-control'), 'no-store');
    assert.ok(
      Buffer.from(await adminPdfRes.arrayBuffer())
        .subarray(0, 5)
        .equals(Buffer.from('%PDF-')),
    );

    const adminPngRes = await fetch(`${baseUrl}/api/v1/admin/certificates/${certId}/download/png`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminPngRes.status, 200);
    assert.equal(adminPngRes.headers.get('content-type'), 'image/png');
    assert.equal(
      adminPngRes.headers.get('content-disposition'),
      'attachment; filename="ASRA-Certificate-ASRA-2026-DEMO-1234.png"',
    );

    // 2. Student download (PNG & PDF)
    stubDelegateMethod(t, prisma.authSession, 'findUnique', (async () => ({
      ...buildMockSession([PERMISSIONS.CONTENT_VIEW_ENROLLED], 'STUDENT'),
      id: studentSessionId,
      userId: studentId,
      user: {
        ...buildMockSession([PERMISSIONS.CONTENT_VIEW_ENROLLED], 'STUDENT').user,
        id: studentId,
      },
    })) as unknown as typeof prisma.authSession.findUnique);
    const studentToken = await tokenService.signAccessToken({
      sub: studentId,
      sid: studentSessionId,
    });

    const stuPdfRes = await fetch(`${baseUrl}/api/v1/student/certificates/${certId}/download/pdf`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(stuPdfRes.status, 200);
    assert.equal(stuPdfRes.headers.get('content-type'), 'application/pdf');

    const stuPngRes = await fetch(`${baseUrl}/api/v1/student/certificates/${certId}/download/png`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.equal(stuPngRes.status, 200);
    assert.equal(stuPngRes.headers.get('content-type'), 'image/png');
  });

  it('streams recruitment resume PDF with original filename, enforces RBAC, and surfaces 503 when upstream storage blocks delivery', async (t) => {
    const token = await tokenService.signAccessToken({
      sub: ADMIN_USER_ID,
      sid: ADMIN_SESSION_ID,
    });

    // Unauthenticated requests are rejected with 401
    const anonRes = await fetch(
      `${baseUrl}/api/v1/admin/recruitment/applications/${APPLICATION_ID}/resume`,
    );
    assert.equal(anonRes.status, 401);

    // Authenticated user without RECRUITMENT_MANAGE is rejected with 403
    stubDelegateMethod(t, prisma.authSession, 'findUnique', (async () =>
      buildMockSession(
        [PERMISSIONS.CERTIFICATES_VIEW],
        'CONTENT_ADMIN',
      )) as unknown as typeof prisma.authSession.findUnique);
    const forbiddenRes = await fetch(
      `${baseUrl}/api/v1/admin/recruitment/applications/${APPLICATION_ID}/resume`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(forbiddenRes.status, 403);

    // Authorized admin downloads stored resume PDF cleanly
    stubDelegateMethod(t, prisma.authSession, 'findUnique', (async () =>
      buildMockSession(
        [PERMISSIONS.RECRUITMENT_MANAGE],
        'ADMIN',
      )) as unknown as typeof prisma.authSession.findUnique);
    stubDelegateMethod(t, prisma.jobApplication, 'findUnique', (async () => ({
      resumeAssetId: 'resume_0123456789abcdef0123456789abcdef.pdf',
      resumeOriginalName: 'inbound2374569990595114549.pdf',
      resumeMimeType: 'application/pdf',
    })) as unknown as typeof prisma.jobApplication.findUnique);

    const storageAny = resumeStorageService as unknown as {
      cloudinaryCloudName?: string;
      cloudinaryApiKey?: string;
      cloudinaryApiSecret?: string;
      isProduction: boolean;
      fetchImpl: typeof fetch;
    };
    const prevStorageState = {
      cloudinaryCloudName: storageAny.cloudinaryCloudName,
      cloudinaryApiKey: storageAny.cloudinaryApiKey,
      cloudinaryApiSecret: storageAny.cloudinaryApiSecret,
      isProduction: storageAny.isProduction,
      fetchImpl: storageAny.fetchImpl,
    };

    try {
      storageAny.cloudinaryCloudName = 'asra-prod-cloud';
      storageAny.cloudinaryApiKey = 'key-123';
      storageAny.cloudinaryApiSecret = 'secret-123';
      storageAny.isProduction = true;
      storageAny.fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (
          url ===
          'https://res.cloudinary.com/asra-prod-cloud/raw/upload/resume_0123456789abcdef0123456789abcdef'
        ) {
          return new Response(VALID_PDF, {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'content-length': String(VALID_PDF.length),
            },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof fetch;

      const okRes = await fetch(
        `${baseUrl}/api/v1/admin/recruitment/applications/${APPLICATION_ID}/resume`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(okRes.status, 200);
      assert.equal(okRes.headers.get('content-type'), 'application/pdf');
      assert.equal(
        okRes.headers.get('content-disposition'),
        'inline; filename="inbound2374569990595114549.pdf"',
      );
      assert.equal(okRes.headers.get('cache-control'), 'private, no-cache, no-store');
      const bodyBuf = Buffer.from(await okRes.arrayBuffer());
      assert.ok(bodyBuf.equals(VALID_PDF));

      // When Cloudinary blocks PDF delivery (401/403), API returns 503 rather than an inaccurate 404
      storageAny.fetchImpl = (async () =>
        new Response('Unauthorized', { status: 401 })) as typeof fetch;
      const blockedRes = await fetch(
        `${baseUrl}/api/v1/admin/recruitment/applications/${APPLICATION_ID}/resume`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(blockedRes.status, 503);
    } finally {
      Object.assign(storageAny, prevStorageState);
    }

    // Missing resume in DB still returns 404
    stubDelegateMethod(
      t,
      prisma.jobApplication,
      'findUnique',
      (async () => null) as unknown as typeof prisma.jobApplication.findUnique,
    );
    const missingRes = await fetch(
      `${baseUrl}/api/v1/admin/recruitment/applications/${APPLICATION_ID}/resume`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(missingRes.status, 404);
  });

  it('keeps AppError codes consistent across resume stream failures', () => {
    const err = new AppError('SERVICE_UNAVAILABLE', 'Blocked');
    assert.equal(err.statusCode, 503);
  });
});
