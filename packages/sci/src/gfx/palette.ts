/** 256-colour VGA palette: 8-bit RGB triplets plus a per-entry "used" flag. */
export interface Palette {
  rgb: Uint8Array; // 256 * 3
  used: Uint8Array; // 256
}

export const emptyPalette = (): Palette => ({ rgb: new Uint8Array(768), used: new Uint8Array(256) });

/**
 * Parses a "hunk palette", the SCI32 palette format used by palette resources and
 * embedded in pics and views.
 *
 *   header (13 bytes): byte 10 = number of palettes
 *   u16 per palette (skipped)
 *   entry header (22 bytes):
 *     +10 u8  first colour index
 *     +14 u16 colour count
 *     +16 u8  default "used" flag
 *     +17 u8  shared-used: 1 = entries are RGB (3 bytes), 0 = used+RGB (4 bytes)
 *   colours
 *
 * Returns a palette with only the entries this hunk defines marked used.
 */
export function parseHunkPalette(data: Uint8Array, offset = 0): Palette | undefined {
  const count = data[offset + 10] ?? 0;
  if (count === 0) return undefined;

  const entry = offset + 13 + 2 * count;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const start = data[entry + 10]!;
  const numColors = view.getUint16(entry + 14, true);
  const defaultUsed = data[entry + 16]!;
  const sharedUsed = data[entry + 17]! !== 0;

  const pal = emptyPalette();
  let pos = entry + 22;
  for (let i = start; i < start + numColors && i < 256; i++) {
    pal.used[i] = sharedUsed ? defaultUsed : data[pos++]!;
    pal.rgb[i * 3] = data[pos++]!;
    pal.rgb[i * 3 + 1] = data[pos++]!;
    pal.rgb[i * 3 + 2] = data[pos++]!;
  }
  return pal;
}

/** Returns `base` with every used entry of `over` applied on top. */
export function mergePalette(base: Palette, over: Palette | undefined): Palette {
  if (!over) return base;
  const out: Palette = { rgb: base.rgb.slice(), used: base.used.slice() };
  for (let i = 0; i < 256; i++) {
    if (!over.used[i]) continue;
    out.used[i] = 1;
    out.rgb.set(over.rgb.subarray(i * 3, i * 3 + 3), i * 3);
  }
  return out;
}
