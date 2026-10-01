/**
 * Room pictures.
 *   pnpm pic export <n> [dir]              <n>.png (background) and <n>.layer-<priority>.png pieces
 *   pnpm pic import <dir> <n> [outDir]     build pic <n> from <dir>/<n>.png (+ layers) → <n>.P56
 *   pnpm pic roundtrip                     parse + write every pic, compare bytes
 * Flags: --no-dither (import).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResourceManager, ResourceType, hunkToPalette, mergePalette, parsePicFile, writePic, type PicFile } from "@sci-ts/sci";
import { nodeFiles } from "./node-files.ts";
import { writePatch } from "./patches.ts";
import { basePalette, picFromPngs } from "./pic-build.ts";
import { rgbaPng } from "./png.ts";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const [command = "roundtrip", ...args] = argv.filter((a) => !a.startsWith("--"));
const rm = await ResourceManager.open(nodeFiles(process.env.SCI_GAME ?? "original"));

/** Composites a pic's layers (or just some) to RGBA, 320x190. */
function render(pic: PicFile, palette: ReturnType<typeof hunkToPalette>, only?: (priority: number) => boolean) {
  const w = 320, h = 190;
  const data = new Uint8Array(w * h * 4);
  for (const cel of [...pic.cels].sort((a, b) => a.priority - b.priority)) {
    if (only && !only(cel.priority)) continue;
    for (let y = 0; y < cel.height; y++) for (let x = 0; x < cel.width; x++) {
      const c = cel.pixels[y * cel.width + x]!;
      const X = cel.x + x, Y = cel.y + y;
      if (c === cel.skipColor || X < 0 || Y < 0 || X >= w || Y >= h) continue;
      data.set([palette.rgb[c * 3]!, palette.rgb[c * 3 + 1]!, palette.rgb[c * 3 + 2]!, 255], (Y * w + X) * 4);
    }
  }
  return { width: w, height: h, data };
}

if (command === "export") {
  const n = Number(args[0]);
  const dir = args[1] ?? "out/pics";
  mkdirSync(dir, { recursive: true });
  const pic = parsePicFile((await rm.load({ type: ResourceType.Pic, number: n })).data);
  const palette = mergePalette(await basePalette(rm), hunkToPalette(pic.palette));
  writeFileSync(join(dir, `${n}.png`), rgbaPng(render(pic, palette, (p) => p === -1000)));
  for (const p of new Set(pic.cels.map((c) => c.priority).filter((p) => p > -1000))) {
    writeFileSync(join(dir, `${n}.layer-${p}.png`), rgbaPng(render(pic, palette, (q) => q === p)));
  }
  console.log(`pic ${n}: ${pic.cels.length} cels → ${dir}/${n}.png${pic.cels.length > 1 ? ` + ${pic.cels.length - 1} layers` : ""}`);
} else if (command === "import") {
  const [dir, n, outDir = "out/pics"] = [args[0]!, Number(args[1]), args[2]];
  const pic = await picFromPngs(dir, n, rm, !flags.has("--no-dither"));
  writePatch(outDir, ResourceType.Pic, n, writePic(pic));
} else {
  const list = rm.list(ResourceType.Pic);
  const bad: number[] = [];
  for (const info of list) {
    const d = Buffer.from((await rm.load(info)).data);
    if (d.compare(Buffer.from(writePic(parsePicFile(d))))) bad.push(info.number);
  }
  console.log(`${list.length - bad.length}/${list.length} pics round-trip byte-exact${bad.length ? `; differ: ${bad.join(" ")}` : ""}`);
  process.exitCode = bad.length ? 1 : 0;
}
