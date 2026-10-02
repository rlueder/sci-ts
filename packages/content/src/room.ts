import { LineCounter, parseDocument, type Document } from "yaml";
import type { Target } from "./target.ts";
import { parseYarn, type YarnChoice, type YarnCommand, type YarnExpr, type YarnItem, type YarnLine, type YarnNode } from "./yarn.ts";

/**
 * A room described as data (YAML) plus what's said in it (Yarn), compiled to SCI assembly
 * (.sca) and message text (.msg), the formats tools/mod-build.ts already builds from.
 *
 *   room: 701
 *   hero: { at: [36, 152], enterTo: [110, 160] }
 *   perspective: { horizon: 72, fullSize: 176 }
 *   walkable: [[28, 152], [60, 135], ...]
 *   features:
 *     pods: { rect: [236, 14, 310, 94] }
 *   exits:
 *     passage: { rect: [12, 84, 64, 156], approach: [40, 152], walkTo: [30, 152], to: 770 }
 *   props:
 *     wisp: { view: 701, at: [200, 96], cycle: forward }
 *
 * Yarn nodes named `<thing>.<verb>` are what the hero gets for that verb on that thing
 * (`pods.look`, `wisp.do`, `room.look`); `room.enter` is narration on arrival. Lines can
 * name a speaker (`Wisp: ...`, `Hero: ...`): characters are declared under `characters:`.
 * A node with choices (`-> Who are you?`) is a conversation: the game's topic menu, each
 * choice answered by the lines indented under it.
 */
export interface RoomSpec {
  room: number;
  picture?: number;
  /** Music played (looping) here; left alone if it's already playing. */
  music?: number;
  hero?: {
    at?: Point;
    /** Walk here on arrival (hands off until there). */
    enterTo?: Point;
    /** Perspective for the hero alone: `front`% at y `frontY`, `back`% at y `backY` (perspective: is simpler). */
    scale?: { front: number; back: number; frontY: number; backY: number };
  };
  /**
   * The picture's camera, for sizing people by where they stand: the horizon (the y the
   * floor's lines meet at), and the y where a figure's feet are when it's drawn at full
   * size. A figure's height is in proportion to how far below the horizon it stands, so it
   * shrinks towards the back and grows past fullSize at the front. The hero and props that
   * move are sized as they go; a still prop only with scale: true.
   *
   * A picture painted at an angle, where a line across the screen isn't one depth all the
   * way along, gives sizes measured instead: `columns`, up to three places across the floor
   * (left, middle, right), each with a size at the back and at the front of the floor.
   */
  perspective?: { horizon: number; fullSize: number } | { columns: FloorColumn[] };
  /** The floor: a polygon the hero stays inside. */
  walkable?: Point[];
  /** Polygons the hero walks around. */
  obstacles?: Point[][];
  features?: Record<string, FeatureSpec>;
  exits?: Record<string, ExitSpec>;
  props?: Record<string, PropSpec>;
  /** Who speaks in this room's Yarn (besides the narrator and the hero). */
  characters?: Record<string, CharacterSpec>;
  /** Raw property values per object (the room is `room`), for anything not covered above. */
  properties?: Record<string, Record<string, number>>;
}

interface CharacterSpec {
  /** Their name in Yarn (`Old Crow: ...`), besides the key. */
  name?: string;
  /**
   * Portrait view: loop 0 the bust, loop 1 mouth shapes (cel 0 closed), loop 2 eyes
   * (cel 0 open, then blinking); every cel the same size. Without one, a plain text box.
   */
  portrait?: number;
}

type Point = [number, number];

/** A place across the floor where sizes were measured: x, and [y, percent] at the back and front. */
export interface FloorColumn {
  x: number;
  back: [number, number];
  front: [number, number];
}
type Rect = [number, number, number, number];

interface FeatureSpec {
  /** left, top, right, bottom (room coordinates). */
  rect: Rect;
  /** Where the hero looks at; the middle of rect unless given. */
  at?: Point;
  approach?: Point;
  sightAngle?: number;
}

interface ExitSpec extends FeatureSpec {
  to: number;
  /** Walk here before leaving. */
  walkTo?: Point;
}

interface PropSpec {
  view: number;
  at: Point;
  /** It walks or floats about in cutscenes (<<walk wisp x y>>): an Actor, not a Prop. */
  moves?: boolean;
  loop?: number;
  cel?: number;
  /** forward: loop the animation forever. */
  cycle?: "forward";
  sightAngle?: number;
  /** A Script class of the game's: an instance of it runs on the prop (ambient behaviour). */
  script?: string;
  /**
   * Sized by the room's perspective: by default a prop that moves is and a still one
   * (drawn to fit its place, like someone in a chair) isn't.
   */
  scale?: boolean;
}

export interface CompiledRoom {
  number: number;
  /** SCI assembly for tools/asm.ts. */
  sca: string;
  /** Message text for tools/msg.ts. */
  msg: string;
  /** The room defines characters: the game needs the target's support for room talkers. */
  roomTalkers: boolean;
  /** Yarn variables ($name) used: each is a flag, numbered by `options.flag`. */
  flags: string[];
  /** The spoken lines (not menu labels), with their message keys today. */
  lines: SpokenLine[];
}

/**
 * A line someone says. Its message key (noun, verb, cond, seq) is positional and changes
 * when lines or things are added before it; its id (#line:) doesn't, so recordings use that.
 */
export interface SpokenLine {
  id?: string;
  noun: number;
  verb: number;
  cond: number;
  seq: number;
  talker: number;
  /** As written in the Yarn (Narrator when it has none). */
  speaker: string;
  text: string;
  /** The Yarn node it's in (and for a topic's answer, the topic). */
  node: string;
  /** What's said just before it in the same node, if anything: context for whoever records it. */
  before?: { speaker: string; text: string };
  /** file:line in the Yarn. */
  where: string;
}

export interface CompileOptions {
  /**
   * The flag number for a Yarn variable. Variables are flags shared by a whole mod (and
   * its saved games), so the caller keeps the numbering (tools/mod-build.ts: flags.yaml).
   */
  flag?: (name: string) => number;
}

export class ContentError extends Error {}

/** Compiles `<n>.room.yaml` (+ `<n>.yarn`) source text. File names only label errors. */
export function compileRoom(
  yamlSource: string,
  yarnSource: string | undefined,
  target: Target,
  files: { yaml?: string; yarn?: string } = {},
  options: CompileOptions = {},
): CompiledRoom {
  const spec = readSpec(yamlSource, files.yaml ?? "<room.yaml>");
  const nodes = yarnSource === undefined ? [] : parseYarn(yarnSource, files.yarn ?? "<yarn>");
  const flag = options.flag ?? (() => {
    throw new Error("variables need flag numbers (CompileOptions.flag)");
  });
  return new RoomCompiler(spec, nodes, target, files.yarn ?? "<yarn>", flag).compile();
}

// --- Reading and checking the YAML ------------------------------------------------

function readSpec(source: string, file: string): RoomSpec {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, prettyErrors: true, version: "1.2" });
  if (doc.errors.length) throw new ContentError(`${file}: ${doc.errors[0]!.message}`);
  const at = (path: (string | number)[]) => {
    const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
    const pos = node?.range ? lines.linePos(node.range[0]) : undefined;
    return `${file}${pos ? `:${pos.line}` : ""}: ${path.join(".") || "(top)"}`;
  };
  const spec = doc.toJS() as RoomSpec;
  new SpecChecker(spec, at, doc).check();
  return spec;
}

class SpecChecker {
  constructor(
    readonly spec: RoomSpec,
    readonly at: (path: (string | number)[]) => string,
    readonly doc: Document,
  ) {}

  fail(path: (string | number)[], why: string): never {
    throw new ContentError(`${this.at(path)}: ${why}`);
  }

