/**
 * Artwork-based certificate templates (ASRA QUIZORA 2026 — Certificate of Participation,
 * Design 1 and Design 2).
 *
 * Shared, framework-free layout + text logic consumed by:
 *   - the API PDF renderer (PDFKit),
 *   - the API PNG renderer (Sharp / SVG with fontkit glyph outlines),
 *   - the web live preview (React, canvas text measurement).
 *
 * Each template is described by an `ArtworkTemplateDefinition` (reference artwork, fonts, text
 * styles and coordinates in reference-artwork pixels, 1536 × 1024). Every renderer measures text
 * with the same bundled font files, so wrapping and fitting decisions are identical across outputs.
 * All layout functions default to Design 1 (`QUIZORA_2026_DEFINITION`).
 */

export type CertificateTextVariant =
  | 'body'
  | 'emphasis'
  | 'title'
  | 'date'
  | 'dateSuffix'
  | 'name'
  | 'metaLabel'
  | 'metaValue'
  | 'caption';

export const ARTWORK_CERTIFICATE_STYLES = [
  'QUIZORA_PARTICIPATION',
  'QUIZORA_PARTICIPATION_DESIGN_2',
] as const;
export type ArtworkCertificateStyle = (typeof ARTWORK_CERTIFICATE_STYLES)[number];

export interface ArtworkVariantStyle {
  /** Key into `ArtworkTemplateDefinition.fonts`. */
  face: string;
  color: string;
  /** Size multiplier relative to the block font size (default 1). */
  scale?: number;
  /** Outline (em) in the text colour to match heavier reference lettering (default none). */
  strokeEm?: number;
}

export type ArtworkMetadataField =
  'completed' | 'issued' | 'certificateId' | 'verifyLabel' | 'verifyUrl' | 'verify';

export interface ArtworkLayout {
  width: number;
  height: number;
  /** Transparent patch hiding the reference artwork's baked-in sample content. */
  statementPatch: { x: number; y: number; width: number; height: number };
  name: {
    centerX: number;
    baselineY: number;
    maxWidth: number;
    startSize: number;
    minSize: number;
    twoLineStartSize: number;
    twoLineMinSize: number;
    twoLineBaselines: readonly [number, number];
  };
  statement: {
    centerX: number;
    middleBaselineY: number;
    maxWidth: number;
    startSize: number;
    minSize: number;
    lineGapRatio: number;
    maxBlockHeight: number;
    superscriptScale: number;
    superscriptRise: number;
  };
  signatureSlots: readonly {
    sortOrder: number;
    label: string;
    box: { x: number; y: number; width: number; height: number };
  }[];
  qr: {
    x: number;
    y: number;
    size: number;
    padding: number;
    /** Quiet zone (in modules) painted white inside the box. */
    quietZoneModules: number;
    /** 'card' = white rounded card with gold frame + caption; 'plain' = white square only. */
    frame: 'card' | 'plain';
    captionHeight: number;
    caption: string | null;
    captionSize: number;
  };
  metadata: {
    fontSize: number;
    minFontSize: number;
    lineGap: number;
    blocks: readonly {
      centerX: number;
      firstBaselineY: number;
      maxWidth: number;
      rows: readonly (readonly ArtworkMetadataField[])[];
    }[];
  };
}

export interface ArtworkTemplateDefinition {
  style: ArtworkCertificateStyle;
  key: string;
  name: string;
  /** Folder under `certificates/` holding artwork.jpg and statement-patch.png. */
  assetDir: string;
  /** Font face → file path relative to the `certificates/` asset root. */
  fonts: Readonly<Record<string, string>>;
  variantStyles: Readonly<Record<CertificateTextVariant, ArtworkVariantStyle>>;
  colors: {
    qrDark: string;
    qrBorder: string;
    watermarkRevoked: string;
    watermarkSuperseded: string;
  };
  defaultBodyText: string;
  layout: ArtworkLayout;
}

// ---------------------------------------------------------------------------------------------
// Design 1 — ASRA QUIZORA 2026 — Certificate of Participation
// ---------------------------------------------------------------------------------------------

export const QUIZORA_2026_TEMPLATE_KEY = 'asra-quizora-2026-participation';
export const QUIZORA_2026_TEMPLATE_STYLE = 'QUIZORA_PARTICIPATION' as const;

