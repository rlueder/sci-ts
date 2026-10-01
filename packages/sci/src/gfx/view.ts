import { decodeCel, type Cel } from "./cel.ts";
import { parseHunkPalette, type Palette } from "./palette.ts";

export interface Loop {
  /** Loop drawn as a horizontal mirror of another (e.g. walking left = walking right, flipped). */
  mirror: boolean;
  cels: Cel[];
}

/** A view: sprite animations grouped into loops (usually one per facing direction). */
export interface View {
  loops: Loop[];
  palette: Palette | undefined;
}

/**
 * SCI32 view layout:
 *
 *   +0  u16 header size (loop headers start at 2 + this)
 *   +2  u8  loop count
 *   +8  u32 embedded palette offset (0 = none)
 *   +12 u8  loop header size
 *   +13 u8  cel header size
 *
 * Loop header:
 *   +0  i8  linked loop (-1 = own cels; otherwise reuse that loop's cels)
 *   +1  u8  1 = mirror the linked loop
 *   +2  u8  cel count
 *   +12 u32 offset of the first cel header
 */
export function parseView(data: Uint8Array): View {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerSize = v.getUint16(0, true);
  const loopCount = data[2]!;
  const paletteOffset = v.getUint32(8, true);
  const loopHeaderSize = data[12]!;
  const celHeaderSize = data[13]!;

  const loopHeaderAt = (i: number) => 2 + headerSize + loopHeaderSize * i;
  const decoded = new Map<number, Cel[]>();

  const celsOf = (loopNo: number): Cel[] => {
    let cels = decoded.get(loopNo);
    if (!cels) {
      const lh = loopHeaderAt(loopNo);
      const celCount = data[lh + 2]!;
      const first = v.getUint32(lh + 12, true);
      cels = Array.from({ length: celCount }, (_, c) => decodeCel(data, first + celHeaderSize * c));
      decoded.set(loopNo, cels);
    }
    return cels;
  };

  const loops: Loop[] = [];
  for (let i = 0; i < loopCount; i++) {
    const lh = loopHeaderAt(i);
    const link = v.getInt8(lh);
    loops.push(link === -1 ? { mirror: false, cels: celsOf(i) } : { mirror: data[lh + 1] === 1, cels: celsOf(link) });
  }

  return { loops, palette: paletteOffset ? parseHunkPalette(data, paletteOffset) : undefined };
}
