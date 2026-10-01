import { ObjectSlot } from "../script/script.ts";
import { audio } from "./kernels/audio.ts";
import { graphics } from "./kernels/graphics.ts";
import { paletteEffects, type PaletteEffectsState } from "./kernels/palette.ts";
import type { Palette } from "../gfx/palette.ts";
import { cloneShape, type ArrayType, type ListNode, type SciList, type SciObject } from "./memory.ts";
import type { Vm } from "./vm.ts";
import { makeRef, segmentOf, type Value } from "./value.ts";

/**
 * A saved game: the VM's memory, not the original interpreter's. Every reference in the game
 * is a (segment, offset) pair, so restoring means recreating each segment at its original id:
 * scripts by number (their code comes from the resources), clones by the script object they
 * were cloned from, and arrays, lists, nodes and bitmaps by value. The call stack isn't
 * saved: like Sierra's interpreter, restoring restarts execution with `theGame replay`.
 */
export interface VmSnapshot {
  format: 1;
  segments: (SegmentSnapshot | null)[];
  freeSegments: number[];
  scripts: { number: number; segment: number; localsSegment: number; locals: Value[]; objects: [offset: number, vars: Value[]][] }[];
  stack: Value[];
  graphics: { planes: Value[]; items: Value[]; palette?: Palette; effects: PaletteEffectsState };
  audio: { masterVolume: number; songs: { object: Value; number: number; loop: boolean; volume: number; position: number }[] };
}

type SegmentSnapshot =
  | { kind: "script" | "locals" | "stack" }
  | { kind: "clone"; template: Value; vars: Value[] }
  | { kind: "array"; type: ArrayType; data: Value[] }
  | { kind: "list"; first: number; last: number }
  | { kind: "node"; value: Value; key: Value; prev: number; next: number; list: number }
  | { kind: "bitmap"; width: number; height: number; pixels: Uint8Array; skipColor: number; originX: number; originY: number };

const seg = (v: { address: Value } | undefined) => (v ? segmentOf(v.address) : -1);

export function snapshot(vm: Vm): VmSnapshot {
  const m = vm.memory;
  const segments = m.segments.map((s): SegmentSnapshot | null => {
    switch (s.kind) {
      case "script": case "locals": case "stack": return { kind: s.kind };
      case "clone": return { kind: "clone", template: s.object.template!.address, vars: s.object.vars.slice() };
      case "array": return { kind: "array", type: s.array.type, data: s.array.data.slice() };
      case "list": return { kind: "list", first: seg(s.list.first), last: seg(s.list.last) };
      case "node": return { kind: "node", value: s.node.value, key: s.node.key, prev: seg(s.node.prev), next: seg(s.node.next), list: seg(s.node.list) };
      case "bitmap": return { kind: "bitmap", ...s.bitmap, pixels: s.bitmap.pixels.slice() };
      default: return null;
    }
  });
  const g = graphics(vm);
  const a = audio(vm);
  const now = a.ticks();
  return {
    format: 1,
    segments,
    freeSegments: [...m.free_],
    scripts: vm.loadedScripts.map((s) => ({
      number: s.number,
      segment: s.segment,
      localsSegment: s.localsSegment,
      locals: s.locals.slice(),
      objects: [...s.objects].map(([offset, obj]) => [offset, obj.vars.slice()]),
    })),
    stack: m.stack.slice(),
    graphics: {
      planes: [...g.planes],
      items: [...g.items],
      palette: g.sourcePalette && { rgb: g.sourcePalette.rgb.slice(), used: g.sourcePalette.used.slice() },
      effects: paletteEffects(vm).save(),
    },
    audio: {
      masterVolume: a.masterVolume,
      songs: a.playingSongs().map((p) => ({ object: p.object, number: p.number, loop: p.player.loop, volume: p.player.volume, position: p.player.position(now) })),
    },
  };
}