/**
 * Default statement. Placeholders: `{title}` → certificate subject title (quiz / course / event),
 * `{date}` → completion date ("14th November 2026"), `**text**` → bold emphasis, newline → forced
 * line break. Reproduces the wording and line breaks of the reference artwork.
 */
export const QUIZORA_2026_DEFAULT_BODY_TEXT =
  'has successfully attempted the {title}, a National Level Quiz Competition organized by **ASRA Academy**\non {date}.';

export const QUIZORA_2026_TIME_ZONE = 'Asia/Kolkata';

export const QUIZORA_2026_FONT_FILES = {
  regular: 'texgyrepagella-regular.otf',
  italic: 'texgyrepagella-italic.otf',
  bold: 'texgyrepagella-bold.otf',
  boldItalic: 'texgyrepagella-bolditalic.otf',
} as const;

export type QuizoraFontFace = keyof typeof QUIZORA_2026_FONT_FILES;

export const QUIZORA_2026_COLORS = {
  navy: '#0B1638',
  title: '#7A0F12',
  label: '#7A5A14',
  qrDark: '#0B1638',
  qrBorder: '#C9A13B',
  watermarkRevoked: '#B42318',
  watermarkSuperseded: '#B45309',
} as const;

export const QUIZORA_2026_VARIANT_STYLES: Record<
  CertificateTextVariant,
  { face: QuizoraFontFace; color: string }
> = {
  body: { face: 'italic', color: QUIZORA_2026_COLORS.navy },
  emphasis: { face: 'boldItalic', color: QUIZORA_2026_COLORS.navy },
  title: { face: 'boldItalic', color: QUIZORA_2026_COLORS.title },
  date: { face: 'boldItalic', color: QUIZORA_2026_COLORS.navy },
  dateSuffix: { face: 'boldItalic', color: QUIZORA_2026_COLORS.navy },
  name: { face: 'boldItalic', color: QUIZORA_2026_COLORS.navy },
  metaLabel: { face: 'bold', color: QUIZORA_2026_COLORS.label },
  metaValue: { face: 'regular', color: QUIZORA_2026_COLORS.navy },
  caption: { face: 'bold', color: QUIZORA_2026_COLORS.navy },
};

export const QUIZORA_2026_LAYOUT = {
  width: 1536,
  height: 1024,
  statementPatch: { x: 250, y: 608, width: 1042, height: 146 },
  /** Recipient name, written on the horizontal rule below the "This is to certify that" ribbon. */
  name: {
    centerX: 768,
    baselineY: 580,
    maxWidth: 1000,
    startSize: 54,
    minSize: 30,
    twoLineStartSize: 30,
    twoLineMinSize: 20,
    twoLineBaselines: [557, 589] as const,
  },
  statement: {
    centerX: 768,
    middleBaselineY: 690,
    maxWidth: 1020,
    startSize: 33.5,
    minSize: 20,
    lineGapRatio: 1.254,
    maxBlockHeight: 128,
    superscriptScale: 0.58,
    superscriptRise: 0.36,
  },
  /** Signature images sit directly above the artwork's printed signature rules (y = 824). */
  signatureSlots: [
    { sortOrder: 0, label: 'Event Coordinator', box: { x: 372, y: 748, width: 182, height: 72 } },
    { sortOrder: 1, label: 'Director', box: { x: 1025, y: 748, width: 182, height: 72 } },
  ] as const,
  /** Verification QR card in the cream area right of the Director rule, clear of the gold swoosh. */
  qr: {
    x: 1258,
    y: 744,
    size: 108,
    captionHeight: 15,
    caption: 'SCAN TO VERIFY',
    captionSize: 9,
    padding: 3,
    quietZoneModules: 4,
    frame: 'card' as const,
  },
  /** Dates + certificate ID under the Event Coordinator rule; verify URL under the Director rule. */
  metadata: {
    fontSize: 12.5,
    minFontSize: 9,
    lineGap: 17.5,
    blocks: [
      {
        centerX: 463,
        firstBaselineY: 906,
        maxWidth: 296,
        rows: [['completed'], ['issued'], ['certificateId']],
      },
      { centerX: 1110, firstBaselineY: 906, maxWidth: 318, rows: [['verifyLabel'], ['verifyUrl']] },
    ],
  },
} as const satisfies ArtworkLayout;

