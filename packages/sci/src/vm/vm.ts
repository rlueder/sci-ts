import type { ResourceManager } from "../resource/manager.ts";
import { ResourceType } from "../resource/types.ts";
import { kernelNames } from "../script/kernel-names.ts";
import { ObjectSlot, parseScript } from "../script/script.ts";
import { parseClassTable, parseSelectorNames } from "../script/vocab.ts";
import { Memory, type LoadedScript, type SciObject } from "./memory.ts";
import { NULL, bool, formatValue, isNumber, makeRef, offsetOf, segmentOf, toSigned, type Value } from "./value.ts";

/** A message a native (generator) kernel wants sent; the VM resumes it with the result. */
export interface SendRequest {
  object: Value;
  selector: number;
  args: Value[];
}

/** A native kernel's request to end the current frame (it has drawn one) and resume next tick. */
export interface FrameRequest {
  frame: true;
}

/**
 * A kernel function receives its arguments (argc = args.length) and returns acc.
 * Kernels that call back into scripts are generators: they yield SendRequests and run as a
 * "native frame" on the VM's frame stack, so a FrameOut inside the callback can still pause
 * the whole VM for the browser.
 */
export type KernelFn = (vm: Vm, args: Value[]) => Value | void | Generator<SendRequest | FrameRequest, Value | void, Value>;

interface SendItem {
  selector: number;
  argc: number;
  /** Stack index of the selector word; argc is at base+1, args follow. */
  base: number;
}

/** A multi-selector send in progress, resumed each time a method it invoked returns. */
interface SendJob {
  object: SciObject;
  /** For `super`: class where method lookup starts. */
  startClass: number | undefined;
  items: SendItem[];
  index: number;
  spAfter: number;
}

interface Frame {
  script: LoadedScript;
  pc: number;
  self: SciObject | undefined;
  /** Stack index of this call's argc (param 0). */
  paramBase: number;
  /** Stack index of temp 0. */
  tempBase: number;
  /** Stack pointer to restore when this frame returns (call/callk-style frames). */
  restoreSp: number;
  /** Set on the *caller* while a send it started is still dispatching selectors. */
  send?: SendJob;
  /** Frames started by `invoke` stop the nested run loop when they return. */
  stopOnReturn?: boolean;
  /** Native frame: a generator kernel waiting on the sends it requested. */
  native?: Generator<SendRequest | FrameRequest, Value | void, Value>;
}

/** SCI2 -info- flag: a drawing property changed since the screen item was last updated. */
export const INFO_VIEW_CHANGED = 0x0008;
/** SCI2 variable slots whose writes set it (games with nsLeft-style selectors). */
const VIEW_VAR_FIRST = 26, VIEW_VAR_LAST = 44;

export class VmError extends Error {}

/** Opcodes, for readability in the dispatch loop (instruction byte = opcode << 1 | small). */
enum Op {
  bnot, add, sub, mul, div, mod, shr, shl, xor, and, or, neg, not,
  eq, ne, gt, ge, lt, le, ugt, uge, ult, ule,
  bt, bnt, jmp, ldi, push, pushi, toss, dup, link,
  call, callk, callb, calle, ret, send,
  class_ = 0x28, self_ = 0x2a, super_, rest, lea, selfID,
  pprev = 0x30, pToa, aTop, pTos, sTop, ipToa, dpToa, ipTos, dpTos,
  lofsa, lofss, push0, push1, push2, pushSelf,
}

/**
 * The SCI virtual machine: a stack machine with an accumulator, executing bytecode methods
 * of objects that talk to each other through `send`.
 *
 * Execution uses an explicit frame stack rather than JS recursion, so `run()` can stop at
 * any instruction boundary (e.g. when FrameOut wants the browser to draw) and pick up later.
 */
export class Vm {
  memory = new Memory();
  readonly selectors: string[];
  readonly selectorIds = new Map<string, number>();
  private readonly classScripts: number[];
  private readonly classes = new Map<number, SciObject>();
  private readonly scripts = new Map<number, LoadedScript>();
  private readonly kernels: (KernelFn | undefined)[] = [];
  readonly missingKernels = new Map<string, number>();

  acc: Value = NULL;
  prev: Value = NULL;
  private sp = 0;
  private rest = 0;
  private frames: Frame[] = [];
  /** Set by kernels (FrameOut) to end the current `run()` slice. */
  yieldRequested = false;
  instructions = 0;
  /** Milliseconds since boot. Browser: real time. Headless runs can drive it per frame. */
  clock: () => number = (() => {
    const t0 = Date.now();
    return () => Date.now() - t0;
  })();
  /** Host hook: move the mouse (SetCursor warp), e.g. update the input position. */
  moveMouse?: (x: number, y: number) => void;
  /** Called once per FrameOut (music sequencing, etc.). */
  readonly frameHooks: (() => void)[] = [];
  /** Optional hook for tracing method calls (object, selector name, argument count). */
  onSend?: (object: SciObject, selector: string, argc: number) => void;
  /** Optional hook for tracing kernel calls. */
  onKernelCall?: (name: string, args: Value[], result: Value) => void;

