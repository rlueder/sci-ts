export interface Glyph {
  width: number;
  height: number;
  /** 1 byte per pixel, 1 = ink. */
  pixels: Uint8Array;
}

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
  const out = new Uint8Array(6 + count * 2 + bodies.reduce((n, b) => n + b.length, 0));
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
  return out;
}

export const textWidth = (font: Font, text: string): number =>
  [...text].reduce((w, ch) => w + (font.glyphs[ch.charCodeAt(0)]?.width ?? 0), 0);

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

/** Renders already-wrapped lines, each aligned within the bitmap width. */
export function renderText(font: Font, lines: string[], align: "left" | "center" = "left"): TextBitmap {
  const width = Math.max(1, ...lines.map((l) => textWidth(font, l)));
  const height = Math.max(1, lines.length * font.height);
  const pixels = new Uint8Array(width * height);

  lines.forEach((line, row) => {
    let x = align === "center" ? Math.floor((width - textWidth(font, line)) / 2) : 0;
    for (const ch of line) {
      const g = font.glyphs[ch.charCodeAt(0)];
      if (!g) continue;
      for (let gy = 0; gy < g.height; gy++) {
        for (let gx = 0; gx < g.width; gx++) {
          if (g.pixels[gy * g.width + gx]) pixels[(row * font.height + gy) * width + x + gx] = 1;
        }
      }
      x += g.width;
    }
  });
  return { width, height, pixels };
}
