/**
 * Games built from their own sources (see tools/game/build.ts):
 *
 *   pnpm game build games/<name> [out dir]   RESOURCE.MAP + RESOURCE.000, by default in
 *                                            out/games/<name>, and in src/ the assembly
 *                                            compiled from each .sc script
 *   pnpm game new <name>                     a new game in games/<name>, from tools/game/template:
 *                                            a room in YAML and Yarn, a hero, placeholder art
 *   pnpm game site games/<name> [out dir]    a static site: the docs as pages and the game
 *                                            in the player (out/site by default; see
 *                                            tools/site/build.ts)
 *
 * Play one in the browser with SCI_GAME=out/games/<name> pnpm viewer (then /play.html), or
 * headless with SCI_GAME=out/games/<name> pnpm play.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { writeResourceArchive } from "@sci-ts/sci";
import { GameBuildError, buildGame } from "./game/build.ts";
import { newGame } from "./game/new.ts";
import { buildSite } from "./site/build.ts";

const [command, dir, outArg] = process.argv.slice(2);
if ((command !== "build" && command !== "site" && command !== "new") || !dir) {
  console.error("usage: pnpm game build|site games/<name> [out dir], or pnpm game new <name>");
  process.exit(2);
}
if (command === "new") {
  try {
    const target = newGame(join("games", basename(dir)));
    console.log(`${target}: a room (rooms/1.room.yaml, 1.yarn), the game (scripts/0.sc) and placeholder art (resources.ts)`);
    console.log(`  pnpm game build ${target}, then SCI_GAME=out/${target} pnpm viewer`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}
if (command === "site") {
  const out = outArg ?? "out/site";
  try {
    const site = await buildSite(dir, out);
    console.log(`${out}: ${site.pages} pages, ${site.game} in play/play.html${site.soundFont ? "" : " (no SoundFont in assets/soundfonts: music is silent)"}`);
  } catch (e) {
    if (!(e instanceof GameBuildError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
  process.exit(0);
}
try {
  const game = await buildGame(dir);
  const out = outArg ?? join("out/games", basename(dir));
  const { map, volume } = writeResourceArchive(game.resources);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "RESOURCE.MAP"), map);
  writeFileSync(join(out, "RESOURCE.000"), volume);
  for (const [name, data] of Object.entries(game.files)) writeFileSync(join(out, name), data);
  // What the compiler made of the .sc scripts, to read when something doesn't work.
  if (game.generated.size) {
    mkdirSync(join(out, "src"), { recursive: true });
    for (const [n, text] of game.generated) writeFileSync(join(out, "src", `${n}.sca`), text);
  }
  for (const w of game.warnings) console.warn(`warning: ${w}`);
  console.log(`${relative(process.cwd(), out) || "."}: ${game.resources.length} resources, ${game.selectors.length} selectors, ${game.classes.size} classes`);
} catch (e) {
  if (!(e instanceof GameBuildError)) throw e;
  console.error(e.message);
  process.exit(1);
}
