import { ObjectSlot, readString, type Script } from "../script/script.ts";
import { makeRef, offsetOf, segmentOf, type Value } from "./value.ts";

/** A script loaded into the VM: its own segment, mutable locals and live objects. */
export interface LoadedScript {
  number: number;
  script: Script;
  segment: number;
  /** Segment used for pointers to this script's locals (from `lea`). */
  localsSegment: number;
  /** Local variables (script 0's locals are the game's globals). */
  locals: Value[];
  /** Live objects by heap offset. */
  objects: Map<number, SciObject>;
  code: Uint8Array;
  codeView: DataView;
}

/**
 * An object at runtime. Property slots are full Values (they can hold references),
 * unlike the 16-bit words in the heap resource they're initialised from.
 */
export interface SciObject {
  address: Value;
  name: string;
  /** Script whose code implements this object's own methods. */
  script: LoadedScript;
  vars: Value[];
  isClass: boolean;
  /** Own methods: selector → code offset in `script`. Clones share their parent's. */
  methods: Map<number, number>;
  /** Selector → property slot. Shared by every object of a class. */
  propIndex: Map<number, number>;
  /** Class number where method lookup continues after `methods`. */
  superclass: number;
  /** For classes: own class number. For instances/clones: their class's. */
  species: number;
  isClone: boolean;
  /** For clones: the script object whose methods/layout it uses (cloning a clone = cloning this). */
  template: SciObject | undefined;
}

export type ArrayType = "int16" | "id" | "byte" | "string";

/** SCI32 dynamic array (kArray / kString). Byte and string arrays hold 0..255. */
export interface SciArray {
  type: ArrayType;
  data: Value[];
}

export interface ListNode {
  address: Value;
  value: Value;
  key: Value;
  prev: ListNode | undefined;
  next: ListNode | undefined;
  list: SciList | undefined;
}

export interface SciList {
  address: Value;
  first: ListNode | undefined;
  last: ListNode | undefined;
}

/** SCI32 in-memory bitmap (text boxes and other script-drawn images), 8-bit indexed. */
export interface SciBitmap {
  width: number;
  height: number;
  pixels: Uint8Array;
  skipColor: number;
  originX: number;
  originY: number;
}

export type Segment =
  | { kind: "script"; script: LoadedScript }
  | { kind: "locals"; script: LoadedScript }
  | { kind: "clone"; object: SciObject }
  | { kind: "stack" }
  | { kind: "array"; array: SciArray }
  | { kind: "list"; list: SciList }
  | { kind: "node"; node: ListNode }
  | { kind: "bitmap"; bitmap: SciBitmap }
  | { kind: "free" };

/**
 * The segment table. Every addressable thing gets its own segment, which keeps
 * references stable and makes "what is this pointer?" a table lookup.
 */
export class Memory {
  readonly segments: Segment[] = [{ kind: "free" }]; // segment 0 = numbers
  private readonly freeSegments: number[] = [];
  readonly objects = new Map<Value, SciObject>();
  readonly stack: Value[];
  readonly stackSegment: number;

  /**
   * `stack` can be handed over from a previous Memory: the interpreter loop holds on to the
   * stack array, so restarting or restoring mid-instruction must keep the same array.
   */
  constructor(stack: Value[] = new Array(0x2000).fill(0)) {
    this.stack = stack;
    this.stackSegment = this.allocate({ kind: "stack" });
  }

  /** Puts a segment at a specific id (restoring a save), growing the table if needed. */
  allocateAt(id: number, segment: Segment): void {
    while (this.segments.length <= id) this.segments.push({ kind: "free" });
    this.segments[id] = segment;
    const i = this.freeSegments.indexOf(id);
    if (i >= 0) this.freeSegments.splice(i, 1);
  }

  /** Free segment ids, for snapshots. */
  get free_(): readonly number[] {
    return this.freeSegments;
  }

  setFreeSegments(ids: number[]): void {
    this.freeSegments.length = 0;
    this.freeSegments.push(...ids);
  }

  allocate(segment: Segment): number {
    const id = this.freeSegments.pop();
    if (id !== undefined) {
      this.segments[id] = segment;
      return id;
    }
    this.segments.push(segment);
    return this.segments.length - 1;
  }

  free(id: number): void {
    this.segments[id] = { kind: "free" };
    this.freeSegments.push(id);
  }

  segment(v: Value): Segment | undefined {
    return this.segments[segmentOf(v)];
  }

