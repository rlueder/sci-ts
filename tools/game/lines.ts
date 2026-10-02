import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { YarnError, parseYarn, tagLines, yarnLines } from "@sci-ts/content";
import { GameBuildError } from "./build.ts";

/**
 * Spoken lines and their recordings. Recordings are filed under a line's #line: id, which
 * stays with the line however the rooms change; the build maps ids to message keys.
 */

const yarnFiles = (dir: string) => {
  const rooms = join(dir, "rooms");
  let names: string[];
  try { names = readdirSync(rooms); } catch { return []; }
  return names.filter((f) => /^\d+\.yarn$/.test(f)).sort().map((f) => ({ file: join(rooms, f), room: f.slice(0, -5) }));
};

/**
 * Gives every spoken line in the game's rooms/*.yarn without an id one: `<room>-001` and on,
 * unique across the game. Returns the files changed and the ids added to each.
 */
export function tagGameLines(dir: string): { file: string; added: string[] }[] {
  const files = yarnFiles(dir).map((f) => ({ ...f, text: readFileSync(f.file, "utf8") }));
  const parse = <T>(f: () => T): T => {
    try { return f(); } catch (e) {
      if (e instanceof YarnError) throw new GameBuildError(e.message);
      throw e;
    }
  };
  const taken = new Set<string>();
  for (const f of files) {
    const where = relative(process.cwd(), f.file);
    for (const l of parse(() => parseYarn(f.text, where)).flatMap((n) => yarnLines(n.body))) if (l.id !== undefined) taken.add(l.id);
  }
  const changed: { file: string; added: string[] }[] = [];
  for (const f of files) {
    const where = relative(process.cwd(), f.file);
    const { source, added } = parse(() => tagLines(f.text, f.room, taken, where));
    if (!added.length) continue;
    writeFileSync(f.file, source);
    changed.push({ file: f.file, added });
  }
  return changed;
}