  constructor(readonly resources: ResourceManager) {
    this.selectors = parseSelectorNames(resources.loadSync({ type: ResourceType.Vocab, number: 997 }).data);
    this.selectors.forEach((name, id) => this.selectorIds.set(name, id));
    this.classScripts = parseClassTable(resources.loadSync({ type: ResourceType.Vocab, number: 996 }).data);
  }

  registerKernels(table: Record<string, KernelFn>): void {
    kernelNames.forEach((name, i) => {
      if (table[name]) this.kernels[i] = table[name];
    });
  }

  // --- Scripts, classes, objects ---------------------------------------------

  loadScript(number: number): LoadedScript {
    const existing = this.scripts.get(number);
    if (existing) return existing;
    const loaded = this.instantiateScript(number);
    this.resolveScript(loaded);
    return loaded;
  }

  /**
   * Creates a script's segments, locals and objects from its resources, without linking
   * instances to their classes (which may load other scripts). Restoring a save instantiates
   * every script at its saved segment ids first, then resolves them all.
   */
  private instantiateScript(number: number, at?: { segment: number; localsSegment: number }): LoadedScript {
    const code = this.resources.loadSync({ type: ResourceType.Script, number }).data;
    const heap = this.resources.loadSync({ type: ResourceType.Heap, number }).data;
    const script = parseScript(number, code, heap);
    const hv = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);

    // Heap words listed in the relocation table are pointers into this script's heap.
    const relocTable = hv.getUint16(0, true);
    const relocated = new Set<number>();
    for (let i = 0; i < hv.getUint16(relocTable, true); i++) relocated.add(hv.getUint16(relocTable + 2 + i * 2, true));

    const loaded: LoadedScript = {
      number,
      script,
      segment: 0,
      localsSegment: 0,
      locals: [],
      objects: new Map(),
      code,
      codeView: new DataView(code.buffer, code.byteOffset, code.byteLength),
    };
    if (at) {
      loaded.segment = at.segment;
      loaded.localsSegment = at.localsSegment;
      this.memory.allocateAt(at.segment, { kind: "script", script: loaded });
      this.memory.allocateAt(at.localsSegment, { kind: "locals", script: loaded });
    } else {
      loaded.segment = this.memory.allocate({ kind: "script", script: loaded });
      loaded.localsSegment = this.memory.allocate({ kind: "locals", script: loaded });
    }
    const word = (heapOffset: number) => {
      const w = hv.getUint16(heapOffset, true);
      return relocated.has(heapOffset) ? makeRef(loaded.segment, w) : w;
    };
    loaded.locals = script.locals.map((_, i) => word(4 + i * 2));
    this.scripts.set(number, loaded);

