import { opcodes, varKind } from "./opcodes.ts";
import { readString, type Script, type ScriptObject } from "./script.ts";

export interface Instruction {
  offset: number;
  length: number;
  opcode: number;
  name: string;
  operands: number[];
  /** Absolute target for jumps and local calls. */
  target?: number;
}

/** Decodes one instruction at `offset` in the script's code. */
export function decodeInstruction(code: Uint8Array, offset: number): Instruction {
  const v = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const raw = code[offset]!;
  const opcode = raw >> 1;
  const small = (raw & 1) === 1;
  const info = opcodes[opcode]!;

  let pos = offset + 1;
  const operands: number[] = [];
  for (const kind of info.operands) {
    if (kind === "B") {
      operands.push(code[pos++]!);
    } else if (kind === "U") {
      operands.push(v.getUint16(pos, true));
      pos += 2;
    } else if (small) {
      operands.push(kind === "W" ? code[pos]! : v.getInt8(pos));
      pos += 1;
    } else {
      operands.push(kind === "W" ? v.getUint16(pos, true) : v.getInt16(pos, true));
      pos += 2;
    }
  }

  const ins: Instruction = { offset, length: pos - offset, opcode, name: info.name, operands };
  if (info.operands[0] === "R") ins.target = pos + operands[0]!;
  return ins;
}

const RET = 0x24;
const JMP = 0x19;
const CALL = 0x20;

/**
 * Traces reachable code from `entry`, following both sides of branches, until every path
 * hits `ret`. Local `call` targets are collected, not followed: they're separate functions.
 */
export function traceFunction(code: Uint8Array, entry: number): { instructions: Instruction[]; calls: number[] } {
  const seen = new Map<number, Instruction>();
  const calls = new Set<number>();
  const work = [entry];

  while (work.length) {
    let pc = work.pop()!;
    while (!seen.has(pc) && pc >= 0 && pc < code.length) {
      const ins = decodeInstruction(code, pc);
      seen.set(pc, ins);
      if (ins.opcode === CALL) calls.add(ins.target!);
      else if (ins.target !== undefined) work.push(ins.target);
      if (ins.opcode === RET || ins.opcode === JMP) break;
      pc += ins.length;
    }
  }
  return { instructions: [...seen.values()].sort((a, b) => a.offset - b.offset), calls: [...calls] };
}

/** Names the disassembler can't know from one script alone. */
export interface DisasmContext {
  selectorNames: readonly string[];
  kernelNames: readonly string[];
  /** Class number → class name. */
  className(species: number): string | undefined;
  /** Property selectors for an object (its own if a class, else its class's). */
  propSelectors(obj: ScriptObject): readonly number[] | undefined;
}

export interface DisasmFunction {
  label: string;
  entry: number;
  owner?: ScriptObject;
  instructions: Instruction[];
  /** Per-instruction comment, keyed by offset. */
  comments: Map<number, string>;
  /** What the linear stack simulation could tell about each send, call and comparison. */
  facts: FunctionFacts;
}

/** A value as far as one linear pass can tell: a constant, an object/string, a variable. */
export interface ValueFact {
  const?: number;
  /** Heap offset of an object or string in this script (lofsa/lofss). */
  heap?: number;
  global?: number;
  /** Property of the method's own object, by selector. */
  prop?: number;
  self?: true;
}

export interface SendFact {
  offset: number;
  /** `send` goes to whatever acc holds; `self`/`super` to the method's object. */
  receiver: ValueFact;
  selector: number;
  args: ValueFact[];
}

export interface CallFact {
  offset: number;
  kind: "kernel" | "export";
  /** Kernel number, or the script number for an export call. */
  target: number;
  /** Export index for export calls. */
  index?: number;
  args: ValueFact[];
}

/** `global <op> constant`, e.g. switch cases over the previous room number. */
export interface CompareFact {
  offset: number;
  global: number;
  op: string;
  value: number;
}

export interface FunctionFacts {
  sends: SendFact[];
  calls: CallFact[];
  compares: CompareFact[];
}

const hex = (n: number, w = 4) => n.toString(16).padStart(w, "0");

/** Disassembles every method and exported/called procedure in a script. */
export function disassemble(script: Script, ctx: DisasmContext): DisasmFunction[] {
  const functions = new Map<number, DisasmFunction>();
  const pending: { entry: number; label: string; owner?: ScriptObject }[] = [];

  for (const obj of script.objects) {
    for (const m of obj.methods) {
      pending.push({ entry: m.offset, label: `${obj.name}::${ctx.selectorNames[m.selector] ?? `sel_${m.selector}`}`, owner: obj });
    }
  }
  for (const e of script.exports) {
    if (e.kind === "code") pending.push({ entry: e.offset, label: `export${e.index}` });
  }

  while (pending.length) {
    const { entry, label, owner } = pending.shift()!;
    if (functions.has(entry)) continue;
    const { instructions, calls } = traceFunction(script.code, entry);
    const fn: DisasmFunction = { label, entry, owner, instructions, comments: new Map(), facts: { sends: [], calls: [], compares: [] } };
    functions.set(entry, fn);
    // Local procedures inherit the caller's object context for property names.
    for (const c of calls) if (!functions.has(c)) pending.push({ entry: c, label: `proc_${hex(c)}`, owner });
  }

  const labels = new Map([...functions.values()].map((f) => [f.entry, f.label]));
  for (const fn of functions.values()) annotate(fn, script, ctx, labels);
  return [...functions.values()].sort((a, b) => a.entry - b.entry);
}