  check(): void {
    const s = this.spec as unknown as Record<string, unknown>;
    if (!s || typeof s !== "object") this.fail([], "expected a mapping (room: ..., features: ...)");
    this.known(s, [], ["room", "picture", "music", "hero", "perspective", "walkable", "obstacles", "features", "exits", "props", "characters", "properties"]);
    this.int(s.room, ["room"], 0, 65535);
    if (s.picture !== undefined) this.int(s.picture, ["picture"], 0, 65535);
    if (s.music !== undefined) this.int(s.music, ["music"], 0, 65535);
    if (s.hero !== undefined) {
      const h = this.map(s.hero, ["hero"]);
      this.known(h, ["hero"], ["at", "enterTo", "scale"]);
      if (h.at !== undefined) this.point(h.at, ["hero", "at"]);
      if (h.enterTo !== undefined) this.point(h.enterTo, ["hero", "enterTo"]);
      if (h.scale !== undefined) {
        const sc = this.map(h.scale, ["hero", "scale"]);
        this.known(sc, ["hero", "scale"], ["front", "back", "frontY", "backY"]);
        for (const k of ["front", "back", "frontY", "backY"]) this.int(sc[k], ["hero", "scale", k], 0, 1000);
      }
    }
    if (s.perspective !== undefined) {
      const pv = this.map(s.perspective, ["perspective"]);
      if (pv.columns !== undefined) {
        this.known(pv, ["perspective"], ["columns"]);
        if (!Array.isArray(pv.columns) || pv.columns.length < 1 || pv.columns.length > 3) this.fail(["perspective", "columns"], "expected one to three places across the floor");
        let lastX = -Infinity;
        (pv.columns as unknown[]).forEach((value, i) => {
          const path = ["perspective", "columns", i];
          const c = this.map(value, path);
          this.known(c, path, ["x", "back", "front"]);
          this.int(c.x, [...path, "x"], 0, 319);
          if ((c.x as number) <= lastX) this.fail([...path, "x"], "places go left to right");
          lastX = c.x as number;
          for (const end of ["back", "front"] as const) {
            const v = c[end];
            if (!Array.isArray(v) || v.length !== 2) this.fail([...path, end], "expected [y, size in percent]");
            this.int((v as unknown[])[0], [...path, end, 0], 0, 199);
            this.int((v as unknown[])[1], [...path, end, 1], 1, 400);
          }
          if ((c.back as number[])[0]! >= (c.front as number[])[0]!) this.fail([...path, "front"], "the front is lower on the screen than the back (a bigger y)");
        });
      } else {
        this.known(pv, ["perspective"], ["horizon", "fullSize", "columns"]);
        this.int(pv.horizon, ["perspective", "horizon"], -1000, 199);
        this.int(pv.fullSize, ["perspective", "fullSize"], 0, 1000);
        if ((pv.fullSize as number) <= (pv.horizon as number)) this.fail(["perspective", "fullSize"], "must be below the horizon (a bigger y)");
      }
    }
    if (s.walkable !== undefined) this.polygon(s.walkable, ["walkable"]);
    if (s.obstacles !== undefined) {
      if (!Array.isArray(s.obstacles)) this.fail(["obstacles"], "expected a list of polygons");
      s.obstacles.forEach((p, i) => this.polygon(p, ["obstacles", i]));
    }
    const names = new Set<string>(["room"]);
    for (const group of ["features", "exits", "props"] as const) {
      if (s[group] === undefined) continue;
      const things = this.map(s[group], [group]);
      for (const [name, value] of Object.entries(things)) {
        const path = [group, name];
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) this.fail(path, "names are letters and digits, starting with a letter");
        if (names.has(name)) this.fail(path, `"${name}" is already used`);
        names.add(name);
        const t = this.map(value, path);
        if (group === "props") {
          this.known(t, path, ["view", "at", "loop", "cel", "cycle", "sightAngle", "moves", "script", "scale"]);
          if (t.scale !== undefined && typeof t.scale !== "boolean") this.fail([...path, "scale"], "expected true or false");
          if (t.scale === true && s.perspective === undefined) this.fail([...path, "scale"], "the room has no perspective: to size it by");
          if (t.script !== undefined && (typeof t.script !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(t.script))) this.fail([...path, "script"], "expected a class name, e.g. Scurry");
          if (t.moves !== undefined && typeof t.moves !== "boolean") this.fail([...path, "moves"], "expected true or false");
          this.int(t.view, [...path, "view"], 0, 65535);
          this.point(t.at, [...path, "at"]);
          if (t.loop !== undefined) this.int(t.loop, [...path, "loop"], 0, 255);
          if (t.cel !== undefined) this.int(t.cel, [...path, "cel"], 0, 255);
          if (t.cycle !== undefined && t.cycle !== "forward") this.fail([...path, "cycle"], `unknown cycle "${String(t.cycle)}" (supported: forward)`);
        } else {
          const keys = ["rect", "at", "approach", "sightAngle", ...(group === "exits" ? ["to", "walkTo"] : [])];
          this.known(t, path, keys);
          this.rect(t.rect, [...path, "rect"]);
          if (t.at !== undefined) this.point(t.at, [...path, "at"]);
          if (t.approach !== undefined) this.point(t.approach, [...path, "approach"]);
          if (group === "exits") {
            this.int(t.to, [...path, "to"], 0, 65535);
            if (t.walkTo !== undefined) this.point(t.walkTo, [...path, "walkTo"]);
          }
        }
        if (t.sightAngle !== undefined) this.int(t.sightAngle, [...path, "sightAngle"], 0, 360);
      }
    }
    if (s.characters !== undefined) {
      for (const [key, value] of Object.entries(this.map(s.characters, ["characters"]))) {
        const path = ["characters", key];
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) this.fail(path, "names are letters and digits, starting with a letter");
        if (["narrator", "hero"].includes(key.toLowerCase())) this.fail(path, `"${key}" is built in`);
        const c = this.map(value ?? {}, path);
        this.known(c, path, ["name", "portrait"]);
        if (c.portrait !== undefined) this.int(c.portrait, [...path, "portrait"], 0, 65535);
        if (c.name !== undefined && (typeof c.name !== "string" || !/^[\x20-\x7e]{1,40}$/.test(c.name))) {
          this.fail([...path, "name"], "expected plain text, up to 40 characters");
        }
      }
    }
    if (s.properties !== undefined) {
      const props = this.map(s.properties, ["properties"]);
      for (const [name, values] of Object.entries(props)) {
        if (!names.has(name)) this.fail(["properties", name], `no feature, exit or prop called "${name}" (the room is "room")`);
        for (const [k, v] of Object.entries(this.map(values, ["properties", name]))) this.int(v, ["properties", name, k], -32768, 65535);
      }
    }
  }

  known(o: Record<string, unknown>, path: (string | number)[], keys: string[]): void {
    for (const k of Object.keys(o)) if (!keys.includes(k)) this.fail([...path, k], `unknown key (expected one of: ${keys.join(", ")})`);
  }
  map(v: unknown, path: (string | number)[]): Record<string, unknown> {
    if (!v || typeof v !== "object" || Array.isArray(v)) this.fail(path, "expected a mapping (key: value)");
    return v as Record<string, unknown>;
  }
  int(v: unknown, path: (string | number)[], min: number, max: number): void {
    if (v === undefined) this.fail(path, "missing");
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) this.fail(path, `expected a whole number from ${min} to ${max}, got ${JSON.stringify(v)}`);
  }
  point(v: unknown, path: (string | number)[]): void {
    if (!Array.isArray(v) || v.length !== 2) this.fail(path, "expected [x, y]");
    v.forEach((n, i) => this.int(n, [...path, i], -1000, 1000));
  }
  rect(v: unknown, path: (string | number)[]): void {
    if (!Array.isArray(v) || v.length !== 4) this.fail(path, "expected [left, top, right, bottom]");
    v.forEach((n, i) => this.int(n, [...path, i], -1000, 1000));
    if (v[0] > v[2] || v[1] > v[3]) this.fail(path, "left must be <= right and top <= bottom");
  }
  polygon(v: unknown, path: (string | number)[]): void {
    if (!Array.isArray(v) || v.length < 3) this.fail(path, "expected a list of at least 3 [x, y] points");
    v.forEach((p, i) => this.point(p, [...path, i]));
  }
}

