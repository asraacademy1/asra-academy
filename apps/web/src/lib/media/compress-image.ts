import { MEDIA_LIMITS } from '@asra/validation';

/**
 * Client-side image optimization before upload (question/option images, ≤ 100 KB).
 *
 * `fitWithinLimit` is the pure policy (unit-tested with a fake encoder): scale the longest side
 * down to 1600 px, encode WebP at falling quality (0.82 → 0.5), then shrink 20 % at a time down to
 * 640 px. Browsers that cannot ENCODE WebP (the canvas silently returns PNG, e.g. older Safari)
 * fall back to JPEG. If nothing fits, it fails with a clear message — an oversized file is never
 * uploaded. The API enforces the same 100 KB limit again.
 *
 * `compressImageFile` is the browser part (decode → canvas → encode). No dependencies.
 */

export type OutputType = 'image/webp' | 'image/jpeg';

/** Encodes the source at `width`×`height`; the returned Blob's `type` is what was really produced. */
export type Encoder = (
  width: number,
  height: number,
  type: OutputType,
  quality: number,
) => Promise<Blob>;

export const QUALITY_STEPS = [0.82, 0.72, 0.62, 0.5] as const;
const SHRINK_FACTOR = 0.8;

export type CompressionResult =
  | { ok: true; blob: Blob; width: number; height: number; type: OutputType }
  | { ok: false; message: string };

export const TOO_DETAILED_MESSAGE = `This image is too detailed to fit within ${
  MEDIA_LIMITS.maxBytes / 1024
} KB. Try cropping it or using a simpler image.`;

export function scaledSize(width: number, height: number, longest: number) {
  const scale = Math.min(1, longest / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function fitWithinLimit(
  source: { width: number; height: number },
  encode: Encoder,
  limits: { maxBytes: number; target: number; min: number } = {
    maxBytes: MEDIA_LIMITS.maxBytes,
    target: MEDIA_LIMITS.targetDimension,
    min: MEDIA_LIMITS.minDimension,
  },
): Promise<CompressionResult> {
  let type: OutputType = 'image/webp';
  let longest = Math.min(limits.target, Math.max(source.width, source.height));
  // The smallest we try is `min` px — or the image's own size if it is smaller than that.
  const floor = Math.min(limits.min, longest);
  for (;;) {
    const size = scaledSize(source.width, source.height, longest);
    for (const quality of QUALITY_STEPS) {
      let blob = await encode(size.width, size.height, type, quality);
      if (type === 'image/webp' && blob.type !== 'image/webp') {
        type = 'image/jpeg'; // WebP encoding unsupported: use JPEG from here on
        blob = await encode(size.width, size.height, type, quality);
      }
      if (blob.type !== type) return { ok: false, message: UNSUPPORTED_MESSAGE };
      if (blob.size > 0 && blob.size <= limits.maxBytes) {
        return { ok: true, blob, width: size.width, height: size.height, type };
      }
    }
    if (longest <= floor) return { ok: false, message: TOO_DETAILED_MESSAGE };
    longest = Math.max(floor, Math.floor(longest * SHRINK_FACTOR));
  }
}

export const UNSUPPORTED_MESSAGE =
  'This file could not be read as an image. Use a JPEG, PNG or WebP picture.';

/** Inputs larger than this are refused before decoding (protects the browser's memory). */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export async function compressImageFile(file: File): Promise<CompressionResult> {
  if (!file.type.startsWith('image/') && file.type !== '') {
    return { ok: false, message: UNSUPPORTED_MESSAGE };
  }
  if (file.size > MAX_INPUT_BYTES) {
    return { ok: false, message: 'This picture is larger than 25 MB. Choose a smaller one.' };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { ok: false, message: UNSUPPORTED_MESSAGE };
  }
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return { ok: false, message: UNSUPPORTED_MESSAGE };
    const encode: Encoder = (width, height, type, quality) => {
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      if (type === 'image/jpeg') {
        // JPEG has no transparency: flatten onto white instead of black.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
      }
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      return new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))),
          type,
          quality,
        ),
      );
    };
    return await fitWithinLimit({ width: bitmap.width, height: bitmap.height }, encode);
  } catch {
    return { ok: false, message: UNSUPPORTED_MESSAGE };
  } finally {
    bitmap.close();
  }
}

export function formatKilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