/** Exactly two signatories: index 0 → Event Coordinator rule, index 1 → Director rule. */
export const QUIZORA_2026_REQUIRED_SIGNATURES = QUIZORA_2026_LAYOUT.signatureSlots.length;

export const QUIZORA_2026_DEFINITION: ArtworkTemplateDefinition = {
  style: QUIZORA_2026_TEMPLATE_STYLE,
  key: QUIZORA_2026_TEMPLATE_KEY,
  name: 'ASRA QUIZORA 2026 — Certificate of Participation',
  assetDir: 'quizora-2026',
  fonts: {
    regular: `quizora-2026/fonts/${QUIZORA_2026_FONT_FILES.regular}`,
    italic: `quizora-2026/fonts/${QUIZORA_2026_FONT_FILES.italic}`,
    bold: `quizora-2026/fonts/${QUIZORA_2026_FONT_FILES.bold}`,
    boldItalic: `quizora-2026/fonts/${QUIZORA_2026_FONT_FILES.boldItalic}`,
  },
  variantStyles: QUIZORA_2026_VARIANT_STYLES,
  colors: QUIZORA_2026_COLORS,
  defaultBodyText: QUIZORA_2026_DEFAULT_BODY_TEXT,
  layout: QUIZORA_2026_LAYOUT,
};

// ---------------------------------------------------------------------------------------------
// Design 2 — ASRA QUIZORA 2026 — Certificate of Participation (Design 2)
// ---------------------------------------------------------------------------------------------

export const QUIZORA_2026_DESIGN_2_TEMPLATE_KEY = 'asra-quizora-2026-participation-design-2';
export const QUIZORA_2026_DESIGN_2_TEMPLATE_STYLE = 'QUIZORA_PARTICIPATION_DESIGN_2' as const;

/** Reproduces the Design 2 reference wording and its four centred lines. */
export const QUIZORA_2026_DESIGN_2_DEFAULT_BODY_TEXT =
  'has successfully attempted the {title},\na National Level Quiz Competition organized by\n**ASRA Academy**\non {date}.';

const DESIGN_2_COLORS = {
  navy: '#0B1638',
  ink: '#141414',
  title: '#7A0F12',
  label: '#7A5A14',
};