  object(v: Value): SciObject | undefined {
    return this.objects.get(v);
  }

  // --- Arrays ---------------------------------------------------------------

  newArray(type: ArrayType, size: number): Value {
    const seg = this.allocate({ kind: "array", array: { type, data: new Array(size).fill(0) } });
    return makeRef(seg, 0);
  }

  array(v: Value): SciArray | undefined {
    const s = this.segment(v);
    return s?.kind === "array" ? s.array : undefined;
  }

  // --- Lists ----------------------------------------------------------------

  newList(): SciList {
    const list: SciList = { address: 0, first: undefined, last: undefined };
    list.address = makeRef(this.allocate({ kind: "list", list }), 0);
    return list;
  }

  newNode(value: Value, key: Value): ListNode {
    const node: ListNode = { address: 0, value, key, prev: undefined, next: undefined, list: undefined };
    node.address = makeRef(this.allocate({ kind: "node", node }), 0);
    return node;
  }

  list(v: Value): SciList | undefined {
    const s = this.segment(v);
    return s?.kind === "list" ? s.list : undefined;
  }

  node(v: Value): ListNode | undefined {
    const s = this.segment(v);
    return s?.kind === "node" ? s.node : undefined;
  }

  // --- Bitmaps ----------------------------------------------------------------

  newBitmap(width: number, height: number, fill: number, skipColor: number): Value {
    const bitmap: SciBitmap = { width, height, pixels: new Uint8Array(width * height).fill(fill), skipColor, originX: 0, originY: 0 };
    return makeRef(this.allocate({ kind: "bitmap", bitmap }), 0);
  }

  bitmap(v: Value): SciBitmap | undefined {
    const s = this.segment(v);
    return s?.kind === "bitmap" ? s.bitmap : undefined;
  }

  // --- Strings and raw references -------------------------------------------

  /** Reads a string from a heap literal, a string/byte array, or a String object's data. */
  string(v: Value): string {
    const s = this.segment(v);
    if (!s) return "";
    if (s.kind === "script") return readString(s.script.script.heap, offsetOf(v));
    if (s.kind === "array") {
      const chars: number[] = [];
      for (let i = offsetOf(v); i < s.array.data.length; i++) {
        const c = s.array.data[i]! & 0xff;
        if (c === 0) break;
        chars.push(c);
      }
      return String.fromCharCode(...chars);
    }
    return "";
  }

  /** Reads through a pointer to a variable (from `lea`): locals/globals or the stack. */
  read(v: Value): Value {
    const s = this.segment(v);
    const i = offsetOf(v) >> 1;
    if (s?.kind === "locals") return s.script.locals[i] ?? 0;
    if (s?.kind === "stack") return this.stack[i] ?? 0;
    if (s?.kind === "array") return s.array.data[offsetOf(v)] ?? 0;
    throw new Error(`read through unsupported reference ${v.toString(16)}`);
  }

  write(v: Value, value: Value): void {
    const s = this.segment(v);
    const i = offsetOf(v) >> 1;
    if (s?.kind === "locals") s.script.locals[i] = value;
    else if (s?.kind === "stack") this.stack[i] = value;
    else if (s?.kind === "array") s.array.data[offsetOf(v)] = value;
    else throw new Error(`write through unsupported reference ${v.toString(16)}`);
  }

  // --- Objects --------------------------------------------------------------

  clone(parent: SciObject): SciObject {
    const obj = cloneShape(parent.template ?? parent, parent.vars.slice());
    obj.address = makeRef(this.allocate({ kind: "clone", object: obj }), 0);
    obj.vars[ObjectSlot.Info] = (obj.vars[ObjectSlot.Info]! & ~0x8000) | 0x0001;
    this.objects.set(obj.address, obj);
    return obj;
  }

  disposeClone(obj: SciObject): void {
    if (!obj.isClone) return;
    this.objects.delete(obj.address);
    this.free(segmentOf(obj.address));
  }
}

/**
 * A clone of `template` (a script object) with the given property values. A clone of a class
 * behaves like an instance of that class; a clone of an instance shares its methods.
 */
export function cloneShape(template: SciObject, vars: Value[]): SciObject {
  return {
    ...template,
    address: 0,
    vars,
    isClass: false,
    isClone: true,
    template,
    superclass: template.isClass ? template.species : template.superclass,
    methods: template.isClass ? new Map() : template.methods,
  };
}
