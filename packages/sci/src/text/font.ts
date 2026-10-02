export interface Glyph {
  width: number;
  height: number;
  /** 1 byte per pixel, 1 = ink. */
  pixels: Uint8Array;
  /** Where the bitmap starts from the pen (default 0); it can be left of it, an italic j's tail. */
  bearingX?: number;
  /** How far the pen moves on (default the width); ink can reach past it. */
  advance?: number;
}

/** How far the pen moves on after a glyph. */
export const advanceOf = (g: Glyph) => g.advance ?? g.width;

/** The extension at the end of a font resource with bearings and advances: see writeFont. */
const METRICS_TAG = [0x58, 0x4d, 0x54, 0x31]; // "XMT1"
const hasOwnMetrics = (g: Glyph | undefined) => !!g && ((g.bearingX ?? 0) !== 0 || (g.advance ?? g.width) !== g.width);

export interface Font {
  /** Line height in pixels. */
  height: number;
  /** Indexed by character code; missing codes are undefined. */
  glyphs: (Glyph | undefined)[];
}

/**
 * SCI bitmap font (unchanged since SCI0):
 *
 *   +0 u16 first char (unused in practice)
 *   +2 u16 char count
 *   +4 u16 line height
 *   +6 u16 offset per char
 *
 * Each glyph: u8 width, u8 height, then rows of 1bpp pixels, MSB first,
 * each row padded to a whole byte.
 *
 * A font can also carry each glyph's bearing and advance (writeFont adds them when any glyph
 * has its own): after the glyphs, i8 bearing and u8 advance per character, then "XMT1". SCI
 * reads glyphs by their offsets and never gets there; without it, bearings are 0 and
 * advances the widths, as fonts always were.
 */
export function parseFont(data: Uint8Array): Font {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = v.getUint16(2, true);
  const height = v.getUint16(4, true);

  const glyphs: (Glyph | undefined)[] = [];
  for (let c = 0; c < count; c++) {
    const offset = v.getUint16(6 + c * 2, true);
    const width = data[offset]!;
    const h = data[offset + 1]!;
    const stride = Math.ceil(width / 8);
    const pixels = new Uint8Array(width * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < width; x++) {
        const byte = data[offset + 2 + y * stride + (x >> 3)]!;
        pixels[y * width + x] = (byte >> (7 - (x & 7))) & 1;
      }
    }
    glyphs[c] = { width, height: h, pixels };
  }
  const tagAt = data.length - 4;
  if (tagAt - count * 2 >= 6 + count * 2 && METRICS_TAG.every((b, i) => data[tagAt + i] === b)) {
    const at = tagAt - count * 2;
    glyphs.forEach((g, c) => {
      if (!g) return;
      const bearing = (data[at + c * 2]! << 24) >> 24, advance = data[at + c * 2 + 1]!;
      if (bearing) g.bearingX = bearing;
      if (advance !== g.width) g.advance = advance;
    });
  }
  return { height, glyphs };
}

/** A font resource (the inverse of parseFont). Missing glyphs are written as 0×0. */
export function writeFont(font: Font): Uint8Array {
  const count = font.glyphs.length;
  const bodies = Array.from({ length: count }, (_, c) => {
    const g = font.glyphs[c] ?? { width: 0, height: 0, pixels: new Uint8Array(0) };
    if (g.width > 255 || g.height > 255) throw new Error(`glyph ${c} is ${g.width}x${g.height}`);
    const stride = Math.ceil(g.width / 8);
    const out = new Uint8Array(2 + stride * g.height);
    out[0] = g.width;
    out[1] = g.height;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) if (g.pixels[y * g.width + x]) out[2 + y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
    }
    return out;
  });
  const metrics = font.glyphs.some(hasOwnMetrics);
  const bodySize = bodies.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(6 + count * 2 + bodySize + (metrics ? count * 2 + 4 : 0));
  const v = new DataView(out.buffer);
  v.setUint16(2, count, true);
  v.setUint16(4, font.height, true);
  let at = 6 + count * 2;
  bodies.forEach((b, c) => {
    if (at > 0xffff) throw new Error("font too large: offsets are 16-bit");
    v.setUint16(6 + c * 2, at, true);
    out.set(b, at);
    at += b.length;
  });
  if (metrics) {
    font.glyphs.forEach((g, c) => {
      const bearing = g?.bearingX ?? 0, advance = g ? advanceOf(g) : 0;
      if (bearing < -128 || bearing > 127 || advance < 0 || advance > 255) throw new Error(`glyph ${c}: bearing ${bearing}, advance ${advance}`);
      out[at + c * 2] = bearing & 0xff;
      out[at + c * 2 + 1] = advance;
    });
    out.set(METRICS_TAG, at + count * 2);
  }
  return out;
}

export const textWidth = (font: Font, text: string): number =>
  [...text].reduce((w, ch) => { const g = font.glyphs[ch.charCodeAt(0)]; return w + (g ? advanceOf(g) : 0); }, 0);

/** Splits text into lines no wider than `maxWidth`, breaking at spaces and honouring CR/LF. */
export function wrapText(font: Font, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = "";
    for (const word of paragraph.split(/(?<= )/)) {
      if (line && textWidth(font, (line + word).trimEnd()) > maxWidth) {
        lines.push(line.trimEnd());
        line = "";
      }
      line += word;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** A 1-byte-per-pixel ink mask of rendered text. */
export interface TextBitmap {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * Renders already-wrapped lines, each aligned within the line width. Ink that starts left of
 * the pen or runs past the last advance (an italic's first and last letters) is kept: the
 * bitmap grows to hold it, and `originX` says where the pen started.
 */
export function renderText(font: Font, lines: string[], align: "left" | "center" = "left"): TextBitmap & { originX: number } {
  const lineWidth = Math.max(1, ...lines.map((l) => textWidth(font, l)));
  const pens = lines.map((line) => {
    let x = align === "center" ? Math.floor((lineWidth - textWidth(font, line)) / 2) : 0;
    return [...line].flatMap((ch) => {
      const g = font.glyphs[ch.charCodeAt(0)];
      if (!g) return [];
      const at = { g, x: x + (g.bearingX ?? 0) };
      x += advanceOf(g);
      return [at];
    });
  });
  const inks = pens.flat();
  const left = Math.min(0, ...inks.map((p) => p.x)), right = Math.max(lineWidth, ...inks.map((p) => p.x + p.g.width));
  const width = right - left;
  const height = Math.max(1, lines.length * font.height);
  const pixels = new Uint8Array(width * height);
  pens.forEach((row, r) => {
    for (const { g, x } of row) {
      for (let gy = 0; gy < g.height && r * font.height + gy < height; gy++) {
        for (let gx = 0; gx < g.width; gx++) {
          if (g.pixels[gy * g.width + gx]) pixels[(r * font.height + gy) * width + x - left + gx] = 1;
        }
      }
    }
  });
  return { width, height, pixels, originX: -left };
}
