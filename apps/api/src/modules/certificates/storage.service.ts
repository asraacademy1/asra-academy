import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CERTIFICATE_SIGNATURE_LIMITS } from '@asra/validation';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../utils/app-error.js';
import { cloudinarySignature } from '../assessments/media/image-store.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface SniffedSignaturePng {
  width: number;
  height: number;
  bytes: number;
  hasTransparency: boolean;
}

/**
 * Strictly validates an uploaded digital signature image from its binary bytes.
 * Only non-animated PNG files are accepted; transparent PNGs (RGBA, Grayscale+Alpha,
 * or indexed PNG with tRNS chunk) are detected and flagged so original signatures stay crisp.
 */
export function validateSignaturePng(buffer: Buffer, contentType?: string): SniffedSignaturePng {
  if (buffer.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Choose a PNG signature image to upload.');
  }
  if (buffer.length > CERTIFICATE_SIGNATURE_LIMITS.maxFileBytes) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Signature PNG is ${Math.ceil(buffer.length / 1024)} KB; maximum allowed is ${CERTIFICATE_SIGNATURE_LIMITS.maxFileBytes / 1024} KB.`,
    );
  }
  if (contentType) {
    const normalized = contentType.split(';')[0]!.trim().toLowerCase();
    if (normalized !== 'image/png' && normalized !== 'application/octet-stream') {
      throw new AppError(
        'VALIDATION_ERROR',
        'Only transparent PNG signature files (.png) are accepted.',
      );
    }
  }
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new AppError('VALIDATION_ERROR', 'Invalid image format. Upload a valid PNG file.');
  }
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new AppError('VALIDATION_ERROR', 'Corrupted PNG header.');
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25]!;

  if (
    width < CERTIFICATE_SIGNATURE_LIMITS.minWidth ||
    height < CERTIFICATE_SIGNATURE_LIMITS.minHeight ||
    width > CERTIFICATE_SIGNATURE_LIMITS.maxWidth ||
    height > CERTIFICATE_SIGNATURE_LIMITS.maxHeight
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Signature dimensions (${width}×${height}px) must be between ${CERTIFICATE_SIGNATURE_LIMITS.minWidth}×${CERTIFICATE_SIGNATURE_LIMITS.minHeight}px and ${CERTIFICATE_SIGNATURE_LIMITS.maxWidth}×${CERTIFICATE_SIGNATURE_LIMITS.maxHeight}px.`,
    );
  }

  let animated = false;
  let hasTrns = false;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (type === 'acTL') animated = true;
    if (type === 'tRNS') hasTrns = true;
    if (type === 'IEND') break;
    if (length > buffer.length - offset - 12) {
      throw new AppError('VALIDATION_ERROR', 'Truncated PNG data.');
    }
    offset += 12 + length;
  }

  if (animated) {
    throw new AppError('VALIDATION_ERROR', 'Animated PNG files are not supported for signatures.');
  }

  // PNG colorType: 4 = Grayscale + Alpha, 6 = RGB + Alpha, 3 with tRNS = Indexed with transparency
  const hasTransparency = colorType === 6 || colorType === 4 || hasTrns;

  return {
    width,
    height,
    bytes: buffer.length,
    hasTransparency,
  };
}

export interface StoredSignatureAsset {
  storageProvider: 'cloudinary' | 'local' | 'memory';
  storageKey: string;
  imageUrl: string | null;
}

export interface CertificateStorageOptions {
  cloudinaryCloudName?: string;
  cloudinaryApiKey?: string;
  cloudinaryApiSecret?: string;
  isProduction?: boolean;
  localRootDir?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Storage adapter for reusable original digital signature PNG assets only.
 * Generated certificate PDFs, PNGs, and QR images are rendered strictly in memory on demand
 * and are never persisted or uploaded.
 */
export class CertificateStorageService {
  private cloudinaryCloudName?: string;
  private cloudinaryApiKey?: string;
  private cloudinaryApiSecret?: string;
  private isProduction: boolean;
  private localRootDir: string;
  private fetchImpl: typeof fetch;
  private memorySignatures = new Map<string, Buffer>();

  constructor(options: CertificateStorageOptions = {}) {
    this.cloudinaryCloudName = options.cloudinaryCloudName ?? env.CLOUDINARY_CLOUD_NAME;
    this.cloudinaryApiKey = options.cloudinaryApiKey ?? env.CLOUDINARY_API_KEY;
    this.cloudinaryApiSecret = options.cloudinaryApiSecret ?? env.CLOUDINARY_API_SECRET;
    this.isProduction = options.isProduction ?? env.isProduction;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.localRootDir =
      options.localRootDir ?? path.resolve(process.cwd(), 'storage', 'certificates');

    if (!this.isProduction && process.env.NODE_ENV !== 'test') {
      try {
        fs.mkdirSync(path.join(this.localRootDir, 'signatures'), { recursive: true });
      } catch (err) {
        logger.warn({ err }, 'Could not initialize local signature storage directory');
      }
    }
  }

  public isCloudinaryConfigured(): boolean {
    return Boolean(
      this.cloudinaryCloudName?.trim() &&
      this.cloudinaryApiKey?.trim() &&
      this.cloudinaryApiSecret?.trim(),
    );
  }

