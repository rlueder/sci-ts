import type { KernelFn, Vm } from "../vm.ts";
import { stringHelpers } from "./arrays.ts";
import { fromInt, toSigned, type Value } from "../value.ts";

/** SCI key codes for non-character keys: PC BIOS scan codes in the high byte. */
export const SciKey = {
  Home: 0x4700, Up: 0x4800, PageUp: 0x4900, Left: 0x4b00, Center: 0x4c00, Right: 0x4d00,
  End: 0x4f00, Down: 0x5000, PageDown: 0x5100, Insert: 0x5200, Delete: 0x5300, ShiftTab: 0x0f00,
  F1: 0x3b00, F2: 0x3c00, F3: 0x3d00, F4: 0x3e00, F5: 0x3f00, F6: 0x4000, F7: 0x4100, F8: 0x4200, F9: 0x4300, F10: 0x4400,
} as const;

/** Keypad/arrow keys → SCI directions (1 = up, clockwise to 8 = up-left; 0 = stop). */
const KEY_TO_DIRECTION = new Map<number, number>([
  [SciKey.Up, 1], [SciKey.PageUp, 2], [SciKey.Right, 3], [SciKey.PageDown, 4],
  [SciKey.Down, 5], [SciKey.End, 6], [SciKey.Left, 7], [SciKey.Home, 8], [SciKey.Center, 0],
]);

/** SCI event types (SCI32). */
// Direction = 0x10 in SCI2 (scripts test `type & $10`); SCI0 used 0x40.
export const EventType = { Null: 0, MouseDown: 1, MouseUp: 2, KeyDown: 4, KeyUp: 8, Direction: 0x10, Quit: 0x400 } as const;

export interface SciEvent {
  type: number;
  message: number;
  modifiers: number;
  x: number;
  y: number;
}

/** Input from the host (browser or test harness). */
export class Input {
  readonly queue: SciEvent[] = [];
  x = 160;
  y = 100;
  modifiers = 0;

  push(e: Omit<SciEvent, "x" | "y" | "modifiers"> & Partial<SciEvent>): void {
    this.queue.push({ x: this.x, y: this.y, modifiers: this.modifiers, ...e });
  }
}

const inputOf = new WeakMap<Vm, Input>();
export const input = (vm: Vm): Input => {
  let i = inputOf.get(vm);
  if (!i) {
    const created = new Input();
    inputOf.set(vm, (i = created));
    vm.moveMouse ??= (x, y) => {
      created.x = x;
      created.y = y;
    };
  }
  return i;
};

function shiftEvent(vm: Vm, event: Value, plane: Value, sign: number): Value {
  if (!vm.memory.object(event) || !vm.memory.object(plane)) return 0;
  const get = (o: Value, n: string) => toSigned(vm.getProp(o, n) ?? 0);
  vm.setProp(event, "x", fromInt(get(event, "x") + sign * get(plane, "inLeft")));
  vm.setProp(event, "y", fromInt(get(event, "y") + sign * get(plane, "inTop")));
  return 0;
}

/** Events, sound (stubbed for now), files and host information. */
export const systemKernels: Record<string, KernelFn> = {
  GetEvent: (vm, [mask = 0, event = 0]) => {
    const inp = input(vm);
    const index = inp.queue.findIndex((e) => (e.type & mask) !== 0);
    const e = index >= 0 ? inp.queue.splice(index, 1)[0]! : { type: EventType.Null, message: 0, modifiers: inp.modifiers, x: inp.x, y: inp.y };
    vm.setProp(event, "type", e.type);
    vm.setProp(event, "message", e.message);
    vm.setProp(event, "modifiers", e.modifiers);
    vm.setProp(event, "x", fromInt(e.x));
    vm.setProp(event, "y", fromInt(e.y));
    return e.type === EventType.Null ? 0 : 1;
  },
  // Convert an event's x/y between screen and plane-local coordinates.
  GlobalToLocal: (vm, [event = 0, plane = 0]) => shiftEvent(vm, event, plane, -1),
  LocalToGlobal: (vm, [event = 0, plane = 0]) => shiftEvent(vm, event, plane, 1),
  // Turns an arrow/keypad key event into a direction event; 0 if it isn't one.
  MapKeyToDir: (vm, [event = 0]) => {
    if (vm.getProp(event, "type") !== EventType.KeyDown) return undefined; // leave acc
    const dir = KEY_TO_DIRECTION.get(vm.getProp(event, "message") ?? 0);
    if (dir === undefined) return 0;
    vm.setProp(event, "type", EventType.Direction);
    vm.setProp(event, "message", dir);
    return 1;
  },
  VibrateMouse: () => 0,

  SetQuitStr: () => 0,
  GetCWD: (vm) => stringHelpers.newString(vm, "C:\\GAME"),
  ValidPath: () => 1,
  CheckFreeSpace: () => 1,
  CheckCDisc: () => 1,
  GetSaveCDisc: () => 1,
  DeviceInfo: () => 0,
  MemoryInfo: () => 0x7fff,
  ResourceTrack: () => 0,
  PreloadResource: () => 0,
  Dummy: () => 0,

  // No filesystem yet: opens fail (-1), which the scripts handle as "no config/saves".
  FileIO: (vm, [op = 0, name = 0]) => {
    switch (op) {
      case 0: return 0xffff; // open
      case 10: { // exists: only what the host says is there
        const file = stringHelpers.str(vm, name).split(/[\\/]/).pop()!.toLowerCase();
        return hostFiles(vm).has(file) ? 1 : 0;
      }
      default: return 0;
    }
  },
};

export type { Value };

const hostFileSets = new WeakMap<Vm, Set<string>>();
/**
 * Files the game may find with FileIO "exists" (lower-case names). A game may load Sierra's
 * debug room (script 18: Alt-T teleport, Alt-G flags, Alt-I items...) when "18.scr" exists, as it
 * did on the developers' machines.
 */
export const hostFiles = (vm: Vm): Set<string> => {
  let set = hostFileSets.get(vm);
  if (!set) hostFileSets.set(vm, (set = new Set()));
  return set;
};
