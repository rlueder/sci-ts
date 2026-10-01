import type { Palette } from "./palette.ts";
import type { PicCel } from "./pic.ts";

/**
 * A pic resource with everything needed to write it back byte for byte. Measured on all 59
 * pics of an SCI2 game (every one has this exact layout; all cels are uncompressed):
 *
 *   +0  u16 header size (14)  +2 u8 cel count  +3 u8 0  +4 u16 cel header size (42)
 *   +6  u32 palette offset    +10 u16/u16 resolution (320,200, or 0,0 meaning the default)
 *   cel headers, 42 bytes each:
 *     +0 u16 width  +2 u16 height  +4 i16 displaceX  +6 i16 displaceY  +8 u8 skip colour
 *     +9 u8 compression (0 = raw)  +10 u16 0  +12 u32 pixel bytes (w*h)
 *     +16 u32 `unknown16` (2768 in most pics, 6 in a few; the engine ignores it)
 *     +20 u32 0  +24 u32 pixel offset  +28 u32 0  +32 u32 0
 *     +36 i16 priority  +38 i16 x  +40 i16 y
 *   00 03 u32 palette size | hunk palette
 *   00 04 u32 pixel bytes  | each cel's pixels, in cel order
 */
export interface PicFile {
  resolution: [number, number];
  cels: (PicCel & { unknown16: number })[];
  palette: HunkPaletteFile;
}

/**
 * A hunk palette with its exact header bytes. Pics use one entry: `first` and
 * `count` colours, each with its own "used" flag (4 bytes per colour) unless `shared`.
 */
export interface HunkPaletteFile {
  /** The 13-byte hunk header (byte 0 = 14, byte 10 = entry count = 1). */
  header: Uint8Array;
  /** The first 10 bytes of the entry header (editor data; varies, never read). */
  entryPrefix: Uint8Array;
  first: number;
  used: number[];
  rgb: [number, number, number][];
  /** Shared "used" flag: every colour is 3 bytes and takes `defaultUsed`. */
  shared: boolean;
  defaultUsed: number;
}

const PIC_HEADER = 14;
const CEL_HEADER = 42;

export function parseHunkPaletteFile(data: Uint8Array, offset: number): HunkPaletteFile {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[offset + 10] !== 1) throw new Error(`Hunk palette with ${data[offset + 10]} entries: only 1 is supported`);
  const entry = offset + 13 + 2;
  const first = data[entry + 10]!;
  const count = v.getUint16(entry + 14, true);
  const defaultUsed = data[entry + 16]!;
  const shared = data[entry + 17]! !== 0;
  const used: number[] = [], rgb: [number, number, number][] = [];
  let p = entry + 22;
  for (let i = 0; i < count; i++) {
    used.push(shared ? defaultUsed : data[p++]!);
    rgb.push([data[p]!, data[p + 1]!, data[p + 2]!]);
    p += 3;
  }
  return { header: data.slice(offset, offset + 13), entryPrefix: data.slice(entry, entry + 10), first, used, rgb, shared, defaultUsed };
}

export function writeHunkPalette(p: HunkPaletteFile): Uint8Array {
  const colors = p.rgb.length * (p.shared ? 3 : 4);
  const out = new Uint8Array(13 + 2 + 22 + colors);
  const v = new DataView(out.buffer);
  out.set(p.header, 0);
  out[10] = 1;
  v.setUint16(13, 22 + colors, true);
  const entry = 15;
  out.set(p.entryPrefix, entry);
  out[entry + 10] = p.first;
  v.setUint16(entry + 14, p.rgb.length, true);
  out[entry + 16] = p.defaultUsed;
  out[entry + 17] = p.shared ? 1 : 0;
  let o = entry + 22;
  p.rgb.forEach((c, i) => {
    if (!p.shared) out[o++] = p.used[i]!;
    out.set(c, o);
    o += 3;
  });
  return out;
}

export function parsePicFile(data: Uint8Array): PicFile {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = data[2]!;
  const cels = Array.from({ length: count }, (_, i) => {
    const h = PIC_HEADER + CEL_HEADER * i;
    if (data[h + 9] !== 0) throw new Error(`Compressed pic cels aren't supported (cel ${i})`);
    const width = v.getUint16(h, true), height = v.getUint16(h + 2, true);
    const at = v.getUint32(h + 24, true);
    return {
      width, height,
      displaceX: v.getInt16(h + 4, true), displaceY: v.getInt16(h + 6, true),
      skipColor: data[h + 8]!,
      pixels: data.slice(at, at + width * height),
      unknown16: v.getUint32(h + 16, true),
      priority: v.getInt16(h + 36, true), x: v.getInt16(h + 38, true), y: v.getInt16(h + 40, true),
    };
  });
  return { resolution: [v.getUint16(10, true), v.getUint16(12, true)], cels, palette: parseHunkPaletteFile(data, v.getUint32(6, true)) };
}

export function writePic(pic: PicFile): Uint8Array {
  const palette = writeHunkPalette(pic.palette);
  const headers = PIC_HEADER + CEL_HEADER * pic.cels.length;
  const paletteAt = headers + 6;
  const pixelsAt = paletteAt + palette.length + 6;
  const pixelBytes = pic.cels.reduce((n, c) => n + c.width * c.height, 0);
  const out = new Uint8Array(pixelsAt + pixelBytes);
  const v = new DataView(out.buffer);
  v.setUint16(0, PIC_HEADER, true);
  out[2] = pic.cels.length;
  v.setUint16(4, CEL_HEADER, true);
  v.setUint32(6, paletteAt, true);
  v.setUint16(10, pic.resolution[0], true);
  v.setUint16(12, pic.resolution[1], true);
  let at = pixelsAt;
  pic.cels.forEach((c, i) => {
    const h = PIC_HEADER + CEL_HEADER * i;
    if (c.pixels.length !== c.width * c.height) throw new Error(`cel ${i}: ${c.pixels.length} pixels for ${c.width}x${c.height}`);
    v.setUint16(h, c.width, true);
    v.setUint16(h + 2, c.height, true);
    v.setInt16(h + 4, c.displaceX, true);
    v.setInt16(h + 6, c.displaceY, true);
    out[h + 8] = c.skipColor;
    v.setUint32(h + 12, c.width * c.height, true);
    v.setUint32(h + 16, c.unknown16, true);
    v.setUint32(h + 24, at, true);
    v.setInt16(h + 36, c.priority, true);
    v.setInt16(h + 38, c.x, true);
    v.setInt16(h + 40, c.y, true);
    out.set(c.pixels, at);
    at += c.pixels.length;
  });
  out.set([0, 3], headers);
  v.setUint32(headers + 2, palette.length, true);
  out.set(palette, paletteAt);
  out.set([0, 4], paletteAt + palette.length);
  v.setUint32(paletteAt + palette.length + 2, pixelBytes, true);
  return out;
}

/** The palette a pic installs, as the engine sees it. */
export function hunkToPalette(p: HunkPaletteFile): Palette {
  const pal: Palette = { rgb: new Uint8Array(768), used: new Uint8Array(256) };
  p.rgb.forEach((c, i) => {
    const idx = p.first + i;
    if (idx > 255) return;
    pal.used[idx] = p.used[i]!;
    pal.rgb.set(c, idx * 3);
  });
  return pal;
}
