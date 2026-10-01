import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { GameBuildError } from "./build.ts";

/** Where `sci-ts new` copies from: a room in YAML and Yarn, the game, placeholder art. */
const TEMPLATE = join(import.meta.dirname, "template");
const ROOT = resolve(import.meta.dirname, "../..");

/**
 * A new game in `target` (a folder that doesn't exist yet), from the template. NAME becomes
 * the folder's name and Name the same in capitals (the game's class). KIT and SCHEMA become
 * the art kit and the room schema: by path for a game inside this repository, through the
 * `sci-ts` package for one outside it. `.tmpl` files lose the suffix (they aren't type
 * checked where they stand). `refs` overrides that choice. Returns the game's folder.
 */
export function newGame(target: string, refs?: "path" | "package"): string {
  const name = basename(resolve(target));
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new GameBuildError(`${name}: a game's name is lower-case letters, digits and dashes, starting with a letter`);
  if (existsSync(target) && readdirSync(target).some((f) => f === "scripts" || f === "rooms")) throw new GameBuildError(`${target} is already there`);
  const inside = refs ? refs === "path" : !relative(ROOT, resolve(target)).startsWith("..");
  const slash = (p: string) => p.replaceAll("\\", "/");
  const kit = inside ? slash(relative(resolve(target), join(ROOT, "tools/game/kit.ts"))) : "sci-ts/kit";
  const schema = inside
    ? slash(relative(join(resolve(target), "rooms"), join(ROOT, "packages/content/room.schema.json")))
    : "../node_modules/sci-ts/packages/content/room.schema.json";
  const Name = name.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
  const fill = (text: string) =>
    text.replaceAll('"KIT"', JSON.stringify(kit)).replaceAll("SCHEMA", schema).replaceAll("NAME", name).replaceAll("Name", Name);
  const copy = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(join(from, entry.name), join(to, entry.name));
      else writeFileSync(join(to, entry.name.replace(/\.tmpl$/, "")), fill(readFileSync(join(from, entry.name), "utf8")));
    }
  };
  copy(TEMPLATE, target);
  return target;
}
