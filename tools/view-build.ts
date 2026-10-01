import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ROOM_COLORS, ResourceType, SHARED_COLORS, hunkToPalette, mapToPalette, mergePalette, parsePicFile, type HunkPaletteFile,
  type ResourceManager, type ViewFile, type ViewLoop,
} from "@sci-ts/sci";
import { basePalette } from "./pic-build.ts";
import { decodePng } from "./png.ts";

/**
 * A view described by a JSON manifest next to its PNGs:
 *
 *   { "view": 701, "palette": "shared" | { "pic": 701 }, "dither": false,
 *     "loops": [
 *       { "cels": [{ "png": "wisp-0.png", "anchor": [8, 15] }, ...] },   // own cels
 *       { "link": 0, "mirror": true }                                  // loop 0, flipped
 *     ] }
 *
 * `anchor` is the pixel placed at the object's x,y (default: bottom centre). "shared" uses
 * only the colours every room shares (characters, items); { "pic": n } may also use room
 * n's own colours (its props). Alpha 64-191 becomes a shadow pixel.
 */
export interface ViewManifest {
  view: number;
  palette: "shared" | { pic: number };
  dither?: boolean;
  loops: ({ cels: { png: string; anchor?: [number, number] }[] } | { link: number; mirror?: boolean })[];
}

const SKIP = 255;

export async function viewFromManifest(path: string, rm: ResourceManager): Promise<{ number: number; view: ViewFile }> {
  const m = JSON.parse(readFileSync(path, "utf8")) as ViewManifest;
  const base = await basePalette(rm);
  let palette = base, indices = SHARED_COLORS;
  if (m.palette !== "shared") {
    const pic = parsePicFile((await rm.load({ type: ResourceType.Pic, number: m.palette.pic })).data);
    palette = mergePalette(base, hunkToPalette(pic.palette));
    indices = ROOM_COLORS;
  }
  const loops: ViewLoop[] = m.loops.map((l) => {
    if ("link" in l) return { link: l.link, mirror: !!l.mirror, cels: [] };
    return {
      link: -1,
      mirror: false,
      cels: l.cels.map((c) => {
        const img = decodePng(readFileSync(join(dirname(path), c.png)));
        const [ax, ay] = c.anchor ?? [img.width >> 1, img.height - 1];
        return {
          width: img.width, height: img.height,
          displaceX: (img.width >> 1) - ax, displaceY: img.height - 1 - ay,
          skipColor: SKIP,
          pixels: mapToPalette(img.data, img.width, img.height, palette, indices, SKIP, !!m.dither),
        };
      }),
    };
  });
  // The view carries the entries it may use, with the same colours as the rooms have them.
  const used = [...indices, 253, 254].sort((a, b) => a - b);
  const first = used[0]!, last = used.at(-1)!;
  const hunk: HunkPaletteFile = {
    header: Uint8Array.from([14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]),
    entryPrefix: Uint8Array.from([0, 255, 255, 255, 255, 255, 255, 255, 0, 0]),
    first,
    used: Array.from({ length: last - first + 1 }, (_, i) => (used.includes(first + i) ? 1 : 0)),
    rgb: Array.from({ length: last - first + 1 }, (_, i) => [palette.rgb[(first + i) * 3]!, palette.rgb[(first + i) * 3 + 1]!, palette.rgb[(first + i) * 3 + 2]!]),
    shared: false,
    defaultUsed: 1,
  };
  return { number: m.view, view: { flags: 1, loops, palette: hunk } };
}
