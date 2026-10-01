/**
 * Headless game runner for debugging the VM.
 *   pnpm play [--frames N] [--trace] [--png-every K]
 *     boot the game, run N FrameOut cycles, report kernel usage, save every Kth frame to out/
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { ResourceManager, Vm, allKernels, formatValue, graphics } from "@sci-ts/sci";
import { nodeFiles } from "./node-files.ts";
import { framePng } from "./png.ts";

const argv = process.argv.slice(2);
const frames = Number(argv[argv.indexOf("--frames") + 1] || 1);
const trace = argv.includes("--trace");
const pngEvery = Number(argv[argv.indexOf("--png-every") + 1] || 0) || (argv.includes("--png-every") ? 1 : 0);

const rm = await ResourceManager.open(nodeFiles(process.env.SCI_GAME ?? "original"));
await rm.preload();
const vm = new Vm(rm);
vm.registerKernels(allKernels);
// Deterministic time: each frame is one 60 Hz tick, however fast we actually run.
vm.clock = () => (graphics(vm).frames * 1000) / 60;

const calls = new Map<string, number>();
vm.onKernelCall = (name, args, result) => {
  calls.set(name, (calls.get(name) ?? 0) + 1);
  if (trace) console.log(`  ${name}(${args.map(formatValue).join(", ")}) → ${formatValue(result)}`);
};

if (pngEvery) mkdirSync("out/frames", { recursive: true });
graphics(vm).onFrame = (f) => {
  const n = graphics(vm).frames;
  if (pngEvery && n % pngEvery === 0) writeFileSync(`out/frames/${String(n).padStart(5, "0")}.png`, framePng(f));
};

const game = vm.exportAddress(0, 0);
console.log(`game object: ${vm.object(game).name}`);
vm.start(game, "play");

let frame = 0;
const t0 = performance.now();
try {
  while (vm.running && frame < frames) {
    vm.run();
    if (vm.yieldRequested) frame++;
    else if (vm.running) throw new Error("instruction budget exhausted without a frame (infinite loop?)");
  }
} catch (e) {
  console.log(`\nERROR: ${(e as Error).message}`);
  console.log(vm.backtrace().map((l) => `  at ${l}`).join("\n"));
}
const ms = performance.now() - t0;
console.log(`\n${vm.instructions.toLocaleString()} instructions in ${ms.toFixed(0)} ms, ${frame} frame(s), running=${vm.running}`);
console.log("kernel calls:", Object.fromEntries([...calls].sort((a, b) => b[1] - a[1])));
console.log("missing kernels:", Object.fromEntries(vm.missingKernels));
