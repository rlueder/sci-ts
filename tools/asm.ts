/**
 * SCI2 assembly.
 *   pnpm asm dump <script> [file.sca]     write a script as assembly text
 *   pnpm asm build <file.sca> [outDir]    assemble into <n>.SCR + <n>.HEP patch files
 *   pnpm asm roundtrip [script...]        disassemble + reassemble, compare bytes (all by default)
 *
 * Mods (diffs against these dumps) are built with `pnpm mod`, see tools/mod.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ResourceManager, ResourceType, ScriptWorld, assemble, toAssembly } from "@sci-ts/sci";
import { nodeFiles } from "./node-files.ts";
import { writePatch } from "./patches.ts";

const [command = "roundtrip", ...args] = process.argv.slice(2);
const rm = await ResourceManager.open(nodeFiles(process.env.SCI_GAME ?? "original"));
const world = await ScriptWorld.open(rm);
await world.loadAllClasses();
const ctx = world.asmContext();

const firstDiff = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return -1;
};

if (command === "dump") {
  const text = toAssembly(await world.script(Number(args[0])), ctx);
  if (args[1]) writeFileSync(args[1], text);
  else process.stdout.write(text);
} else if (command === "build") {
  build(readFileSync(args[0]!, "utf8"), args[1] ?? "out/mods");
} else if (command === "roundtrip") {
  const numbers = args.length ? args.map(Number) : rm.list(ResourceType.Script).map((r) => r.number).filter((n) => rm.has({ type: ResourceType.Heap, number: n }));
  let ok = 0;
  const failures: string[] = [];
  for (const n of numbers) {
    const s = await world.script(n);
    try {
      const out = assemble(toAssembly(s, ctx), ctx);
      const dc = firstDiff(s.code, out.code), dh = firstDiff(s.heap, out.heap);
      if (dc < 0 && dh < 0) ok++;
      else failures.push(`${n}: ${dc >= 0 ? `code differs at $${dc.toString(16)} (${s.code.length} vs ${out.code.length} bytes)` : ""} ${dh >= 0 ? `heap differs at $${dh.toString(16)} (${s.heap.length} vs ${out.heap.length} bytes)` : ""}`);
    } catch (e) {
      failures.push(`${n}: ${(e as Error).message}`);
    }
  }
  console.log(`${ok}/${numbers.length} scripts round-trip byte-exact`);
  if (failures.length) console.log(failures.slice(0, 20).join("\n"));
  process.exitCode = failures.length ? 1 : 0;
}

function build(text: string, dir: string) {
  const out = assemble(text, ctx);
  writePatch(dir, ResourceType.Script, out.number, out.code);
  writePatch(dir, ResourceType.Heap, out.number, out.heap);
}
