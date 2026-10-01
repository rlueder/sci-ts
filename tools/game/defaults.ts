import { writeFont, writeHunkPalette, writeView, type HunkPaletteFile, type ResourceData, ResourceType } from "@sci-ts/sci";
import { pixelFont } from "./font.ts";

/**
 * What every game built by sci-ts gets unless it brings its own: font 0, palette 999 (the
 * base palette) and view 999 (the cursor).
 */

/** Colour indices in the base palette. */
export const Colour = { Black: 0, White: 255, Transparent: 254 } as const;

/**
 * The base palette:
 *   0-15     black, then a dark and a light version of seven hues
 *   16-231   a 6×6×6 colour cube (index 16 + 36r + 6g + b, each 0-5)
 *   232-253  greys, dark to light
 *   254      the transparent colour our own art uses (never drawn)
 *   255      white
 */
export function basePalette(): HunkPaletteFile {
  const rgb: [number, number, number][] = [[0, 0, 0]];
  const hues: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  for (const level of [128, 240]) for (const [r, g, b] of hues) if (rgb.length < 16) rgb.push([r * level, g * level, b * level]);
  while (rgb.length < 16) rgb.push([255, 255, 255]);
  const step = [0, 51, 102, 153, 204, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) rgb.push([step[r]!, step[g]!, step[b]!]);
  for (let i = 0; i < 22; i++) {
    const v = Math.round(8 + (i * (247 - 8)) / 21);
    rgb.push([v, v, v]);
  }
  rgb.push([255, 0, 255], [255, 255, 255]);
  return {
    header: Uint8Array.from([14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]),
    entryPrefix: new Uint8Array(10),
    first: 0,
    used: rgb.map(() => 1),
    rgb,
    shared: false,
    defaultUsed: 1,
  };
}

/** The nearest colour-cube index for an RGB colour (0-255 per channel). */
export const cube = (r: number, g: number, b: number): number =>
  16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);

/** An arrow, white with a black outline; its hotspot is the tip (the top-left pixel). */
function cursorView() {
  const art = [
    "X.........",
    "XX........",
    "XWX.......",
    "XWWX......",
    "XWWWX.....",
    "XWWWWX....",
    "XWWWWWX...",
    "XWWWWWWX..",
    "XWWWWWWWX.",
    "XWWWWXXXXX",
    "XWWXWWX...",
    "XWX.XWWX..",
    "XX..XWWX..",
    "X....XWWX.",
    ".....XWWX.",
    "......XX..",
  ];
  const width = art[0]!.length, height = art.length;
  const pixels = Uint8Array.from(art.join(""), (c) => (c === "X" ? Colour.Black : c === "W" ? Colour.White : Colour.Transparent));
  const cel = { width, height, displaceX: width >> 1, displaceY: height - 1, skipColor: Colour.Transparent, pixels };
  return writeView({ flags: 1, loops: [{ link: -1, mirror: false, cels: [cel] }], palette: undefined });
}

export const DEFAULT_FONT = 0;
export const BASE_PALETTE = 999;
export const CURSOR_VIEW = 999;

export function defaultResources(): ResourceData[] {
  return [
    { type: ResourceType.Font, number: DEFAULT_FONT, data: writeFont(pixelFont()) },
    { type: ResourceType.Palette, number: BASE_PALETTE, data: writeHunkPalette(basePalette()) },
    { type: ResourceType.View, number: CURSOR_VIEW, data: cursorView() },
  ];
}
