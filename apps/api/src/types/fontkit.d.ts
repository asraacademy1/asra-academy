/**
 * Minimal typings for the subset of `fontkit` (v2) used by the certificate renderers
 * (fontkit ships no type declarations). Coordinates are in font units (y axis up).
 */
declare module 'fontkit' {
  export interface FontkitPath {
    toSVG(): string;
  }

  export interface FontkitGlyph {
    id: number;
    path: FontkitPath;
    advanceWidth: number;
  }

  export interface FontkitGlyphPosition {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }

  export interface FontkitGlyphRun {
    glyphs: FontkitGlyph[];
    positions: FontkitGlyphPosition[];
    advanceWidth: number;
  }

  export interface FontkitFont {
    unitsPerEm: number;
    ascent: number;
    descent: number;
    familyName: string;
    postscriptName: string;
    layout(text: string, features?: string[] | Record<string, boolean>): FontkitGlyphRun;
  }

  export function create(buffer: Buffer | Uint8Array, postscriptName?: string): FontkitFont;
}
