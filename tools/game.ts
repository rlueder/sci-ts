/**
 * Games built from their own sources (see tools/game/build.ts):
 *
 *   pnpm game build games/<name> [out dir]   RESOURCE.MAP + RESOURCE.000, by default in
 *                                            out/games/<name>
 *
 * Play one in the browser with SCI_GAME=out/games/<name> pnpm viewer (then /play.html), or
 * headless with SCI_GAME=out/games/<name> pnpm play.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { writeResourceArchive } from "@sci-ts/sci";
import { GameBuildError, buildGame } from "./game/build.ts";

const [command, dir, outArg] = process.argv.slice(2);
if (command !== "build" || !dir) {
  console.error("usage: pnpm game build games/<name> [out dir]");
  process.exit(2);
}
try {
  const game = await buildGame(dir);
  const out = outArg ?? join("out/games", basename(dir));
  const { map, volume } = writeResourceArchive(game.resources);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "RESOURCE.MAP"), map);
  writeFileSync(join(out, "RESOURCE.000"), volume);
  console.log(`${relative(process.cwd(), out) || "."}: ${game.resources.length} resources, ${game.selectors.length} selectors, ${game.classes.size} classes`);
} catch (e) {
  if (!(e instanceof GameBuildError)) throw e;
  console.error(e.message);
  process.exit(1);
}
