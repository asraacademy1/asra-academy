import type { MediaFormat } from '@asra/validation';

/**
 * Identifies an uploaded image from its BYTES (never from its name or declared type) and reads
 * its dimensions from the header. Dependency-free on purpose: only the three formats the browser
 * compressor produces are accepted, and anything that does not parse cleanly is rejected.
 * Animated WebP/PNG are reported so the caller can refuse them.
 */
export interface SniffedImage {
  format: MediaFormat;
  width: number;
  height: number;
  animated: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffPng(buf: Buffer): SniffedImage | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // The first chunk must be IHDR (13 bytes of data).
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  // Walk the chunks up to the first IDAT: an `acTL` chunk before it makes the file an APNG.
  let animated = false;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (type === 'acTL') animated = true;
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + length;
  }
  return { format: 'png', width, height, animated };
}

/** SOF markers carry the frame size (DHT C4, JPG C8 and DAC CC are not frames). */
const isStartOfFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function sniffJpeg(buf: Buffer): SniffedImage | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1]!;
    // Fill bytes and stand-alone markers (RSTn, TEM) have no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI/SOS before any frame header
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (offset + 9 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { format: 'jpg', width, height, animated: false };
    }
    offset += 2 + length;
  }
  return null;
}

function sniffWebp(buf: Buffer): SniffedImage | null {
  if (buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  // RIFF size = file length − 8; a truncated or padded container is rejected.
  if (buf.readUInt32LE(4) + 8 > buf.length) return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    const flags = buf[20]!;
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return { format: 'webp', width, height, animated: (flags & 0x02) !== 0 };
  }
  if (chunk === 'VP8 ') {
    // Key frame start code 9D 01 2A, then 14-bit width/height.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { format: 'webp', width, height, animated: false };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { format: 'webp', width, height, animated: false };
  }
  return null;
}

/** Returns the image, or null when the bytes are not a well-formed WebP, JPEG or PNG header. */
export function sniffImage(buf: Buffer): SniffedImage | null {
  const result = sniffWebp(buf) ?? sniffPng(buf) ?? sniffJpeg(buf);
  if (!result || result.width < 1 || result.height < 1) return null;
  return result;
}

export const MIME_BY_FORMAT: Record<MediaFormat, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  png: 'image/png',
};
