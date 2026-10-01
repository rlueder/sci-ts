/**
 * Scripted headless session: boots, then replays clicks at given frames.
 *   pnpm tsx tools/scenario.ts <frames> [frame:x,y ...] [--png-every N] [--out dir]
 *   frame:type=Text   types Text followed by Enter at that frame
 *   frame:move=x,y    moves the mouse without clicking (e.g. to open the icon bar)
 * Example: pnpm tsx tools/scenario.ts 2400 1401:160,60 1800:100,110 2000:type=Hero
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { EventType, ResourceManager, Vm, allKernels, formatValue, graphics, input } from "@sci-ts/sci";
import { nodeFiles } from "./node-files.ts";
import { framePng } from "./png.ts";

const argv = process.argv.slice(2);
const total = Number(argv[0]);
const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const pngEvery = Number(opt("--png-every") ?? 0);
const outDir = opt("--out") ?? "out/scenario";
const clicks = new Map(
  argv.filter((a) => /^\d+:\d+,\d+$/.test(a)).map((a) => {
    const [f, xy] = a.split(":");
    const [x, y] = xy!.split(",").map(Number);
    return [Number(f), { x: x!, y: y! }] as const;
  }),
);

const typing = new Map(
  argv.filter((a) => /^\d+:type=/.test(a)).map((a) => {
    const i = a.indexOf(":type=");
    return [Number(a.slice(0, i)), a.slice(i + 6)] as const;
  }),
);

const moves = new Map(
  argv.filter((a) => /^\d+:move=\d+,\d+$/.test(a)).map((a) => {
    const [f, xy] = a.split(":move=");
    const [x, y] = xy!.split(",").map(Number);
    return [Number(f), { x: x!, y: y! }] as const;
  }),
);

const rm = await ResourceManager.open(nodeFiles("original"));
await rm.preload();
const vm = new Vm(rm);
vm.registerKernels(allKernels);
const g = graphics(vm);
vm.clock = () => (g.frames * 1000) / 60;
if (pngEvery) mkdirSync(outDir, { recursive: true });
g.onFrame = (f) => {
  if (pngEvery && (g.frames % pngEvery === 0 || clicks.has(g.frames - 1) || typing.has(g.frames - 1))) writeFileSync(`${outDir}/${String(g.frames).padStart(5, "0")}.png`, framePng(f));
};
const trace = argv.includes("--trace") ? (opt("--trace-from") ? Number(opt("--trace-from")) : 0) : Infinity;
vm.onKernelCall = (name, args, r) => {
  if (g.frames >= trace && !["GetEvent", "FrameOut", "GetTime", "ListEachElementDo", "EmptyList", "FirstNode", "NextNode", "NodeValue", "Clone", "DisposeClone", "GameIsRestarting"].includes(name))
    console.log(`  [${g.frames}] ${name}(${args.map((a) => vm.memory.object(a)?.name ?? formatValue(a)).join(", ")}) → ${formatValue(r)}`);
};

vm.start(vm.exportAddress(0, 0), "play");
const inp = input(vm);
try {
  while (g.frames < total && vm.running) {
    const move = moves.get(g.frames);
    if (move) (inp.x = move.x), (inp.y = move.y);
    const click = clicks.get(g.frames);
    if (click) {
      inp.x = click.x;
      inp.y = click.y;
      inp.push({ type: EventType.MouseDown, message: 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
    }
    const text = typing.get(g.frames);
    if (text !== undefined) {
      for (const ch of text) inp.push({ type: EventType.KeyDown, message: ch.charCodeAt(0) });
      inp.push({ type: EventType.KeyDown, message: 13 });
    }
    vm.run();
  }
} catch (e) {
  console.log(`ERROR at frame ${g.frames}: ${(e as Error).message}\n${vm.backtrace().map((l) => `  at ${l}`).join("\n")}`);
}
console.log(`frames ${g.frames}, missing kernels:`, Object.fromEntries(vm.missingKernels));
