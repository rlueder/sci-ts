import type { ResourceManager } from "../resource/manager.ts";
import { ResourceType } from "../resource/types.ts";
import { disassemble, type DisasmFunction, type ValueFact } from "../script/disasm.ts";
import { kernelNames } from "../script/kernel-names.ts";
import { ObjectSlot, type Script, type ScriptObject } from "../script/script.ts";
import { ScriptWorld } from "../script/world.ts";

/**
 * A static map of a game, built from its scripts alone: which scripts are rooms, how rooms
 * connect, the class hierarchy and every object. Nothing runs; facts come from the
 * disassembler's stack simulation, so anything computed at run time is missed (and marked
 * as such where we can tell).
 */
export interface GameIndex {
  rooms: RoomInfo[];
  exits: Exit[];
  /** Exits whose target isn't a room script (maze codes, cut rooms). */
  unresolved: Exit[];
  classes: ClassInfo[];
  scripts: ScriptInfo[];
  /**
   * Verb names, guessed from the objects that send them: icons, inventory items and spells
   * keep their verb in `message` (iconLook → 1, theCloth → 54).
   */
  verbs: Record<number, string>;
}

export interface RoomInfo {
  number: number;
  /** The room object's name, e.g. "rm710". */
  name: string;
  className: string;
  picture: number;
  noun: number;
  /** Scripts this room loads (ScriptID and export calls), which may hold more of its logic. */
  uses: number[];
}

/**
 * How we know two rooms connect:
 *   newRoom    `curRoom newRoom: N` with a constant
 *   script     a script object calls `newRoom: register`, started with `setScript: s 0 N`
 *   property   `newRoom:` with one of the object's own properties (exit features)
 *   direction  the room's north/south/east/west property
 *   entry      the target room checks `prevRoomNum == N`: it can be entered from N
 */
export type ExitKind = "newRoom" | "script" | "property" | "direction" | "entry";

export interface Exit {
  from: number;
  to: number;
  kind: ExitKind;
  /** The script whose code holds the evidence (may be a helper, not `from` itself). */
  script: number;
  /** Method or procedure label, e.g. "sExit::changeState". */
  where: string;
}

export interface PropValue {
  name: string;
  value: number;
}

export interface ClassInfo {
  species: number;
  name: string;
  script: number;
  /** Superclass species, or -1 for a root class. */
  superclass: number;
  props: PropValue[];
  methods: string[];
}

export interface ObjectInfo {
  name: string;
  script: number;
  /** Heap offset in its script: identifies the object. */
  offset: number;
  superclass: number;
  className: string;
  props: PropValue[];
  methods: string[];
}

export interface ScriptInfo {
  number: number;
  isRoom: boolean;
  objects: ObjectInfo[];
  /** Other scripts referenced by ScriptID or export calls. */
  references: number[];
}

export interface AnalyzeOptions {
  /** Globals the room logic uses; SCI's system scripts fix these. */
  curRoomGlobal?: number;
  prevRoomGlobal?: number;
  /** Class every room inherits from. */
  roomClass?: string;
  /** Reuse a world (and its loaded scripts), e.g. to disassemble on demand afterwards. */
  world?: ScriptWorld;
  onProgress?: (done: number, total: number) => void;
}

/** The objects' header slots aren't interesting to show as properties. */
const HEADER_SLOTS = ObjectSlot.Name + 1;
const DIRECTIONS = ["north", "east", "south", "west"];