export const QUIZORA_2026_DESIGN_2_DEFINITION: ArtworkTemplateDefinition = {
  style: QUIZORA_2026_DESIGN_2_TEMPLATE_STYLE,
  key: QUIZORA_2026_DESIGN_2_TEMPLATE_KEY,
  name: 'ASRA QUIZORA 2026 — Certificate of Participation (Design 2)',
  assetDir: 'quizora-2026-design-2',
  fonts: {
    // Parisienne (OFL): formal script matching the reference "Participant Name".
    script: 'quizora-2026-design-2/fonts/parisienne-regular.ttf',
    // TeX Gyre Pagella (shared with Design 1): the reference statement is a Palatino-style
    // bold italic (measured stroke slant ≈ 13°); metadata uses the upright cuts.
    regular: `quizora-2026/fonts/${QUIZORA_2026_FONT_FILES.regular}`,
    bold: `quizora-2026/fonts/${QUIZORA_2026_FONT_FILES.bold}`,
    boldItalic: `quizora-2026/fonts/${QUIZORA_2026_FONT_FILES.boldItalic}`,
  },
  variantStyles: {
    body: { face: 'boldItalic', color: DESIGN_2_COLORS.navy, strokeEm: 0.022 },
    emphasis: { face: 'boldItalic', color: DESIGN_2_COLORS.navy, scale: 1.29, strokeEm: 0.045 },
    title: { face: 'boldItalic', color: DESIGN_2_COLORS.title, scale: 1.12, strokeEm: 0.045 },
    date: { face: 'boldItalic', color: DESIGN_2_COLORS.navy, scale: 1.11, strokeEm: 0.045 },
    dateSuffix: { face: 'boldItalic', color: DESIGN_2_COLORS.navy, scale: 1.11, strokeEm: 0.045 },
    name: { face: 'script', color: DESIGN_2_COLORS.ink },
    metaLabel: { face: 'bold', color: DESIGN_2_COLORS.label },
    metaValue: { face: 'regular', color: DESIGN_2_COLORS.navy },
    caption: { face: 'bold', color: DESIGN_2_COLORS.navy },
  },
  colors: {
    qrDark: '#000000',
    qrBorder: '#FFFFFF',
    watermarkRevoked: QUIZORA_2026_COLORS.watermarkRevoked,
    watermarkSuperseded: QUIZORA_2026_COLORS.watermarkSuperseded,
  },
  defaultBodyText: QUIZORA_2026_DESIGN_2_DEFAULT_BODY_TEXT,
  layout: {
    width: 1536,
    height: 1024,
    statementPatch: { x: 360, y: 484, width: 840, height: 432 },
    /** Script name above the gold divider (y = 584) under "This is to certify that". */
    name: {
      centerX: 768,
      baselineY: 557,
      maxWidth: 690,
      startSize: 89,
      minSize: 50,
      twoLineStartSize: 42,
      twoLineMinSize: 30,
      twoLineBaselines: [522, 566],
    },
    statement: {
      centerX: 768,
      middleBaselineY: 696.5,
      maxWidth: 840,
      startSize: 29.8,
      minSize: 18,
      lineGapRatio: 1.398,
      maxBlockHeight: 156,
      superscriptScale: 0.58,
      superscriptRise: 0.36,
    },
    /** Above the printed rules (y = 845): left 366–601, right 950–1193. */
    signatureSlots: [
      { sortOrder: 0, label: 'Event Coordinator', box: { x: 383, y: 774, width: 201, height: 68 } },
      { sortOrder: 1, label: 'Director', box: { x: 971, y: 774, width: 201, height: 68 } },
    ],
    /** Bottom-centre QR at the reference QR position (714–817 × 810–907). */
    qr: {
      x: 710,
      y: 802,
      size: 112,
      padding: 0,
      quietZoneModules: 2,
      frame: 'plain',
      captionHeight: 0,
      caption: null,
      captionSize: 9,
    },
    /** Two centred footer lines in the clear band between the QR and the bottom wave. */
    metadata: {
      fontSize: 11,
      minFontSize: 8,
      lineGap: 14,
      blocks: [
        {
          centerX: 768,
          firstBaselineY: 924,
          maxWidth: 620,
          rows: [['completed', 'issued', 'certificateId'], ['verify']],
        },
      ],
    },
  },
};

export const ARTWORK_TEMPLATE_DEFINITIONS: readonly ArtworkTemplateDefinition[] = [
  QUIZORA_2026_DEFINITION,
  QUIZORA_2026_DESIGN_2_DEFINITION,
];

/** Definition of an artwork template style, or null for vector (non-artwork) layouts. */
export function artworkTemplateForStyle(
  style: string | null | undefined,
): ArtworkTemplateDefinition | null {
  return ARTWORK_TEMPLATE_DEFINITIONS.find((def) => def.style === style) ?? null;
}

/** True when the template uses a fixed reference artwork (statement-only customization). */
export function isArtworkCertificateStyle(style: string | null | undefined): boolean {
  return artworkTemplateForStyle(style) !== null;
}

// ---------------------------------------------------------------------------------------------
// Text model
// ---------------------------------------------------------------------------------------------

export interface CertificateTextRun {
  text: string;
  variant: CertificateTextVariant;
}

/** Width in artwork pixels of `text` drawn in `variant` at `fontSize`. */
export type CertificateTextMeasurer = (
  text: string,
  variant: CertificateTextVariant,
  fontSize: number,
) => number;

export interface LaidOutSegment {
  text: string;
  variant: CertificateTextVariant;
  x: number;
  width: number;
  fontSize: number;
  /** Vertical offset from the line baseline (negative = raised, e.g. ordinal suffix). */
  dy: number;
}

export interface LaidOutLine {
  segments: LaidOutSegment[];
  width: number;
  baselineY: number;
}

export interface CertificateTextBlockLayout {
  fontSize: number;
  lines: LaidOutLine[];
  truncated: boolean;
}

function toDate(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function dateParts(value: Date | string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).formatToParts(toDate(value));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return { day: Number(get('day')), month: get('month'), year: get('year') };
}

