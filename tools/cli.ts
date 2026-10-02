/**
 * sci-ts: the command for making games with sci-ts. Run it in a game's folder, or give it one.
 *
 *   sci-ts new <dir>                    a new game: a room in YAML and Yarn, the game, placeholder art
 *   sci-ts build [dir] [--out <dir>]    RESOURCE.MAP, RESOURCE.000 (and .SFX) in <dir>/out/game
 *   sci-ts play [dir] [--port <n>]      build it, then serve the player for it
 *   sci-ts edit [dir] [--port <n>]      build it, then serve the live editor for its rooms
 *   sci-ts site [dir] [--out <dir>]     a static site: the game's README and docs, and the game
 *                                       in the player (in <dir>/out/site)
 *   sci-ts lines tag [dir]              give every spoken line in rooms/*.yarn a #line: id
 *   sci-ts lines script [dir]           write voices/lines.json, the script for recording, and
 *                                       say what's recorded and what's still to do
 *   sci-ts art check|build <art.json> [out]   check or build editor-made art (tools/art.ts)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { writeResourceArchive } from "@sci-ts/sci";
import { GameBuildError, buildGame } from "./game/build.ts";
import { tagGameLines } from "./game/lines.ts";
import { readLineScript } from "./game/voices.ts";
import { newGame } from "./game/new.ts";
import { buildSite } from "./site/build.ts";

const VIEWER = resolve(import.meta.dirname, "../apps/viewer");
const usage = `usage: sci-ts new <dir>
       sci-ts build|play|edit|site [dir] [--out <dir>] [--port <n>]
       sci-ts lines tag|script [dir]
       sci-ts art check|build <art.json> [out]`;

const [command, ...rest] = process.argv.slice(2);
const sub = command === "lines" ? rest.shift() : undefined;
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
  if (["build", "play", "edit", "site", "lines"].includes(command ?? "") && !existsSync(join(dir, "scripts"))) {
    throw new GameBuildError(`${shown(dir)}: no game here (no scripts/ folder); sci-ts new <dir> starts one`);
  }
  switch (command) {
    case "new": {
      if (!rest[0]) throw new GameBuildError(usage);
      const target = newGame(rest[0]);
      console.log(`${shown(target)}: a room (rooms/1.room.yaml, 1.yarn), the game (scripts/0.sc) and placeholder art (resources.ts)`);
      console.log(shown(target) === "." ? "  sci-ts play" : `  cd ${shown(target)} && sci-ts play`);
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
    case "lines": {
      if (sub === "tag") {
        const tagged = tagGameLines(dir);
        for (const { file, added } of tagged) console.log(`${shown(file)}: ${added.length} line${added.length > 1 ? "s" : ""} tagged (${added[0]} to ${added.at(-1)})`);
        if (!tagged.length) console.log(`${shown(dir)}: every spoken line has an id`);
      } else if (sub === "script") {
        // The build writes the script once there's a voices/ folder.
        mkdirSync(join(dir, "voices"), { recursive: true });
        const game = await buildGame(dir);
        const lines = [...readLineScript(dir).values()];
        const untagged = [...game.lines.values()].flat().filter((l) => l.id === undefined).length;
        console.log(`${shown(join(dir, "voices/lines.json"))}: ${lines.length} lines${untagged ? ` (and ${untagged} with no id: sci-ts lines tag)` : ""}`);
        const speakers = [...new Set(lines.map((l) => l.speaker))];
        for (const who of speakers) {
          const theirs = lines.filter((l) => l.speaker === who);
          const count = (r: string) => theirs.filter((l) => l.recording === r).length;
          console.log(`  ${who}: ${theirs.length} lines, ${count("recorded")} recorded, ${count("changed")} changed since, ${count("missing")} to record`);
        }
        for (const l of lines.filter((x) => x.recording === "changed")) console.log(`  changed: ${l.id} (${l.where}) "${l.text}"`);
      } else throw new GameBuildError(usage);
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