// --- Code generation ---------------------------------------------------------------

/** A value pushed as a send argument. */
type Val = number | { obj: string } | { cls: string } | "self" | { code: string[] };
/** Who receives a send. */
type To = { global: number } | { obj: string } | { cls: string } | "self" | { superOf: string };

const SCREEN_BOTTOM = 200;

/** A column's size at y: the straight line through its back and front. */
const along = (c: FloorColumn, y: number) => c.back[1] + ((c.front[1] - c.back[1]) * (y - c.back[0])) / (c.front[0] - c.back[0]);

/** Three columns for the FloorScaler: one is used for all three, two get one between them. */
function floorColumns(cols: FloorColumn[]): [FloorColumn, FloorColumn, FloorColumn] {
  if (cols.length === 3) return cols as [FloorColumn, FloorColumn, FloorColumn];
  const [a, b] = [cols[0]!, cols.at(-1)!];
  if (cols.length === 1) return [a, { ...a, x: a.x + 1 }, { ...a, x: a.x + 2 }];
  const mid = (y: number) => Math.round((along(a, y) + along(b, y)) / 2);
  return [a, { x: Math.round((a.x + b.x) / 2), back: [a.back[0], mid(a.back[0])], front: [a.front[0], mid(a.front[0])] }, b];
}

/** A figure's size at x, y among three columns: straight lines in y at each, then in x between them. */
function floorSize(cols: [FloorColumn, FloorColumn, FloorColumn], x: number, y: number): number {
  const [a, b, c] = cols.map((col) => along(col, y)) as [number, number, number];
  const [c1, c2, c3] = cols;
  if (x <= c1.x) return a;
  if (x < c2.x) return a + ((b - a) * (x - c1.x)) / (c2.x - c1.x);
  if (x < c3.x) return b + ((c - b) * (x - c2.x)) / (c3.x - c2.x);
  return c;
}
const num = (n: number) => (n < 0 ? `-$${(-n).toString(16)}` : String(n));

function pushVal(v: Val): string[] {
  if (typeof v === "number") return [v === 0 ? "push0" : v === 1 ? "push1" : v === 2 ? "push2" : `pushi ${num(v)}`];
  if (v === "self") return ["pushSelf"];
  if ("obj" in v) return [`lofsa @${v.obj}`, "push"];
  if ("cls" in v) return [`class ${v.cls}`, "push"];
  return [...v.code, "push"];
}

/** `to sel1: args..., sel2: args...` as one send. */
function send(to: To, calls: [selector: string, args: Val[]][]): string[] {
  const out: string[] = [];
  let words = 0;
  for (const [sel, args] of calls) {
    out.push(`pushi #${sel}`, ...pushVal(args.length));
    for (const a of args) out.push(...pushVal(a));
    words += 2 + args.length;
  }
  const bytes = words * 2;
  if (to === "self") out.push(`self ${bytes}`);
  else if ("superOf" in to) out.push(`super ${to.superOf} ${bytes}`);
  else {
    out.push("global" in to ? `lag ${to.global}` : "obj" in to ? `lofsa @${to.obj}` : `class ${to.cls}`);
    out.push(`send ${bytes}`);
  }
  return out;
}

interface Message {
  noun: number;
  verb: number;
  cond: number;
  seq: number;
  talker: number;
  speaker: string;
  text: string;
  label: string;
}

/** A topic menu on a thing: its labels at rootNoun/verb/cond, answers at sayNoun/verb/cond. */
interface Conversation {
  thing: string;
  /** The verb that opens it (usually Talk). */
  opensWith: number;
  rootNoun: number;
  sayNoun: number;
}

/** A Script's states: each runs some code and cues the script (directly or when done). */
type State = string[];

/**
 * A step of a compiled Yarn sequence, run by a Script's changeState: `say` and `async`
 * cue the script when done (the next step starts a new state); labels start a state too,
 * and jumping to one sets `state` and cues.
 */
type Instr =
  | { op: "say"; noun: number; verb: number; cond: number }
  | { op: "async"; code: string[] }
  | { op: "code"; code: string[] }
  | { op: "set"; name: string; value: YarnExpr; where: string }
  | { op: "unless"; when: YarnExpr; label: string; where: string }
  | { op: "jump"; label: string }
  | { op: "label"; name: string };

/** A topic menu on a thing: its labels at rootNoun/verb/cond, answers at sayNoun/verb/cond. */
interface Conversation {
  thing: string;
  /** The verb that opens it (usually Talk). */
  opensWith: number;
  rootNoun: number;
  sayNoun: number;
  /** Topics offered only when a condition holds. */
  conditional: { topic: number; when: YarnExpr; where: string }[];
  /** Topics answered by a script (their bodies set flags or branch). */
  scripted: { topic: number; script: string }[];
}

class RoomCompiler {
  readonly name: string;
  readonly nouns = new Map<string, number>();
  readonly messages: Message[] = [];
  readonly lines: SpokenLine[] = [];
  readonly instances: string[] = [];
  readonly code: string[] = [];
  readonly strings: string[] = [];
  readonly conversations: Conversation[] = [];
  /** Characters by lower-case key and name -> talker number. */
  readonly talkers = new Map<string, number>();
  /** Verbs whose Yarn sets flags or branches, per thing: verb -> Script. */
  readonly scriptedVerbs = new Map<string, [verb: number, script: string][]>();
  /** Scripts compiled from Yarn: name, steps, and what ends them. */
  readonly sequences: { name: string; steps: Instr[]; end: string[] }[] = [];
  readonly flagsUsed = new Set<string>();
  private nextNoun = 0;
  private nextLabel = 0;

  constructor(
    readonly spec: RoomSpec,
    readonly nodes: YarnNode[],
    readonly target: Target,
    readonly yarnFile: string,
    readonly flagNumber: (name: string) => number,
  ) {
    this.name = `rm${spec.room}`;
  }

  compile(): CompiledRoom {
    const { spec, target } = this;
    const g = target.globals;
    // Nouns: the room first, then everything clickable in the order written.
    this.nouns.set("room", 1);
    for (const name of [...Object.keys(spec.features ?? {}), ...Object.keys(spec.exits ?? {}), ...Object.keys(spec.props ?? {})]) {
      this.nouns.set(name, this.nouns.size + 1);
    }
    this.nextNoun = this.nouns.size + 1;
    const characters = Object.entries(spec.characters ?? {});
    characters.forEach(([key, c], i) => {
      const talker = target.firstRoomTalker + i;
      this.talkers.set(key.toLowerCase(), talker);
      if (c?.name) this.talkers.set(c.name.toLowerCase(), talker);
    });
    const enter = this.readNodes();

    // Arrival: walk in (PolyPath cues the script), then room.enter, then hands back.
    const enterSteps: Instr[] = [];
    if (spec.hero?.enterTo) {
      enterSteps.push({ op: "async", code: send({ global: g.ego }, [["setMotion", [{ cls: "PolyPath" }, ...spec.hero.enterTo, "self"]]]) });
    }
    enterSteps.push(...enter);
    if (enterSteps.length) {
      this.sequences.unshift({
        name: "sEnter",
        steps: [{ op: "code", code: send({ global: g.game }, [["handsOff", []]]) }, ...enterSteps],
        end: [...send({ global: g.game }, [["handsOn", []]]), ...send("self", [["dispose", []]])],
      });
    }

    const exitScripts = new Map<string, string>();
    for (const [name, exit] of Object.entries(spec.exits ?? {})) {
      const script = `sExit${cap(name)}`;
      exitScripts.set(name, script);
      const leave = send({ global: g.curRoom }, [["newRoom", [exit.to]]]);
      this.script(script, exit.walkTo
        ? [
            [...send({ global: g.game }, [["handsOff", []]]), ...send({ global: g.ego }, [["setMotion", [{ cls: "PolyPath" }, ...exit.walkTo, "self"]]])],
            leave,
          ]
        : [[...send({ global: g.game }, [["handsOff", []]]), ...leave]]);
    }
    for (const seq of this.sequences) this.sequenceScript(seq.name, seq.steps, seq.end);

    this.roomInstance(enterSteps.length > 0, characters.length > 0);
    for (const [name, f] of Object.entries(spec.features ?? {})) this.feature(name, f);
    for (const [name, e] of Object.entries(spec.exits ?? {})) this.feature(name, e, exitScripts.get(name));
    for (const [name, p] of Object.entries(spec.props ?? {})) this.prop(name, p);
    for (const [key, c] of characters) this.character(key, c ?? {});
    for (const conv of this.conversations) this.teller(conv);

    return {
      number: spec.room, sca: this.assembly(), msg: this.messageText(), roomTalkers: characters.length > 0,
      flags: [...this.flagsUsed].sort(), lines: this.lines,
    };
  }

