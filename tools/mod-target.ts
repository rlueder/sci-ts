import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Target } from "@sci-ts/content";

/**
 * A game that mods can add rooms to: how the content compiler should write for it, plus
 * patches to the game's own scripts that new rooms may need.
 */
export interface ModTarget {
  content: Target;
  /**
   * Applied when a room brings its own characters: generated file (e.g. "0.sca") -> diff
   * that teaches the game to ask the current room for talkers numbered from
   * `content.firstRoomTalker`.
   */
  roomTalkerPatches?: Record<string, string>;
}

const TARGETS = join(import.meta.dirname, "targets");

/** The target named in a mod's mod.yaml (`target: <name>`): tools/targets/<name>.ts. */
export async function loadTarget(modDir: string): Promise<ModTarget> {
  const file = join(modDir, "mod.yaml");
  const known = existsSync(TARGETS) ? readdirSync(TARGETS).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)) : [];
  const listing = known.length ? `available: ${known.join(", ")}` : "none in tools/targets";
  if (!existsSync(file)) throw new Error(`${modDir}: rooms need a mod.yaml naming the game (target: <name>; ${listing})`);
  const name = /^target:\s*([\w-]+)\s*$/m.exec(readFileSync(file, "utf8"))?.[1];
  if (!name) throw new Error(`${file}: expected a line "target: <name>" (${listing})`);
  if (!known.includes(name)) throw new Error(`${file}: unknown target "${name}" (${listing})`);
  const mod = (await import(join(TARGETS, `${name}.ts`))) as { default: ModTarget };
  return mod.default;
}
