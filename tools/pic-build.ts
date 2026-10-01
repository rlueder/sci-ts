import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildRoomPic, emptyPalette, parseHunkPalette, ResourceType, type PicFile, type PicLayer, type ResourceManager } from "@sci-ts/sci";
import { decodePng } from "./png.ts";

/** The base palette (999): the colours every room keeps. */
export async function basePalette(rm: ResourceManager) {
  return parseHunkPalette((await rm.load({ type: ResourceType.Palette, number: 999 })).data) ?? emptyPalette();
}

/**
 * A room picture from PNGs in a directory: `<n>.png` is the background (320x190), and
 * `<n>.layer-<priority>.png` files (same size, transparent where empty) are foreground
 * pieces that actors with a lower y walk behind.
 */
export async function picFromPngs(dir: string, n: number, rm: ResourceManager, dither = true): Promise<PicFile> {
  const layers: PicLayer[] = [];
  const background = decodePng(readFileSync(join(dir, `${n}.png`)));
  layers.push({ width: background.width, height: background.height, rgba: background.data, priority: -1000 });
  for (const f of readdirSync(dir)) {
    const m = new RegExp(`^${n}\\.layer-(-?\\d+)\\.png$`).exec(f);
    if (!m) continue;
    const img = decodePng(readFileSync(join(dir, f)));
    layers.push({ width: img.width, height: img.height, rgba: img.data, priority: Number(m[1]) });
  }
  return buildRoomPic(layers, await basePalette(rm), { dither });
}
