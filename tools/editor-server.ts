/**
 * The live editor's server side (apps/viewer/editor.html, through the dev server's
 * /__editor routes): lists mods, reads their room files, and on save writes them and builds
 * the mod the way `pnpm mod build` does, returning the built resources for the page to swap
 * into the running game. The game's files and class tables stay loaded between builds.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ResourceManager, ScriptWorld, type AsmContext } from "@sci-ts/sci";
import { buildMod, type BuiltResource } from "./mod-build.ts";
import { nodeFiles } from "./node-files.ts";
import { writePatch } from "./patches.ts";

const ROOT = resolve(import.meta.dirname, "..");
const MODS = join(ROOT, "mods");
/** The files the editor shows and may write. */
const EDITABLE = /^(\d+\.room\.yaml|\d+\.yarn|flags\.yaml)$/;

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

export function listMods(): { name: string; rooms: number[] }[] {
  return readdirSync(MODS)
    .filter((d) => statSync(join(MODS, d)).isDirectory())
    .map((name) => ({
      name,
      rooms: readdirSync(join(MODS, name)).flatMap((f) => /^(\d+)\.room\.yaml$/.exec(f)?.[1] ?? []).map(Number).sort((a, b) => a - b),
    }));
}

export function readFiles(mod: string): Record<string, string> {
  const dir = modDir(mod);
  return Object.fromEntries(readdirSync(dir).filter((f) => EDITABLE.test(f)).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

export interface BuildResult {
  ok: boolean;
  /** Everything the mod builds, base64: the page swaps it into the running game. */
  resources?: { type: number; number: number; data: string }[];
  /** The compiled .sca / .msg text, for reading. */
  generated?: Record<string, string>;
  /** flags.yaml after the build (new variables get numbers). */
  flags?: string;
  ms?: number;
  error?: { message: string; file?: string; line?: number };
}

let queue: Promise<unknown> = Promise.resolve();

/** Writes `files` (only room files) into the mod, then builds it. One build at a time. */
export function save(mod: string, files: Record<string, string>): Promise<BuildResult> {
  const run = async (): Promise<BuildResult> => {
    const started = Date.now();
    try {
      const dir = modDir(mod);
      for (const [name, text] of Object.entries(files)) {
        if (!EDITABLE.test(name)) throw new Error(`the editor doesn't write ${name}`);
        if (!existsSync(join(dir, name)) || readFileSync(join(dir, name), "utf8") !== text) writeFileSync(join(dir, name), text);
      }
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
