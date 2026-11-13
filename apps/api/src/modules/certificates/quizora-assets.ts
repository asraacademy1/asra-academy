import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUIZORA_2026_DEFINITION,
  type ArtworkTemplateDefinition,
  type CertificateTextMeasurer,
} from '@asra/validation';
import * as fontkit from 'fontkit';
import { AppError } from '../../utils/app-error.js';

/**
 * Static assets of the artwork certificate templates, stored under `apps/api/assets/certificates/`
 * (never in PostgreSQL):
 *
 *   quizora-2026/            Design 1 — artwork.jpg, statement-patch.png, TeX Gyre Pagella fonts
 *   quizora-2026-design-2/   Design 2 — artwork.jpg, statement-patch.png, Parisienne (+ Design 1 Pagella)
 *
 * Each file is referenced with a literal `new URL(..., import.meta.url)` so serverless file
 * tracing bundles it; `process.cwd()` candidates cover `node dist/server.js` and the test runner.
 * Paths are relative to the `certificates/` asset root, as used by `ArtworkTemplateDefinition`.
 */
const ASSET_URLS: Readonly<Record<string, URL>> = {
  'quizora-2026/artwork.jpg': new URL(
    '../../../assets/certificates/quizora-2026/artwork.jpg',
    import.meta.url,
  ),
  'quizora-2026/statement-patch.png': new URL(
    '../../../assets/certificates/quizora-2026/statement-patch.png',
    import.meta.url,
  ),
  'quizora-2026/fonts/texgyrepagella-regular.otf': new URL(
    '../../../assets/certificates/quizora-2026/fonts/texgyrepagella-regular.otf',
    import.meta.url,
  ),
  'quizora-2026/fonts/texgyrepagella-italic.otf': new URL(
    '../../../assets/certificates/quizora-2026/fonts/texgyrepagella-italic.otf',
    import.meta.url,
  ),
  'quizora-2026/fonts/texgyrepagella-bold.otf': new URL(
    '../../../assets/certificates/quizora-2026/fonts/texgyrepagella-bold.otf',
    import.meta.url,
  ),
  'quizora-2026/fonts/texgyrepagella-bolditalic.otf': new URL(
    '../../../assets/certificates/quizora-2026/fonts/texgyrepagella-bolditalic.otf',
    import.meta.url,
  ),
  'quizora-2026-design-2/artwork.jpg': new URL(
    '../../../assets/certificates/quizora-2026-design-2/artwork.jpg',
    import.meta.url,
  ),
  'quizora-2026-design-2/statement-patch.png': new URL(
    '../../../assets/certificates/quizora-2026-design-2/statement-patch.png',
    import.meta.url,
  ),
  'quizora-2026-design-2/fonts/parisienne-regular.ttf': new URL(
    '../../../assets/certificates/quizora-2026-design-2/fonts/parisienne-regular.ttf',
    import.meta.url,
  ),
};

export interface QuizoraAssets {
  artwork: Buffer;
  statementPatch: Buffer;
  fonts: Record<string, { buffer: Buffer; font: fontkit.FontkitFont }>;
}

const API_ROOT_URL = new URL('../../../', import.meta.url);

function readAsset(relativeToCertificates: string): Buffer {
  const url = ASSET_URLS[relativeToCertificates];
  const relative = path.join('assets', 'certificates', relativeToCertificates);
  const candidates = [
    ...(url ? [fileURLToPath(url)] : []),
    path.resolve(fileURLToPath(API_ROOT_URL), relative),
    path.resolve(process.cwd(), relative),
    path.resolve(process.cwd(), 'apps/api', relative),
  ];
  for (const candidate of candidates) {
    try {
      const buf = fs.readFileSync(candidate);
      if (buf.length > 0) return buf;
    } catch {
      // try next candidate
    }
  }
  throw new AppError(
    'SERVICE_UNAVAILABLE',
    `Certificate artwork asset "${relative}" is not available on this server.`,
  );
}

const cache = new Map<string, QuizoraAssets>();

/** Loads (once per template) the artwork, statement patch and fonts. Throws if any is missing. */
export function loadArtworkAssets(def: ArtworkTemplateDefinition): QuizoraAssets {
  const hit = cache.get(def.key);
  if (hit) return hit;
  const fonts: QuizoraAssets['fonts'] = {};
  for (const [face, file] of Object.entries(def.fonts)) {
    const buffer = readAsset(file);
    fonts[face] = { buffer, font: fontkit.create(buffer) };
  }
  const assets: QuizoraAssets = {
    artwork: readAsset(`${def.assetDir}/artwork.jpg`),
    statementPatch: readAsset(`${def.assetDir}/statement-patch.png`),
    fonts,
  };
  cache.set(def.key, assets);
  return assets;
}

/** Design 1 assets (kept for existing callers). */
export function loadQuizoraAssets(): QuizoraAssets {
  return loadArtworkAssets(QUIZORA_2026_DEFINITION);
}

const widthCache = new Map<string, number>();

/** Width measurer backed by the bundled font files (kerning + ligatures, same as PDFKit). */
export function quizoraTextMeasurer(
  assets: QuizoraAssets = loadQuizoraAssets(),
  def: ArtworkTemplateDefinition = QUIZORA_2026_DEFINITION,
): CertificateTextMeasurer {
  return (text, variant, fontSize) => {
    const face = def.variantStyles[variant].face;
    const fontFile = def.fonts[face]!;
    const key = `${fontFile}\u0000${text}`;
    let unitsPerEm = widthCache.get(key);
    if (unitsPerEm === undefined) {
      const font = assets.fonts[face]!.font;
      unitsPerEm = font.layout(text).advanceWidth / font.unitsPerEm;
      if (widthCache.size > 5000) widthCache.clear();
      widthCache.set(key, unitsPerEm);
    }
    return unitsPerEm * fontSize;
  };
}
