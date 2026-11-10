import crypto from 'node:crypto';
import type { MediaFormat } from '@asra/validation';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { AppError } from '../../../utils/app-error.js';
import { MIME_BY_FORMAT } from './image-sniff.js';

/**
 * Where question/option images live. Production: the existing Cloudinary account (signed
 * server-side Upload API calls over `fetch`, like recruitment résumés — no SDK). Tests install an
 * in-memory store with `setImageStoreForTests`, so no test ever reaches Cloudinary.
 */
export interface ImageStore {
  /** Stores the bytes under `publicId` (never overwrites). */
  upload(input: { publicId: string; format: MediaFormat; buffer: Buffer }): Promise<void>;
  /** Removes the file. Resolves for "deleted" and "already gone"; rejects when it may still exist. */
  destroy(publicId: string): Promise<void>;
  /** Public delivery URL of the stored original (no transformations → no transformation quota). */
  url(publicId: string, format: MediaFormat): string;
}

/** Cloudinary signature: sorted `key=value` pairs joined with `&`, then the secret, SHA-1. */
export function cloudinarySignature(params: Record<string, string>, secret: string): string {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto
    .createHash('sha1')
    .update(payload + secret)
    .digest('hex');
}

export function createCloudinaryImageStore(options: {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
}): ImageStore {
  const { cloudName, apiKey, apiSecret } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = (action: 'upload' | 'destroy') =>
    `https://api.cloudinary.com/v1_1/${cloudName}/image/${action}`;

  const signed = (params: Record<string, string>) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const all = { ...params, timestamp };
    return { ...all, api_key: apiKey, signature: cloudinarySignature(all, apiSecret) };
  };

  return {
    async upload({ publicId, format, buffer }) {
      const form = new FormData();
      const fields = signed({ public_id: publicId, overwrite: 'false' });
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      form.append('file', new Blob([new Uint8Array(buffer)], { type: MIME_BY_FORMAT[format] }));
      const response = await fetchImpl(endpoint('upload'), { method: 'POST', body: form });
      if (!response.ok) {
        logger.error({ status: response.status }, 'Cloudinary image upload failed');
        throw new AppError('SERVICE_UNAVAILABLE', 'The image could not be stored. Try again.');
      }
    },

    async destroy(publicId) {
      const form = new FormData();
      const fields = signed({ public_id: publicId, invalidate: 'true' });
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      const response = await fetchImpl(endpoint('destroy'), { method: 'POST', body: form });
      const body = (await response.json().catch(() => ({}))) as { result?: string };
      if (!response.ok || (body.result !== 'ok' && body.result !== 'not found')) {
        throw new Error(`Cloudinary destroy failed (${response.status}, ${body.result ?? '?'})`);
      }
    },

    url(publicId, format) {
      return `https://res.cloudinary.com/${cloudName}/image/upload/${publicId}.${format}`;
    },
  };
}

/** Used when Cloudinary is not configured (local development): explains instead of failing oddly. */
const unconfiguredStore: ImageStore = {
  async upload() {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      'Image storage is not configured on this server (CLOUDINARY_* settings).',
    );
  },
  async destroy() {
    throw new Error('Image storage is not configured');
  },
  url(publicId, format) {
    return `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME?.trim() || 'unconfigured'}/image/upload/${publicId}.${format}`;
  },
};

let store: ImageStore | null = null;

export function imageStore(): ImageStore {
  if (store) return store;
  const cloudName = env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = env.CLOUDINARY_API_SECRET?.trim();
  store =
    cloudName && apiKey && apiSecret
      ? createCloudinaryImageStore({ cloudName, apiKey, apiSecret })
      : unconfiguredStore;
  return store;
}

/** Test-only: installs a fake store and returns the previous one. */
export function setImageStoreForTests(next: ImageStore | null): ImageStore | null {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setImageStoreForTests is only available in tests');
  }
  const previous = store;
  store = next;
  return previous;
}
