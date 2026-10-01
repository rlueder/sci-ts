import { decodeCel, type Cel } from "./cel.ts";
import { parseHunkPalette, type Palette } from "./palette.ts";

export interface PicCel extends Cel {
  /** Draw order against other pic layers and actors. */
  priority: number;
  x: number;
  y: number;
}

/** A pic: a room background made of one or more positioned cel layers. */
export interface Pic {
  width: number;
  height: number;
  cels: PicCel[];
  palette: Palette | undefined;
}

/**
 * SCI32 pic layout:
 *
 *   +0  u16 header size (first cel header starts here)
 *   +2  u8  cel count
 *   +4  u16 cel header size
 *   +6  u32 embedded palette offset
 *   +10 u16/u16 resolution: (w, h) if the second is non-zero, else a code (0 = 320x200, 1 = 640x480, 2 = 640x400)
 *
 * Cel headers are the common layout plus +36 i16 priority, +38 i16 x, +40 i16 y.
 */
export function parsePic(data: Uint8Array): Pic {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerSize = v.getUint16(0, true);
  const celCount = data[2]!;
  const celHeaderSize = v.getUint16(4, true);
  const paletteOffset = v.getUint32(6, true);

  const res1 = v.getUint16(10, true);
  const res2 = v.getUint16(12, true);
  const presets: [number, number][] = [[320, 200], [640, 480], [640, 400]];
  const [width, height] = res2 ? [res1, res2] : (presets[res1] ?? [320, 200]);

  const cels = Array.from({ length: celCount }, (_, i): PicCel => {
    const h = headerSize + celHeaderSize * i;
    return {
      ...decodeCel(data, h),
      priority: v.getInt16(h + 36, true),
      x: v.getInt16(h + 38, true),
      y: v.getInt16(h + 40, true),
    };
  });

  return { width, height, cels, palette: paletteOffset ? parseHunkPalette(data, paletteOffset) : undefined };
}
