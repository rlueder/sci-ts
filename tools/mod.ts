/**
 * Mods: directories of new files and diffs against generated text.
 *   pnpm mod build <modDir> [outDir]   build <n>.sca / <n>.msg (new files) and apply <n>.sca.diff /
 *                                      <n>.msg.diff (changes) to fresh dumps; patch files go to
 *                                      out/mods/<name> by default
 *                                      (<n>.room.yaml + <n>.yarn rooms are compiled first; the
 *                                      generated .sca/.msg land in <outDir>/generated to read)
 *   pnpm mod dump <n> <dir>            write <n>.sca and <n>.msg to start editing
 *
 * The repo holds only our own files and diffs, never Sierra's scripts or text. Tools load
 * built mods with SCI_MODS=out/mods/<name>[,...] and the browser pages with ?mods=<name>,
 * the way the game loads Sierra's own patch files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ResourceManager, ResourceType, ScriptWorld, toAssembly } from "@sci-ts/sci";
import { buildMod, dumpMessages } from "./mod-build.ts";
import { nodeFiles } from "./node-files.ts";
import { writePatch } from "./patches.ts";

const [command, ...args] = process.argv.slice(2);
const rm = await ResourceManager.open(nodeFiles(process.env.SCI_GAME ?? "original"));
const world = await ScriptWorld.open(rm);
await world.loadAllClasses();
const ctx = world.asmContext();

if (command === "dump") {
  const [n, dir = "."] = [Number(args[0]), args[1]];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${n}.sca`), toAssembly(await world.script(n), ctx));
  const hasMessages = rm.has({ type: ResourceType.Message, number: n });
  if (hasMessages) writeFileSync(join(dir, `${n}.msg`), await dumpMessages(rm, world, n));
  console.log(`wrote ${n}.sca${hasMessages ? ` and ${n}.msg` : ""} to ${dir}`);
} else if (command === "build") {
  const modDir = args[0]!.replace(/\/$/, "");
  const outDir = args[1] ?? join("out/mods", basename(modDir));
  const generated = join(outDir, "generated");
  const built = await buildMod(modDir, rm, world, ctx, (file, text) => {
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, file), text);
  });
  for (const r of built) writePatch(outDir, r.type, r.number, r.data);
} else {
  console.log("usage: pnpm mod build <modDir> [outDir] | pnpm mod dump <n> <dir>");
}
