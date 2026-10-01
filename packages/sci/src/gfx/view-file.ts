import type { Cel } from "./cel.ts";
import { decodeCel } from "./cel.ts";
import { parseHunkPaletteFile, writeHunkPalette, type HunkPaletteFile } from "./pic-file.ts";

/**
 * A view resource with everything needed to write it back byte for byte. Measured on all
 * 500 views of an SCI2 game (every one has this layout; all 9,628 cels are RLE-compressed):
 *
 *   header (18): +0 u16 16  +2 u8 loop count  +3 u8 0  +4 u8 `flags` (1)  +5 u8 0
 *                +6 u8 total cels  +7 u8 0  +8 u32 palette offset  +12 u8 16  +13 u8 36
 *   loop headers (16): +0 i8 linked loop (-1 = own cels)  +1 u8 mirror  +2 u8 cel count
 *                      +3 ff ff ff ff 03 00 00 00 00  +12 u32 first cel header
 *                      (a linked loop's points at where the next cel headers begin)
 *   cel headers (36), loop by loop: +0 u16 w  +2 u16 h  +4 i16 dx  +6 i16 dy  +8 u8 skip
 *                      +9 u8 0x8a  +12 u32 control+literal bytes  +16 u32 control bytes
 *                      +24 control offset  +28 literal offset  +32 row table offset
 *   00 03 u32 size | hunk palette
 *   00 04 u32 size | every cel's control stream, then every cel's literal stream
 *   00 05 u32 size | every cel's row table (u32 control offsets, then u32 literal offsets)
 */
export interface ViewFile {
  flags: number;
  loops: ViewLoop[];
  palette: HunkPaletteFile | undefined;
  /** The two chunk-size words (498 views: control+literal bytes, 0; 2 views: control, literal). */
  chunkSizes?: [number, number];
}

export interface ViewLoop {
  /** -1: this loop has its own cels; otherwise it reuses loop `link`'s (mirrored if `mirror`). */
  link: number;
  mirror: boolean;
  cels: ViewCel[];
}

export interface ViewCel extends Cel {
  /**
   * The cel's compressed streams as read, reused while `pixels` still equals `original`.
   * Sierra's encoder follows heuristics we don't reproduce exactly,
   * so keeping them is what makes untouched views round-trip byte for byte.
   */
  encoded?: RleCel & { original: Uint8Array };
}

export interface RleCel {
  control: number[] | Uint8Array;
  literal: number[] | Uint8Array;
  rowControl: number[];
  rowLiteral: number[];
}

const HEADER = 18, LOOP = 16, CEL = 36;
const LOOP_FILLER = [0xff, 0xff, 0xff, 0xff, 0x03, 0, 0, 0, 0];

export function parseViewFile(data: Uint8Array): ViewFile {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const loopCount = data[2]!;
  const palette = v.getUint32(8, true);
  const loops: ViewLoop[] = [];
  for (let i = 0; i < loopCount; i++) {
    const lh = HEADER + LOOP * i;
    const link = v.getInt8(lh);
    const first = v.getUint32(lh + 12, true);
    loops.push({
      link,
      mirror: data[lh + 1] === 1,
      cels: link === -1 ? Array.from({ length: data[lh + 2]! }, (_, c) => readCel(data, first + CEL * c)) : [],
    });
  }
  let chunkSizes: [number, number] | undefined;
  const firstCel = loops.findIndex((l) => l.link === -1 && l.cels.length);
  if (firstCel >= 0) {
    const h = v.getUint32(HEADER + LOOP * firstCel + 12, true);
    const ctrl = v.getUint32(h + 24, true), rows = v.getUint32(h + 32, true);
    const litEnd = rows - 6;
    chunkSizes = [v.getUint32(ctrl - 4, true), v.getUint32(litEnd + 2, true)];
  }
  return { flags: data[4]!, loops, palette: palette ? parseHunkPaletteFile(data, palette) : undefined, chunkSizes };
}

function readCel(data: Uint8Array, h: number): ViewCel {
  const cel: ViewCel = decodeCel(data, h);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ctrlSize = v.getUint32(h + 16, true), total = v.getUint32(h + 12, true);
  const ctrl = v.getUint32(h + 24, true), lit = v.getUint32(h + 28, true), rows = v.getUint32(h + 32, true);
  cel.encoded = {
    control: data.slice(ctrl, ctrl + ctrlSize),
    literal: data.slice(lit, lit + total - ctrlSize),
    rowControl: Array.from({ length: cel.height }, (_, y) => v.getUint32(rows + y * 4, true)),
    rowLiteral: Array.from({ length: cel.height }, (_, y) => v.getUint32(rows + (cel.height + y) * 4, true)),
    original: cel.pixels.slice(),
  };
  return cel;
}

/**
 * SCI32 cel RLE, one row at a time: transparent pixels as transparent runs (11nnnnnn), equal
 * pixels as colour runs (10nnnnnn + the colour in the literal stream), the rest as literals
 * (0nnnnnnn + that many bytes); runs hold up to 63 pixels, literal groups up to 127.
 *
 * Each row is split to use the fewest bytes: a transparent run costs 1, a colour run 2, a
 * literal group 1 + its length (and may include a lone transparent pixel when that's
 * cheaper, as Sierra's encoder also does). The result is never larger than Sierra's.
 */
