import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../utils/app-error.js';
import { cloudinarySignature } from '../assessments/media/image-store.js';

export const MAX_RESUME_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const PDF_MAGIC_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // '%PDF-'

export interface StoredResumeMetadata {
  assetId: string;
  originalName: string;
  mimeType: 'application/pdf';
  fileSize: number;
  storageProvider: 'cloudinary' | 'local';
}

export interface UploadResumeResult extends StoredResumeMetadata {
  uploadToken: string;
}

export interface ResumeStorageOptions {
  cloudinaryCloudName?: string;
  cloudinaryApiKey?: string;
  cloudinaryApiSecret?: string;
  jwtSecret?: string;
  isProduction?: boolean;
  localUploadsDir?: string;
  fetchImpl?: typeof fetch;
}

export class ResumeStorageService {
  private localUploadsDir: string;
  private cloudinaryCloudName?: string;
  private cloudinaryApiKey?: string;
  private cloudinaryApiSecret?: string;
  private jwtSecret?: string;
  private isProduction: boolean;
  private fetchImpl: typeof fetch;
  private inMemoryResumes: Map<string, { buffer: Buffer; metadata: StoredResumeMetadata }> =
    new Map();

  constructor(options: ResumeStorageOptions = {}) {
    this.cloudinaryCloudName = options.cloudinaryCloudName ?? env.CLOUDINARY_CLOUD_NAME;
    this.cloudinaryApiKey = options.cloudinaryApiKey ?? env.CLOUDINARY_API_KEY;
    this.cloudinaryApiSecret = options.cloudinaryApiSecret ?? env.CLOUDINARY_API_SECRET;
    this.jwtSecret = options.jwtSecret ?? env.JWT_SECRET;
    this.isProduction = options.isProduction ?? env.isProduction;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.localUploadsDir =
      options.localUploadsDir ?? path.resolve(process.cwd(), 'storage', 'resumes');

    // Ensure storage directory exists if using local storage (development only)
    if (!this.isProduction && process.env.NODE_ENV !== 'test') {
      try {
        if (!fs.existsSync(this.localUploadsDir)) {
          fs.mkdirSync(this.localUploadsDir, { recursive: true });
        }
      } catch (err) {
        logger.warn({ err }, 'Could not create local resume storage directory');
      }
    }
  }

  public isCloudinaryConfigured(): boolean {
    const cloudName = this.cloudinaryCloudName?.trim();
    const apiKey = this.cloudinaryApiKey?.trim();
    const apiSecret = this.cloudinaryApiSecret?.trim();
    return Boolean(cloudName && apiKey && apiSecret);
  }

  /**
   * Validates a buffer is a genuine, well-formed PDF file within size constraints.
   */
  public validatePdfBuffer(buffer: Buffer, originalFilename: string): void {
    if (buffer.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'Uploaded resume file is empty');
    }

