/**
 * Builds `assets/certificates/<template>/statement-patch.png` from an approved reference artwork
 * (`artwork.jpg`, 1536 × 1024).
 *
 * The reference artworks have sample content baked into the image (Design 1: the participation
 * statement; Design 2: "Participant Name", the statement, sample signatures and a static QR).
 * That content is rendered dynamically, so the baked pixels must be removed. Instead of editing
 * the original artwork, this script produces a transparent PNG that covers ONLY the measured
 * boxes with paper reconstructed from the surrounding clean background (normalized-convolution
 * blur that ignores lettering pixels). Renderers draw the untouched original JPEG first and this
 * patch on top at `<definition>.layout.statementPatch.{x,y}`.
 *
 * Run (from apps/api), deterministic:
 *   npx tsx scripts/build-quizora-statement-patch.ts             # Design 1
 *   npx tsx scripts/build-quizora-statement-patch.ts design-2    # Design 2
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUIZORA_2026_DEFINITION,
  QUIZORA_2026_DESIGN_2_DEFINITION,
  type ArtworkTemplateDefinition,
} from '@asra/validation';
import sharp from 'sharp';

/** `feather` (px, default 5): soft edge; 1 = hard edge for boxes touching kept artwork lines. */
type Box = { x0: number; x1: number; y0: number; y1: number; feather?: number };

/**
 * Measured bounding boxes (artwork pixels, a few px margin around the ink). Restricting the
 * patch to these boxes keeps every other artwork element (badges, laurels, dividers, rules,
 * illustrations) untouched.
 */
const TARGETS: Record<string, { def: ArtworkTemplateDefinition; boxes: Box[] }> = {
  'design-1': {
    def: QUIZORA_2026_DEFINITION,
    boxes: [
      { x0: 254, x1: 1283, y0: 614, y1: 664 }, // "has successfully attempted the ASRA QUIZORA – 2026, a National Level"
      { x0: 424, x1: 1114, y0: 658, y1: 706 }, // "Quiz Competition organized by ASRA Academy"
      { x0: 584, x1: 954, y0: 699, y1: 750 }, // "on 14th November 2026."
    ],
  },
  'design-2': {
    def: QUIZORA_2026_DESIGN_2_DEFINITION,
    boxes: [
      { x0: 450, x1: 1100, y0: 486, y1: 583, feather: 1 }, // "Participant Name" (gold divider y 584 kept)
      { x0: 370, x1: 1190, y0: 604, y1: 648 }, // "has successfully attempted the ASRA QUIZORA – 2026,"
      { x0: 443, x1: 1110, y0: 645, y1: 686 }, // "a National Level Quiz Competition organized by"
      { x0: 632, x1: 921, y0: 682, y1: 729 }, // "ASRA Academy"
      { x0: 604, x1: 956, y0: 730, y1: 768 }, // "on 14th November 2026."
      { x0: 410, x1: 556, y0: 782, y1: 844, feather: 1 }, // sample Event Coordinator signature (rule y 845 kept)
      { x0: 996, x1: 1154, y0: 781, y1: 844, feather: 1 }, // sample Director signature (rule y 845 kept)
      { x0: 708, x1: 823, y0: 803, y1: 913 }, // static sample QR code
    ],
  },
};

const target = TARGETS[process.argv[2] ?? 'design-1'];
if (!target) throw new Error(`Unknown template "${process.argv[2]}" (use design-1 or design-2)`);
const LAYOUT = target.def.layout;
const LINE_BOXES = target.boxes;

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.resolve(here, '../assets/certificates', target.def.assetDir);
const artworkPath = path.join(assetDir, 'artwork.jpg');
const outputPath = path.join(assetDir, 'statement-patch.png');

const { x: RX, y: RY, width: RW, height: RH } = LAYOUT.statementPatch;
const FEATHER = 5;
const BLUR_RADIUS = 10;
const BLUR_PASSES = 3;

const { data, info } = await sharp(artworkPath)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
if (info.width !== LAYOUT.width || info.height !== LAYOUT.height) {
  throw new Error(`Unexpected artwork size ${info.width}×${info.height}`);
}
const W = info.width;
const src = (x: number, y: number, c: number) => data[(y * W + x) * 3 + c]!;