export function ordinalSuffix(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/** "14th November 2026" split for superscript rendering of the ordinal suffix. */
export function formatCertificateOrdinalDate(
  value: Date | string,
  timeZone: string = QUIZORA_2026_TIME_ZONE,
): { day: string; suffix: string; rest: string } {
  const { day, month, year } = dateParts(value, timeZone);
  return { day: String(day), suffix: ordinalSuffix(day), rest: ` ${month} ${year}` };
}

/** "November 14, 2026" — used for the certificate metadata lines. */
export function formatCertificateLongDate(
  value: Date | string,
  timeZone: string = QUIZORA_2026_TIME_ZONE,
): string {
  const { day, month, year } = dateParts(value, timeZone);
  return `${month} ${day}, ${year}`;
}

const STATEMENT_TOKEN = /(\*\*[^*\n]+?\*\*|\{\s*title\s*\}|\{\s*date\s*\})/gi;

/**
 * Parses the template statement into paragraphs (forced line breaks) of styled runs.
 * Only `{title}`, `{date}` and `**bold**` are interpreted; everything else is literal text.
 */
export function buildCertificateStatementRuns(
  template: string,
  values: { title: string; date: Date | string; timeZone?: string },
): CertificateTextRun[][] {
  const timeZone = values.timeZone ?? QUIZORA_2026_TIME_ZONE;
  const title = values.title.replace(/\s+/g, ' ').trim() || 'Certificate';
  const date = formatCertificateOrdinalDate(values.date, timeZone);

  return template
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((paragraph) => {
      const runs: CertificateTextRun[] = [];
      const push = (text: string, variant: CertificateTextVariant) => {
        if (!text) return;
        const last = runs[runs.length - 1];
        if (last && last.variant === variant) last.text += text;
        else runs.push({ text, variant });
      };
      for (const piece of paragraph.split(STATEMENT_TOKEN)) {
        if (!piece) continue;
        if (/^\{\s*title\s*\}$/i.test(piece)) {
          push(title, 'title');
        } else if (/^\{\s*date\s*\}$/i.test(piece)) {
          push(date.day, 'date');
          push(date.suffix, 'dateSuffix');
          push(date.rest, 'date');
        } else if (/^\*\*[^*\n]+?\*\*$/.test(piece)) {
          push(piece.slice(2, -2), 'emphasis');
        } else {
          push(piece.replace(/\s+/g, ' '), 'body');
        }
      }
      // Trim outer whitespace of the paragraph.
      if (runs[0]) runs[0].text = runs[0].text.replace(/^\s+/, '');
      const tail = runs[runs.length - 1];
      if (tail) tail.text = tail.text.replace(/\s+$/, '');
      return runs.filter((r) => r.text.length > 0);
    })
    .filter((paragraph) => paragraph.length > 0);
}

interface WordPart {
  text: string;
  variant: CertificateTextVariant;
  /** Extra horizontal advance (in em of the line font size) for an empty spacer part. */
  spacerEm?: number;
}

/**
 * Extra space (em) where a word space separates two different font faces, e.g. italic "the" →
 * bold-italic "ASRA": the slanted capitals otherwise visually swallow Pagella's 0.25em space.
 */
const STYLE_BOUNDARY_SPACER_EM = 0.05;
/** Gap (em) between a metadata label ("ISSUED DATE:") and its value. */
const METADATA_LABEL_SPACER_EM = 0.5;
/** Gap (em) on each side of the "·" separating metadata fields that share a row. */
const METADATA_FIELD_SPACER_EM = 0.7;

type Token =
  { kind: 'word'; parts: WordPart[] } | { kind: 'space'; variant: CertificateTextVariant };

function tokenize(paragraph: CertificateTextRun[]): Token[] {
  const tokens: Token[] = [];
  let current: WordPart[] | null = null;
  for (const run of paragraph) {
    for (const piece of run.text.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        if (current) {
          tokens.push({ kind: 'word', parts: current });
          current = null;
        }
        if (tokens.length > 0 && tokens[tokens.length - 1]!.kind !== 'space') {
          tokens.push({ kind: 'space', variant: run.variant });
        }
      } else {
        (current ??= []).push({ text: piece, variant: run.variant });
      }
    }
  }
  if (current) tokens.push({ kind: 'word', parts: current });
  while (tokens.length > 0 && tokens[tokens.length - 1]!.kind === 'space') tokens.pop();
  return tokens;
}

function sizeFor(
  variant: CertificateTextVariant,
  fontSize: number,
  def: ArtworkTemplateDefinition,
): number {
  const base =
    variant === 'dateSuffix' ? fontSize * def.layout.statement.superscriptScale : fontSize;
  const scale = def.variantStyles[variant].scale;
  return scale === undefined ? base : base * scale;
}

