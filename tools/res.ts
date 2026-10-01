/**
 * Resource CLI.
 *   pnpm res list [type]              JSONL of every resource (optionally one type)
 *   pnpm res extract <type> <number>  write decompressed bytes to out/<type>.<number>.bin
 *   pnpm res disasm <script>          print a script's disassembly
 */
import { mkdir, writeFile } from "node:fs/promises";
import { ResourceManager, ResourceType, ScriptWorld, disassemble, formatDisassembly, resourceTypeName } from "@sci-ts/sci";
import { nodeFiles } from "./node-files.ts";

const typeByName = (name: string): ResourceType => {
  const t = Object.entries(ResourceType).find(([k]) => k.toLowerCase() === name.toLowerCase());
  if (!t) throw new Error(`Unknown resource type "${name}"`);
  return t[1];
};

process.stdout.on("error", (e: NodeJS.ErrnoException) => e.code === "EPIPE" && process.exit(0));

const [cmd, ...args] = process.argv.slice(2);
const rm = await ResourceManager.open(nodeFiles(process.env.SCI_GAME ?? "original"));

switch (cmd) {
  case "list": {
    const type = args[0] ? typeByName(args[0]) : undefined;
    for (const r of rm.list(type)) {
      console.log(JSON.stringify({ type: resourceTypeName[r.type], number: r.number, source: r.source }));
    }
    break;
  }
  case "extract": {
    const [typeName, num] = args;
    if (!typeName || !num) throw new Error("usage: extract <type> <number>");
    const res = await rm.load({ type: typeByName(typeName), number: Number(num) });
    await mkdir("out", { recursive: true });
    const path = `out/${typeName.toLowerCase()}.${num}.bin`;
    await writeFile(path, res.data);
    console.log(JSON.stringify({ path, bytes: res.data.length }));
    break;
  }
  case "disasm": {
    const world = await ScriptWorld.open(rm);
    await world.loadAllClasses();
    const script = await world.script(Number(args[0]));
    console.log(formatDisassembly(script, disassemble(script, world.context())));
    break;
  }
  default:
    console.error("usage: pnpm res <list [type] | extract <type> <number> | disasm <script>>");
    process.exit(1);
}