/** Patch opacity (0–1) at (x, y): feathered inside the boxes, 0 outside them. */
function insideDepth(x: number, y: number): number {
  let alpha = 0;
  for (const b of LINE_BOXES) {
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
    const depth = Math.min(x - b.x0, b.x1 - x, y - b.y0, b.y1 - y) + 1;
    alpha = Math.max(alpha, Math.min(1, depth / (b.feather ?? FEATHER)));
  }
  return alpha;
}

// 1. Clean-paper weight map over the patch rectangle: lettering, anti-aliasing and JPEG
//    ringing (anything darker than the cream paper or red-tinted) gets zero weight.
const weight = new Float32Array(RW * RH);
const values = new Float32Array(RW * RH * 3);
for (let y = 0; y < RH; y++) {
  for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    const r = src(RX + x, RY + y, 0);
    const g = src(RX + x, RY + y, 1);
    const b = src(RX + x, RY + y, 2);
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const clean = l >= 241 && r - b < 16;
    weight[i] = clean ? 1 : 0;
    values[i * 3] = r * weight[i]!;
    values[i * 3 + 1] = g * weight[i]!;
    values[i * 3 + 2] = b * weight[i]!;
  }
}

function boxBlur(buf: Float32Array, channels: number, radius: number): Float32Array {
  const tmp = new Float32Array(buf.length);
  const out = new Float32Array(buf.length);
  for (let y = 0; y < RH; y++) {
    for (let c = 0; c < channels; c++) {
      let acc = 0;
      for (let x = -radius; x <= radius; x++)
        acc += buf[(y * RW + Math.min(RW - 1, Math.max(0, x))) * channels + c]!;
      for (let x = 0; x < RW; x++) {
        tmp[(y * RW + x) * channels + c] = acc / (2 * radius + 1);
        const add = Math.min(RW - 1, x + radius + 1);
        const sub = Math.max(0, x - radius);
        acc += buf[(y * RW + add) * channels + c]! - buf[(y * RW + sub) * channels + c]!;
      }
    }
  }
  for (let x = 0; x < RW; x++) {
    for (let c = 0; c < channels; c++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++)
        acc += tmp[(Math.min(RH - 1, Math.max(0, y)) * RW + x) * channels + c]!;
      for (let y = 0; y < RH; y++) {
        out[(y * RW + x) * channels + c] = acc / (2 * radius + 1);
        const add = Math.min(RH - 1, y + radius + 1);
        const sub = Math.max(0, y - radius);
        acc += tmp[(add * RW + x) * channels + c]! - tmp[(sub * RW + x) * channels + c]!;
      }
    }
  }
  return out;
}

// 2. Normalized convolution: blur(value·weight) / blur(weight) ≈ local clean paper colour.
let blurredValues: Float32Array = values;
let blurredWeight: Float32Array = weight;
for (let pass = 0; pass < BLUR_PASSES; pass++) {
  blurredValues = boxBlur(blurredValues, 3, BLUR_RADIUS);
  blurredWeight = boxBlur(blurredWeight, 1, BLUR_RADIUS);
}

// 3. Compose RGBA: reconstructed paper inside the line boxes (feathered at the box edges),
//    fully transparent elsewhere so the original artwork shows through unchanged.
const rgba = Buffer.alloc(RW * RH * 4);
for (let y = 0; y < RH; y++) {
  for (let x = 0; x < RW; x++) {
    const i = y * RW + x;
    const depth = insideDepth(RX + x, RY + y);
    if (depth === 0) continue;
    const w = blurredWeight[i]!;
    for (let c = 0; c < 3; c++) {
      const v = w > 1e-3 ? blurredValues[i * 3 + c]! / w : src(RX + x, RY + y, c);
      rgba[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
    rgba[i * 4 + 3] = Math.round(255 * depth);
  }
}

await sharp(rgba, { raw: { width: RW, height: RH, channels: 4 } })
  .png({ compressionLevel: 9 })
  .toFile(outputPath);

console.log(`✔ Wrote ${path.relative(process.cwd(), outputPath)} (${RW}×${RH} at ${RX},${RY})`);