function buildLineSegments(
  parts: WordPart[],
  measure: CertificateTextMeasurer,
  fontSize: number,
  centerX: number,
  baselineY: number,
  def: ArtworkTemplateDefinition,
): LaidOutLine {
  const merged: WordPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && last.variant === part.variant && !last.spacerEm && !part.spacerEm) {
      last.text += part.text;
    } else {
      merged.push({ ...part });
    }
  }
  const widths = merged.map((p) =>
    p.spacerEm
      ? p.spacerEm * fontSize
      : measure(p.text, p.variant, sizeFor(p.variant, fontSize, def)),
  );
  const width = widths.reduce((a, b) => a + b, 0);
  let x = centerX - width / 2;
  const segments = merged.map((p, i) => {
    const riseScale = def.variantStyles[p.variant].scale;
    const seg: LaidOutSegment = {
      text: p.spacerEm ? '' : p.text,
      variant: p.variant,
      x,
      width: widths[i]!,
      fontSize: sizeFor(p.variant, fontSize, def),
      dy:
        p.variant === 'dateSuffix'
          ? -fontSize *
            def.layout.statement.superscriptRise *
            (riseScale === undefined ? 1 : riseScale)
          : 0,
    };
    x += widths[i]!;
    return seg;
  });
  return { segments: segments.filter((s) => s.text.length > 0), width, baselineY };
}

function wrapParagraphs(
  paragraphs: CertificateTextRun[][],
  measure: CertificateTextMeasurer,
  fontSize: number,
  maxWidth: number,
  def: ArtworkTemplateDefinition,
): { lines: WordPart[][]; widths: number[] } {
  const lines: WordPart[][] = [];
  const widths: number[] = [];
  const wordWidth = (parts: WordPart[]) =>
    parts.reduce(
      (sum, p) => sum + measure(p.text, p.variant, sizeFor(p.variant, fontSize, def)),
      0,
    );

  for (const paragraph of paragraphs) {
    let line: WordPart[] = [];
    let lineWidth = 0;
    let pendingSpace: CertificateTextVariant | null = null;
    for (const token of tokenize(paragraph)) {
      if (token.kind === 'space') {
        pendingSpace = token.variant;
        continue;
      }
      const w = wordWidth(token.parts);
      const spaceVariant = pendingSpace ?? 'body';
      const prevVariant = line[line.length - 1]?.variant;
      const boundary =
        prevVariant !== undefined &&
        def.variantStyles[prevVariant].face !== def.variantStyles[token.parts[0]!.variant].face
          ? STYLE_BOUNDARY_SPACER_EM
          : 0;
      const spaceW =
        line.length > 0
          ? measure(' ', spaceVariant, sizeFor(spaceVariant, fontSize, def)) + boundary * fontSize
          : 0;
      if (line.length > 0 && lineWidth + spaceW + w > maxWidth) {
        lines.push(line);
        widths.push(lineWidth);
        line = [...token.parts.map((p) => ({ ...p }))];
        lineWidth = w;
      } else {
        if (line.length > 0) {
          line.push({ text: ' ', variant: spaceVariant });
          if (boundary > 0) line.push({ text: '', variant: spaceVariant, spacerEm: boundary });
        }
        line.push(...token.parts.map((p) => ({ ...p })));
        lineWidth += spaceW + w;
      }
      pendingSpace = null;
    }
    if (line.length > 0) {
      lines.push(line);
      widths.push(lineWidth);
    }
  }
  return { lines, widths };
}

function tryLayoutStatement(
  paragraphs: CertificateTextRun[][],
  measure: CertificateTextMeasurer,
  fontSize: number,
  def: ArtworkTemplateDefinition,
): CertificateTextBlockLayout | null {
  const cfg = def.layout.statement;
  const { lines, widths } = wrapParagraphs(paragraphs, measure, fontSize, cfg.maxWidth, def);
  if (lines.length === 0) return { fontSize, lines: [], truncated: false };
  if (widths.some((w) => w > cfg.maxWidth + 0.01)) return null;
  const gap = fontSize * cfg.lineGapRatio;
  const blockHeight = (lines.length - 1) * gap + fontSize;
  if (blockHeight > cfg.maxBlockHeight + 0.01) return null;
  const firstBaseline = cfg.middleBaselineY - ((lines.length - 1) * gap) / 2;
  return {
    fontSize,
    truncated: false,
    lines: lines.map((parts, i) =>
      buildLineSegments(parts, measure, fontSize, cfg.centerX, firstBaseline + i * gap, def),
    ),
  };
}

