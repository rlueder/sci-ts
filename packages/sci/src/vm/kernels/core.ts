import { ResourceType } from "../../resource/types.ts";
import type { KernelFn } from "../vm.ts";
import { NULL, bool, fromInt, toSigned } from "../value.ts";

/** Script, object and resource management. */
export const coreKernels: Record<string, KernelFn> = {
  // Resource loading is eager in this engine, so these only need to answer sensibly.
  Load: (_vm, [, number = 0]) => number,
  Unload: () => 0,
  Lock: () => 0,
  Purge: () => 0,
  ResCheck: (vm, [type = 0, number = 0]) => bool(vm.resources.has({ type: (type & 0x7f) as ResourceType, number })),

  ScriptID: (vm, [script = 0, index = 0]) => {
    if (!vm.resources.has({ type: ResourceType.Script, number: script })) return NULL;
    return vm.exportAddress(script, index);
  },
  // Unloads the script (see Vm.disposeScript) and returns its optional second argument:
  // scripts use it to hand a value back from code that's about to be unloaded (SRDialog
  // returns the chosen save id this way).
  DisposeScript: (vm, args) => {
    vm.disposeScript(args[0]! & 0xffff);
    return args.length >= 2 ? args[1] : undefined;
  },

  Clone: (vm, [obj = 0]) => vm.memory.clone(vm.object(obj)).address,
  DisposeClone: (vm, [obj = 0]) => {
    const o = vm.memory.object(obj);
    if (o) vm.memory.disposeClone(o);
  },
  RespondsTo: (vm, [obj = 0, selector = 0]) => {
    const o = vm.memory.object(obj);
    return bool(!!o && vm.respondsTo(o, selector));
  },
};

let seed = 0x1234;
const bootDate = Date.now();

/** Maths, time and the host platform. */
export const mathKernels: Record<string, KernelFn> = {
  Random: (_vm, args) => {
    if (args.length === 1) {
      seed = args[0]!; // seed the generator
      return 0;
    }
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (args.length < 2) return (seed >> 8) & 0xffff;
    const lo = toSigned(args[0]!), hi = toSigned(args[1]!);
    return fromInt(lo + ((seed >> 8) % (hi - lo + 1)));
  },
  Abs: (_vm, [n = 0]) => fromInt(Math.abs(toSigned(n))),
  Sqrt: (_vm, [n = 0]) => Math.floor(Math.sqrt(Math.abs(toSigned(n)))),
  GetAngle: (_vm, [x1 = 0, y1 = 0, x2 = 0, y2 = 0]) => sciAngle(toSigned(x2) - toSigned(x1), toSigned(y2) - toSigned(y1)),
  GetDistance: (_vm, [x1 = 0, y1 = 0, x2 = 0, y2 = 0, perspective = 0]) => {
    const dx = toSigned(x2) - toSigned(x1);
    let dy = toSigned(y2) - toSigned(y1);
    if (perspective) dy = Math.trunc((dy * 3) / 2);
    return Math.round(Math.sqrt(dx * dx + dy * dy)) & 0xffff;
  },
  ATan: (_vm, [x1 = 0, y1 = 0, x2 = 0, y2 = 0]) => sciAngle(toSigned(x2) - toSigned(x1), toSigned(y2) - toSigned(y1)),
  SinMult: (_vm, [angle = 0, n = 0]) => fromInt(Math.round(Math.sin(rad(angle)) * toSigned(n))),
  CosMult: (_vm, [angle = 0, n = 0]) => fromInt(Math.round(Math.cos(rad(angle)) * toSigned(n))),
  SinDiv: (_vm, [angle = 0, n = 0]) => {
    const s = Math.sin(rad(angle));
    return s === 0 ? 0 : fromInt(Math.round(toSigned(n) / s));
  },
  CosDiv: (_vm, [angle = 0, n = 0]) => {
    const c = Math.cos(rad(angle));
    return c === 0 ? 0 : fromInt(Math.round(toSigned(n) / c));
  },
  GetTime: (vm, [mode = 0]) => {
    // All modes follow vm.clock so headless runs see time pass consistently.
    const now = new Date(bootDate + vm.clock());
    switch (mode) {
      case 0: return Math.floor((vm.clock() * 60) / 1000) & 0xffff; // ticks (1/60 s)
      case 1: return ((now.getHours() % 12) << 12) | (now.getMinutes() << 6) | now.getSeconds();
      case 2: return (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      default: return ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    }
  },
  Platform: (_vm, [op = 0]) => (op === 0 ? 1 /* DOS */ : op === 2 ? 2 /* 256 colours */ : 0),
};

const rad = (deg: number) => (toSigned(deg) * Math.PI) / 180;

/** SCI angles: 0 = north (up), clockwise, 0..359. */
function sciAngle(dx: number, dy: number): number {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return Math.round((deg + 360) % 360);
}
