/**
 * The live editor's server side (apps/viewer/editor.html, through the dev server's
 * /__editor routes): lists what can be edited, reads its room files, and on save writes them
 * and builds, returning the built resources for the page to swap into the running game.
 *
 * What's edited depends on what the dev server serves. A game of ours (SCI_GAME=
 * out/games/<name>): its YAML rooms, rebuilt with `pnpm game build`; the page gets the
 * resources that changed. Sierra's game: mods, built like `pnpm mod build`, with the game's
 * files and class tables kept loaded between builds.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ResourceManager, ResourceType, ScriptWorld, writeResourceArchive, type AsmContext } from "@sci-ts/sci";
import { buildGame } from "./game/build.ts";
import { buildMod, type BuiltResource } from "./mod-build.ts";
import { nodeFiles } from "./node-files.ts";
import { writePatch } from "./patches.ts";

const ROOT = resolve(import.meta.dirname, "..");
const MODS = join(ROOT, "mods");
const GAMES = join(ROOT, "games");
/** The files the editor shows and may write. */
const EDITABLE = /^(\d+\.room\.yaml|\d+\.yarn|flags\.yaml)$/;

/** The game of ours the dev server serves (SCI_GAME=out/games/<name>), if it is one. */
const servedGame = (() => {
  const name = /(?:^|\/)out\/games\/([\w-]+)\/?$/.exec(process.env.SCI_GAME ?? "")?.[1];
  return name && existsSync(join(GAMES, name)) ? name : undefined;
})();

/** Where an editable thing's files are: a mod's folder, or a game's rooms/ (flags.yaml beside it). */
function filesDir(name: string): { dir: string; game: boolean } {
  if (servedGame && name === servedGame) return { dir: join(GAMES, name), game: true };
  return { dir: modDir(name), game: false };
}
const fileIn = (where: { dir: string; game: boolean }, file: string) =>
  join(where.dir, where.game && file !== "flags.yaml" ? "rooms" : "", file);

let game: Promise<{ rm: ResourceManager; world: ScriptWorld; ctx: AsmContext }> | undefined;
const openGame = () =>
  (game ??= (async () => {
    const rm = await ResourceManager.open(nodeFiles(join(ROOT, "original")));
    const world = await ScriptWorld.open(rm);
    await world.loadAllClasses();
    return { rm, world, ctx: world.asmContext() };
  })());

const modDir = (mod: string) => {
  if (!/^[\w-]+$/.test(mod) || !existsSync(join(MODS, mod))) throw new Error(`no mod called "${mod}"`);
  return join(MODS, mod);
};

const roomsIn = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).flatMap((f) => /^(\d+)\.room\.yaml$/.exec(f)?.[1] ?? []).map(Number).sort((a, b) => a - b) : [];

export function listMods(): { name: string; kind: "mod" | "game"; rooms: number[] }[] {
  if (servedGame) return [{ name: servedGame, kind: "game", rooms: roomsIn(join(GAMES, servedGame, "rooms")) }];
  return readdirSync(MODS)
    .filter((d) => statSync(join(MODS, d)).isDirectory())
    .map((name) => ({ name, kind: "mod" as const, rooms: roomsIn(join(MODS, name)) }));
}

export function readFiles(name: string): Record<string, string> {
  const where = filesDir(name);
  const names = where.game
    ? [...readdirSync(join(where.dir, "rooms")), ...(existsSync(join(where.dir, "flags.yaml")) ? ["flags.yaml"] : [])]
    : readdirSync(where.dir);
  return Object.fromEntries(names.filter((f) => EDITABLE.test(f)).map((f) => [f, readFileSync(fileIn(where, f), "utf8")]));
}

export interface BuildResult {
  ok: boolean;
  /** Everything the mod builds, base64: the page swaps it into the running game. */
  resources?: { type: number; number: number; data: string }[];
  /** The compiled .sca / .msg text, for reading. */
  generated?: Record<string, string>;
  /** flags.yaml after the build (new variables get numbers). */
  flags?: string;
  /** What changed can't be swapped into a running game (its selectors): reload the page. */
  reload?: boolean;
  ms?: number;
  error?: { message: string; file?: string; line?: number };
}

let queue: Promise<unknown> = Promise.resolve();

/** Writes `files` (only room files) into the mod, then builds it. One build at a time. */
export function save(mod: string, files: Record<string, string>): Promise<BuildResult> {
  const run = async (): Promise<BuildResult> => {
    const started = Date.now();
    try {
      const where = filesDir(mod);
      for (const [name, text] of Object.entries(files)) {
        if (!EDITABLE.test(name)) throw new Error(`the editor doesn't write ${name}`);
        const path = fileIn(where, name);
        if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
      }
      if (where.game) return { ...(await buildServedGame(mod)), ms: Date.now() - started };
      const dir = where.dir;
      const { rm, world, ctx } = await openGame();
      const generated: Record<string, string> = {};
      const built: BuiltResource[] = await buildMod(dir, rm, world, ctx, (file, text) => (generated[file] = text));
      const out = join(ROOT, "out/mods", mod);
      for (const r of built) writePatch(out, r.type, r.number, r.data);
      const flagsFile = join(dir, "flags.yaml");
      return {
        ok: true,
        resources: built.map((r) => ({ type: r.type, number: r.number, data: Buffer.from(r.data).toString("base64") })),
        generated,
        flags: existsSync(flagsFile) ? readFileSync(flagsFile, "utf8") : undefined,
        ms: Date.now() - started,
      };
    } catch (e) {
      const message = (e as Error).message;
      // Compiler errors start with file:line.
      const at = /^(?:.*\/)?([^/:\s]+):(\d+):/.exec(message);
      return { ok: false, error: { message: message.replace(ROOT + "/", ""), file: at?.[1], line: at ? Number(at[2]) : undefined }, ms: Date.now() - started };
    }
  };
  const result = queue.then(run, run);
  queue = result;
  return result;
}

/**
 * Rebuilds a game of ours into out/games/<name>, and returns what changed since the files
 * there (which the page is running).
 */
async function buildServedGame(name: string): Promise<BuildResult> {
  const game = await buildGame(join(GAMES, name));
  const out = join(ROOT, "out/games", name);
  const changed: typeof game.resources = [];
  if (existsSync(join(out, "RESOURCE.MAP"))) {
    const before = await ResourceManager.open(nodeFiles(out), []);
    for (const r of game.resources) {
      const old = before.has(r) ? (await before.load(r)).data : undefined;
      if (!old || Buffer.compare(Buffer.from(old), Buffer.from(r.data)) !== 0) changed.push(r);
    }
  } else changed.push(...game.resources);
  const { map, volume } = writeResourceArchive(game.resources);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "RESOURCE.MAP"), map);
  writeFileSync(join(out, "RESOURCE.000"), volume);
  // The running VM read its selector and class tables when it started.
  const reload = changed.some((r) => r.type === ResourceType.Vocab);
  const generated: Record<string, string> = {};
  for (const [n, text] of game.generated) generated[`${n}.sca`] = text;
  for (const [n, text] of game.roomMessages) generated[`${n}.msg`] = text;
  const flagsFile = join(GAMES, name, "flags.yaml");
  return {
    ok: true,
    resources: changed.map((r) => ({ type: r.type, number: r.number, data: Buffer.from(r.data).toString("base64") })),
    generated,
    flags: existsSync(flagsFile) ? readFileSync(flagsFile, "utf8") : undefined,
    reload: reload || undefined,
  };
}
