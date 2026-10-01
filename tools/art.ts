import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeResourceArchive } from "@sci-ts/sci";
import { ArtError, buildArt } from "./art/build.ts";

const [command, manifest, outArg] = process.argv.slice(2);
if (!manifest || (command !== "check" && command !== "build")) {
  console.error("usage: pnpm art <check|build> games/<name>/art/art.json [out dir]");
  process.exit(2);
}
try {
  const art = buildArt(manifest);
  if (command === "build") {
    const out = outArg ?? join("out/art", basename(dirname(dirname(manifest))));
    const { map, volume } = writeResourceArchive(art.resources);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "RESOURCE.MAP"), map);
    writeFileSync(join(out, "RESOURCE.000"), volume);
    const gpl = ["GIMP Palette", "Name: SCI project palette", "Columns: 8", "#"];
    for (const hex of art.colours) gpl.push(`${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(" ")} ${hex}`);
    writeFileSync(join(out, "palette.gpl"), `${gpl.join("\n")}\n`);
    console.log(`${out}: art-only archive (no game scripts), palette.gpl`);
  }
  console.log(`${manifest}: ${art.images} PNGs checked, ${art.colours.length} colours, ${art.resources.length} resources`);
} catch (e) {
  if (!(e instanceof ArtError)) throw e;
  console.error(e.message);
  process.exit(1);
}
