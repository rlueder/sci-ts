import type { Font, Glyph } from "@sci-ts/sci";
import type { Rgba } from "../png.ts";

/**
 * A font from a sheet of glyphs drawn in a paint program: a grid of same-size cells, one
 * character per cell, left to right and top to bottom from `first`. A glyph is drawn from
 * its cell's left edge; any opaque pixel is ink (its colour doesn't matter: text takes its
 * colour when it's drawn), and its width is up to its rightmost ink. A cell with no ink is
 * a character the font doesn't have, except the space, which is `space` pixels wide.
 */
export interface FontSheet {
  /** Cell size in pixels: [width, height]. */
  cell: [number, number];
  /** The character in the first cell (default 32, the space). */
  first?: number;
  /** Pixels between one glyph and the next (default 1). */
  spacing?: number;
  /** Width of the space (default half a cell). */
  space?: number;
  /** Line height (default the cell height). */
  lineHeight?: number;
}

export class FontSheetError extends Error {}

export function fontFromSheet(img: Rgba, sheet: FontSheet): Font {
  const [cw, ch] = sheet.cell;
  const first = sheet.first ?? 32, spacing = sheet.spacing ?? 1;
  const space = sheet.space ?? Math.max(1, cw >> 1), lineHeight = sheet.lineHeight ?? ch;
  const fail = (message: string): never => { throw new FontSheetError(message); };
  if (img.width % cw || img.height % ch) fail(`${img.width}x${img.height} is not a whole number of ${cw}x${ch} cells`);
  const columns = img.width / cw, cells = columns * (img.height / ch);
  if (first + cells > 256) fail(`${cells} cells from character ${first} go past 255`);
  if (lineHeight < 1 || lineHeight > 255) fail(`line height ${lineHeight} is outside 1..255`);

  const glyphs: Glyph[] = Array.from({ length: Math.max(128, first + cells) }, () => ({ width: 0, height: 0, pixels: new Uint8Array(0) }));
  for (let i = 0; i < cells; i++) {
    const left = (i % columns) * cw, top = Math.floor(i / columns) * ch;
    const ink = new Uint8Array(cw * ch);
    let right = -1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const a = img.data[((top + y) * img.width + left + x) * 4 + 3]!;
        if (a !== 0 && a !== 255) fail(`character ${first + i} (${left + x},${top + y}): alpha ${a}; export without antialiasing`);
        if (a) (ink[y * cw + x] = 1), (right = Math.max(right, x));
      }
    }
    const code = first + i;
    if (right < 0 && code !== 32) continue;
    const inked = right + 1, width = (code === 32 && right < 0 ? space : inked + spacing);
    const pixels = new Uint8Array(width * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < inked; x++) pixels[y * width + x] = ink[y * cw + x]!;
    glyphs[code] = { width, height: ch, pixels };
  }
  return { height: lineHeight, glyphs };
}
