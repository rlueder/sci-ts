/**
 * Static game index (rooms, exits, classes, objects) as JSON.
 *   pnpm tsx tools/analyze.ts [--summary]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { ResourceManager, analyzeGame } from "@sci-ts/sci";
import { nodeFiles } from "./node-files.ts";

const rm = await ResourceManager.open(nodeFiles(process.env.SCI_GAME ?? "original"));
const t = performance.now();
const index = await analyzeGame(rm);
const ms = Math.round(performance.now() - t);
mkdirSync("out", { recursive: true });
writeFileSync("out/game-index.json", JSON.stringify(index));
const byKind: Record<string, number> = {};
for (const e of index.exits) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
console.log(JSON.stringify({
  ms,
  rooms: index.rooms.length,
  classes: index.classes.length,
  objects: index.scripts.reduce((n, s) => n + s.objects.length, 0),
  exits: byKind,
  isolatedRooms: index.rooms.filter((r) => !index.exits.some((e) => e.from === r.number || e.to === r.number)).map((r) => r.number),
  unresolved: index.unresolved.length,
}, null, 1));
