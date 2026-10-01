/**
 * Message resources as text.
 *   pnpm msg dump <n> [file.msg]     write a message file as text (verbs and nouns annotated)
 *   pnpm msg build <file.msg> [dir]  build a <n>.MSG patch file (default out/mods)
 *   pnpm msg roundtrip               parse + write every message file, compare bytes
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ResourceManager, ResourceType, ScriptWorld, messagesFromText, messagesToText, parseMessages, writeMessages } from "@sci-ts/sci";
import { dumpMessages } from "./mod-build.ts";
import { nodeFiles } from "./node-files.ts";
import { writePatch } from "./patches.ts";

const [command = "roundtrip", ...args] = process.argv.slice(2);
const rm = await ResourceManager.open(nodeFiles(process.env.SCI_GAME ?? "original"));

if (command === "dump") {
  const text = await dumpMessages(rm, await ScriptWorld.open(rm), Number(args[0]));
  if (args[1]) writeFileSync(args[1], text);
  else process.stdout.write(text);
} else if (command === "build") {
  const { number, file } = messagesFromText(readFileSync(args[0]!, "utf8"));
  writePatch(args[1] ?? "out/mods", ResourceType.Message, number, writeMessages(file));
} else {
  let ok = 0;
  const bad: number[] = [];
  const list = rm.list(ResourceType.Message);
  for (const info of list) {
    const data = (await rm.load(info)).data;
    const direct = writeMessages(parseMessages(data));
    const viaText = writeMessages(messagesFromText(messagesToText(info.number, parseMessages(data))).file);
    if (Buffer.compare(Buffer.from(data), Buffer.from(direct)) === 0 && Buffer.compare(Buffer.from(data), Buffer.from(viaText)) === 0) ok++;
    else bad.push(info.number);
  }
  console.log(`${ok}/${list.length} message files round-trip byte-exact (binary and via text)${bad.length ? `; differ: ${bad.join(" ")}` : ""}`);
  process.exitCode = bad.length ? 1 : 0;
}
