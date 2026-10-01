import type { SciObject } from "../vm/memory.ts";
import { graphics } from "../vm/kernels/graphics.ts";
import type { Value } from "../vm/value.ts";
import type { Vm } from "../vm/vm.ts";

/**
 * Reading a running game for tools (the explorer's live view): globals, the system
 * collections, polygons and what's drawn where. Read-only: nothing here sends messages or
 * changes state.
 */

/** SCI's system scripts fix these globals. */
export const EGO_GLOBAL = 0;
export const CUR_ROOM_GLOBAL = 2;
export const ROOM_NUM_GLOBAL = 11;
/** The room the game should switch to: Game::doit calls `newRoom:` when it differs from 11. */
export const NEW_ROOM_GLOBAL = 13;

/** Script 0's variables are the game's globals. */
export const gameGlobal = (vm: Vm, n: number): Value | undefined => vm.loadedScripts.find((s) => s.number === 0)?.locals[n];

export const objectAt = (vm: Vm, v: Value | undefined): SciObject | undefined => (v ? vm.memory.object(v) : undefined);

/** A property as a signed 16-bit number (object references come back unchanged). */
export const signedProp = (vm: Vm, o: SciObject | Value, name: string): number => {
  const v = vm.getProp(o, name) ?? 0;
  return v >= 0x8000 && v < 0x10000 ? v - 0x10000 : v;
};

/** The first instance with this name, e.g. the system collections cast, features, regions. */
export function namedObject(vm: Vm, name: string): SciObject | undefined {
  for (const o of vm.memory.objects.values()) if (!o.isClass && o.name === name) return o;
  return undefined;
}

/** The objects in a collection's `elements` list (cast, features, obstacles...). */
export function collectionElements(vm: Vm, collection: SciObject | Value | undefined): SciObject[] {
  const c = typeof collection === "number" ? objectAt(vm, collection) : collection;
  const elements = c && vm.getProp(c, "elements");
  const list = elements ? vm.memory.list(elements) : undefined;
  const out: SciObject[] = [];
  // Guard against a corrupted (cyclic) list: a tool must never hang the page.
  for (let n = list?.first, guard = 0; n && guard < 10_000; n = n.next, guard++) {
    const o = objectAt(vm, n.value);
    if (o) out.push(o);
  }
  return out;
}

/** Numbers from an array, or an IntArray object's `data`. */
export function readInts(vm: Vm, ref: Value, count: number): number[] {
  if (!ref) return [];
  const direct = vm.memory.array(ref);
  const data = direct ? undefined : vm.memory.object(ref) ? vm.getProp(ref, "data") : undefined;
  const array = direct ?? (data ? vm.memory.array(data) : undefined);
  return (array?.data ?? []).slice(0, count).map((v) => (v >= 0x8000 ? v - 0x10000 : v));
}

/** Polygon types: 0 total access, 1 near point, 2 barred, 3 contained. */
export function polygonOf(vm: Vm, poly: SciObject): { type: number; points: [number, number][] } {
  const size = Math.max(0, Math.min(signedProp(vm, poly, "size"), 1000));
  const flat = readInts(vm, vm.getProp(poly, "points") ?? 0, size * 2);
  return {
    type: signedProp(vm, poly, "type"),
    points: Array.from({ length: Math.floor(flat.length / 2) }, (_, i) => [flat[i * 2]!, flat[i * 2 + 1]!] as [number, number]),
  };
}

export function isKindOf(vm: Vm, o: SciObject, className: string): boolean {
  for (let species = o.isClass ? o.species : o.superclass, guard = 0; species !== 0xffff && guard < 64; guard++) {
    let c: SciObject | undefined;
    try {
      c = vm.classObject(species);
    } catch {
      return false;
    }
    if (c.name === className) return true;
    species = c.superclass;
  }
  return false;
}

/** The room's plane (below the status bar): room objects' coordinates are relative to it. */
export function roomPlane(vm: Vm): { left: number; top: number; address: Value } | undefined {
  const g = graphics(vm);
  const room = objectAt(vm, gameGlobal(vm, CUR_ROOM_GLOBAL));
  let plane = room ? vm.getProp(room, "plane") : undefined;
  if (!plane || !vm.memory.object(plane)) {
    plane = [...g.planes].find((p) => vm.memory.object(p) && g.prop(p, "picture") >= 0 && g.prop(p, "picture") < 0x8000);
  }
  return plane ? { left: g.prop(plane, "inLeft"), top: g.prop(plane, "inTop"), address: plane } : undefined;
}

export interface DrawnItem {
  item: SciObject;
  plane: Value;
  /** Screen rectangle. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** View screen items in visible planes, frontmost first, where they're drawn on screen. */
export function drawnItems(vm: Vm): DrawnItem[] {
  const g = graphics(vm);
  const out: (DrawnItem & { order: number })[] = [];
  for (const item of g.items) {
    const o = objectAt(vm, item);
    const plane = o && vm.getProp(item, "plane");
    if (!o || !plane || !vm.memory.object(plane)) continue;
    const planePriority = g.prop(plane, "priority");
    if (planePriority === -1) continue;
    const bitmap = vm.getProp(item, "bitmap");
    if (bitmap && vm.memory.bitmap(bitmap)) continue;
    const r = g.viewRect(item);
    if (!r) continue;
    const priority = g.prop(item, "fixPriority") ? g.prop(item, "priority") : g.prop(item, "y");
    out.push({ item: o, plane, x: g.prop(plane, "inLeft") + r.x, y: g.prop(plane, "inTop") + r.y, w: r.width, h: r.height, order: planePriority * 100_000 + priority });
  }
  return out.sort((a, b) => b.order - a.order);
}

/**
 * Asks the game to go to `room`, the way it changes rooms itself: `Game::doit` sees
 * `newRoomNum` (global 13) differ from the current room and calls `newRoom:` (transitions and
 * all). Call between frames. Rooms may assume story state (flags, items, where you came
 * from); Sierra's debug keys (Alt-G flags, Alt-I items) can set that up.
 */
export function requestRoom(vm: Vm, room: number): void {
  const script0 = vm.loadedScripts.find((s) => s.number === 0);
  if (!script0) throw new Error("The game hasn't started");
  script0.locals[NEW_ROOM_GLOBAL] = room & 0xffff;
}

/** True once there's a hero in play (after character creation or a restore). */
export function heroInPlay(vm: Vm): boolean {
  const ego = objectAt(vm, gameGlobal(vm, EGO_GLOBAL));
  return !!ego && signedProp(vm, ego, "view") > 0;
}