    if (buffer.length > MAX_RESUME_SIZE_BYTES) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Resume file size exceeds the maximum limit of ${MAX_RESUME_SIZE_BYTES / (1024 * 1024)}MB`,
      );
    }

    const ext = path.extname(originalFilename).toLowerCase();
    if (ext !== '.pdf') {
      throw new AppError('VALIDATION_ERROR', 'Only PDF resume files (.pdf) are accepted');
    }

    // Verify magic header %PDF-
    if (buffer.length < 5 || !buffer.subarray(0, 5).equals(PDF_MAGIC_BYTES)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Invalid or corrupted PDF file. File header signature mismatch',
      );
    }
  }

  /**
   * Generates a tamper-proof upload token using HMAC with the centrally validated JWT_SECRET.
   */
  public createUploadToken(assetId: string, fileSize: number): string {
    const secret = this.jwtSecret?.trim();
    if (!secret) {
      throw new AppError('INTERNAL_ERROR', 'JWT_SECRET is required for resume token signing');
    }
    const payload = `${assetId}:${fileSize}`;
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `${payload}:${hmac}`;
  }

  /**
   * Verifies an upload token using the centrally validated JWT_SECRET.
   */
  public verifyUploadToken(token: string, assetId: string, fileSize: number): boolean {
    const secret = this.jwtSecret?.trim();
    if (!secret) {
      throw new AppError('INTERNAL_ERROR', 'JWT_SECRET is required for resume token verification');
    }
    const parts = token.split(':');
    if (parts.length !== 3) return false;
    const [tAssetId, tFileSize, hmac] = parts;
    if (!tAssetId || !tFileSize || !hmac) return false;
    if (tAssetId !== assetId || Number(tFileSize) !== fileSize) return false;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${tAssetId}:${tFileSize}`)
      .digest('hex');
    if (hmac.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
  }

  /**
   * Stores a PDF resume buffer.
   */
  public async storeResume(buffer: Buffer, originalFilename: string): Promise<UploadResumeResult> {
    this.validatePdfBuffer(buffer, originalFilename);

    const safeId = `resume_${crypto.randomUUID().replace(/-/g, '')}.pdf`;
    const safeOriginalName = path.basename(originalFilename).replace(/[^\w.-]/g, '_');
    const fileSize = buffer.length;

    // Production strictly requires Cloudinary storage. Never fall back to local disk in production.
    if (this.isProduction && !this.isCloudinaryConfigured()) {
      logger.error(
        'Resume upload refused: Cloudinary storage is required in production but not configured',
      );
      throw new AppError(
        'INTERNAL_ERROR',
        'Cloud storage is required in production but not configured',
      );
    }

    // Cloudinary upload if configured
    if (this.isCloudinaryConfigured()) {
      try {
        const cloudName = this.cloudinaryCloudName!.trim();
        const apiKey = this.cloudinaryApiKey!.trim();
        const apiSecret = this.cloudinaryApiSecret!.trim();
        const timestamp = Math.floor(Date.now() / 1000);
        const folder = 'asra_recruitment_resumes';
        // Cloudinary `raw` assets treat the file extension as part of `public_id`.
        const publicId = safeId;
        // Store new applicant resumes with `private` delivery type so unauthenticated CDN URLs
        // can never serve candidate PII directly.
        const deliveryType = 'private';

        const signature = cloudinarySignature(
          {
            folder,
            public_id: publicId,
            timestamp: String(timestamp),
            type: deliveryType,
          },
          apiSecret,
        );

        const formData = new FormData();
        formData.append('file', new Blob([buffer], { type: 'application/pdf' }), safeOriginalName);
        formData.append('api_key', apiKey);
        formData.append('timestamp', String(timestamp));
        formData.append('folder', folder);
        formData.append('public_id', publicId);
        formData.append('type', deliveryType);
        formData.append('signature', signature);

        const response = await this.fetchImpl(
          `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`,
          {
            method: 'POST',
            body: formData,
          },
        );

        if (!response.ok) {
          const errText = await response.text();
          logger.error({ status: response.status, errText }, 'Cloudinary upload failed');
          throw new AppError('INTERNAL_ERROR', 'Cloud resume upload failed');
        }

        const metadata: StoredResumeMetadata = {
          assetId: safeId,
          originalName: safeOriginalName,
          mimeType: 'application/pdf',
          fileSize,
          storageProvider: 'cloudinary',
        };

        const uploadToken = this.createUploadToken(safeId, fileSize);
        return { ...metadata, uploadToken };
      } catch (err) {
        if (this.isProduction) {
          logger.error({ err }, 'Error uploading resume to Cloudinary in production');
          if (err instanceof AppError) throw err;
          throw new AppError('INTERNAL_ERROR', 'Cloud resume upload failed');
        }
        logger.warn(
          { err },
          'Error uploading to Cloudinary in non-production, falling back to local',
        );
        if (err instanceof AppError) throw err;
      }
    }

    // Guard: production must never write to local disk
    if (this.isProduction) {
      throw new AppError('INTERNAL_ERROR', 'Cloud storage is required in production');
    }

    // Local / In-memory storage fallback (development and test only)
    if (process.env.NODE_ENV === 'test') {
      const metadata: StoredResumeMetadata = {
        assetId: safeId,
        originalName: safeOriginalName,
        mimeType: 'application/pdf',
        fileSize,
        storageProvider: 'local',
      };
      this.inMemoryResumes.set(safeId, { buffer, metadata });
      const uploadToken = this.createUploadToken(safeId, fileSize);
      return { ...metadata, uploadToken };
    }

    // Save to disk (development only)
    const targetPath = path.join(this.localUploadsDir, safeId);
    await fs.promises.writeFile(targetPath, buffer);

    const metadata: StoredResumeMetadata = {
      assetId: safeId,
      originalName: safeOriginalName,
      mimeType: 'application/pdf',
      fileSize,
      storageProvider: 'local',
    };

    const uploadToken = this.createUploadToken(safeId, fileSize);
    return { ...metadata, uploadToken };
  }

  /**
   * Builds candidate Cloudinary `public_id` values for a stored `raw` resume asset.
   * Covers both legacy uploads (where `.pdf` was stripped from `public_id`) and `.pdf`-suffixed
   * uploads, across both Fixed Folder (`folder/public_id`) and Dynamic Folder (`public_id`
   * without the folder prefix) Cloudinary environments.
   */
  public buildCandidatePublicIds(assetId: string): string[] {
    const cleanId = assetId.trim().replace(/^\/+/, '');
    if (
      !cleanId ||
      cleanId.includes('..') ||
      cleanId.includes('?') ||
      cleanId.includes('#') ||
      cleanId.includes('\\')
    ) {
      return [];
    }
    const folderPrefix = 'asra_recruitment_resumes/';
    const withoutFolder = cleanId.startsWith(folderPrefix)
      ? cleanId.slice(folderPrefix.length)
      : cleanId;
    const baseName = withoutFolder.replace(/\.pdf$/i, '');
    const pdfName = `${baseName}.pdf`;

    const candidatePublicIds = [
      `asra_recruitment_resumes/${pdfName}`,
      pdfName,
      `asra_recruitment_resumes/${baseName}`,
      baseName,
    ];

    return [...new Set(candidatePublicIds)];
  }

  /**
   * Builds legacy unauthenticated CDN URLs for historical `type: 'upload'` assets.
   * Only fetched server-side after admin authentication & RBAC checks.
   */
  public buildCloudinaryResumeUrls(cloudName: string, assetId: string): string[] {
    const publicIds = this.buildCandidatePublicIds(assetId);
    // For legacy `upload` assets, prioritize extensionless historical paths first.
    const legacyOrdered = [
      ...publicIds.filter((id) => !id.toLowerCase().endsWith('.pdf')),
      ...publicIds.filter((id) => id.toLowerCase().endsWith('.pdf')),
    ];
    return legacyOrdered.map(
      (publicId) => `https://res.cloudinary.com/${cloudName}/raw/upload/${publicId}`,
    );
  }

  /**
   * Generates a short-lived signed server-side download URL targeting Cloudinary's authenticated
   * `/raw/download` API endpoint (`private_download_url` equivalent). Never expose this URL
   * to the browser.
   */
  public buildCloudinarySignedDownloadUrl(
    cloudName: string,
    apiKey: string,
    apiSecret: string,
    publicId: string,
    deliveryType: 'private' | 'upload' | 'authenticated',
    nowSeconds = Math.floor(Date.now() / 1000),
  ): string {
    const expiresAt = nowSeconds + 300;
    const params: Record<string, string> = {
      expires_at: String(expiresAt),
      public_id: publicId,
      timestamp: String(nowSeconds),
      type: deliveryType,
    };
    const signature = cloudinarySignature(params, apiSecret);
    const query = new URLSearchParams({
      ...params,
      api_key: apiKey,
      signature,
    });
    return `https://api.cloudinary.com/v1_1/${cloudName}/raw/download?${query.toString()}`;
  }

  /**
   * Retrieves a resume stream for authorized admin viewing / downloading.
   */
  public async getResumeStream(
    assetId: string,
  ): Promise<{ stream: Readable; fileSize: number; originalName: string }> {
    // Check in-memory first (tests)
    const inMem = this.inMemoryResumes.get(assetId);
    if (inMem) {
      return {
        stream: Readable.from(inMem.buffer),
        fileSize: inMem.metadata.fileSize,
        originalName: inMem.metadata.originalName,
      };
    }

    // Check Cloudinary if configured (server-side only; credentials/URLs are never sent to clients)
    if (this.isCloudinaryConfigured()) {
      const cloudName = this.cloudinaryCloudName!.trim();
      const apiKey = this.cloudinaryApiKey!.trim();
      const apiSecret = this.cloudinaryApiSecret!.trim();
      const candidatePublicIds = this.buildCandidatePublicIds(assetId);

      if (candidatePublicIds.length > 0) {
        const legacyFirstIds = [
          ...candidatePublicIds.filter((id) => !id.toLowerCase().endsWith('.pdf')),
          ...candidatePublicIds.filter((id) => id.toLowerCase().endsWith('.pdf')),
        ];

        const attempts: {
          url: string;
          publicId: string;
          deliveryType: 'private' | 'upload';
          channel: 'raw_download' | 'cdn';
        }[] = [
          // 1. New private uploads & migrated private assets via signed `/raw/download` API
          ...candidatePublicIds.map((publicId) => ({
            url: this.buildCloudinarySignedDownloadUrl(
              cloudName,
              apiKey,
              apiSecret,
              publicId,
              'private',
            ),
            publicId,
            deliveryType: 'private' as const,
            channel: 'raw_download' as const,
          })),
          // 2. Historical `upload` assets via signed `/raw/download` API
          ...legacyFirstIds.map((publicId) => ({
            url: this.buildCloudinarySignedDownloadUrl(
              cloudName,
              apiKey,
              apiSecret,
              publicId,
              'upload',
            ),
            publicId,
            deliveryType: 'upload' as const,
            channel: 'raw_download' as const,
          })),
          // 3. Fallback to server-side fetch of legacy `/raw/upload` delivery URLs
          ...legacyFirstIds.map((publicId) => ({
            url: `https://res.cloudinary.com/${cloudName}/raw/upload/${publicId}`,
            publicId,
            deliveryType: 'upload' as const,
            channel: 'cdn' as const,
          })),
        ];

        let blockedStatus: number | null = null;
        let upstreamStatus: number | null = null;

        for (const attempt of attempts) {
          try {
            const res = await this.fetchImpl(attempt.url);
            if (res.ok && res.body) {
              const stream = Readable.fromWeb(res.body as unknown as NodeReadableStream);
              const len = Number(res.headers.get('content-length')) || 0;
              return {
                stream,
                fileSize: len,
                originalName: assetId,
              };
            }
            await res.body?.cancel().catch(() => undefined);
            if (res.status === 401 || res.status === 403) {
              blockedStatus = res.status;
              logger.warn(
                {
                  status: res.status,
                  xCldError: res.headers.get('x-cld-error'),
                  publicId: attempt.publicId,
                  deliveryType: attempt.deliveryType,
                  channel: attempt.channel,
                  assetId,
                },
                'Cloudinary denied resume delivery (check Settings -> Security -> Allow delivery of PDF and ZIP files)',
              );
            } else if (res.status !== 404 && res.status !== 400) {
              upstreamStatus = res.status;
              logger.warn(
                {
                  status: res.status,
                  publicId: attempt.publicId,
                  deliveryType: attempt.deliveryType,
                  channel: attempt.channel,
                  assetId,
                },
                'Unexpected Cloudinary status fetching resume',
              );
            }
          } catch (err) {
            upstreamStatus = 502;
            logger.error(
              {
                err,
                publicId: attempt.publicId,
                deliveryType: attempt.deliveryType,
                channel: attempt.channel,
                assetId,
              },
              'Could not retrieve resume from Cloudinary',
            );
          }
        }

        if (blockedStatus !== null) {
          throw new AppError(
            'SERVICE_UNAVAILABLE',
            'Resume delivery was blocked by cloud storage permissions. Verify Cloudinary PDF delivery settings.',
          );
        }
        if (upstreamStatus !== null) {
          throw new AppError(
            'SERVICE_UNAVAILABLE',
            'Could not retrieve resume from cloud storage. Please try again.',
          );
        }
      }
    }

    // In production, do not check or serve from local disk
    if (this.isProduction) {
      throw new AppError('NOT_FOUND', 'Resume file not found');
    }

    // Check local filesystem (development only)
    const filePath = path.join(this.localUploadsDir, path.basename(assetId));
    if (fs.existsSync(filePath)) {
      const stat = await fs.promises.stat(filePath);
      const stream = fs.createReadStream(filePath);
      return {
        stream,
        fileSize: stat.size,
        originalName: path.basename(assetId),
      };
    }

    throw new AppError('NOT_FOUND', 'Resume file not found');
  }
}

export const resumeStorageService = new ResumeStorageService();