  private cloudinaryAuthParams(params: Record<string, string>) {
    const cloudName = this.cloudinaryCloudName!.trim();
    const apiKey = this.cloudinaryApiKey!.trim();
    const apiSecret = this.cloudinaryApiSecret!.trim();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const all = { ...params, timestamp };
    const signature = cloudinarySignature(all, apiSecret);
    return { cloudName, fields: { ...all, api_key: apiKey, signature } };
  }

  public async storeSignaturePng(buffer: Buffer): Promise<StoredSignatureAsset> {
    const id = crypto.randomUUID();
    const publicId = `asra/certificate-signatures/${id}`;

    if (this.isProduction && !this.isCloudinaryConfigured()) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Cloudinary storage is required in production for digital signatures.',
      );
    }

    if (this.isCloudinaryConfigured()) {
      const { cloudName, fields } = this.cloudinaryAuthParams({
        public_id: publicId,
        overwrite: 'false',
      });
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append('file', new Blob([new Uint8Array(buffer)], { type: 'image/png' }), `${id}.png`);

      const response = await this.fetchImpl(
        `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
        { method: 'POST', body: form },
      );

      if (!response.ok) {
        logger.error({ status: response.status }, 'Cloudinary signature upload failed');
        throw new AppError('SERVICE_UNAVAILABLE', 'Could not store signature image. Try again.');
      }

      const payload = (await response.json().catch(() => ({}))) as { secure_url?: string };
      const imageUrl =
        payload.secure_url ??
        `https://res.cloudinary.com/${cloudName}/image/upload/${publicId}.png`;
      return {
        storageProvider: 'cloudinary',
        storageKey: publicId,
        imageUrl,
      };
    }

    if (process.env.NODE_ENV === 'test') {
      const key = `${id}.png`;
      this.memorySignatures.set(key, Buffer.from(buffer));
      return { storageProvider: 'memory', storageKey: key, imageUrl: null };
    }

    const key = `${id}.png`;
    const dir = path.join(this.localRootDir, 'signatures');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, key), buffer);
    return { storageProvider: 'local', storageKey: key, imageUrl: null };
  }

  public async destroySignaturePng(storageProvider: string, storageKey: string): Promise<void> {
    if (storageProvider === 'memory') {
      this.memorySignatures.delete(storageKey);
      return;
    }
    if (storageProvider === 'local') {
      const filePath = path.join(this.localRootDir, 'signatures', path.basename(storageKey));
      await fs.promises.unlink(filePath).catch(() => undefined);
      return;
    }
    if (storageProvider === 'cloudinary') {
      if (!this.isCloudinaryConfigured()) {
        throw new Error('Cloudinary is not configured for signature deletion');
      }
      const { cloudName, fields } = this.cloudinaryAuthParams({
        public_id: storageKey,
        invalidate: 'true',
      });
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      const response = await this.fetchImpl(
        `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
        {
          method: 'POST',
          body: form,
        },
      );
      const body = (await response.json().catch(() => ({}))) as { result?: string };
      if (!response.ok || (body.result !== 'ok' && body.result !== 'not found')) {
        throw new Error(
          `Cloudinary signature destroy failed (${response.status}, ${body.result ?? '?'})`,
        );
      }
    }
  }

  public async readSignaturePng(
    storageProvider: string | null | undefined,
    storageKey: string | null | undefined,
    imageUrl: string | null | undefined,
  ): Promise<Buffer | null> {
    if (!storageKey && !imageUrl) return null;

    if (storageProvider === 'memory' && storageKey) {
      return this.memorySignatures.get(storageKey) ?? null;
    }

    if (storageProvider === 'local' && storageKey) {
      const filePath = path.join(this.localRootDir, 'signatures', path.basename(storageKey));
      if (fs.existsSync(filePath)) {
        return fs.promises.readFile(filePath);
      }
      return null;
    }

    if (imageUrl && /^https:\/\//i.test(imageUrl)) {
      try {
        const res = await this.fetchImpl(imageUrl);
        if (res.ok) {
          return Buffer.from(await res.arrayBuffer());
        }
      } catch (err) {
        logger.warn({ err, storageKey }, 'Could not fetch signature image from remote URL');
      }
    }

    return null;
  }

  public async getSignaturePreviewDataUrl(
    storageProvider: string | null | undefined,
    storageKey: string | null | undefined,
    imageUrl: string | null | undefined,
  ): Promise<string | null> {
    if (imageUrl && /^https:\/\//i.test(imageUrl)) {
      return null;
    }
    const buf = await this.readSignaturePng(storageProvider, storageKey, imageUrl);
    if (!buf) return null;
    return `data:image/png;base64,${buf.toString('base64')}`;
  }
}

let storageInstance: CertificateStorageService | null = null;

export function certificateStorage(): CertificateStorageService {
  if (!storageInstance) {
    storageInstance = new CertificateStorageService();
  }
  return storageInstance;
}

export function setCertificateStorageForTests(
  next: CertificateStorageService | null,
): CertificateStorageService | null {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setCertificateStorageForTests is only available in tests');
  }
  const previous = storageInstance;
  storageInstance = next;
  return previous;
}