export async function analyzeGame(rm: ResourceManager, options: AnalyzeOptions = {}): Promise<GameIndex> {
  const { prevRoomGlobal = 12, roomClass = "Room", onProgress } = options;
  const world = options.world ?? (await ScriptWorld.open(rm));
  await world.loadAllClasses();
  const ctx = world.context();
  const selector = (name: string) => world.selectorNames.indexOf(name);
  const selName = (n: number) => world.selectorNames[n] ?? `sel_${n}`;

  const numbers = rm.list(ResourceType.Script).map((r) => r.number).filter((n) => rm.has({ type: ResourceType.Heap, number: n }));
  const scripts: Script[] = [];
  for (const [i, n] of numbers.entries()) {
    scripts.push(await world.script(n));
    onProgress?.(i + 1, numbers.length);
  }

  // Classes, with property names from their own dictionaries.
  const classList: ClassInfo[] = [];
  const classBySpecies = new Map<number, ScriptObject>();
  const classScript = new Map<number, number>();
  for (const s of scripts) {
    for (const o of s.objects) {
      if (!o.isClass) continue;
      classBySpecies.set(o.species, o);
      classScript.set(o.species, s.number);
    }
  }
  const propsOf = (obj: ScriptObject): PropValue[] => {
    const names = ctx.propSelectors(obj) ?? [];
    return obj.properties.slice(HEADER_SLOTS).map((value, i) => ({ name: selName(names[i + HEADER_SLOTS] ?? -1), value }));
  };
  const methodsOf = (obj: ScriptObject) => obj.methods.map((m) => selName(m.selector));
  for (const [species, o] of classBySpecies) {
    classList.push({
      species,
      name: o.name,
      script: classScript.get(species)!,
      superclass: o.superclass === 0xffff ? -1 : o.superclass,
      props: propsOf(o),
      methods: methodsOf(o),
    });
  }
  classList.sort((a, b) => a.species - b.species);

  const inherits = (species: number, name: string): boolean => {
    for (let s = species, guard = 0; s !== 0xffff && guard < 64; guard++) {
      const c = classBySpecies.get(s);
      if (!c) return false;
      if (c.name === name) return true;
      s = c.superclass;
    }
    return false;
  };
  const prop = (obj: ScriptObject, name: string) => propsOf(obj).find((p) => p.name === name)?.value;

  // Disassemble everything once: the facts drive the rest.
  const functions = new Map<number, DisasmFunction[]>();
  for (const s of scripts) functions.set(s.number, disassemble(s, ctx));

  const scriptIdKernel = kernelNames.indexOf("ScriptID");
  const scriptInfos: ScriptInfo[] = [];
  const rooms: RoomInfo[] = [];
  for (const s of scripts) {
    const refs = new Set<number>();
    for (const fn of functions.get(s.number)!) {
      for (const c of fn.facts.calls) {
        if (c.kind === "export" && c.target !== 0) refs.add(c.target);
        if (c.kind === "kernel" && c.target === scriptIdKernel && c.args[0]?.const !== undefined) refs.add(c.args[0].const);
      }
    }
    refs.delete(s.number);
    const room = roomObject(s);
    scriptInfos.push({
      number: s.number,
      isRoom: !!room,
      references: [...refs].sort((a, b) => a - b),
      objects: s.objects.filter((o) => !o.isClass).map((o) => ({
        name: o.name,
        script: s.number,
        offset: o.offset,
        superclass: o.superclass,
        className: classBySpecies.get(o.superclass)?.name ?? `class ${o.superclass}`,
        props: propsOf(o),
        methods: methodsOf(o),
      })),
    });
    if (room) {
      rooms.push({
        number: s.number,
        name: room.name,
        className: classBySpecies.get(room.superclass)?.name ?? "",
        picture: prop(room, "picture") ?? -1,
        noun: prop(room, "noun") ?? 0,
        uses: [...refs].sort((a, b) => a - b),
      });
    }
  }

  function roomObject(s: Script): ScriptObject | undefined {
    const e0 = s.exports[0];
    const obj = e0?.kind === "object" ? s.objects.find((o) => o.offset === e0.offset) : undefined;
    return obj && !obj.isClass && inherits(obj.superclass, roomClass) ? obj : undefined;
  }

  const roomNumbers = new Set(rooms.map((r) => r.number));
  // Helper scripts (like 711 for 710) act on behalf of the rooms that load them.
  const usedBy = new Map<number, number[]>();
  for (const r of rooms) for (const u of r.uses) if (!roomNumbers.has(u)) usedBy.set(u, [...(usedBy.get(u) ?? []), r.number]);
  const ownersOf = (script: number) => (roomNumbers.has(script) ? [script] : usedBy.get(script) ?? []);

  const exits: Exit[] = [];
  const seen = new Set<string>();
  const addExit = (from: number, to: number, kind: ExitKind, script: number, where: string) => {
    if (to <= 0 || to >= 0xffff || from === to) return;
    const key = `${from}>${to}>${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    exits.push({ from, to, kind, script, where });
  };

  const newRoom = selector("newRoom");
  const setScript = selector("setScript");
  const register = selector("register");
  // Script objects whose code calls `newRoom: register`: keyed "script:heapOffset".
  const registerExits = new Map<string, string>();
  // Classes whose methods call `newRoom:` with one of the object's own properties.
  const propertyExits: { species: number; propName: string; where: string; script: number }[] = [];

  for (const s of scripts) {
    for (const fn of functions.get(s.number)!) {
      for (const send of fn.facts.sends) {
        if (send.selector !== newRoom) continue;
        const arg: ValueFact = send.args[0] ?? {};
        if (arg.const !== undefined) {
          for (const from of ownersOf(s.number)) addExit(from, arg.const, "newRoom", s.number, fn.label);
        } else if (arg.prop === register && fn.owner) {
          registerExits.set(`${s.number}:${fn.owner.offset}`, fn.label);
        } else if (arg.prop !== undefined && fn.owner) {
          const propName = selName(arg.prop);
          if (fn.owner.isClass) propertyExits.push({ species: fn.owner.species, propName, where: fn.label, script: s.number });
          else {
            const to = prop(fn.owner, propName);
            if (to !== undefined) for (const from of ownersOf(s.number)) addExit(from, to, "property", s.number, fn.label);
          }
        }
      }
    }
  }

  for (const s of scripts) {
    for (const fn of functions.get(s.number)!) {
      for (const send of fn.facts.sends) {
        // `setScript: sExit 0 N` → sExit runs `newRoom: register` with N.
        if (send.selector === setScript && send.args[0]?.heap !== undefined && send.args[2]?.const !== undefined) {
          const where = registerExits.get(`${s.number}:${send.args[0].heap}`);
          if (where) for (const from of ownersOf(s.number)) addExit(from, send.args[2].const, "script", s.number, where);
        }
      }
      // Rooms that check where the hero came from can be entered from there.
      if (roomNumbers.has(s.number)) {
        for (const c of fn.facts.compares) {
          if (c.global === prevRoomGlobal && c.op === "eq?" && roomNumbers.has(c.value)) addExit(c.value, s.number, "entry", s.number, fn.label);
        }
      }
    }
    for (const o of s.objects) {
      for (const pe of propertyExits) {
        if (o.isClass || !inherits(o.superclass, classBySpecies.get(pe.species)!.name)) continue;
        const to = prop(o, pe.propName);
        if (to !== undefined) for (const from of ownersOf(s.number)) addExit(from, to, "property", pe.script, `${o.name} (${pe.where})`);
      }
    }
    const room = roomObject(s);
    if (room) {
      for (const d of DIRECTIONS) {
        const to = prop(room, d);
        if (to) addExit(s.number, to, "direction", s.number, `${room.name}.${d}`);
      }
    }
  }

  const verbs: Record<number, string> = {};
  const rank = (name: string) => (/^icon[A-Z]/.test(name) ? 0 : /Spell$/.test(name) ? 1 : /^the[A-Z]/.test(name) ? 2 : 3);
  const pretty = (name: string) => name.replace(/^icon|^the|Spell$/g, "").replace(/^./, (c) => c.toUpperCase());
  const best = new Map<number, string>();
  for (const info of scriptInfos) {
    for (const o of info.objects) {
      const verb = o.props.find((p) => p.name === "message")?.value;
      if (!verb || verb >= 0x8000) continue;
      const current = best.get(verb);
      if (current === undefined || rank(o.name) < rank(current)) best.set(verb, o.name);
    }
  }
  for (const [verb, name] of best) verbs[verb] = pretty(name);

  const resolved = exits.filter((e) => roomNumbers.has(e.to));
  const unresolved = exits.filter((e) => !roomNumbers.has(e.to));
  return { rooms, exits: resolved, unresolved, classes: classList, scripts: scriptInfos, verbs };
}
