import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Where `pnpm game new` copies from: a room in YAML and Yarn, the game, placeholder art. */
const TEMPLATE = join(import.meta.dirname, "template");

/**
 * A new game in `gamesDir/<name>`, from the template: NAME becomes the name, Name the
 * name in capitals (the game's class) and KIT the path to tools/game/kit.ts; `.tmpl` files
 * lose the suffix (they aren't type checked where they stand). Returns the game's folder.
 */
export function newGame(name: string, gamesDir = "games"): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${name}: a game's name is lower-case letters, digits and dashes, starting with a letter`);
  const target = join(gamesDir, name);
  if (existsSync(target)) throw new Error(`${target} is already there`);
  const kit = relative(target, join(import.meta.dirname, "kit.ts")).replaceAll("\\", "/");
  const Name = name.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
  const copy = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(join(from, entry.name), join(to, entry.name));
      else writeFileSync(join(to, entry.name.replace(/\.tmpl$/, "")), readFileSync(join(from, entry.name), "utf8").replaceAll('"KIT"', JSON.stringify(kit)).replaceAll("NAME", name).replaceAll("Name", Name));
    }
  };
  copy(TEMPLATE, target);
  return target;
}
