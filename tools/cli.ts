/**
 * sci-ts: the command for making games with sci-ts. Run it in a game's folder, or give it one.
 *
 *   sci-ts new <dir>                    a new game: a room in YAML and Yarn, the game, placeholder art
 *   sci-ts build [dir] [--out <dir>]    RESOURCE.MAP, RESOURCE.000 (and .SFX) in <dir>/out/game
 *   sci-ts play [dir] [--port <n>]      build it, then serve the player for it
 *   sci-ts edit [dir] [--port <n>]      build it, then serve the live editor for its rooms
 *   sci-ts site [dir] [--out <dir>]     a static site: the game's README and docs, and the game
 *                                       in the player (in <dir>/out/site)
 *   sci-ts art check|build <art.json> [out]   check or build editor-made art (tools/art.ts)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { writeResourceArchive } from "@sci-ts/sci";
import { GameBuildError, buildGame } from "./game/build.ts";
import { newGame } from "./game/new.ts";
import { buildSite } from "./site/build.ts";

const VIEWER = resolve(import.meta.dirname, "../apps/viewer");
const usage = `usage: sci-ts new <dir>
       sci-ts build|play|edit|site [dir] [--out <dir>] [--port <n>]
       sci-ts art check|build <art.json> [out]`;

const [command, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest.splice(i, 2)[1] : undefined;
};
const out = option("out"), port = option("port");
const dir = resolve(rest[0] ?? ".");
const shown = (p: string) => relative(process.cwd(), p) || ".";

/** Builds the game in `dir` into `to`; prints warnings and a summary. */
async function build(to: string) {
  const game = await buildGame(dir);
  const { map, volume } = writeResourceArchive(game.resources);
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, "RESOURCE.MAP"), map);
  writeFileSync(join(to, "RESOURCE.000"), volume);
  for (const [name, data] of Object.entries(game.files)) writeFileSync(join(to, name), data);
  for (const w of game.warnings) console.warn(`warning: ${w}`);
  console.log(`${shown(to)}: ${game.resources.length} resources, ${game.classes.size} classes`);
}

/** Serves the viewer app for the game in `dir`, built into `to`; `page` is what to open. */
async function serve(to: string, page: string) {
  process.env.SCI_GAME = to;
  process.env.SCI_GAME_SOURCE = dir;
  const { createServer } = await import("vite");
  const server = await createServer({ root: VIEWER, configFile: join(VIEWER, "vite.config.ts"), server: { port: port ? Number(port) : 5173 } });
  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/";
  console.log(`${basename(dir)}: ${url}${page}`);
}

try {
  if (["build", "play", "edit", "site"].includes(command ?? "") && !existsSync(join(dir, "scripts"))) {
    throw new GameBuildError(`${shown(dir)}: no game here (no scripts/ folder); sci-ts new <dir> starts one`);
  }
  switch (command) {
    case "new": {
      if (!rest[0]) throw new GameBuildError(usage);
      const target = newGame(rest[0]);
      console.log(`${shown(target)}: a room (rooms/1.room.yaml, 1.yarn), the game (scripts/0.sc) and placeholder art (resources.ts)`);
      console.log(`  cd ${shown(target)} && sci-ts play`);
      break;
    }
    case "build":
      await build(resolve(out ?? join(dir, "out/game")));
      break;
    case "play":
    case "edit": {
      const to = join(dir, "out/game");
      await build(to);
      await serve(to, command === "play" ? "play.html" : `editor.html?mod=${basename(dir)}`);
      break;
    }
    case "site": {
      const to = resolve(out ?? join(dir, "out/site"));
      const site = await buildSite(dir, to, { docs: dir, name: basename(dir) });
      console.log(`${shown(to)}: ${site.pages} pages, the game in play/play.html${site.soundFont ? "" : " (no SoundFont: music is silent)"}`);
      break;
    }
    case "art": {
      // The art tool keeps its own command line; run it with this process's loader (tsx).
      const art = spawn(process.execPath, [...process.execArgv, join(import.meta.dirname, "art.ts"), ...rest], { stdio: "inherit" });
      art.on("exit", (code) => process.exit(code ?? 1));
      break;
    }
    default:
      console.error(usage);
      process.exit(2);
  }
} catch (e) {
  if (!(e instanceof GameBuildError)) throw e;
  console.error(e.message);
  process.exit(1);
}

