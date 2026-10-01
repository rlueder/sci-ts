import type { Palette } from "./palette.ts";

/** A single decoded image: 8-bit palette indices, row-major. */
export interface Cel {
  width: number;
  height: number;
  /** Signed displacement from the anchor point, as stored in the header. */
  displaceX: number;
  displaceY: number;
  /** Palette index that is transparent. */
  skipColor: number;
  pixels: Uint8Array;
}

const CelCompression = { None: 0, Rle: 0x8a } as const;

/**
 * Decodes an SCI32 cel. The header layout is shared by views and pics:
 *
 *   +0  u16 width        +2  u16 height
 *   +4  i16 displaceX    +6  i16 displaceY
 *   +8  u8  skip colour  +9  u8  compression (0 = raw, 0x8A = RLE)
 *   +24 u32 data offset (RLE control stream, or raw pixels)
 *   +28 u32 literal offset (RLE literal pixels)
 *   +32 u32 row table offset (RLE: height u32 control offsets, then height u32 literal offsets)
 *
 * All offsets are relative to the start of the resource.
 */
export function decodeCel(data: Uint8Array, headerOffset: number): Cel {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const h = headerOffset;
  const width = v.getUint16(h, true);
  const height = v.getUint16(h + 2, true);
  const cel: Cel = {
    width,
    height,
    displaceX: v.getInt16(h + 4, true),
    displaceY: v.getInt16(h + 6, true),
    skipColor: data[h + 8]!,
    pixels: new Uint8Array(width * height),
  };
  const compression = data[h + 9]!;
  const dataOffset = v.getUint32(h + 24, true);

  if (compression === CelCompression.None) {
    cel.pixels.set(data.subarray(dataOffset, dataOffset + width * height));
    return cel;
  }
  if (compression !== CelCompression.Rle) {
    throw new Error(`Unknown cel compression 0x${compression.toString(16)}`);
  }

  const literalBase = v.getUint32(h + 28, true);
  const rowTable = v.getUint32(h + 32, true);

  for (let y = 0; y < height; y++) {
    let ctrl = dataOffset + v.getUint32(rowTable + y * 4, true);
    let lit = literalBase + v.getUint32(rowTable + (height + y) * 4, true);
    const row = y * width;

    for (let x = 0; x < width; ) {
      const op = data[ctrl++]!;
      if (op & 0x80) {
        const len = op & 0x3f;
        // 11xxxxxx = run of transparent; 10xxxxxx = run of the next literal byte
        const color = op & 0x40 ? cel.skipColor : data[lit++]!;
        cel.pixels.fill(color, row + x, row + x + len);
        x += len;
      } else {
        // 0xxxxxxx = copy that many literal bytes
        cel.pixels.set(data.subarray(lit, lit + op), row + x);
        lit += op;
        x += op;
      }
    }
  }
  return cel;
}

export interface RgbaOptions {
  mirror?: boolean;
  /**
   * Remap colours: indices that aren't real colours but tell the engine to transform
   * whatever is underneath (e.g. 253/254 for shadows). Scripts configure the real
   * transform at runtime; until the VM exists they're approximated as translucent black.
   */
  remap?: ReadonlyMap<number, number>; // index -> alpha 0..255
}

/** Converts a cel to RGBA using `palette`, making the skip colour transparent. */
export function celToRgba(cel: Cel, palette: Palette, { mirror = false, remap }: RgbaOptions = {}): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(cel.width * cel.height * 4);
  for (let y = 0; y < cel.height; y++) {
    for (let x = 0; x < cel.width; x++) {
      const src = cel.pixels[y * cel.width + (mirror ? cel.width - 1 - x : x)]!;
      if (src === cel.skipColor) continue;
      const o = (y * cel.width + x) * 4;
      const remapAlpha = remap?.get(src);
      if (remapAlpha !== undefined) {
        out[o + 3] = remapAlpha;
        continue;
      }
      out[o] = palette.rgb[src * 3]!;
      out[o + 1] = palette.rgb[src * 3 + 1]!;
      out[o + 2] = palette.rgb[src * 3 + 2]!;
      out[o + 3] = 255;
    }
  }
  return out;
}