  /** Yarn nodes -> messages and scripts; returns the arrival narration's steps. */
  private readNodes(): Instr[] {
    let enter: Instr[] = [];
    const verbNames = Object.keys(this.target.verbs);
    for (const node of this.nodes) {
      const fail = (why: string, line = node.line): never => {
        throw new ContentError(`${this.yarnFile}:${line}: node "${node.title}": ${why}`);
      };
      const m = /^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)$/.exec(node.title);
      if (!m) fail("titles are <thing>.<verb>, e.g. pods.look or room.enter");
      const [, thing, verbName] = m!;
      const noun = this.nouns.get(thing!);
      if (noun === undefined) fail(`no feature, exit or prop called "${thing}" (the room itself is "room")`);
      let verb: number;
      if (verbName === "enter") {
        if (thing !== "room") fail("only the room has .enter (narration on arrival)");
        verb = this.target.narrationVerb;
      } else {
        const v = this.target.verbs[verbName!.toLowerCase()];
        if (v === undefined) fail(`unknown verb "${verbName}" (known: ${verbNames.slice(0, 12).join(", ")}${verbNames.length > 12 ? ", ..." : ""})`);
        verb = v!;
      }
      if (!node.body.length) fail("has no lines");
      const choices = node.body.filter((x): x is YarnChoice => x.kind === "choice");

      if (!choices.length) {
        const plain = node.body.every((x) => x.kind === "line");
        if (verbName === "enter") {
          // Plain narration keeps cond 0, like any other message for the room.
          if (plain) {
            node.body.forEach((l, i) => this.message(noun!, verb, 0, i + 1, l as YarnLine, node.title));
            enter = [{ op: "say", noun: noun!, verb, cond: 0 }];
          } else enter = this.steps(node.body, noun!, verb, counter(1), node.title);
        } else if (plain) {
          // The game's doVerb says noun/verb messages by itself: no code at all.
          node.body.forEach((l, i) => this.message(noun!, verb, 0, i + 1, l as YarnLine, node.title));
        } else {
          const script = `s${cap(thing!)}${cap(verbName!)}`;
          this.sequences.push({
            name: script,
            steps: [{ op: "code", code: send({ global: this.target.globals.game }, [["handsOff", []]]) }, ...this.steps(node.body, noun!, verb, counter(1), node.title)],
            end: [...send({ global: this.target.globals.game }, [["handsOn", []]]), ...send("self", [["dispose", []]])],
          });
          this.scriptedVerbs.set(thing!, [...(this.scriptedVerbs.get(thing!) ?? []), [verb, script]]);
        }
        continue;
      }

      // A conversation: the target's topic menu (its Teller). Each choice is a topic (the hero's line), the
      // lines under it the answer.
      const stray = node.body.find((x) => x.kind !== "choice");
      if (stray) fail("lines or commands outside choices in a conversation aren't supported yet (put them under a choice)", stray.line);
      if (thing === "room" || verbName === "enter") fail("conversations need a feature or prop to talk to");
      if (choices.length > 140) fail("too many choices (140 at most)");
      const conv: Conversation = { thing: thing!, opensWith: verb, rootNoun: this.nextNoun++, sayNoun: this.nextNoun++, conditional: [], scripted: [] };
      this.conversations.push(conv);
      const tv = this.target.teller.verb;
      let blockNoun: number | undefined;
      const blockConds = counter(1);
      choices.forEach((c, k) => {
        if (!c.body.length) fail(`choice "${c.text}" needs at least one line under it`, c.line);
        const topic = k + 1;
        const label = `${node.title}: ${c.text}`;
        this.message(conv.rootNoun, tv, topic, 1, { kind: "line", speaker: "Hero", text: c.text, line: c.line }, label, false);
        if (c.when) conv.conditional.push({ topic, when: c.when, where: `${this.yarnFile}:${c.line}` });
        if (c.body.every((x) => x.kind === "line")) {
          c.body.forEach((l, j) => this.message(conv.sayNoun, tv, topic, j + 1, l as YarnLine, label));
          return;
        }
        // Answered by a script, run by the room with the teller as its caller: when it's
        // done it cues the teller, which shows the menu again.
        blockNoun ??= this.nextNoun++;
        const script = `s${cap(thing!)}Topic${topic}`;
        conv.scripted.push({ topic, script });
        this.sequences.push({ name: script, steps: this.steps(c.body, blockNoun, tv, blockConds, label), end: send("self", [["dispose", []]]) });
      });
    }
    return enter;
  }

  /** Yarn items -> steps; runs of lines become one message tuple (one say) each. */
  private steps(items: YarnItem[], noun: number, verb: number, conds: () => number, label: string): Instr[] {
    const out: Instr[] = [];
    let lines: YarnLine[] = [];
    const flush = () => {
      if (!lines.length) return;
      const cond = conds();
      if (cond > 255) throw new ContentError(`${this.yarnFile}:${lines[0]!.line}: node "${label}" has too many separate passages (255 at most)`);
      lines.forEach((l, i) => this.message(noun, verb, cond, i + 1, l, label));
      out.push({ op: "say", noun, verb, cond });
      lines = [];
    };
    for (const item of items) {
      if (item.kind === "line") {
        lines.push(item);
        continue;
      }
      flush();
      const where = `${this.yarnFile}:${item.line}`;
      if (item.kind === "set") out.push({ op: "set", name: item.name, value: item.value, where });
      else if (item.kind === "if") {
        const end = this.label();
        for (const branch of item.branches) {
          const next = this.label();
          if (branch.when) out.push({ op: "unless", when: branch.when, label: next, where });
          out.push(...this.steps(branch.body, noun, verb, conds, label), { op: "jump", label: end }, { op: "label", name: next });
        }
        out.push({ op: "label", name: end });
      } else if (item.kind === "command") out.push(...this.command(item, where));
      else throw new ContentError(`${where}: choices can only be the whole of a conversation node`);
    }
    flush();
    return out;
  }

  /**
   * Cutscene commands. Those that take time (walking, turning, waiting, a one-shot
   * animation) cue the script when done; the rest happen at once.
   */
  private command(cmd: YarnCommand, where: string): Instr[] {
    const g = this.target.globals;
    const { name, args } = cmd;
    const fail = (why: string): never => {
      throw new ContentError(`${where}: <<${name}${args.length ? ` ${args.join(" ")}` : ""}>>: ${why}`);
    };
    const arity = (n: number, usage: string) => args.length !== n && fail(`expected <<${name} ${usage}>>`);
    const int = (s: string | undefined, what: string, min = -1000, max = 1000) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < min || n > max) fail(`${what} must be a whole number from ${min} to ${max}`);
      return n;
    };
    const props = this.spec.props ?? {};
    /** hero, or a prop (`moving`: one with moves: true). */
    const who = (s: string | undefined, moving: boolean): To => {
      if (s === "hero") return { global: g.ego };
      const p = s === undefined ? undefined : props[s];
      if (!p) fail(`"${s}" isn't hero or a prop of this room`);
      if (moving && !p!.moves) fail(`"${s}" doesn't move: give it moves: true in the room's YAML`);
      return { obj: s! };
    };
    const thingAt = (s: string): Point | undefined => {
      const p = props[s];
      if (p) return p.at;
      const f = this.spec.features?.[s] ?? this.spec.exits?.[s];
      if (!f) return undefined;
      return f.at ?? [Math.round((f.rect[0] + f.rect[2]) / 2), Math.round((f.rect[1] + f.rect[3]) / 2)];
    };
    switch (name) {
      case "walk": {
        arity(3, "hero|<prop> x y");
        const to = who(args[0], true);
        const motion = args[0] === "hero" ? "PolyPath" : "MoveTo";
        return [{ op: "async", code: send(to, [["setMotion", [{ cls: motion }, int(args[1], "x"), int(args[2], "y"), "self"]]]) }];
      }
      case "face": {
        if (args.length < 2 || args.length > 3) fail("expected <<face hero|<prop> up|down|left|right|<thing>|x y>>");
        const to = who(args[0], true);
        const directions: Record<string, number> = { up: 0, upright: 45, right: 90, downright: 135, down: 180, downleft: 225, left: 270, upleft: 315 };
        let heading: Val;
        // Props (which may have moved) are faced where they are now; features where they're drawn.
        const pos = (of: To, sel: string) => [...send(of, [[sel, []]]), "push"];
        const target: string[] | undefined = args.length === 3
          ? [...pushVal(int(args[1], "x")), ...pushVal(int(args[2], "y"))]
          : props[args[1]!]
            ? [...pos({ obj: args[1]! }, "x"), ...pos({ obj: args[1]! }, "y")]
            : thingAt(args[1]!)?.flatMap((n) => pushVal(n));
        if (args.length === 2 && directions[args[1]!] !== undefined) heading = directions[args[1]!]!;
        else if (target) {
          // GetAngle from where it stands now to the target.
          heading = { code: ["pushi 4", ...pos(to, "x"), ...pos(to, "y"), ...target, "callk GetAngle 8"] };
        } else {
          return fail(`expected a direction (${Object.keys(directions).join(", ")}), a thing of this room, or x y`);
        }
        return [{ op: "async", code: send(to, [["setHeading", [heading, "self"]]]) }];
      }
      case "wait": {
        arity(1, "seconds");
        const secs = Number(args[0]);
        if (!(secs > 0 && secs <= 600)) fail("seconds must be a number from 0 to 600 (e.g. 1.5)");
        return [{ op: "async", code: [`ldi ${Math.max(1, Math.round(secs * 60))}`, "aTop ticks"] }];
      }
      case "hide":
      case "show":
        arity(1, "hero|<prop>");
        return [{ op: "code", code: send(who(args[0], false), [[name, []]]) }];
      case "loop":
      case "cel":
        arity(2, `hero|<prop> ${name}`);
        return [{ op: "code", code: send(who(args[0], false), [[name === "loop" ? "setLoop" : "setCel", [int(args[1], name, 0, 255)]]]) }];
      case "animate": {
        arity(2, "<prop> once|forever");
        const to = who(args[0], false);
        if (args[1] === "once") return [{ op: "async", code: send(to, [["setCel", [0]], ["setCycle", [{ cls: "End" }, "self"]]]) }];
        if (args[1] === "forever") return [{ op: "code", code: send(to, [["setCycle", [{ cls: this.target.forwardCycle }]]]) }];
        return fail("expected once or forever");
      }
      case "view":
        arity(2, "hero|<prop> view");
        return [{ op: "code", code: send(who(args[0], false), [["view", [int(args[1], "view", 0, 65535)]], ["setCel", [0]]]) }];
      case "normal":
        arity(1, "hero");
        if (args[0] !== "hero") fail("only the hero goes back to normal (walking, turning as he goes)");
        return [{ op: "code", code: send({ global: g.ego }, [["normalize", []]]) }];
      case "stop":
        arity(1, "<prop>");
        return [{ op: "code", code: send(who(args[0], false), [["setCycle", [0]]]) }];
      case "music":
        arity(1, "number|stop");
        return [{ op: "code", code: args[0] === "stop" ? send({ global: g.music }, [["stop", []]]) : this.playMusic(int(args[0], "music", 0, 65535)) }];
      case "sound": {
        if (args.length < 1 || args.length > 2 || (args[1] !== undefined && args[1] !== "wait")) fail("expected <<sound number>> or <<sound number wait>>");
        const n = int(args[0], "sound", 0, 65535);
        // wait: the sound cues the script when it ends.
        return args[1] === "wait"
          ? [{ op: "async", code: send({ global: g.sound }, [["number", [n]], ["loop", [1]], ["play", ["self"]]]) }]
          : [{ op: "code", code: send({ global: g.sound }, [["number", [n]], ["loop", [1]], ["play", []]]) }];
      }
      case "closeup": {
        if (args.length < 1 || args.length > 3) fail("expected <<closeup view [loop [cel]]>>");
        if (!this.target.closeUp) fail("this game has no close-ups");
        const [view, loop = "0", cel = "0"] = args;
        // A new close-up, shown until the player clicks; then it cues the script.
        return [{ op: "async", code: [
          ...send({ cls: this.target.closeUp! }, [["new", []]]),
          "pushi #show", "pushi 4", ...pushVal(int(view, "view", 0, 65535)), ...pushVal(int(loop, "loop", 0, 255)), ...pushVal(int(cel, "cel", 0, 255)), "pushSelf", "send 12",
        ] }];
      }
      case "get":
      case "drop": {
        arity(1, "<item>");
        const { items, globals } = this.target;
        const n = items?.exports[args[0]!];
        if (n === undefined || globals.inventory === undefined) {
          return fail(`no item called "${args[0]}"${items && Object.keys(items.exports).length ? ` (items: ${Object.keys(items.exports).join(", ")})` : " (items with a view in items.yaml)"}`);
        }
        const item: Val = { code: [`pushi 2`, `pushi ${items!.script}`, `pushi ${n}`, "callk ScriptID 4"] };
        return [{ op: "code", code: send({ global: globals.inventory }, [[name === "get" ? "add" : "delete", [item]]]) }];
      }
      case "room":
        arity(1, "number");
        return [{ op: "code", code: send({ global: g.curRoom }, [["newRoom", [int(args[0], "room", 0, 65535)]]]) }];
      default:
        return fail("unknown command (known: walk, face, wait, hide, show, view, loop, cel, animate, normal, stop, music, sound, closeup, get, drop, room; and set, if)");
    }
  }

  /** Loop music n, unless it's what's playing already. */
  private playMusic(n: number): string[] {
    const music = { global: this.target.globals.music };
    const playing = this.label();
    return [
      ...send(music, [["number", []]]), "push", `ldi ${n}`, "eq?", `bt ${playing}`,
      ...send(music, [["number", [n]], ["setLoop", [-1]], ["play", []]]), `${playing}:`,
    ];
  }

  private label(): string {
    return `.c${this.nextLabel++}`;
  }

  /** A Script running `steps`, then `end`. */
  private sequenceScript(name: string, steps: Instr[], end: string[]): void {
    // Where states begin: the start, after each say/async, and at labels.
    const labelState = new Map<string, number>();
    let state = 0, empty = true;
    for (const step of steps) {
      if (step.op === "label") {
        if (!empty) (state++, (empty = true));
        labelState.set(step.name, state);
        continue;
      }
      empty = false;
      if (step.op === "say" || step.op === "async") (state++, (empty = true));
    }
    // Jumping sets the state and cues; the rest of this state's code must not run.
    const jump = (label: string) => [`ldi ${labelState.get(label)! - 1}`, "aTop state", ...send("self", [["cue", []]]), `jmp .${name}_done`];
    const states: State[] = [];
    let code: string[] = [];
    empty = true;
    const close = () => {
      states.push(code);
      code = [];
      empty = true;
    };
    for (const step of steps) {
      switch (step.op) {
        case "label":
          if (!empty) (code.push(...jump(step.name)), close());
          break;
        case "say":
          code.push(...send({ global: this.target.globals.messager }, [["say", [step.noun, step.verb, step.cond, 0, "self"]]]));
          close();
          break;
        case "async":
          code.push(...step.code);
          close();
          break;
        case "code":
          code.push(...step.code);
          empty = false;
          break;
        case "set":
          code.push(...this.setFlag(step.name, step.value, step.where));
          empty = false;
          break;
        case "unless": {
          const holds = this.label();
          code.push(...this.expr(step.when, step.where), `bt ${holds}`, ...jump(step.label), `${holds}:`);
          empty = false;
          break;
        }
        case "jump":
          code.push(...jump(step.label));
          empty = false;
          break;
      }
    }
    code.push(...end);
    states.push(code);
    this.script(name, states);
  }

  // --- Flags ---

  private flag(name: string, where: string): number {
    this.flagsUsed.add(name);
    try {
      return this.flagNumber(name);
    } catch (e) {
      throw new ContentError(`${where}: $${name}: ${(e as Error).message}`);
    }
  }

  private flagCall(kind: "set" | "clear" | "test", flag: number): string[] {
    const f = this.target.flags;
    const call = f.script === 0 ? `callb ${f[kind]} 2` : `calle ${f.script} ${f[kind]} 2`;
    return ["push1", `pushi ${flag}`, call];
  }

  /** The condition's value in acc (non-zero: holds). */
  private expr(e: YarnExpr, where: string): string[] {
    switch (e.kind) {
      case "const":
        return [`ldi ${e.value ? 1 : 0}`];
      case "var":
        return this.flagCall("test", this.flag(e.name, where));
      case "not":
        return [...this.expr(e.of, where), "not"];
      case "and":
      case "or": {
        const done = this.label();
        return [...this.expr(e.a, where), `${e.kind === "and" ? "bnt" : "bt"} ${done}`, ...this.expr(e.b, where), `${done}:`];
      }
    }
  }

  private setFlag(name: string, value: YarnExpr, where: string): string[] {
    const flag = this.flag(name, where);
    if (value.kind === "const") return this.flagCall(value.value ? "set" : "clear", flag);
    const clear = this.label(), done = this.label();
    return [...this.expr(value, where), `bnt ${clear}`, ...this.flagCall("set", flag), `jmp ${done}`, `${clear}:`, ...this.flagCall("clear", flag), `${done}:`];
  }

  // --- Objects ---

  /** A message; `spoken` is false for a topic menu's labels, which nobody says. */
  private message(noun: number, verb: number, cond: number, seq: number, l: YarnLine, label: string, spoken = true): void {
    const where = `${this.yarnFile}:${l.line}`;
    const prev = this.messages.at(-1);
    const shown = styledText(plainText(l.text, l.id === undefined ? where : `${where} (#line:${l.id})`), this.target.fonts, where);
    const m: Message = { noun, verb, cond, seq, talker: this.talkerOf(l.speaker, where), speaker: l.speaker ?? "Narrator", text: shown.text, label };
    this.messages.push(m);
    if (!spoken) return;
    const twice = l.id !== undefined && this.lines.find((x) => x.id === l.id);
    if (twice) throw new ContentError(`${where}: #line:${l.id} is already the id of ${twice.where}`);
    this.lines.push({
      ...(l.id === undefined ? {} : { id: l.id }), noun, verb, cond, seq, talker: m.talker, speaker: m.speaker, text: shown.plain, node: label,
      ...(prev?.label === label ? { before: { speaker: prev.speaker, text: stripCodes(prev.text) } } : {}), where,
    });
  }

  private talkerOf(speaker: string | undefined, where: string): number {
    if (speaker === undefined) return this.target.narrator;
    const s = speaker.toLowerCase();
    if (s === "narrator") return this.target.narrator;
    if (s === "hero") return this.target.heroTalker;
    const t = this.talkers.get(s);
    if (t !== undefined) return t;
    const known = ["Narrator", "Hero", ...Object.keys(this.spec.characters ?? {})];
    throw new ContentError(`${where}: unknown speaker "${speaker}" (add them under characters: in the room; known: ${known.join(", ")})`);
  }

  private instance(label: string, cls: string, props: Record<string, number | string>, methods: string[] = [], shownName = label): void {
    const overrides = this.spec.properties?.[label === this.name ? "room" : label] ?? {};
    const all: Record<string, number | string> = { classScript: 0, info: 0, name: `@s_${label}`, ...props, ...overrides };
    this.instances.push(
      `instance ${label} of ${cls}`,
      ...Object.entries(all).map(([k, v]) => `  ${k} ${typeof v === "number" ? num(v) : v}`),
      ...methods.map((m) => `  method ${m} ${label}::${m}`),
      "",
    );
    this.strings.push(`  s_${label} "${shownName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }

  private roomInstance(hasEnterScript: boolean, hasCharacters: boolean): void {
    const { spec, target } = this;
    const verbs = this.scriptedVerbs.get("room") ?? [];
    this.instance(
      this.name, target.roomClass, { noun: 1, modNum: -1, picture: spec.picture ?? spec.room, ...target.roomDefaults },
      ["init", ...(hasCharacters ? ["findTalker"] : []), ...(verbs.length ? ["doVerb"] : [])],
    );
    if (hasCharacters) this.findTalker();
    if (verbs.length) this.doVerb(this.name, target.roomClass, verbs);
    const c: string[] = [`${this.name}::init:`];
    const hero = spec.hero;
    const egoCalls: [string, Val[]][] = [["init", []]];
    if (hero?.at) egoCalls.push(["x", [hero.at[0]]], ["y", [hero.at[1]]]);
    egoCalls.push(["normalize", []]);
    // Each room sizes the hero its own way, or not at all.
    const perspective = this.perspective();
    if (hero?.scale) egoCalls.push(["setScaler", [{ cls: "Scaler" }, hero.scale.front, hero.scale.back, hero.scale.frontY, hero.scale.backY]]);
    else if (perspective) egoCalls.push(["setScaler", [{ cls: perspective.cls }, ...perspective.args]]);
    else egoCalls.push(["setScaler", [0]]);
    c.push(...send({ global: target.globals.ego }, egoCalls));
    if (spec.music !== undefined) c.push(...this.playMusic(spec.music));
    for (const name of [...Object.keys(spec.features ?? {}), ...Object.keys(spec.exits ?? {})]) c.push(...send({ obj: name }, [["init", []]]));
    for (const [name, p] of Object.entries(spec.props ?? {})) {
      c.push(...send({ obj: name }, [
        ["init", []],
        ...(perspective && p.moves && p.scale !== false ? [["setScaler", [{ cls: perspective.cls }, ...perspective.args]] as [string, Val[]]] : []),
        ...(p.cycle === "forward" ? [["setCycle", [{ cls: this.target.forwardCycle }]] as [string, Val[]]] : []),
        // A new instance of the game's Script class, running on the prop.
        ...(p.script ? [["setScript", [{ code: ["pushi #new", "push0", `class ${p.script}`, "send 4"] }]] as [string, Val[]]] : []),
      ]));
    }
    const polygons: [number, [number, number][]][] = [
      ...(spec.walkable ? [[3, spec.walkable] as [number, [number, number][]]] : []),
      ...(spec.obstacles ?? []).map((p) => [2, p] as [number, [number, number][]]),
    ];
    for (const [type, points] of polygons) {
      // curRoom addObstacle: ((Polygon new) type: t, init: points..., yourself): the
      // type/init/yourself words are pushed first, then `Polygon new` leaves the receiver
      // in acc for the outer send.
      const poly = send({ cls: "Polygon" }, [["new", []]]);
      const inner: string[] = [];
      let words = 0;
      for (const [sel, args] of [["type", [type]], ["init", points.flat()], ["yourself", []]] as [string, number[]][]) {
        inner.push(`pushi #${sel}`, ...pushVal(args.length), ...args.flatMap((a) => pushVal(a)));
        words += 2 + args.length;
      }
      c.push(`pushi #addObstacle`, "push1", ...inner, ...poly, `send ${words * 2}`, "push", `lag ${target.globals.curRoom}`, "send 6");
    }
    for (const conv of this.conversations) {
      c.push(...send({ obj: `${conv.thing}Teller` }, [["init", [{ obj: conv.thing }, spec.room, conv.sayNoun, target.teller.verb, conv.rootNoun]]]));
    }
    c.push("pushi #init", "push0", "&rest 1", `super ${target.roomClass} 4`);
    if (hasEnterScript) c.push(...send("self", [["setScript", [{ obj: "sEnter" }]]]));
    c.push("ret", "");
    this.code.push(...c);
  }

  /** doVerb: given verbs run their script (in the room); anything else as the class does. */
  private doVerb(label: string, superClass: string, cases: [verb: number, script: string][]): void {
    const done = this.label();
    const c = [`${label}::doVerb:`, "lsp 1"];
    for (const [verb, script] of cases) {
      const next = this.label();
      c.push("dup", `ldi ${verb}`, "eq?", `bnt ${next}`, ...send({ global: this.target.globals.curRoom }, [["setScript", [{ obj: script }]]]), `jmp ${done}`, `${next}:`);
    }
    c.push("pushi #doVerb", "push1", "lsp 1", "&rest 2", `super ${superClass} 6`, `${done}:`, "toss", "ret", "");
    this.code.push(...c);
  }

  /** A character's talker: a plain text box, or a portrait talker with its parts. */
  private character(key: string, c: CharacterSpec): void {
    const { target } = this;
    const shown = c.name ?? cap(key);
    if (c.portrait === undefined) {
      this.instance(`${key}Talker`, target.voice.class, target.voice.props, [], shown);
      return;
    }
    const p = target.portrait;
    const [x, y] = p.at;
    this.instance(`${key}Talker`, p.class, p.props, ["init"], shown);
    this.instance(`${key}Bust`, "View", { x, y, view: c.portrait, loop: 0, cel: 0, signal: p.frameSignal });
    this.instance(`${key}Mouth`, "Prop", { x, y, view: c.portrait, loop: 1, cel: 0, signal: p.partSignal });
    this.instance(`${key}Eyes`, "Prop", { x, y, view: c.portrait, loop: 2, cel: 0, signal: p.partSignal });
    // init: mouth bust eyes frame (the bust is drawn as the frame, as the game's own do).
    // Every part gets the talker's priority; the game's portraits sort mouth and eyes above
    // the bust by their y, but ours share one position, so lift them a priority above it.
    this.code.push(
      `${key}Talker::init:`,
      ...[
        "pushi #init", "pushi 4", `lofsa @${key}Mouth`, "push", "push0", `lofsa @${key}Eyes`, "push", `lofsa @${key}Bust`, "push",
        "&rest 1", `super ${p.class} 12`,
        "pushi #setPri", "push1", "pTos priority", "ldi 1", "add", "push", `lofsa @${key}Mouth`, "send 6",
        "pushi #setPri", "push1", "pTos priority", "ldi 1", "add", "push", `lofsa @${key}Eyes`, "send 6",
        // Its body in the room, if a prop has its name: where it stands picks the portrait's side.
        ...(p.who && this.spec.props?.[key] ? send("self", [["who", [{ obj: key }]]]) : []),
        "ret",
      ],
      "",
    );
  }

  /** A conversation's Teller, with showCases (conditional topics) and sayMessage (scripted answers). */
  private teller(conv: Conversation): void {
    const { target } = this;
    const label = `${conv.thing}Teller`;
    const methods = [...(conv.conditional.length ? ["showCases"] : []), ...(conv.scripted.length ? ["sayMessage"] : [])];
    this.instance(label, target.teller.class, { ...target.teller.props, actionVerb: conv.opensWith }, methods);
    if (conv.conditional.length) {
      // super showCases: topic offered? ... (pairs; a topic whose value is 0 is left out)
      const c = [`${label}::showCases:`, "pushi #showCases", `pushi ${conv.conditional.length * 2}`];
      for (const { topic, when, where } of conv.conditional) c.push(`pushi ${topic}`, ...this.expr(when, where), "push");
      c.push(`super ${target.teller.class} ${(2 + conv.conditional.length * 2) * 2}`, "ret", "");
      this.code.push(...c);
    }
    if (conv.scripted.length) {
      const c = [`${label}::sayMessage:`, "pTos iconValue"];
      const other = this.label();
      for (const { topic, script } of conv.scripted) {
        const next = this.label();
        c.push(
          "dup", `ldi ${topic}`, "eq?", `bnt ${next}`, "toss",
          ...send({ global: target.globals.curRoom }, [["setScript", [{ obj: script }, "self"]]]), "ret", `${next}:`,
        );
      }
      c.push(`${other}:`, "toss", "pushi #sayMessage", "push0", "&rest 1", `super ${target.teller.class} 4`, "ret", "");
      this.code.push(...c);
    }
  }

  /** findTalker: n -> this room's character for talker number n (the game asks for 200+). */
  private findTalker(): void {
    const c = [`${this.name}::findTalker:`, "lsp 1"];
    const done = ".findTalkerDone";
    Object.keys(this.spec.characters ?? {}).forEach((key, i) => {
      const next = `.findTalker${i + 1}`;
      c.push("dup", `ldi ${this.target.firstRoomTalker + i}`, "eq?", `bnt ${next}`, `lofsa @${key}Talker`, `jmp ${done}`, `${next}:`);
    });
    // Not one of ours: the narrator, as the game does for numbers it doesn't know.
    c.push(`lag ${this.target.globals.narratorObject}`, `${done}:`, "toss", "ret", "");
    this.code.push(...c);
  }

  private feature(name: string, f: FeatureSpec, exitScript?: string): void {
    const [l, t, r, b] = f.rect;
    const [x, y] = f.at ?? [Math.round((l + r) / 2), Math.round((t + b) / 2)];
    // Do on an exit leaves (its script); verbs with scripted Yarn run theirs.
    const cases: [number, string][] = [...(exitScript ? [[this.target.verbs.do!, exitScript] as [number, string]] : []), ...(this.scriptedVerbs.get(name) ?? [])];
    this.instance(
      name,
      "Feature",
      {
        noun: this.nouns.get(name)!, modNum: -1, nsLeft: l, nsTop: t, nsRight: r, nsBottom: b, sightAngle: f.sightAngle ?? 180,
        ...(f.approach ? { approachX: f.approach[0], approachY: f.approach[1] } : {}), x, y,
      },
      cases.length ? ["doVerb"] : [],
    );
    if (cases.length) this.doVerb(name, "Feature", cases);
  }

  /** The y range people stand in: the floor, and where the hero and props that move start. */
  private standingYs(): number[] {
    return [
      ...(this.spec.walkable ?? []).map((p) => p[1]),
      ...Object.values(this.spec.props ?? {}).filter((p) => p.moves).map((p) => p.at[1]),
      ...[this.spec.hero?.at, this.spec.hero?.enterTo].flatMap((p) => (p ? [p[1]] : [])),
    ];
  }

  /**
   * The room's perspective as a scaler class and its arguments.
   *
   * With a horizon, a Scaler (front, back, frontY, backY): sizes at the nearest and farthest
   * places anyone stands. Size is a straight line in y, so the Scaler's in-between is exact;
   * keeping to that range keeps its 16-bit arithmetic from overflowing.
   *
   * With measured columns, a FloorScaler with three of them (left, middle, right): one is
   * used for all three, two get one halfway between them.
   */
  private perspective(): { cls: string; args: number[] } | undefined {
    const pv = this.spec.perspective;
    if (!pv) return undefined;
    const fail = (why: string): never => { throw new ContentError(`room ${this.spec.room}: perspective: ${why}`); };
    if ("columns" in pv) {
      const cols = floorColumns(pv.columns);
      const ys = this.standingYs();
      const [lo, hi] = [Math.min(...ys, ...cols.map((c) => c.back[0])), Math.max(...ys, ...cols.map((c) => c.front[0]))];
      // FloorScaler works out (front - back) * (y - backY), then (b - a) * (x - x1), in 16 bits.
      for (const c of cols) {
        for (const y of [lo, hi]) {
          if (Math.abs((c.front[1] - c.back[1]) * (y - c.back[0])) > 32767) fail(`sizes from ${c.back[1]}% to ${c.front[1]}% at x ${c.x} are too much for the scaler at y ${y}`);
          const size = along(c, y);
          if (size < 1 || size > 255) fail(`at x ${c.x} a figure standing at y ${y} would be ${Math.round(size)}%`);
        }
      }
      return { cls: "FloorScaler", args: cols.flatMap((c) => [c.x, c.back[0], c.back[1], c.front[0], c.front[1]]) };
    }
    const ys = this.standingYs().filter((y) => y > pv.horizon);
    const backY = ys.length ? Math.min(...ys) : pv.horizon + 1, frontY = ys.length ? Math.max(...ys) : SCREEN_BOTTOM - 1;
    const size = (y: number) => Math.round(((y - pv.horizon) / (pv.fullSize - pv.horizon)) * 100);
    const [front, back] = [size(frontY), size(backY)];
    // Scaler works out (front - back) * (y - backY) on the way.
    if ((front - back) * (frontY - backY) > 32767) fail(`sizes from ${back}% to ${front}% over ${frontY - backY} lines are too much for the Scaler`);
    return { cls: "Scaler", args: [front, back, Math.max(frontY, backY + 1), backY] };
  }

  /** The size, in percent, of a figure standing at x, y. */
  private sizeAt(x: number, y: number): number {
    const pv = this.spec.perspective!;
    if ("columns" in pv) return floorSize(floorColumns(pv.columns), x, y);
    return ((y - pv.horizon) / (pv.fullSize - pv.horizon)) * 100;
  }

  private prop(name: string, p: PropSpec): void {
    const cases = this.scriptedVerbs.get(name) ?? [];
    // A still prop is sized once, for where it is.
    const fixed = this.spec.perspective && p.scale === true && !p.moves ? Math.round((this.sizeAt(p.at[0], p.at[1]) / 100) * 128) : undefined;
    this.instance(
      name, p.moves ? "Actor" : "Prop",
      {
        noun: this.nouns.get(name)!, modNum: -1, sightAngle: p.sightAngle ?? 180, x: p.at[0], y: p.at[1], view: p.view, loop: p.loop ?? 0, cel: p.cel ?? 0,
        ...(fixed === undefined ? {} : { scaleSignal: 1, scaleX: fixed, scaleY: fixed }),
      },
      cases.length ? ["doVerb"] : [],
    );
    if (cases.length) this.doVerb(name, p.moves ? "Actor" : "Prop", cases);
  }

  /** A Script instance whose changeState runs `states` in order. */
  private script(name: string, states: State[]): void {
    this.instance(name, "Script", {}, ["changeState"]);
    const c = [`${name}::changeState:`, "lap 1", "aTop state", "push"];
    const done = `.${name}_done`;
    states.forEach((body, i) => {
      const next = i + 1 < states.length ? `.${name}_${i + 1}` : done;
      if (i > 0) c.push(`.${name}_${i}:`);
      c.push("dup", `ldi ${i}`, "eq?", `bnt ${next}`, ...body);
      if (i + 1 < states.length) c.push(`jmp ${done}`);
    });
    c.push(`${done}:`, "toss", "ret", "");
    this.code.push(...c);
  }

  private assembly(): string {
    const nounList = [...this.nouns].map(([n, v]) => `${v} ${n}`).join(", ");
    return [
      `; Room ${this.spec.room}, compiled from its .room.yaml and .yarn by @sci-ts/content. Don't edit:`,
      `; change the sources and rebuild. Nouns: ${nounList}.`,
      `script ${this.spec.room}`,
      "",
      "exports",
      `  ${this.name}`,
      "",
      ...this.instances,
      "strings",
      ...this.strings,
      "",
      "code",
      "",
      ...this.code.map((l) => (l.endsWith(":") || l === "" ? l : `    ${l}`)),
    ].join("\n");
  }

  private messageText(): string {
    const lines = [`messages ${this.spec.room} version ${this.target.messageVersion}`, '; noun verb cond seq talker "text"   (compiled from Yarn)'];
    for (const m of this.messages) {
      lines.push(`${m.noun} ${m.verb} ${m.cond} ${m.seq} ${m.talker} "${m.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" ; ${m.label}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const counter = (from: number) => {
  let n = from;
  return () => n++;
};

/** Message text is single bytes: typographic punctuation becomes ASCII, anything else is an error. */
/** Message text without SCI's font and colour codes: what's said, and what recordings are for. */
const stripCodes = (text: string) => text.replace(/\|[fc]\d*\|/g, "");

/**
 * Yarn's [b] and [i] markup (nestable, closed with [/b] and [/i]) as SCI's font codes: bold,
 * italic or both, back to the text's own font with |f|. `plain` is the text without it, for
 * speech and the script. \[ is a bracket.
 */
function styledText(text: string, fonts: Target["fonts"], where: string): { text: string; plain: string } {
  if (!text.includes("[")) return { text, plain: text };
  const fail = (why: string): never => { throw new ContentError(`${where}: ${why}`); };
  let shown = "", plain = "", bold = 0, italic = 0;
  const font = () => (bold && italic ? fonts!.boldItalic : bold ? fonts!.bold : italic ? fonts!.italic : 0);
  for (let i = 0; i < text.length; ) {
    if (text.startsWith("\\[", i)) {
      (shown += "["), (plain += "["), (i += 2);
      continue;
    }
    const m = /^\[(\/?)([a-z]+)\]/.exec(text.slice(i));
    if (text[i] === "[") {
      if (!m || (m[2] !== "b" && m[2] !== "i")) fail(`unknown markup "${m?.[0] ?? text.slice(i, i + 8)}" (supported: [b] and [i], closed with [/b] and [/i]; \\[ for a bracket)`);
      if (!fonts) fail("[b] and [i] need the game's bold and italic fonts (\"fonts\" in game.json)");
      const delta = m![1] ? -1 : 1;
      if (m![2] === "b") bold += delta;
      else italic += delta;
      if (bold < 0 || italic < 0) fail(`${m![0]} without its opening`);
      const f = font();
      shown += f ? `|f${f}|` : "|f|";
      i += m![0].length;
      continue;
    }
    (shown += text[i]), (plain += text[i]), i++;
  }
  if (bold || italic) fail(`[${bold ? "b" : "i"}] isn't closed`);
  return { text: shown.replace(/\|f\d*\|$/, (code) => (code === "|f|" ? "" : code)), plain };
}

function plainText(text: string, where: string): string {
  const out = text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "--")
    .replace(/…/g, "...");
  const bad = /[^\x20-\x7e]/.exec(out);
  if (bad) throw new ContentError(`${where}: "${bad[0]}" can't be shown by the game's fonts (plain ASCII only for now)`);
  return out;
}