    for (const def of script.objects) {
      const obj: SciObject = {
        address: makeRef(loaded.segment, def.offset),
        name: def.name,
        script: loaded,
        vars: def.properties.map((_, i) => word(def.offset + i * 2)),
        isClass: def.isClass,
        methods: new Map(def.methods.map((m) => [m.selector, m.offset])),
        propIndex: new Map(),
        superclass: def.superclass,
        species: def.isClass ? def.species : def.superclass,
        isClone: false,
        template: undefined,
      };
      if (def.isClass) {
        def.propSelectors!.forEach((sel, slot) => obj.propIndex.set(sel, slot));
        this.classes.set(def.species, obj);
      }
      loaded.objects.set(def.offset, obj);
      this.memory.objects.set(obj.address, obj);
    }
    return loaded;
  }

  private resolveScript(loaded: LoadedScript): void {
    // Instances share their class's property layout; the class may live in another script.
    // At runtime -super- holds the superclass *object* and a class's -species- is itself
    // (the heap stores class numbers), which is what Obj::isKindOf walks.
    for (const obj of loaded.objects.values()) {
      if (!obj.isClass) obj.propIndex = this.classObject(obj.superclass).propIndex;
      if (obj.isClass) obj.vars[ObjectSlot.Species] = obj.address;
      obj.vars[ObjectSlot.Super] = obj.superclass === 0xffff ? NULL : this.classObject(obj.superclass).address;
      this.fixObjectIdentity(obj);
    }
  }

  /**
   * `Obj::isKindOf` compares -propDict- and -classScript- to decide whether two objects share
   * a class, so (as in the original interpreter) every object's -classScript- is its script
   * number and an instance's -propDict- is its class's. Left as raw heap values, unrelated
   * objects can match (e.g. a spell icon claiming to be an inventory item).
   */
  fixObjectIdentity(obj: SciObject): void {
    const source = obj.isClone ? (obj.template ?? obj) : obj;
    obj.vars[ObjectSlot.ClassScript] = source.script.number;
    const cls = source.isClass ? source : this.classes.get(source.superclass);
    if (cls && !obj.isClass) obj.vars[ObjectSlot.PropDict] = cls.vars[ObjectSlot.PropDict]!;
  }

  /**
   * DisposeScript: as in SSCI the script is unloaded, so its objects start fresh from the
   * resource the next time it's used. Dialogs rely on that: SRDialog's init offsets its
   * buttons from where they are, which only works on fresh objects. A script still running
   * (the dialog disposing its own script) goes once its last frame returns.
   */
  disposeScript(number: number): void {
    if (number === 0 || !this.scripts.has(number)) return;
    this.disposed.add(number);
    this.unloadDisposed();
  }

  private readonly disposed = new Set<number>();

  private unloadDisposed(): void {
    for (const n of this.disposed) {
      const s = this.scripts.get(n);
      if (s && this.frames.some((f) => f.script === s)) continue;
      this.disposed.delete(n);
      if (s && !this.scriptInUse(s)) this.unloadScript(s);
    }
  }

  /** Objects the host keeps outside VM memory (planes, screen items, playing sounds). */
  readonly hostRoots: (() => Iterable<Value>)[] = [];

  /**
   * Whether anything live still needs the script: a reference into it, or a clone or
   * subclass of one of its classes, reachable from the roots (other scripts' locals and
   * objects, the stack, acc, running frames, the host). As in ScummVM's GC, only reachable
   * data counts, so garbage (a list nobody points to any more) doesn't pin it; a disposed
   * script that's still needed stays loaded (a pending Cue to a room's script, say).
   */
  private scriptInUse(s: LoadedScript): boolean {
    const m = this.memory;
    const species = new Set<number>();
    for (const o of s.objects.values()) if (o.isClass) species.add(o.species);
    const seen = new Set<number>();
    const pending: Value[] = [this.acc];
    for (const other of this.scripts.values()) {
      if (other === s) continue;
      pending.push(...other.locals);
      for (const o of other.objects.values()) pending.push(o.address);
    }
    for (let i = 0; i < this.sp; i++) pending.push(m.stack[i]!);
    for (const f of this.frames) if (f.self) pending.push(f.self.address);
    for (const roots of this.hostRoots) pending.push(...roots());
    while (pending.length) {
      const v = pending.pop()!;
      const id = segmentOf(v);
      if (id === 0) continue;
      // Only references to its objects count: stale words that point into its code, strings
      // or locals (a leftover temp, a by-reference argument kept in another script's locals)
      // don't keep SSCI from unloading it either.
      if (id === s.segment && m.objects.has(v)) return true;
      if (m.segments[id]?.kind === "script") {
        // Objects in other scripts are distinct per offset; follow each once.
        if (seen.has(v)) continue;
        seen.add(v);
      } else {
        if (seen.has(id * 0x10000)) continue;
        seen.add(id * 0x10000);
      }
      const seg = m.segments[id];
      const o = m.objects.get(v);
      if (o) {
        if (o.isClone ? o.template?.script === s : species.has(o.superclass)) return true;
        pending.push(...o.vars);
      } else if (seg?.kind === "array") pending.push(...seg.array.data);
      else if (seg?.kind === "list") for (let n = seg.list.first; n; n = n.next) pending.push(n.value, n.key);
      else if (seg?.kind === "node") pending.push(seg.node.value, seg.node.key);
    }
    return false;
  }


  private unloadScript(s: LoadedScript): void {
    for (const o of s.objects.values()) {
      this.memory.objects.delete(o.address);
      if (o.isClass && this.classes.get(o.species) === o) this.classes.delete(o.species);
    }
    this.memory.free(s.segment);
    this.memory.free(s.localsSegment);
    this.scripts.delete(s.number);
  }

  // --- Save/restore support ----------------------------------------------------

  get loadedScripts(): LoadedScript[] {
    return [...this.scripts.values()];
  }

  /** Throws away all scripts, objects and execution state (restart / before a restore). */
  resetMemory(): void {
    // Keep the stack array: a restore/restart kernel runs inside execute(), which holds it.
    const stack = this.memory.stack;
    stack.fill(0);
    this.memory = new Memory(stack);
    this.scripts.clear();
    this.classes.clear();
    this.disposed.clear();
    this.resetExecution();
  }

  /** Drops the call stack: nothing that was running will resume. */
  resetExecution(): void {
    this.frames = [];
    this.sp = 0;
    this.rest = 0;
    this.acc = NULL;
    this.prev = NULL;
  }

  /** Recreates scripts at their saved segment ids, then links them (see instantiateScript). */
  restoreScripts(entries: { number: number; segment: number; localsSegment: number }[]): LoadedScript[] {
    const loaded = entries.map((e) => {
      const s = this.instantiateScript(e.number, e);
      this.scripts.set(e.number, s);
      return s;
    });
    for (const s of loaded) this.resolveScript(s);
    return loaded;
  }

  localsSegment(s: LoadedScript): number {
    return s.localsSegment;
  }

  classObject(species: number): SciObject {
    let cls = this.classes.get(species);
    if (!cls) {
      const scriptNumber = this.classScripts[species];
      if (scriptNumber === undefined) throw new VmError(`Unknown class ${species}`);
      this.loadScript(scriptNumber);
      cls = this.classes.get(species);
      if (!cls) throw new VmError(`Class ${species} not found in script ${scriptNumber}`);
    }
    return cls;
  }

  /** Address of export `index` of `script` (objects: the object; procedures: a code ref). */
  exportAddress(scriptNumber: number, index: number): Value {
    const s = this.loadScript(scriptNumber);
    const e = s.script.exports[index];
    if (!e || e.kind === "empty") return NULL;
    return makeRef(s.segment, e.offset);
  }

  object(v: Value): SciObject {
    const obj = this.memory.object(v);
    if (!obj) throw new VmError(`Not an object: ${formatValue(v)}`);
    return obj;
  }

  selector(name: string): number {
    const id = this.selectorIds.get(name);
    if (id === undefined) throw new VmError(`Unknown selector ${name}`);
    return id;
  }

  /** Reads a property by selector name; undefined if the object doesn't have it. */
  getProp(obj: Value | SciObject, name: string): Value | undefined {
    const o = typeof obj === "number" ? this.object(obj) : obj;
    const slot = o.propIndex.get(this.selector(name));
    return slot === undefined ? undefined : o.vars[slot];
  }

  setProp(obj: Value | SciObject, name: string, value: Value): void {
    const o = typeof obj === "number" ? this.object(obj) : obj;
    const slot = o.propIndex.get(this.selector(name));
    if (slot !== undefined) this.writeVar(o, slot, value);
  }

  /**
   * Writes a property. SCI2's interpreter also marks the object "changed since drawn"
   * (bit 0x0008 of -info-) when the property is one that affects drawing (variable slots
   * 26-44: plane, x, y, z, scale..., priority, inset, view, loop, cel, bitmap), whoever
   * writes it: script, send or kernel. Updating the screen item clears it. Scripts rely on
   * it: Actor::doit only runs its scaler and UpdateScreenItem when the bit is set.
   * (ScummVM: Object::mustSetViewVisible, updateInfoFlagViewVisible.)
   */
  writeVar(obj: SciObject, slot: number, value: Value): void {
    obj.vars[slot] = value;
    if (slot >= VIEW_VAR_FIRST && slot <= VIEW_VAR_LAST) obj.vars[ObjectSlot.Info] = (obj.vars[ObjectSlot.Info]! | INFO_VIEW_CHANGED) & 0xffff;
  }

  private findMethod(obj: SciObject, selector: number, startClass?: number): { script: LoadedScript; offset: number } | undefined {
    if (startClass === undefined) {
      const own = obj.methods.get(selector);
      if (own !== undefined) return { script: obj.script, offset: own };
    }
    let species = startClass ?? obj.superclass;
    for (let guard = 0; guard < 64 && species !== 0xffff; guard++) {
      const cls = this.classObject(species);
      const m = cls.methods.get(selector);
      if (m !== undefined) return { script: cls.script, offset: m };
      if (cls.superclass === species) break;
      species = cls.superclass;
    }
    return undefined;
  }

  respondsTo(obj: SciObject, selector: number): boolean {
    return obj.propIndex.has(selector) || this.findMethod(obj, selector) !== undefined;
  }

  // --- Invocation ------------------------------------------------------------

  private push(v: Value) {
    this.memory.stack[this.sp++] = v;
  }

  /**
   * Starts a send of `selector` with `args` to `object` as a new top-level frame.
   * Used to boot the game (`theGame play`); `run()` then drives it.
   */
  start(object: Value, selectorName: string, args: Value[] = []): void {
    const base = this.sp;
    this.push(this.selector(selectorName));
    this.push(args.length);
    for (const a of args) this.push(a);
    const job: SendJob = {
      object: this.object(object),
      startClass: undefined,
      items: [{ selector: this.selector(selectorName), argc: args.length, base }],
      index: 0,
      spAfter: base,
    };
    // A dummy root frame owns the send so that returning from it ends execution.
    const root: Frame = { script: this.loadScript(0), pc: -1, self: undefined, paramBase: base, tempBase: base, restoreSp: base, send: job };
    this.frames.push(root);
    this.continueSend(root);
  }

  /**
   * Synchronously sends a message and runs until it returns: for kernels that call back
   * into scripts (e.g. ListEachElementDo). Returns the resulting acc.
   */
  invoke(object: Value, selector: number, args: Value[] = []): Value {
    const obj = this.object(object);
    const slot = obj.propIndex.get(selector);
    if (slot !== undefined) {
      if (args.length) this.writeVar(obj, slot, args[0]!);
      return obj.vars[slot]!;
    }
    const savedSp = this.sp;
    const savedAcc = this.acc;
    const depth = this.frames.length;
    const base = this.sp;
    this.push(selector);
    this.push(args.length);
    for (const a of args) this.push(a);
    const method = this.findMethod(obj, selector);
    if (!method) throw new VmError(`${obj.name} does not understand ${this.selectors[selector]}`);
    this.frames.push({ script: method.script, pc: method.offset, self: obj, paramBase: base + 1, tempBase: this.sp, restoreSp: base, stopOnReturn: true });
    this.execute(Infinity, depth);
    const result = this.acc;
    this.sp = savedSp;
    this.acc = savedAcc;
    return result;
  }

  get running(): boolean {
    return this.frames.length > 0;
  }

  /** Runs until the game yields (FrameOut), finishes, or `budget` instructions pass. */
  run(budget = 5_000_000): void {
    this.yieldRequested = false;
    this.execute(budget, 0);
  }

  /** Dispatches remaining selectors of `caller.send`; returns when a method frame is pushed or the send ends. */
  private continueSend(caller: Frame): void {
    const job = caller.send!;
    while (job.index < job.items.length) {
      const item = job.items[job.index++]!;
      const obj = job.object;
      const stack = this.memory.stack;
      const slot = job.startClass === undefined ? obj.propIndex.get(item.selector) : undefined;
      if (slot !== undefined) {
        if (item.argc === 0) this.acc = obj.vars[slot]!;
        else this.writeVar(obj, slot, stack[item.base + 2]!);
        continue;
      }
      const method = this.findMethod(obj, item.selector, job.startClass);
      if (!method) {
        throw new VmError(`${obj.name} does not understand ${this.selectors[item.selector] ?? item.selector}`);
      }
      this.onSend?.(obj, this.selectors[item.selector] ?? String(item.selector), item.argc);
      this.frames.push({
        script: method.script,
        pc: method.offset,
        self: obj,
        paramBase: item.base + 1,
        tempBase: this.sp,
        restoreSp: this.sp,
      });
      return;
    }
    this.sp = job.spAfter;
    caller.send = undefined;
    if (caller.pc === -1) this.frames.pop(); // root frame from start()
  }

  private beginSend(caller: Frame, object: SciObject, frameBytes: number, startClass?: number) {
    const stack = this.memory.stack;
    const words = frameBytes / 2 + this.rest;
    const base = this.sp - words;
    if (this.rest) stack[base + 1] = (stack[base + 1]! + this.rest) & 0xffff;
    this.rest = 0;
    const items: SendItem[] = [];
    for (let i = base; i < base + words; ) {
      const argc = stack[i + 1]!;
      items.push({ selector: stack[i]!, argc, base: i });
      i += 2 + argc;
    }
    caller.send = { object, startClass, items, index: 0, spAfter: base };
    this.continueSend(caller);
  }

  private callKernel(index: number, frameBytes: number) {
    const stack = this.memory.stack;
    const slot = this.sp - frameBytes / 2 - 1 - this.rest;
    const argc = (stack[slot]! + this.rest) & 0xffff;
    this.rest = 0;
    const args = stack.slice(slot + 1, slot + 1 + argc);
    this.sp = slot;
    const name = kernelNames[index] ?? `kernel${index}`;
    const fn = this.kernels[index];
    let result: Value = 0;
    if (fn) {
      const r = fn(this, args);
      if (typeof r === "object") {
        const top = this.frames[this.frames.length - 1]!;
        this.frames.push({ script: top.script, pc: -2, self: undefined, paramBase: slot, tempBase: this.sp, restoreSp: slot, native: r });
        this.onKernelCall?.(name, args, 0);
        return;
      }
      result = r ?? this.acc;
    } else {
      this.missingKernels.set(name, (this.missingKernels.get(name) ?? 0) + 1);
    }
    this.acc = result;
    this.onKernelCall?.(name, args, result);
  }

  private callLocal(script: LoadedScript, offset: number, frameBytes: number, self: SciObject | undefined) {
    const stack = this.memory.stack;
    const slot = this.sp - frameBytes / 2 - 1 - this.rest;
    if (this.rest) stack[slot] = (stack[slot]! + this.rest) & 0xffff;
    this.rest = 0;
    this.frames.push({ script, pc: offset, self, paramBase: slot, tempBase: this.sp, restoreSp: slot });
  }

  /** Resumes a native frame: performs its next send request, or finishes it. */
  private resumeNative(frame: Frame): void {
    const gen = frame.native!;
    let r = gen.next(this.acc);
    while (!r.done) {
      if ("frame" in r.value) {
        // Modal kernels (EditText) wait for input across frames: stop this run slice here
        // and continue the generator on the next one.
        this.yieldRequested = true;
        return;
      }
      const { object, selector, args } = r.value;
      const obj = this.memory.object(object);
      if (!obj) {
        r = gen.next(NULL);
        continue;
      }
      const slot = obj.propIndex.get(selector);
      if (slot !== undefined) {
        if (args.length) this.writeVar(obj, slot, args[0]!);
        r = gen.next(obj.vars[slot]!);
        continue;
      }
      const method = this.findMethod(obj, selector);
      if (!method) throw new VmError(`${obj.name} does not understand ${this.selectors[selector] ?? selector}`);
      const base = this.sp;
      this.push(selector);
      this.push(args.length);
      for (const a of args) this.push(a);
      this.frames.push({ script: method.script, pc: method.offset, self: obj, paramBase: base + 1, tempBase: this.sp, restoreSp: base });
      return;
    }
    this.frames.pop();
    this.sp = frame.restoreSp;
    this.acc = r.value ?? NULL;
  }

  // --- Variables ---------------------------------------------------------------

  private varArray(kind: number, f: Frame): { array: Value[]; base: number } {
    switch (kind) {
      case 0: return { array: this.scripts.get(0)!.locals, base: 0 };
      case 1: return { array: f.script.locals, base: 0 };
      case 2: return { array: this.memory.stack, base: f.tempBase };
      default: return { array: this.memory.stack, base: f.paramBase };
    }
  }

  // --- Interpreter loop --------------------------------------------------------

  /** Executes until frames drop to `stopDepth`, a yield (top level only), or the budget runs out. */
  private execute(budget: number, stopDepth: number): void {
    const stack = this.memory.stack;
    let f = this.frames[this.frames.length - 1]!;
    let code = f.script.code;
    let view = f.script.codeView;
    let pc = f.pc;
    let n = 0;

    const reload = () => {
      f = this.frames[this.frames.length - 1]!;
      code = f.script.code;
      view = f.script.codeView;
      pc = f.pc;
    };

    try {
    while (this.frames.length > stopDepth) {
      if (n++ >= budget || (stopDepth === 0 && this.yieldRequested)) break;
      if (f.native) {
        this.resumeNative(f);
        if (this.frames.length <= stopDepth) return;
        reload();
        continue;
      }
      const insAt = pc;
      const raw = code[pc++]!;
      const op = raw >> 1;
      const small = raw & 1;
      const word = () => {
        const v = small ? code[pc]! : view.getUint16(pc, true);
        pc += small ? 1 : 2;
        return v;
      };
      const sword = () => {
        const v = small ? view.getInt8(pc) : view.getInt16(pc, true);
        pc += small ? 1 : 2;
        return v;
      };
      const u16 = () => {
        const v = view.getUint16(pc, true);
        pc += 2;
        return v;
      };
      const pop = () => stack[--this.sp]!;

      try {
        if (op >= 0x40) {
          // Variable ops: [load|store|inc|dec] [acc|stack] [global|local|temp|param] [indexed]
          const kind = op & 3;
          const toStack = (op & 4) !== 0;
          const indexed = (op & 8) !== 0;
          const action = op >> 4; // 4 load, 5 store, 6 inc, 7 dec
          let index = word();
          if (indexed) index += toSigned(this.acc);
          const { array, base } = this.varArray(kind, f);
          const i = base + index;
          if (kind === 3 && index > stack[f.paramBase]! && action === 4) {
            // Reading a parameter the caller didn't pass: SCI gives 0.
            if (toStack) this.push(0);
            else this.acc = 0;
            continue;
          }
          switch (action) {
            case 4:
              if (toStack) this.push(array[i] ?? 0);
              else this.acc = array[i] ?? 0;
              break;
            case 5:
              if (indexed && !toStack) {
                this.acc = pop();
                array[i] = this.acc;
              } else array[i] = toStack ? pop() : this.acc;
              break;
            case 6:
            case 7: {
              const v = ((array[i] ?? 0) + (action === 6 ? 1 : -1)) & 0xffff;
              array[i] = v;
              if (toStack) this.push(v);
              else this.acc = v;
              break;
            }
          }
          continue;
        }

        switch (op) {
          case Op.bnot: this.acc ^= 0xffff; break;
          case Op.add: this.acc = arith(pop(), this.acc, (a, b) => a + b); break;
          case Op.sub: this.acc = arith(pop(), this.acc, (a, b) => a - b); break;
          case Op.mul: this.acc = (toSigned(pop()) * toSigned(this.acc)) & 0xffff; break;
          case Op.div: {
            const a = toSigned(pop()), b = toSigned(this.acc);
            this.acc = b === 0 ? 0 : Math.trunc(a / b) & 0xffff;
            break;
          }
          case Op.mod: {
            const a = toSigned(pop()), b = Math.abs(toSigned(this.acc));
            let r = b === 0 ? 0 : a % b;
            if (r < 0) r += b;
            this.acc = r & 0xffff;
            break;
          }
          case Op.shr: this.acc = (pop() & 0xffff) >>> (this.acc & 0xf); break;
          case Op.shl: this.acc = ((pop() & 0xffff) << (this.acc & 0xf)) & 0xffff; break;
          case Op.xor: this.acc = (pop() ^ this.acc) & 0xffff; break;
          case Op.and: this.acc = pop() & this.acc & 0xffff; break;
          case Op.or: this.acc = (pop() | this.acc) & 0xffff; break;
          case Op.neg: this.acc = -toSigned(this.acc) & 0xffff; break;
          case Op.not: this.acc = bool(this.acc === 0); break;
          case Op.eq: this.prev = this.acc; this.acc = bool(pop() === this.prev); break;
          case Op.ne: this.prev = this.acc; this.acc = bool(pop() !== this.prev); break;
          case Op.gt: this.prev = this.acc; this.acc = bool(compare(pop(), this.prev, true) > 0); break;
          case Op.ge: this.prev = this.acc; this.acc = bool(compare(pop(), this.prev, true) >= 0); break;
          case Op.lt: this.prev = this.acc; this.acc = bool(compare(pop(), this.prev, true) < 0); break;
          case Op.le: this.prev = this.acc; this.acc = bool(compare(pop(), this.prev, true) <= 0); break;
          case Op.ugt: this.prev = this.acc; this.acc = bool(compare(pop(), this.prev, false) > 0); break;
          case Op.uge: this.prev = this.acc; this.acc = bool(compare(pop(), this.prev, false) >= 0); break;
          case Op.ult: this.prev = this.acc; this.acc = bool(compare(pop(), this.prev, false) < 0); break;
          case Op.ule: this.prev = this.acc; this.acc = bool(compare(pop(), this.prev, false) <= 0); break;
          case Op.bt: { const d = sword(); if (this.acc !== 0) pc += d; break; }
          case Op.bnt: { const d = sword(); if (this.acc === 0) pc += d; break; }
          case Op.jmp: { const d = sword(); pc += d; break; }
          case Op.ldi: this.acc = sword() & 0xffff; break;
          case Op.push: this.push(this.acc); break;
          case Op.pushi: this.push(sword() & 0xffff); break;
          case Op.toss: this.sp--; break;
          case Op.dup: this.push(stack[this.sp - 1]!); break;
          case Op.link: { const count = word(); for (let i = 0; i < count; i++) this.push(0); break; }

          case Op.call: {
            const d = sword();
            const frame = u16();
            f.pc = pc;
            this.callLocal(f.script, pc + d, frame, f.self);
            reload();
            break;
          }
          case Op.callk: {
            const k = word();
            const frame = u16();
            f.pc = pc;
            this.callKernel(k, frame);
            if (this.frames[this.frames.length - 1] !== f) reload(); // kernel could have changed frames
            break;
          }
          case Op.callb:
          case Op.calle: {
            const scriptNumber = op === Op.callb ? 0 : word();
            const index = word();
            const frame = u16();
            f.pc = pc;
            const target = this.loadScript(scriptNumber);
            const e = target.script.exports[index];
            if (!e || e.kind !== "code") throw new VmError(`script ${scriptNumber} export ${index} is not code`);
            this.callLocal(target, e.offset, frame, f.self);
            reload();
            break;
          }
          case Op.ret: {
            const done = this.frames.pop()!;
            if (this.disposed.size) this.unloadDisposed();
            if (done.stopOnReturn) {
              this.sp = done.restoreSp;
              if (this.frames.length <= stopDepth) return;
              reload();
              break;
            }
            const caller = this.frames[this.frames.length - 1];
            if (!caller) return;
            if (caller.send) this.continueSend(caller);
            else this.sp = done.restoreSp;
            if (this.frames.length <= stopDepth) return;
            reload();
            break;
          }
          case Op.send: {
            const frame = word();
            f.pc = pc;
            this.beginSend(f, this.object(this.acc), frame);
            reload();
            break;
          }
          case Op.class_: this.acc = this.classObject(word()).address; break;
          case Op.self_: {
            const frame = word();
            f.pc = pc;
            this.beginSend(f, f.self!, frame);
            reload();
            break;
          }
          case Op.super_: {
            const cls = word();
            const frame = u16();
            f.pc = pc;
            this.beginSend(f, f.self!, frame, cls);
            reload();
            break;
          }
          case Op.rest: {
            const from = word();
            const argc = stack[f.paramBase]!;
            this.rest = Math.max(argc - from + 1, 0);
            for (let i = from; i <= argc; i++) this.push(stack[f.paramBase + i]!);
            break;
          }
          case Op.lea: {
            const type = word() >> 1;
            let index = word();
            if (type & 0x08) index += toSigned(this.acc);
            const kind = type & 3;
            if (kind === 0) this.acc = makeRef(this.localsSegment(this.scripts.get(0)!), index * 2);
            else if (kind === 1) this.acc = makeRef(this.localsSegment(f.script), index * 2);
            else this.acc = makeRef(this.memory.stackSegment, ((kind === 2 ? f.tempBase : f.paramBase) + index) * 2);
            break;
          }
          case Op.selfID: this.acc = f.self?.address ?? NULL; break;
          case Op.pprev: this.push(this.prev); break;
          case Op.pToa: this.acc = f.self!.vars[word() >> 1]!; break;
          case Op.aTop: this.writeVar(f.self!, word() >> 1, this.acc); break;
          case Op.pTos: this.push(f.self!.vars[word() >> 1]!); break;
          case Op.sTop: this.writeVar(f.self!, word() >> 1, pop()); break;
          case Op.ipToa: case Op.dpToa: case Op.ipTos: case Op.dpTos: {
            const i = word() >> 1;
            const v = (f.self!.vars[i]! + (op === Op.ipToa || op === Op.ipTos ? 1 : -1)) & 0xffff;
            this.writeVar(f.self!, i, v);
            if (op === Op.ipTos || op === Op.dpTos) this.push(v);
            else this.acc = v;
            break;
          }
          case Op.lofsa: this.acc = makeRef(f.script.segment, word()); break;
          case Op.lofss: this.push(makeRef(f.script.segment, word())); break;
          case Op.push0: this.push(0); break;
          case Op.push1: this.push(1); break;
          case Op.push2: this.push(2); break;
          case Op.pushSelf: this.push(f.self?.address ?? NULL); break;
          default:
            throw new VmError(`Invalid opcode 0x${raw.toString(16)}`);
        }
      } catch (e) {
        if (e instanceof VmError && !e.message.includes(" @ ")) {
          e.message += ` @ script ${f.script.number} pc ${insAt.toString(16)} in ${f.self?.name ?? "procedure"}`;
        }
        throw e;
      }
    }
    if (this.frames.length) this.frames[this.frames.length - 1]!.pc = pc;
    } finally {
      this.instructions += n;
    }
  }

  /** Human-readable call stack, for errors and debugging. */
  backtrace(): string[] {
    return this.frames.filter((f) => f.pc >= 0).map((f) => `script ${f.script.number} pc ${f.pc.toString(16)} self ${f.self?.name ?? "-"}`).reverse();
  }

  isScriptLoaded(n: number): boolean {
    return this.scripts.has(n);
  }
}

/** Arithmetic on numbers, or pointer ± number / pointer − pointer within one segment. */
function arith(a: Value, b: Value, fn: (x: number, y: number) => number): Value {
  if (isNumber(a) && isNumber(b)) return fn(a, b) & 0xffff;
  if (!isNumber(a) && isNumber(b)) return makeRef(segmentOf(a), fn(offsetOf(a), toSigned(b)));
  if (isNumber(a) && !isNumber(b)) return makeRef(segmentOf(b), fn(toSigned(a), offsetOf(b)));
  if (segmentOf(a) === segmentOf(b)) return fn(offsetOf(a), offsetOf(b)) & 0xffff;
  return fn(a, b) & 0xffff;
}

function compare(a: Value, b: Value, signed: boolean): number {
  if (isNumber(a) && isNumber(b)) return signed ? toSigned(a) - toSigned(b) : a - b;
  if (segmentOf(a) === segmentOf(b)) return offsetOf(a) - offsetOf(b);
  return a - b;
}