function withTruncatedTitle(
  paragraphs: CertificateTextRun[][],
  keepChars: number,
): CertificateTextRun[][] {
  return paragraphs.map((paragraph) =>
    paragraph.map((run) =>
      run.variant === 'title' && run.text.length > keepChars
        ? { ...run, text: `${run.text.slice(0, keepChars).trimEnd()}…` }
        : run,
    ),
  );
}

/**
 * Fits the statement into the artwork's statement band: shrinks from the reference size down to
 * `minSize`; if it still does not fit, the title is ellipsized.
 */
export function layoutCertificateStatement(
  paragraphs: CertificateTextRun[][],
  measure: CertificateTextMeasurer,
  def: ArtworkTemplateDefinition = QUIZORA_2026_DEFINITION,
): CertificateTextBlockLayout {
  const cfg = def.layout.statement;
  for (let size = cfg.startSize; size >= cfg.minSize - 0.001; size -= 0.5) {
    const layout = tryLayoutStatement(paragraphs, measure, size, def);
    if (layout) return layout;
  }
  const longestTitle = Math.max(
    0,
    ...paragraphs
      .flat()
      .filter((r) => r.variant === 'title')
      .map((r) => r.text.length),
  );
  for (let keep = longestTitle - 1; keep >= 1; keep--) {
    const layout = tryLayoutStatement(
      withTruncatedTitle(paragraphs, keep),
      measure,
      cfg.minSize,
      def,
    );
    if (layout) return { ...layout, truncated: true };
  }
  // Pathological template text: hard-wrap at minimum size and let the band clip nothing else.
  const { lines } = wrapParagraphs(paragraphs, measure, cfg.minSize, cfg.maxWidth, def);
  const gap = cfg.minSize * cfg.lineGapRatio;
  const firstBaseline = cfg.middleBaselineY - ((lines.length - 1) * gap) / 2;
  return {
    fontSize: cfg.minSize,
    truncated: true,
    lines: lines.map((parts, i) =>
      buildLineSegments(parts, measure, cfg.minSize, cfg.centerX, firstBaseline + i * gap, def),
    ),
  };
}