export function encodeCelRle(cel: Cel): RleCel & { control: number[]; literal: number[] } {
  const control: number[] = [], literal: number[] = [], rowControl: number[] = [], rowLiteral: number[] = [];
  const { width: w, height: h, pixels, skipColor } = cel;
  for (let y = 0; y < h; y++) {
    rowControl.push(control.length);
    rowLiteral.push(literal.length);
    const row = pixels.subarray(y * w, (y + 1) * w);
    let x = 0;
    for (const [kind, n] of cheapestSplit(row, skipColor)) {
      if (kind === "skip") control.push(0xc0 | n);
      else if (kind === "run") {
        control.push(0x80 | n);
        literal.push(row[x]!);
      } else {
        control.push(n);
        for (let k = 0; k < n; k++) literal.push(row[x + k]!);
      }
      x += n;
    }
  }
  return { control, literal, rowControl, rowLiteral };
}

type Token = ["skip" | "run" | "lit", number];

/** Fewest bytes for a row: dynamic programming from the end. */
function cheapestSplit(row: Uint8Array, skipColor: number): Token[] {
  const n = row.length;
  const cost = new Array<number>(n + 1).fill(Infinity);
  const pick: Token[] = new Array(n);
  cost[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let same = 1;
    while (i + same < n && row[i + same] === row[i] && same < 63) same++;
    const transparent = row[i] === skipColor;
    for (let k = same; k >= (transparent ? 1 : 2); k--) {
      const c = (transparent ? 1 : 2) + cost[i + k]!;
      if (c < cost[i]!) (cost[i] = c), (pick[i] = [transparent ? "skip" : "run", k]);
    }
    for (let k = 1; k <= Math.min(127, n - i); k++) {
      const c = 1 + k + cost[i + k]!;
      if (c < cost[i]!) (cost[i] = c), (pick[i] = ["lit", k]);
    }
  }
  const out: Token[] = [];
  for (let i = 0; i < n; i += pick[i]![1]) out.push(pick[i]!);
  return out;
}

/** The cel's streams: as read if its pixels are untouched, else freshly encoded. */
function streamsOf(cel: ViewCel): RleCel {
  const e = cel.encoded;
  if (e && e.original.length === cel.pixels.length && e.original.every((p, i) => p === cel.pixels[i])) return e;
  return encodeCelRle(cel);
}

export function writeView(view: ViewFile): Uint8Array {
  const own = view.loops.filter((l) => l.link === -1);
  const cels = own.flatMap((l) => l.cels);
  const encoded = cels.map(streamsOf);
  const palette = view.palette ? writeHunkPalette(view.palette) : undefined;
  const headersEnd = HEADER + LOOP * view.loops.length + CEL * cels.length;
  const paletteAt = palette ? headersEnd + 6 : 0;
  const ctrlChunk = (palette ? paletteAt + palette.length : headersEnd) + 6;
  const ctrlSize = encoded.reduce((n, e) => n + e.control.length, 0);
  const litSize = encoded.reduce((n, e) => n + e.literal.length, 0);
  const litAt = ctrlChunk + ctrlSize;
  const rowsAt = litAt + litSize + 6;
  const rowsSize = cels.reduce((n, c) => n + c.height * 8, 0);
  const out = new Uint8Array(rowsAt + rowsSize);
  const v = new DataView(out.buffer);

  v.setUint16(0, HEADER - 2, true);
  out[2] = view.loops.length;
  out[4] = view.flags;
  out[6] = cels.length;
  v.setUint32(8, paletteAt, true);
  out[12] = LOOP;
  out[13] = CEL;

  // Loop headers; cel headers follow in loop order.
  let celHeader = HEADER + LOOP * view.loops.length;
  let celIndex = 0;
  let ctrl = ctrlChunk, lit = litAt, rows = rowsAt;
  view.loops.forEach((loop, i) => {
    const lh = HEADER + LOOP * i;
    v.setInt8(lh, loop.link);
    out[lh + 1] = loop.mirror ? 1 : 0;
    out[lh + 2] = loop.link === -1 ? loop.cels.length : 0;
    out.set(LOOP_FILLER, lh + 3);
    v.setUint32(lh + 12, celHeader, true);
    if (loop.link !== -1) return;
    for (const cel of loop.cels) {
      const e = encoded[celIndex++]!;
      const h = celHeader;
      v.setUint16(h, cel.width, true);
      v.setUint16(h + 2, cel.height, true);
      v.setInt16(h + 4, cel.displaceX, true);
      v.setInt16(h + 6, cel.displaceY, true);
      out[h + 8] = cel.skipColor;
      out[h + 9] = 0x8a;
      v.setUint32(h + 12, e.control.length + e.literal.length, true);
      v.setUint32(h + 16, e.control.length, true);
      v.setUint32(h + 24, ctrl, true);
      v.setUint32(h + 28, lit, true);
      v.setUint32(h + 32, rows, true);
      out.set(e.control, ctrl);
      out.set(e.literal, lit);
      e.rowControl.forEach((o, y) => v.setUint32(rows + y * 4, o, true));
      e.rowLiteral.forEach((o, y) => v.setUint32(rows + (cel.height + y) * 4, o, true));
      ctrl += e.control.length;
      lit += e.literal.length;
      rows += cel.height * 8;
      celHeader += CEL;
    }
  });

  const [size4, size5] = view.chunkSizes ?? [ctrlSize + litSize, 0];
  if (palette) {
    out.set([0, 3], headersEnd);
    v.setUint32(headersEnd + 2, palette.length, true);
    out.set(palette, paletteAt);
  }
  out.set([0, 4], ctrlChunk - 6);
  v.setUint32(ctrlChunk - 4, size4, true);
  out.set([0, 5], rowsAt - 6);
  v.setUint32(rowsAt - 4, size5, true);
  return out;
}