/** Replaces the VM's state with `snap`. The caller then restarts execution (`replay`). */
export function restore(vm: Vm, snap: VmSnapshot): void {
  if (snap.format !== 1) throw new Error(`Unsupported save format ${snap.format}`);
  audio(vm).stopEverything();
  vm.resetMemory();
  const m = vm.memory;
  if (m.stackSegment !== snap.segments.findIndex((s) => s?.kind === "stack")) throw new Error("Stack segment moved");

  // Reserve the whole table so nothing we create lands on a saved id by accident.
  m.allocateAt(snap.segments.length - 1, { kind: "free" });
  m.setFreeSegments([]);

  for (const s of vm.restoreScripts(snap.scripts)) {
    const saved = snap.scripts.find((x) => x.number === s.number)!;
    s.locals.splice(0, s.locals.length, ...saved.locals);
    for (const [offset, vars] of saved.objects) {
      const obj = s.objects.get(offset);
      if (obj) obj.vars = vars.slice();
    }
  }

  const nodes = new Map<number, ListNode>();
  const lists = new Map<number, SciList>();
  snap.segments.forEach((s, id) => {
    if (!s) return;
    const address = makeRef(id, 0);
    switch (s.kind) {
      case "clone": {
        const template = m.object(s.template);
        if (!template) throw new Error(`Clone template ${s.template.toString(16)} missing`);
        const obj: SciObject = cloneShape(template.template ?? template, s.vars.slice());
        obj.address = address;
        m.allocateAt(id, { kind: "clone", object: obj });
        m.objects.set(address, obj);
        break;
      }
      case "array":
        m.allocateAt(id, { kind: "array", array: { type: s.type, data: s.data.slice() } });
        break;
      case "bitmap":
        m.allocateAt(id, { kind: "bitmap", bitmap: { width: s.width, height: s.height, pixels: s.pixels.slice(), skipColor: s.skipColor, originX: s.originX, originY: s.originY } });
        break;
      case "list": {
        const list: SciList = { address, first: undefined, last: undefined };
        lists.set(id, list);
        m.allocateAt(id, { kind: "list", list });
        break;
      }
      case "node": {
        const node: ListNode = { address, value: s.value, key: s.key, prev: undefined, next: undefined, list: undefined };
        nodes.set(id, node);
        m.allocateAt(id, { kind: "node", node });
        break;
      }
    }
  });
  // Link lists and nodes now that they all exist.
  snap.segments.forEach((s, id) => {
    if (s?.kind === "list") Object.assign(lists.get(id)!, { first: nodes.get(s.first), last: nodes.get(s.last) });
    if (s?.kind === "node") Object.assign(nodes.get(id)!, { prev: nodes.get(s.prev), next: nodes.get(s.next), list: lists.get(s.list) });
  });
  m.setFreeSegments(snap.freeSegments.slice());
  // Derived identity slots (see Vm.fixObjectIdentity): recompute rather than trust old saves.
  for (const obj of m.objects.values()) vm.fixObjectIdentity(obj);
  m.stack.splice(0, m.stack.length, ...snap.stack);

  const g = graphics(vm);
  g.planes.clear();
  g.items.clear();
  for (const p of snap.graphics.planes) g.planes.add(p);
  for (const i of snap.graphics.items) g.items.add(i);
  g.resetPalette();
  g.sourcePalette = snap.graphics.palette && { rgb: snap.graphics.palette.rgb.slice(), used: snap.graphics.palette.used.slice() };
  paletteEffects(vm).load(snap.graphics.effects, Math.floor((vm.clock() * 60) / 1000));

  const a = audio(vm);
  a.masterVolume = snap.audio.masterVolume;
  a.midi?.setMasterVolume?.(a.masterVolume);
  for (const song of snap.audio.songs) a.startSong(song.object, song.number, song.loop, song.volume, song.position);
}

/** Sanity check used by tests: every object's -super- points at a live class object. */
export function checkObjects(vm: Vm): string[] {
  const problems: string[] = [];
  for (const obj of vm.memory.objects.values()) {
    const sup = obj.vars[ObjectSlot.Super]!;
    if (sup && !vm.memory.object(sup)) problems.push(`${obj.name}: -super- ${sup.toString(16)} is not an object`);
  }
  return problems;
}

/**
 * Saved games as JSON text, for moving them between the browser (IndexedDB keeps them as
 * structured clones) and the Node tools. Typed arrays become `{ $typed, data }`.
 */
export function savesToJson(list: { info: unknown; snapshot: VmSnapshot }[]): string {
  return JSON.stringify(list, (_key, value: unknown) =>
    ArrayBuffer.isView(value) && !(value instanceof DataView)
      ? { $typed: value.constructor.name, data: Array.from(value as unknown as ArrayLike<number>) }
      : value,
  );
}

const TYPED: Record<string, new (data: number[]) => ArrayBufferView> = { Uint8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };

export function savesFromJson<Info>(text: string): { info: Info; snapshot: VmSnapshot }[] {
  return JSON.parse(text, (_key, value: unknown) => {
    const t = value as { $typed?: string; data?: number[] } | null;
    return t && typeof t === "object" && t.$typed && TYPED[t.$typed] ? new TYPED[t.$typed]!(t.data!) : value;
  });
}
