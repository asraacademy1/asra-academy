/**
 * Resume Storage & Cloudinary Integration Tests (Unit; no external network).
 * Covers Cloudinary credential initialization, production enforcement,
 * fail-safe error handling, local storage compatibility, and JWT upload token validation.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ResumeStorageService } from '../src/modules/recruitment/resume-storage.service.js';
import { AppError } from '../src/utils/app-error.js';

const VALID_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF',
);

const MOCK_CREDENTIALS = {
  cloudinaryCloudName: 'test-cloud',
  cloudinaryApiKey: '123456789012345',
  cloudinaryApiSecret: 'test_api_secret_key_123',
  jwtSecret: 'test-valid-jwt-signing-secret-32-chars-minimum',
};

function createMockFetch(response: { status: number; body?: string; ok?: boolean }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(response.body ?? '{}', {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe('ResumeStorageService — Cloudinary & Storage Enforcement', () => {
  it('correctly reports Cloudinary as configured when all credentials are provided', () => {
    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      isProduction: false,
    });
    assert.equal(service.isCloudinaryConfigured(), true);
  });

  it('reports Cloudinary as not configured when any credential is missing or empty', () => {
    for (const key of ['cloudinaryCloudName', 'cloudinaryApiKey', 'cloudinaryApiSecret'] as const) {
      const service = new ResumeStorageService({
        ...MOCK_CREDENTIALS,
        [key]: '',
        isProduction: false,
      });
      assert.equal(service.isCloudinaryConfigured(), false, `expected false when ${key} is empty`);
    }
  });

  it('fails safely with a clear configuration error when production has no Cloudinary credentials', async () => {
    const service = new ResumeStorageService({
      cloudinaryCloudName: '',
      cloudinaryApiKey: '',
      cloudinaryApiSecret: '',
      jwtSecret: MOCK_CREDENTIALS.jwtSecret,
      isProduction: true,
    });

    await assert.rejects(
      () => service.storeResume(VALID_PDF, 'cv.pdf'),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INTERNAL_ERROR');
        assert.match(err.message, /Cloud storage is required in production/i);
        return true;
      },
    );
  });

  it('uploads to Cloudinary with raw upload URL and signed payload in production', async () => {
    const { impl: mockFetch, calls } = createMockFetch({
      status: 200,
      body: JSON.stringify({ secure_url: 'https://cloudinary.test/cv.pdf' }),
    });

    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      isProduction: true,
      fetchImpl: mockFetch,
    });

    const result = await service.storeResume(VALID_PDF, 'candidate_resume.pdf');

    assert.equal(result.storageProvider, 'cloudinary');
    assert.match(result.assetId, /^resume_[a-f0-9]+\.pdf$/);
    assert.equal(result.mimeType, 'application/pdf');
    assert.equal(result.fileSize, VALID_PDF.length);
    assert.ok(result.uploadToken.length > 0);

    // Verify Cloudinary endpoint was called
    assert.equal(calls.length, 1);
    const firstCall = calls[0];
    assert.ok(firstCall);
    assert.equal(
      firstCall.url,
      `https://api.cloudinary.com/v1_1/${MOCK_CREDENTIALS.cloudinaryCloudName}/raw/upload`,
    );
    assert.equal(firstCall.init?.method, 'POST');
    assert.ok(firstCall.init?.body instanceof FormData);
    const uploadedPublicId = firstCall.init.body.get('public_id');
    assert.equal(
      uploadedPublicId,
      result.assetId,
      'Cloudinary raw upload public_id must retain the .pdf extension',
    );
    assert.equal(
      firstCall.init.body.get('type'),
      'private',
      'New applicant resumes must be uploaded as private Cloudinary assets',
    );
    const uploadedTimestamp = String(firstCall.init.body.get('timestamp'));
    const expectedSig = crypto
      .createHash('sha1')
      .update(
        `folder=asra_recruitment_resumes&public_id=${result.assetId}&timestamp=${uploadedTimestamp}&type=private${MOCK_CREDENTIALS.cloudinaryApiSecret}`,
      )
      .digest('hex');
    assert.equal(firstCall.init.body.get('signature'), expectedSig);
  });

  it('retrieves private resumes via server-side signed /raw/download API and supports legacy Fixed/Dynamic Folder formats', async () => {
    const assetId = 'resume_0123456789abcdef0123456789abcdef.pdf';
    const baseName = 'resume_0123456789abcdef0123456789abcdef';

    const matchers: {
      label: string;
      matches: (url: URL) => boolean;
    }[] = [
      {
        label: 'private Fixed-Folder via /raw/download',
        matches: (u) =>
          u.origin === 'https://api.cloudinary.com' &&
          u.pathname === `/v1_1/${MOCK_CREDENTIALS.cloudinaryCloudName}/raw/download` &&
          u.searchParams.get('type') === 'private' &&
          u.searchParams.get('public_id') === `asra_recruitment_resumes/${assetId}` &&
          u.searchParams.get('api_key') === MOCK_CREDENTIALS.cloudinaryApiKey &&
          Boolean(u.searchParams.get('signature')) &&
          Boolean(u.searchParams.get('expires_at')),
      },
      {
        label: 'private Dynamic-Folder via /raw/download',
        matches: (u) =>
          u.origin === 'https://api.cloudinary.com' &&
          u.pathname === `/v1_1/${MOCK_CREDENTIALS.cloudinaryCloudName}/raw/download` &&
          u.searchParams.get('type') === 'private' &&
          u.searchParams.get('public_id') === assetId,
      },
      {
        label: 'legacy upload extensionless Fixed-Folder via /raw/download',
        matches: (u) =>
          u.origin === 'https://api.cloudinary.com' &&
          u.pathname === `/v1_1/${MOCK_CREDENTIALS.cloudinaryCloudName}/raw/download` &&
          u.searchParams.get('type') === 'upload' &&
          u.searchParams.get('public_id') === `asra_recruitment_resumes/${baseName}`,
      },
      {
        label: 'legacy upload extensionless Dynamic-Folder via /raw/download',
        matches: (u) =>
          u.origin === 'https://api.cloudinary.com' &&
          u.pathname === `/v1_1/${MOCK_CREDENTIALS.cloudinaryCloudName}/raw/download` &&
          u.searchParams.get('type') === 'upload' &&
          u.searchParams.get('public_id') === baseName,
      },
      {
        label: 'legacy upload extensionless Fixed-Folder CDN fallback',
        matches: (u) =>
          u.href ===
          `https://res.cloudinary.com/${MOCK_CREDENTIALS.cloudinaryCloudName}/raw/upload/asra_recruitment_resumes/${baseName}`,
      },
      {
        label: 'legacy upload extensionless Dynamic-Folder CDN fallback',
        matches: (u) =>
          u.href ===
          `https://res.cloudinary.com/${MOCK_CREDENTIALS.cloudinaryCloudName}/raw/upload/${baseName}`,
      },
    ];

    for (const testCase of matchers) {
      let matched = false;
      const mockFetch = (async (input: string | URL | Request) => {
        const parsed = new URL(String(input));
        if (testCase.matches(parsed)) {
          matched = true;
          return new Response(VALID_PDF, {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'content-length': String(VALID_PDF.length),
            },
          });
        }
        return new Response('Not found', { status: 404 });
      }) as typeof fetch;

      const service = new ResumeStorageService({
        ...MOCK_CREDENTIALS,
        isProduction: true,
        fetchImpl: mockFetch,
      });

      const result = await service.getResumeStream(assetId);
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(Buffer.from(chunk));
      }
      assert.equal(Buffer.concat(chunks).toString(), VALID_PDF.toString(), testCase.label);
      assert.equal(result.fileSize, VALID_PDF.length, testCase.label);
      assert.equal(matched, true, `Expected matcher to hit: ${testCase.label}`);
    }
  });

  it('surfaces SERVICE_UNAVAILABLE (not fake NOT_FOUND) when Cloudinary blocks delivery with 401/403', async () => {
    const assetId = 'resume_blocked_pdf_delivery_test.pdf';
    const mockFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/raw/upload/asra_recruitment_resumes/resume_blocked_pdf_delivery_test')) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'x-cld-error': 'deny or ACL failure' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      isProduction: true,
      fetchImpl: mockFetch,
    });

    await assert.rejects(
      () => service.getResumeStream(assetId),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SERVICE_UNAVAILABLE');
        assert.match(err.message, /Cloudinary PDF delivery/i);
        return true;
      },
    );
  });

  it('rejects path traversal assetIds without requesting Cloudinary or reading parent directories', async () => {
    const { impl: mockFetch, calls } = createMockFetch({ status: 200, body: 'leak' });
    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      isProduction: true,
      fetchImpl: mockFetch,
    });

    await assert.rejects(
      () => service.getResumeStream('../etc/passwd'),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'NOT_FOUND');
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it('handles Cloudinary upload HTTP errors safely in production without falling back to local disk', async () => {
    const { impl: mockFetch } = createMockFetch({ status: 500, body: 'Internal Cloudinary Error' });

    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      isProduction: true,
      fetchImpl: mockFetch,
    });

    await assert.rejects(
      () => service.storeResume(VALID_PDF, 'cv.pdf'),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INTERNAL_ERROR');
        assert.match(err.message, /Cloud resume upload failed/i);
        return true;
      },
    );
  });

  it('handles Cloudinary network exceptions safely in production without falling back to local disk', async () => {
    const mockFetch = (async () => {
      throw new Error('Network connection timeout');
    }) as typeof fetch;

    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      isProduction: true,
      fetchImpl: mockFetch,
    });

    await assert.rejects(
      () => service.storeResume(VALID_PDF, 'cv.pdf'),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INTERNAL_ERROR');
        assert.match(err.message, /Cloud resume upload failed/i);
        return true;
      },
    );
  });

  it('refuses to read from local disk storage in production', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asra-resume-test-'));
    try {
      const assetId = 'resume_local_stored_test.pdf';
      fs.writeFileSync(path.join(tmpDir, assetId), VALID_PDF);

      // Cloudinary mock that returns 404
      const { impl: mockFetch } = createMockFetch({ status: 404, body: 'Not found' });

      const service = new ResumeStorageService({
        ...MOCK_CREDENTIALS,
        isProduction: true,
        localUploadsDir: tmpDir,
        fetchImpl: mockFetch,
      });

      // Must throw NOT_FOUND in production and refuse to serve the local file
      await assert.rejects(
        () => service.getResumeStream(assetId),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'NOT_FOUND');
          return true;
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports local filesystem storage in development when Cloudinary is not configured', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asra-resume-dev-'));
    const previousEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      const service = new ResumeStorageService({
        cloudinaryCloudName: '',
        cloudinaryApiKey: '',
        cloudinaryApiSecret: '',
        jwtSecret: MOCK_CREDENTIALS.jwtSecret,
        isProduction: false,
        localUploadsDir: tmpDir,
      });

      const result = await service.storeResume(VALID_PDF, 'dev_candidate.pdf');
      assert.equal(result.storageProvider, 'local');

      // Verify file exists on local disk
      const filePath = path.join(tmpDir, result.assetId);
      assert.ok(fs.existsSync(filePath));
      assert.equal(fs.readFileSync(filePath).length, VALID_PDF.length);

      // Verify getResumeStream reads it back
      const streamResult = await service.getResumeStream(result.assetId);
      assert.equal(streamResult.fileSize, VALID_PDF.length);
      const chunks: Buffer[] = [];
      for await (const chunk of streamResult.stream) {
        chunks.push(Buffer.from(chunk));
      }
      assert.equal(Buffer.concat(chunks).length, VALID_PDF.length);
    } finally {
      process.env.NODE_ENV = previousEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates PDF buffer integrity, rejecting empty or non-PDF files', async () => {
    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      isProduction: false,
    });

    // Empty buffer
    await assert.rejects(
      () => service.storeResume(Buffer.alloc(0), 'empty.pdf'),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.match(err.message, /empty/i);
        return true;
      },
    );

    // Non-PDF extension
    await assert.rejects(
      () => service.storeResume(VALID_PDF, 'document.docx'),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.match(err.message, /Only PDF/i);
        return true;
      },
    );

    // Missing %PDF- magic bytes
    const fakePdf = Buffer.from('NOT-A-PDF-FILE-HEADER');
    await assert.rejects(
      () => service.storeResume(fakePdf, 'fake.pdf'),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.match(err.message, /mismatch/i);
        return true;
      },
    );
  });
});

describe('ResumeStorageService — JWT Secret & Upload Token Signing', () => {
  it('signs and verifies upload tokens using the centrally configured JWT secret', () => {
    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      isProduction: false,
    });

    const assetId = 'resume_1234567890abcdef.pdf';
    const fileSize = 1024;
    const token = service.createUploadToken(assetId, fileSize);

    // Token format: assetId:fileSize:hmac
    const parts = token.split(':');
    assert.equal(parts.length, 3);
    const [tokenAssetId, tokenFileSize, tokenHmac] = parts;
    assert.equal(tokenAssetId, assetId);
    assert.equal(tokenFileSize, String(fileSize));
    assert.ok(tokenHmac);
    assert.equal(tokenHmac.length, 64); // SHA-256 hex digest

    // Verification succeeds with matching parameters
    assert.equal(service.verifyUploadToken(token, assetId, fileSize), true);

    // Verification fails if assetId or fileSize differs
    assert.equal(service.verifyUploadToken(token, 'other_asset.pdf', fileSize), false);
    assert.equal(service.verifyUploadToken(token, assetId, 2048), false);

    // Verification fails if HMAC signature is tampered
    const tamperedToken = `${assetId}:${fileSize}:${'0'.repeat(64)}`;
    assert.equal(service.verifyUploadToken(tamperedToken, assetId, fileSize), false);
  });

  it('fails safely when JWT_SECRET is missing or empty, with no hardcoded fallback', () => {
    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      jwtSecret: '',
      isProduction: false,
    });

    assert.throws(
      () => service.createUploadToken('resume_1.pdf', 500),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INTERNAL_ERROR');
        assert.match(err.message, /JWT_SECRET is required/i);
        return true;
      },
    );

    assert.throws(
      () => service.verifyUploadToken('resume_1.pdf:500:abcd', 'resume_1.pdf', 500),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INTERNAL_ERROR');
        assert.match(err.message, /JWT_SECRET is required/i);
        return true;
      },
    );
  });

  it('proves that the old hardcoded fallback secret is rejected and not used', () => {
    const oldHardcodedSecret = 'recruitment-resume-upload-secret-32-chars';
    const assetId = 'resume_test_fallback.pdf';
    const fileSize = 1024;

    // Forge a token signed with the old hardcoded fallback secret
    const payload = `${assetId}:${fileSize}`;
    const forgedHmac = crypto
      .createHmac('sha256', oldHardcodedSecret)
      .update(payload)
      .digest('hex');
    const forgedToken = `${payload}:${forgedHmac}`;

    const service = new ResumeStorageService({
      ...MOCK_CREDENTIALS,
      jwtSecret: 'a-totally-different-production-jwt-secret-minimum-32-chars',
      isProduction: false,
    });

    // Verification must fail — proving no silent fallback to the hardcoded string
    assert.equal(service.verifyUploadToken(forgedToken, assetId, fileSize), false);
  });
});