function ellipsize(
  text: string,
  measure: CertificateTextMeasurer,
  variant: CertificateTextVariant,
  size: number,
  maxWidth: number,
): string {
  if (measure(text, variant, size) <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && measure(`${text.slice(0, end).trimEnd()}…`, variant, size) > maxWidth) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Recipient name: one line shrinking from the reference size to `minSize`; longer names wrap
 * onto two balanced lines; anything longer is ellipsized. Never overlaps neighbouring artwork.
 */
export function layoutCertificateRecipientName(
  rawName: string,
  measure: CertificateTextMeasurer,
  def: ArtworkTemplateDefinition = QUIZORA_2026_DEFINITION,
): CertificateTextBlockLayout {
  const cfg = def.layout.name;
  const name = rawName.replace(/\s+/g, ' ').trim() || 'Recipient Name';
  const line = (text: string, size: number, baselineY: number): LaidOutLine => {
    const width = measure(text, 'name', size);
    return {
      width,
      baselineY,
      segments: [
        { text, variant: 'name', x: cfg.centerX - width / 2, width, fontSize: size, dy: 0 },
      ],
    };
  };

  for (let size = cfg.startSize; size >= cfg.minSize - 0.001; size -= 1) {
    if (measure(name, 'name', size) <= cfg.maxWidth) {
      return { fontSize: size, truncated: false, lines: [line(name, size, cfg.baselineY)] };
    }
  }

  const words = name.split(' ');
  if (words.length > 1) {
    // Balanced split: the break that minimizes the wider of the two lines.
    let best = { first: name, second: '', widest: Infinity };
    for (let i = 1; i < words.length; i++) {
      const first = words.slice(0, i).join(' ');
      const second = words.slice(i).join(' ');
      const widest = Math.max(
        measure(first, 'name', cfg.twoLineStartSize),
        measure(second, 'name', cfg.twoLineStartSize),
      );
      if (widest < best.widest) best = { first, second, widest };
    }
    for (let size = cfg.twoLineStartSize; size >= cfg.twoLineMinSize - 0.001; size -= 1) {
      if (
        measure(best.first, 'name', size) <= cfg.maxWidth &&
        measure(best.second, 'name', size) <= cfg.maxWidth
      ) {
        return {
          fontSize: size,
          truncated: false,
          lines: [
            line(best.first, size, cfg.twoLineBaselines[0]),
            line(best.second, size, cfg.twoLineBaselines[1]),
          ],
        };
      }
    }
    const size = cfg.twoLineMinSize;
    return {
      fontSize: size,
      truncated: true,
      lines: [
        line(
          ellipsize(best.first, measure, 'name', size, cfg.maxWidth),
          size,
          cfg.twoLineBaselines[0],
        ),
        line(
          ellipsize(best.second, measure, 'name', size, cfg.maxWidth),
          size,
          cfg.twoLineBaselines[1],
        ),
      ],
    };
  }

  const size = cfg.minSize;
  return {
    fontSize: size,
    truncated: true,
    lines: [line(ellipsize(name, measure, 'name', size, cfg.maxWidth), size, cfg.baselineY)],
  };
}

export interface CertificateMetadataValues {
  completedAt: Date | string;
  issuedAt: Date | string;
  certificateNumber: string;
  verificationUrl: string;
  timeZone?: string;
}

/**
 * Metadata lines (completion / issue dates, certificate ID, verification URL) positioned per
 * template. Never includes scores, ranks or marks.
 */
export function layoutCertificateMetadata(
  values: CertificateMetadataValues,
  measure: CertificateTextMeasurer,
  def: ArtworkTemplateDefinition = QUIZORA_2026_DEFINITION,
): LaidOutLine[] {
  const cfg = def.layout.metadata;
  const tz = values.timeZone ?? QUIZORA_2026_TIME_ZONE;
  const fieldText = (field: ArtworkMetadataField): [string, string] => {
    switch (field) {
      case 'completed':
        return ['COMPLETION DATE:', formatCertificateLongDate(values.completedAt, tz)];
      case 'issued':
        return ['ISSUED DATE:', formatCertificateLongDate(values.issuedAt, tz)];
      case 'certificateId':
        return ['CERTIFICATE ID:', values.certificateNumber];
      case 'verifyLabel':
        return ['VERIFY AT:', ''];
      case 'verifyUrl':
        return ['', values.verificationUrl];
      case 'verify':
        return ['VERIFY AT:', values.verificationUrl];
    }
  };
  const rowParts = (row: readonly ArtworkMetadataField[]): WordPart[] => {
    const parts: WordPart[] = [];
    row.forEach((field, i) => {
      if (i > 0) {
        parts.push({ text: '', variant: 'metaLabel', spacerEm: METADATA_FIELD_SPACER_EM });
        parts.push({ text: '·', variant: 'metaLabel' });
        parts.push({ text: '', variant: 'metaLabel', spacerEm: METADATA_FIELD_SPACER_EM });
      }
      const [label, value] = fieldText(field);
      if (label) parts.push({ text: label, variant: 'metaLabel' });
      if (label && value) {
        parts.push({ text: '', variant: 'metaLabel', spacerEm: METADATA_LABEL_SPACER_EM });
      }
      if (value) parts.push({ text: value, variant: 'metaValue' });
    });
    return parts;
  };

  const out: LaidOutLine[] = [];
  for (const block of cfg.blocks) {
    const rows = block.rows.map(rowParts);
    const rowWidth = (parts: WordPart[], size: number) =>
      parts.reduce(
        (sum, p) => sum + (p.spacerEm ? p.spacerEm * size : measure(p.text, p.variant, size)),
        0,
      );
    let size: number = cfg.fontSize;
    while (size > cfg.minFontSize && rows.some((r) => rowWidth(r, size) > block.maxWidth)) {
      size -= 0.25;
    }
    rows.forEach((parts, i) => {
      out.push(
        buildLineSegments(
          parts,
          measure,
          size,
          block.centerX,
          block.firstBaselineY + i * cfg.lineGap,
          def,
        ),
      );
    });
  }
  return out;
}