/** Globals whose meaning is fixed by SCI's system scripts. */
const wellKnownGlobals: Record<number, string> = { 0: "ego", 1: "theGame" };

/** What produced a value on the stack, as far as a single linear pass can tell. */
type StackEntry = ValueFact & { offset: number };

const COMPARISONS = new Set(["eq?", "ne?", "gt?", "ge?", "lt?", "le?", "ugt?", "uge?", "ult?", "ule?"]);
const valueOf = ({ offset: _, ...v }: StackEntry): ValueFact => v;

function annotate(fn: DisasmFunction, script: Script, ctx: DisasmContext, labels: Map<number, string>) {
  const { comments } = fn;
  const sel = (n: number) => ctx.selectorNames[n] ?? `sel_${n}`;
  const props = fn.owner && ctx.propSelectors(fn.owner);
  const heapLabel = (o: number) => {
    const obj = script.objects.find((x) => x.offset === o);
    if (obj) return obj.name;
    const s = readString(script.heap, o);
    return s ? JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}...` : s) : undefined;
  };

  const { facts } = fn;
  let stack: StackEntry[] = [];
  let acc: ValueFact = {};
  const push = (ins: Instruction, value?: number, v: ValueFact = {}) => stack.push({ ...v, ...(value === undefined ? {} : { const: value }), offset: ins.offset });
  const pop = (n: number) => stack.splice(Math.max(0, stack.length - n), n);
  /** Arguments of a call frame: [argc, ...args]. */
  const callArgs = (frame: StackEntry[]) => frame.slice(1).map(valueOf);

  /** Splits a send frame into `selector(args)` messages; skips it if the frame doesn't parse. */
  const describeSend = (frame: StackEntry[], receiver: ValueFact, offset: number): string | undefined => {
    const parts: string[] = [];
    const sends: SendFact[] = [];
    for (let i = 0; i < frame.length; ) {
      const s = frame[i]?.const;
      const argc = frame[i + 1]?.const;
      if (s === undefined || argc === undefined || i + 2 + argc > frame.length) return undefined;
      comments.set(frame[i]!.offset, sel(s));
      parts.push(`${sel(s)}${argc ? `(${argc} arg${argc > 1 ? "s" : ""})` : ""}`);
      sends.push({ offset, receiver, selector: s, args: frame.slice(i + 2, i + 2 + argc).map(valueOf) });
      i += 2 + argc;
    }
    facts.sends.push(...sends);
    return parts.join(", ");
  };

  for (const ins of fn.instructions) {
    const [a = 0, b = 0] = ins.operands;
    const o = ins.opcode;

    if (labels.has(ins.offset) && ins.offset !== fn.entry) {
      // A jump target: several paths meet here, so forget acc. Compiled code keeps the stack
      // balanced across branches (switch statements keep their subject on it), so keep that.
      acc = {};
    }
    const propSel = (offset: number) => props?.[offset / 2];
    let nextAcc: ValueFact = {};

    switch (ins.name) {
      case "push": push(ins, undefined, acc); break;
      case "dup": { const top = stack.at(-1); push(ins, undefined, top ? valueOf(top) : {}); break; }
      case "pushSelf": push(ins, undefined, { self: true }); break;
      case "pTos": { const s = propSel(a); push(ins, undefined, s === undefined ? {} : { prop: s }); break; }
      case "ipTos": case "dpTos": push(ins); break;
      case "pushi": push(ins, a); break;
      case "push0": push(ins, 0); break;
      case "push1": push(ins, 1); break;
      case "push2": push(ins, 2); break;
      case "lofss": push(ins, undefined, { heap: a }); break;
      case "toss": pop(1); break;
      case "&rest": stack = []; break; // pushes an unknown number of values
      case "ldi": nextAcc = { const: a }; break;
      case "lofsa": nextAcc = { heap: a }; break;
      case "selfID": nextAcc = { self: true }; break;
      case "pToa": { const s = propSel(a); if (s !== undefined) nextAcc = { prop: s }; break; }
      case "call": pop(ins.operands.at(-1)! / 2 + 1); break;
      case "callk": case "callb": case "calle": {
        const frame = pop(ins.operands.at(-1)! / 2 + 1);
        const call: CallFact = ins.name === "callk"
          ? { offset: ins.offset, kind: "kernel", target: a, args: callArgs(frame) }
          : ins.name === "callb"
            ? { offset: ins.offset, kind: "export", target: 0, index: a, args: callArgs(frame) }
            : { offset: ins.offset, kind: "export", target: a, index: b, args: callArgs(frame) };
        facts.calls.push(call);
        break;
      }
      case "send": case "self": case "super": {
        const frame = pop(ins.operands.at(-1)! / 2);
        const receiver: ValueFact = ins.name === "send" ? acc : { self: true };
        const msg = describeSend(frame, receiver, ins.offset);
        const who = ins.name === "super" ? `super ${ctx.className(a) ?? a}` : ins.name === "self" ? "self" : "acc";
        if (msg) comments.set(ins.offset, `${who}: ${msg}`);
        break;
      }
      default:
        if ((o >= 0x01 && o <= 0x0a) || (o >= 0x0d && o <= 0x16)) {
          // Binary ops: stack top <op> acc.
          const [left] = pop(1);
          if (COMPARISONS.has(ins.name) && left?.global !== undefined && acc.const !== undefined) {
            facts.compares.push({ offset: ins.offset, global: left.global, op: ins.name, value: acc.const });
          }
        } else if (o === 0x17 || o === 0x18) { /* branches read acc */ nextAcc = acc; }
        else if (o >= 0x40) {
          const action = o >> 4; // 4 load, 5 store, 6 inc, 7 dec
          const toStack = (o & 4) !== 0;
          const indexed = (o & 8) !== 0;
          const v: ValueFact = varKind(o) === "global" && !indexed ? { global: a } : {};
          if (action === 5 && toStack) pop(1);
          else if (action !== 5 && toStack) push(ins, undefined, action === 4 ? v : {});
          else if (action === 4) nextAcc = v;
        }
    }
    acc = nextAcc;

    // Operand names
    switch (ins.name) {
      case "callk": comments.set(ins.offset, `${ctx.kernelNames[a] ?? `kernel_${a}`}`); break;
      case "call": comments.set(ins.offset, labels.get(ins.target!) ?? `proc_${hex(ins.target!)}`); break;
      case "callb": comments.set(ins.offset, `script 0 export ${a}`); break;
      case "calle": comments.set(ins.offset, `script ${a} export ${b}`); break;
      case "class": comments.set(ins.offset, ctx.className(a) ?? `class ${a}`); break;
      case "lofsa": case "lofss": { const l = heapLabel(a); if (l) comments.set(ins.offset, l); break; }
      case "pToa": case "aTop": case "pTos": case "sTop": case "ipToa": case "dpToa": case "ipTos": case "dpTos": {
        const s = props?.[a / 2];
        if (s !== undefined) comments.set(ins.offset, sel(s));
        break;
      }
    }
    if (o >= 0x40) {
      const kind = varKind(o)!;
      const name = kind === "global" && wellKnownGlobals[a] ? wellKnownGlobals[a] : `${kind}${a}`;
      if (!comments.has(ins.offset)) comments.set(ins.offset, name);
    }
  }
}

/** Plain-text listing, one function per block. */
export function formatDisassembly(script: Script, functions: DisasmFunction[]): string {
  const out: string[] = [`; script ${script.number}`];
  for (const obj of script.objects) {
    out.push(`; ${obj.isClass ? "class" : "instance"} ${obj.name} @heap ${hex(obj.offset)} (species ${obj.isClass ? obj.species : "-"}, super ${obj.superclass})`);
  }
  for (const e of script.exports) out.push(`; export ${e.index}: ${e.kind} @${hex(e.offset)}`);

  for (const fn of functions) {
    const targets = new Set(fn.instructions.filter((i) => i.target !== undefined && i.name !== "call").map((i) => i.target!));
    out.push("", `(${fn.label})`);
    for (const ins of fn.instructions) {
      if (targets.has(ins.offset)) out.push(`  code_${hex(ins.offset)}:`);
      const bytes = [...script.code.subarray(ins.offset, ins.offset + ins.length)].map((b) => hex(b, 2)).join(" ");
      const args = ins.target !== undefined
        ? [ins.name === "call" ? `proc_${hex(ins.target)}` : `code_${hex(ins.target)}`, ...ins.operands.slice(1)]
        : ins.operands.map((n) => (n > 9 ? `$${hex(n)}` : String(n)));
      const comment = fn.comments.get(ins.offset);
      out.push(`    ${hex(ins.offset)}: ${bytes.padEnd(18)} ${ins.name.padEnd(8)} ${args.join(" ").padEnd(16)}${comment ? `; ${comment}` : ""}`.trimEnd());
    }
  }
  return out.join("\n");
}
