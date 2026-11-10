import type { MediaUploadDto } from '@asra/types';
import type { ImageStore } from '../../src/modules/assessments/media/image-store.js';
import { WEB_ORIGIN } from './http.js';

/**
 * Test support for question/option images: byte-exact image headers (no image library needed —
 * the API reads only headers) and an in-memory ImageStore standing in for Cloudinary.
 */

const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** A WebP (VP8X container) of the given size, optionally animated, padded to `bytes`. */
export function webp(
  width = 800,
  height = 600,
  options: { animated?: boolean; bytes?: number } = {},
) {
  const chunk = Buffer.alloc(18);
  chunk.write('VP8X', 0, 'latin1');
  chunk.writeUInt32LE(10, 4);
  chunk[8] = options.animated ? 0x02 : 0x00;
  chunk.writeUIntLE(width - 1, 12, 3);
  chunk.writeUIntLE(height - 1, 15, 3);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk]);
  const header = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4)]);
  header.writeUInt32LE(body.length, 4);
  const file = Buffer.concat([header, body]);
  return options.bytes && options.bytes > file.length
    ? Buffer.concat([file, Buffer.alloc(options.bytes - file.length)])
    : file;
}

/** A PNG with IHDR (+ acTL when animated) + IDAT + IEND (CRCs are not checked by the API). */
export function png(width = 400, height = 300, options: { animated?: boolean } = {}) {
  const chunk = (type: string, data: Buffer) =>
    Buffer.concat([u32be(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(options.animated ? [chunk('acTL', Buffer.alloc(8))] : []),
    chunk('IDAT', Buffer.alloc(10)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A baseline JPEG: SOI, APP0 (JFIF), SOF0 with the frame size, EOI. */
export function jpeg(width = 640, height = 480) {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from('JFIF\0'),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

export interface FakeImageStore extends ImageStore {
  uploaded: Set<string>;
  destroyed: string[];
  failDestroy: boolean;
}

export function fakeImageStore(): FakeImageStore {
  const store: FakeImageStore = {
    uploaded: new Set(),
    destroyed: [],
    failDestroy: false,
    async upload({ publicId }) {
      if (store.uploaded.has(publicId)) throw new Error('overwrite refused');
      store.uploaded.add(publicId);
    },
    async destroy(publicId) {
      if (store.failDestroy) throw new Error('Cloudinary unavailable');
      store.uploaded.delete(publicId);
      store.destroyed.push(publicId);
    },
    url: (publicId, format) => `https://images.test/${publicId}.${format}`,
  };
  return store;
}

/** POSTs raw image bytes the way the web compressor does. */
export async function uploadImage(
  baseUrl: string,
  token: string | undefined,
  bytes: Buffer,
  options: { contentType?: string; portal?: 'faculty' | 'admin' } = {},
) {
  const response = await fetch(
    `${baseUrl}/api/v1/${options.portal ?? 'faculty'}/assessment-media`,
    {
      method: 'POST',
      headers: {
        'content-type': options.contentType ?? 'image/webp',
        origin: WEB_ORIGIN,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: new Uint8Array(bytes),
    },
  );
  const text = await response.text();
  const body = text ? (JSON.parse(text) as { data: MediaUploadDto; message: string }) : null;
  return { status: response.status, body, text };
}
