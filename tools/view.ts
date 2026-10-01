/**
 * Views (sprites and animations).
 *   pnpm view export <n> [dir]          loop<L>-cel<C>.png + view.json (a manifest you can edit)
 *   pnpm view import <view.json> [dir]  build the view → <n>.V56
 *   pnpm view roundtrip                 parse + write every view, compare bytes
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResourceManager, ResourceType, celToRgba, hunkToPalette, mergePalette, parseViewFile, writeView } from "@sci-ts/sci";
import { nodeFiles } from "./node-files.ts";
import { writePatch } from "./patches.ts";
import { basePalette } from "./pic-build.ts";
import { rgbaPng } from "./png.ts";
import { viewFromManifest, type ViewManifest } from "./view-build.ts";

const [command = "roundtrip", ...args] = process.argv.slice(2);
const rm = await ResourceManager.open(nodeFiles(process.env.SCI_GAME ?? "original"));

if (command === "export") {
  const n = Number(args[0]);
  const dir = args[1] ?? `out/views/${n}`;
  mkdirSync(dir, { recursive: true });
  const view = parseViewFile((await rm.load({ type: ResourceType.View, number: n })).data);
  const palette = mergePalette(await basePalette(rm), view.palette ? hunkToPalette(view.palette) : undefined);
  const manifest: ViewManifest = { view: n, palette: "shared", loops: [] };
  view.loops.forEach((loop, l) => {
    if (loop.link !== -1) return manifest.loops.push({ link: loop.link, mirror: loop.mirror });
    manifest.loops.push({
      cels: loop.cels.map((cel, c) => {
        const png = `loop${l}-cel${c}.png`;
        // Shadows (remap 254) come out half-transparent black, the way import reads them.
        const rgba = new Uint8Array(celToRgba(cel, palette, { remap: new Map([[253, 128], [254, 128]]) }).buffer);
        writeFileSync(join(dir, png), rgbaPng({ width: cel.width, height: cel.height, data: rgba }));
        return { png, anchor: [(cel.width >> 1) - cel.displaceX, cel.height - 1 - cel.displaceY] as [number, number] };
      }),
    });
  });
  writeFileSync(join(dir, "view.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`view ${n}: ${view.loops.length} loops → ${dir}`);
} else if (command === "import") {
  const { number, view } = await viewFromManifest(args[0]!, rm);
  writePatch(args[1] ?? "out/views", ResourceType.View, number, writeView(view));
} else {
  const list = rm.list(ResourceType.View);
  const bad: number[] = [];
  for (const info of list) {
    const d = Buffer.from((await rm.load(info)).data);
    if (d.compare(Buffer.from(writeView(parseViewFile(d))))) bad.push(info.number);
  }
  console.log(`${list.length - bad.length}/${list.length} views round-trip byte-exact${bad.length ? `; differ: ${bad.join(" ")}` : ""}`);
  process.exitCode = bad.length ? 1 : 0;
}
