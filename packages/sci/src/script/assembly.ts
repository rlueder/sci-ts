import { decodeInstruction, disassemble, type DisasmContext, type Instruction } from "./disasm.ts";
import { opcodes, type OperandKind } from "./opcodes.ts";
import { ObjectSlot, readString, type Script, type ScriptObject } from "./script.ts";

/**
 * SCI2 assembly: a text form of a script + heap pair that assembles back to the same
 * bytes, and that you can write by hand.
 *
 *   script 710
 *   locals 0 0 5                       ; initial values (@label for heap addresses)
 *   exports
 *     rm710                            ; an object, a code label, or 0 (unused)
 *   instance rm710 of Room             ; or: class Name of Super species 166
 *     classScript 0                    ; header slots that aren't computed
 *     info 0
 *     name @s_0b2c
 *     picture 710                      ; properties by name (or #slot)
 *     method init rm710::init
 *   strings
 *     s_0b2c "rm710"
 *   code
 *   rm710::init:                       ; code owned by rm710 (self)
 *     lsg 201
 *     bnt .L015c                       ; minimal form unless .b / .w says otherwise
 *     pushi #init                      ; #selector, @heap label, class Name, callk Name
 *     pToa register                    ; properties of self by name
 *   proc_0abc:
 *     owner sExit                      ; procedures say whose properties they use
 *
 * Layout rules, measured on all 285 scripts of an SCI2 game (and required to hold for byte-exact
 * round trips):
 *   script  header (reloc offset, 0, 0, export count) | exports | per object in heap order:
 *           class propDict, then methDict | code (no gaps) | code relocation table
 *   heap    header (reloc offset, local count) | locals | objects | 0 | strings | heap relocs
 *   Code relocations are object exports and every lofsa/lofss operand (always 16-bit);
 *   heap relocations are object slots holding heap addresses (names, string properties).
 *
 * Operand forms: the compiler didn't always pick the smallest encoding (forward jumps and
 * selector pushes are split), so round trips mark the exceptions with `.w` / `.b`. By
 * default the assembler picks the smallest form, except send/self (almost always 16-bit
 * in the original scripts) and lofsa/lofss (relocated, so always 16-bit).
 */

export interface AsmContext extends DisasmContext {
  /** Class name → class number, for `of Name`, `class Name` and `super Name`. */
  classSpecies(name: string): number | undefined;
  /** Property selectors of a class by number (for instances of classes in other scripts). */
  classPropSelectors(species: number): readonly number[] | undefined;
  /** A class's default property values, all slots (instances start from these). */
  classDefaults(species: number): readonly number[] | undefined;
  /**
   * A selector the context doesn't know yet: a game built from nothing numbers its selectors
   * as its scripts use them. Without it, unknown selectors are errors.
   */
  newSelector?(name: string): number;
}

export class AsmError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line ? `line ${line}: ${message}` : message);
  }
}

const hex = (n: number, w = 4) => n.toString(16).padStart(w, "0");
const RELATIVE = (k: OperandKind) => k === "R";
const SIZED = (k: OperandKind) => k === "W" || k === "S" || k === "R";
/** Opcodes whose default form is 16-bit. */
const WORD_DEFAULT = new Set(["send", "self", "lofsa", "lofss"]);
const HEAP_OPERAND = new Set(["lofsa", "lofss"]);
const HEADER_SLOTS = ObjectSlot.Name + 1;
/** Instructions whose operand is a property of self, as a byte offset. */
const PROPERTY_OPS = new Set(["pToa", "aTop", "pTos", "sTop", "ipToa", "dpToa", "ipTos", "dpTos"]);

/**
 * The name for a property byte offset in a layout, if it maps back unambiguously (so the
 * assembler reproduces the same offset). Names never look like numbers or labels.
 */
function propertyName(layout: readonly number[] | undefined, offset: number, sel: (n: number) => string): string | undefined {
  if (!layout || offset % 2 || offset / 2 >= layout.length) return undefined;
  const selector = layout[offset / 2]!;
  if (layout.indexOf(selector) !== layout.lastIndexOf(selector)) return undefined;
  const name = sel(selector);
  return /^[A-Za-z_-][\w-]*$/.test(name) && !name.startsWith("sel_") ? name : undefined;
}

/** Would these operand values fit the byte form? */
function fitsSmall(kinds: readonly OperandKind[], values: readonly number[]): boolean {
  return kinds.every((k, i) => {
    const v = values[i]!;
    if (k === "W") return v >= 0 && v <= 0xff;
    if (k === "S" || k === "R") return v >= -128 && v <= 127;
    return true;
  });
}

// --- Script → text ----------------------------------------------------------------------

export function toAssembly(script: Script, ctx: AsmContext): string {
  const { code, heap } = script;
  const cw = (o: number) => code[o]! | (code[o + 1]! << 8);
  const hw = (o: number) => heap[o]! | (heap[o + 1]! << 8);
  const sel = (n: number) => ctx.selectorNames[n] ?? `sel_${n}`;
  const out: string[] = [`script ${script.number}`];

  // Heap labels: objects by name, strings by offset.
  const heapReloc = hw(0);
  const heapRelocs = new Set(Array.from({ length: hw(heapReloc) }, (_, i) => hw(heapReloc + 2 + i * 2)));
  const codeReloc = cw(0);
  const codeRelocs = new Set(Array.from({ length: cw(codeReloc) }, (_, i) => cw(codeReloc + 2 + i * 2)));
  const objectsEnd = script.objects.length ? script.objects.at(-1)!.offset + script.objects.at(-1)!.properties.length * 2 : 4 + script.locals.length * 2;
  const strings: { offset: number; bytes: Uint8Array }[] = [];
  for (let p = objectsEnd + 2; p < heapReloc; ) {
    let e = p;
    while (e < heapReloc && heap[e] !== 0) e++;
    strings.push({ offset: p, bytes: heap.subarray(p, e) });
    p = e + 1;
  }
  const objectLabels = uniqueObjectLabels(script.objects);
  const heapLabel = (offset: number): string => {
    const o = script.objects.findIndex((x) => x.offset === offset);
    if (o >= 0) return `@${objectLabels[o]}`;
    const s = strings.find((x) => x.offset === offset);
    if (s) return `@s_${hex(offset)}`;
    // Inside something: the nearest label before it, plus an offset.
    const before = [...script.objects.map((x, i) => ({ at: x.offset, label: objectLabels[i]! })), ...strings.map((x) => ({ at: x.offset, label: `s_${hex(x.offset)}` }))]
      .filter((x) => x.at <= offset).sort((a, b) => b.at - a.at)[0];
    if (before) return `@${before.label}+${offset - before.at}`;
    return `@${offset}`;
  };

  // Code labels: functions from the disassembler, jump targets from a linear sweep.
  const fns = disassemble(script, ctx);
  const labels = new Map<number, string>();
  for (const f of fns) labels.set(f.entry, f.label);
  let dictEnd = 8 + script.exports.length * 2;
  for (const o of script.objects) {
    if (o.isClass) dictEnd = o.properties[ObjectSlot.PropDict]! + o.properties.length * 2;
    const md = o.properties[ObjectSlot.MethDict]!;
    dictEnd = md + 2 + cw(md) * 4;
  }
  const sweep: Instruction[] = [];
  for (let pc = dictEnd; pc < codeReloc; ) {
    const ins = decodeInstruction(code, pc);
    sweep.push(ins);
    pc += ins.length;
  }
  for (const ins of sweep) if (ins.target !== undefined && !labels.has(ins.target)) labels.set(ins.target, ins.name === "call" ? `proc_${hex(ins.target)}` : `.L${hex(ins.target)}`);
  const codeLabel = (offset: number) => labels.get(offset) ?? `${offset}`;

  // Locals
  if (script.locals.length) out.push(`locals ${script.locals.map((v) => (v > 9 ? `$${hex(v)}` : `${v}`)).join(" ")}`);

  // Exports
  out.push("exports");
  for (const e of script.exports) {
    if (e.kind === "empty") out.push("  0");
    else if (e.kind === "object") out.push(`  ${heapLabel(e.offset)}`);
    else out.push(`  ${codeLabel(e.offset)}`);
  }

  // Objects
  for (const [i, o] of script.objects.entries()) {
    const label = objectLabels[i]!;
    const species = o.isClass ? o.species : o.superclass;
    const superName = (n: number) => (n === 0xffff ? "-" : ctx.className(n) ?? `$${hex(n)}`);
    const propSels = o.isClass ? o.propSelectors! : ctx.classPropSelectors(o.superclass);
    out.push("");
    out.push(o.isClass ? `class ${label} of ${superName(o.superclass)} species ${species}` : `instance ${label} of ${superName(o.superclass)}`);
    const slotValue = (slot: number) => {
      const at = o.offset + slot * 2;
      const v = o.properties[slot]!;
      return heapRelocs.has(at) ? heapLabel(v) : v > 9 ? `$${hex(v)}` : `${v}`;
    };
    out.push(`  classScript ${slotValue(ObjectSlot.ClassScript)}`);
    out.push(`  info ${slotValue(ObjectSlot.Info)}`);
    out.push(`  name ${slotValue(ObjectSlot.Name)}`);
    if (o.isClass) {
      // A class declares its own layout: each property with its selector.
      const headerSels = o.propSelectors!.slice(0, HEADER_SLOTS);
      out.push(`  header ${headerSels.map(sel).join(" ")}`);
      for (let slot = HEADER_SLOTS; slot < o.properties.length; slot++) out.push(`  prop ${sel(o.propSelectors![slot]!)} ${slotValue(slot)}`);
    } else {
      for (let slot = HEADER_SLOTS; slot < o.properties.length; slot++) {
        const s = propSels?.[slot];
        out.push(`  ${s === undefined ? `#${slot}` : sel(s)} ${slotValue(slot)}`);
      }
    }
    for (const m of o.methods) out.push(`  method ${sel(m.selector)} ${codeLabel(m.offset)}`);
  }

  // Strings
  out.push("", "strings");
  for (const s of strings) out.push(`  s_${hex(s.offset)} ${quote(s.bytes)}`);

  // Code
  out.push("", "code");
  const selectorPushes = new Set<number>();
  for (const f of fns) for (const ins of f.instructions) if (ins.name === "pushi" && f.comments.get(ins.offset) === sel(ins.operands[0]!)) selectorPushes.add(ins.offset);
  // Property operands are named against the layout of the code's owner (self). The owner
  // follows the rule the assembler uses: a label `Obj::method` sets it, an `owner Obj` line
  // sets it (emitted for procedures, whose labels don't say), `.L` labels keep it, and any
  // other label clears it.
  const fnAt = new Map(fns.map((f) => [f.entry, f] as const));
  const labelOf = new Map(script.objects.map((o, i) => [o, objectLabels[i]!] as const));
  const layoutOf = (o: ScriptObject) => (o.isClass ? o.propSelectors : ctx.classPropSelectors(o.superclass));
  let owner: ScriptObject | undefined;
  for (const ins of sweep) {
    const label = labels.get(ins.offset);
    if (label) {
      out.push(label.startsWith(".") ? `${label}:` : `\n${label}:`);
      if (!label.startsWith(".")) {
        const fnOwner = fnAt.get(ins.offset)?.owner;
        const prefix = label.includes("::") ? label.slice(0, label.lastIndexOf("::")) : undefined;
        const byLabel = prefix === undefined ? undefined : script.objects.find((o) => labelOf.get(o) === prefix);
        owner = byLabel;
        if (fnOwner && fnOwner !== byLabel) {
          out.push(`    owner ${labelOf.get(fnOwner)}`);
          owner = fnOwner;
        }
      }
    }
    const info = opcodes[ins.opcode]!;
    const small = (code[ins.offset]! & 1) === 1;
    const hasSized = info.operands.some(SIZED);
    let suffix = "";
    if (hasSized) {
      const defaultSmall = WORD_DEFAULT.has(ins.name) ? false : fitsSmall(info.operands, ins.operands);
      if (small !== defaultSmall) suffix = small ? ".b" : ".w";
    } else if (small) suffix = ".b"; // the size bit on an opcode without sized operands
    const args = info.operands.map((k, i) => {
      const v = ins.operands[i]!;
      if (RELATIVE(k)) return codeLabel(ins.target!);
      if (i === 0 && HEAP_OPERAND.has(ins.name)) return codeRelocs.has(ins.offset + 1) ? heapLabel(v) : `${v}`;
      if (i === 0 && ins.name === "pushi" && selectorPushes.has(ins.offset)) return `#${sel(v)}`;
      if (i === 0 && ins.name === "callk") {
        const name = ctx.kernelNames[v];
        return name && ctx.kernelNames.indexOf(name) === ctx.kernelNames.lastIndexOf(name) ? name : `${v}`;
      }
      if (i === 0 && (ins.name === "class" || ins.name === "super")) return ctx.className(v) ?? `$${hex(v)}`;
      if (i === 0 && PROPERTY_OPS.has(ins.name) && owner) {
        const name = propertyName(layoutOf(owner), v, sel);
        if (name) return name;
      }
      return k === "S" ? `${v}` : v > 9 ? `$${hex(v)}` : `${v}`;
    });
    out.push(`    ${ins.name}${suffix}${args.length ? ` ${args.join(" ")}` : ""}`);
  }
  return `${out.join("\n")}\n`;
}

/** Object labels: names, disambiguated when a script reuses one. */
function uniqueObjectLabels(objects: ScriptObject[]): string[] {
  const seen = new Map<string, number>();
  return objects.map((o) => {
    const n = seen.get(o.name) ?? 0;
    seen.set(o.name, n + 1);
    const safe = /^[A-Za-z_][\w:$-]*$/.test(o.name) ? o.name : `obj_${hex(o.offset)}`;
    return n ? `${safe}~${n}` : safe;
  });
}

function quote(bytes: Uint8Array): string {
  let s = '"';
  for (const b of bytes) {
    if (b === 0x22) s += '\\"';
    else if (b === 0x5c) s += "\\\\";
    else if (b === 0x0a) s += "\\n";
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += `\\x${hex(b, 2)}`;
  }
  return `${s}"`;
}

// --- Text → script ----------------------------------------------------------------------

interface Line {
  no: number;
  tokens: string[];
}

function tokenize(text: string): Line[] {
  const lines: Line[] = [];
  text.split("\n").forEach((raw, i) => {
    const tokens: string[] = [];
    for (let p = 0; p < raw.length; ) {
      const c = raw[p]!;
      if (c === ";") break;
      if (c === " " || c === "\t" || c === "\r") { p++; continue; }
      if (c === '"') {
        let e = p + 1;
        while (e < raw.length && raw[e] !== '"') e += raw[e] === "\\" ? 2 : 1;
        tokens.push(raw.slice(p, e + 1));
        p = e + 1;
        continue;
      }
      let e = p;
      while (e < raw.length && !" \t\r;".includes(raw[e]!)) e++;
      tokens.push(raw.slice(p, e));
      p = e;
    }
    if (tokens.length) lines.push({ no: i + 1, tokens });
  });
  return lines;
}

function unquote(token: string, line: number): Uint8Array {
  if (!token.startsWith('"') || !token.endsWith('"') || token.length < 2) throw new AsmError(`expected a string, got ${token}`, line);
  const out: number[] = [];
  for (let i = 1; i < token.length - 1; i++) {
    const c = token[i]!;
    if (c !== "\\") { out.push(c.charCodeAt(0) & 0xff); continue; }
    const n = token[++i];
    if (n === "n") out.push(0x0a);
    else if (n === "x") { out.push(parseInt(token.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push((n ?? "").charCodeAt(0));
  }
  return Uint8Array.from(out);
}

type Value = { kind: "num"; value: number } | { kind: "heap"; label: string; offset: number } | { kind: "code"; label: string };

interface AsmObject {
  line: number;
  label: string;
  isClass: boolean;
  superclass: number;
  species: number;
  classScript: Value;
  info: Value;
  name: Value;
  headerSelectors?: number[];
  /** Slot → value, from HEADER_SLOTS on. */
  props: Map<number, Value>;
  propSelectors: number[];
  methods: { selector: number; label: string }[];
  heapOffset: number;
  size: number;
}

interface AsmInstruction {
  line: number;
  name: string;
  opcode: number;
  /** Forced form: true = byte, false = word, undefined = default. */
  forced?: boolean;
  args: (number | { label: string; heap: boolean; offset: number } | { property: string })[];
  /** The object whose layout names property operands (self). */
  owner?: string;
  offset: number;
  small: boolean;
}

export function assemble(text: string, ctx: AsmContext): { number: number; code: Uint8Array; heap: Uint8Array } {
  const lines = tokenize(text);
  const selectorIds = new Map(ctx.selectorNames.map((n, i) => [n, i] as const));
  const selector = (name: string, line: number) => {
    let id = selectorIds.get(name) ?? (name.startsWith("sel_") ? Number(name.slice(4)) : undefined);
    if (id === undefined && ctx.newSelector && /^[A-Za-z_-][\w-]*$/.test(name)) selectorIds.set(name, (id = ctx.newSelector(name)));
    if (id === undefined || Number.isNaN(id)) throw new AsmError(`unknown selector ${name}`, line);
    return id;
  };
  const number = (t: string, line: number) => {
    const v = t.startsWith("$") ? parseInt(t.slice(1), 16) : t.startsWith("-$") ? -parseInt(t.slice(2), 16) : Number(t);
    if (!Number.isFinite(v) || t === "") throw new AsmError(`expected a number, got ${t}`, line);
    return v;
  };
  const value = (t: string, line: number): Value => {
    if (t.startsWith("@")) {
      const [label, off] = t.slice(1).split("+");
      return { kind: "heap", label: label!, offset: off ? Number(off) : 0 };
    }
    if (/^-?(\$[0-9a-fA-F]+|\d+)$/.test(t)) return { kind: "num", value: number(t, line) };
    return { kind: "code", label: t };
  };
  const classNumber = (t: string, line: number) => {
    if (t === "-") return 0xffff;
    if (t.startsWith("$")) return number(t, line);
    const local = objects.find((o) => o.isClass && o.label === t);
    const n = local ? local.species : ctx.classSpecies(t);
    if (n === undefined) throw new AsmError(`unknown class ${t}`, line);
    return n;
  };

  let scriptNumber: number | undefined;
  let locals: Value[] = [];
  const exports: Value[] = [];
  const objects: AsmObject[] = [];
  const strings: { label: string; bytes: Uint8Array; line: number }[] = [];
  const instructions: AsmInstruction[] = [];
  const codeLabels = new Map<string, number>(); // label → instruction index
  let section = "";
  let current: AsmObject | undefined;
  let owner: string | undefined;
  const opcodeByName = new Map(opcodes.map((o, i) => [o.name, i] as const));
  const kernelIds = new Map(ctx.kernelNames.map((n, i) => [n, i] as const));

  for (const { no, tokens } of lines) {
    const [head, ...rest] = tokens as [string, ...string[]];
    // Keywords double as property names (`script`, `code`...): inside an object, a line
    // with a value is a property. Section headers stand alone.
    const inObject = section === "object";
    if (head === "script" && !inObject && section === "") { scriptNumber = number(rest[0] ?? "", no); continue; }
    if (head === "locals" && !inObject && section === "") { locals = rest.map((t) => value(t, no)); continue; }
    if ((head === "exports" || head === "strings" || head === "code") && rest.length === 0) { section = head; current = undefined; continue; }
    // In code, `class Name` is the instruction that loads a class object.
    if ((head === "class" || head === "instance") && rest[1] === "of" && section !== "code") {
      section = "object";
      const [label, of, superName, speciesKw, speciesNo] = rest;
      if (!label || of !== "of" || !superName) throw new AsmError(`expected: ${head} Name of Super`, no);
      const isClass = head === "class";
      if (isClass && speciesKw !== "species") throw new AsmError("classes need: species N", no);
      current = {
        line: no, label, isClass, superclass: 0, species: isClass ? number(speciesNo ?? "", no) : 0xffff,
        classScript: { kind: "num", value: 0 }, info: { kind: "num", value: isClass ? 0x8000 : 0 }, name: { kind: "num", value: 0 },
        props: new Map(), propSelectors: [], methods: [], heapOffset: 0, size: 0,
      };
      // Resolved after all objects are read (a class may be declared later in the file).
      (current as AsmObject & { superName: string }).superName = superName;
      objects.push(current);
      continue;
    }
    if (section === "exports") { exports.push(value(head, no)); continue; }
    if (section === "strings") {
      if (!rest[0]) throw new AsmError("expected: label \"text\"", no);
      strings.push({ label: head, bytes: unquote(rest[0], no), line: no });
      continue;
    }
    if (section === "object" && current) {
      const o = current;
      if (head === "classScript") o.classScript = value(rest[0] ?? "", no);
      else if (head === "info") o.info = value(rest[0] ?? "", no);
      else if (head === "name") o.name = value(rest[0] ?? "", no);
      else if (head === "header") o.headerSelectors = rest.map((t) => selector(t, no));
      else if (head === "method") o.methods.push({ selector: selector(rest[0] ?? "", no), label: rest[1] ?? "" });
      else if (head === "prop") {
        if (!o.isClass) throw new AsmError("only classes declare new properties with `prop`", no);
        o.propSelectors.push(selector(rest[0] ?? "", no));
        o.props.set(HEADER_SLOTS + o.propSelectors.length - 1, value(rest[1] ?? "", no));
      } else {
        // An instance's property, by name (resolved against its class later) or #slot.
        (o as AsmObject & { named?: { name: string; value: Value; line: number }[] }).named ??= [];
        (o as AsmObject & { named: { name: string; value: Value; line: number }[] }).named.push({ name: head, value: value(rest[0] ?? "", no), line: no });
      }
      continue;
    }
    if (section === "code") {
      if (head.endsWith(":") && rest.length === 0) {
        const label = head.slice(0, -1);
        if (codeLabels.has(label)) throw new AsmError(`duplicate label ${label}`, no);
        codeLabels.set(label, instructions.length);
        // `Obj::method` code runs with self = Obj; local labels keep the owner; others clear it.
        if (!label.startsWith(".")) owner = label.includes("::") ? label.slice(0, label.lastIndexOf("::")) : undefined;
        continue;
      }
      if (head === "owner") {
        if (!rest[0]) throw new AsmError("expected: owner ObjectOrClass", no);
        owner = rest[0];
        continue;
      }
      const [mnemonic, form] = head.split(".") as [string, string | undefined];
      const opcode = opcodeByName.get(mnemonic);
      if (opcode === undefined) throw new AsmError(`unknown instruction ${head}`, no);
      const info = opcodes[opcode]!;
      if (rest.length !== info.operands.length) throw new AsmError(`${mnemonic} takes ${info.operands.length} operand(s)`, no);
      const args = info.operands.map((k, i) => {
        const t = rest[i]!;
        if (k === "R") return { label: t, heap: false, offset: 0 };
        if (t.startsWith("@")) {
          const [label, off] = t.slice(1).split("+");
          return { label: label!, heap: true, offset: off ? Number(off) : 0 };
        }
        if (t.startsWith("#")) return selector(t.slice(1), no);
        if (i === 0 && mnemonic === "callk" && !/^-?\$?\d/.test(t)) {
          const id = kernelIds.get(t);
          if (id === undefined) throw new AsmError(`unknown kernel ${t}`, no);
          return id;
        }
        if (i === 0 && (mnemonic === "class" || mnemonic === "super") && !/^\$?\d/.test(t)) return classNumber(t, no);
        if (i === 0 && PROPERTY_OPS.has(mnemonic) && !/^-?\$?\d/.test(t)) return { property: t };
        return number(t, no);
      });
      instructions.push({ line: no, name: mnemonic, opcode, forced: form === "b" ? true : form === "w" ? false : undefined, args, owner, offset: 0, small: false });
      continue;
    }
    throw new AsmError(`unexpected ${head}`, no);
  }
  if (scriptNumber === undefined) throw new AsmError("missing `script N`");

  // --- Resolve object layouts --------------------------------------------------------
  for (const o of objects) {
    o.superclass = classNumber((o as AsmObject & { superName: string }).superName, o.line);
    if (o.isClass) {
      const header = o.headerSelectors ?? ctx.classPropSelectors(o.superclass)?.slice(0, HEADER_SLOTS);
      if (!header) throw new AsmError(`class ${o.label} needs a header line (its superclass layout is unknown)`, o.line);
      o.propSelectors = [...header, ...o.propSelectors];
    } else {
      const sels = ctx.classPropSelectors(o.superclass) ?? objects.find((c) => c.isClass && c.species === o.superclass)?.propSelectors;
      if (!sels) throw new AsmError(`unknown layout for the class of ${o.label}`, o.line);
      o.propSelectors = [...sels];
      // Unlisted properties keep the class's defaults.
      const cls = objects.find((c) => c.isClass && c.species === o.superclass);
      if (cls) for (const [slot, v] of cls.props) o.props.set(slot, v);
      else ctx.classDefaults(o.superclass)?.forEach((v, slot) => slot >= HEADER_SLOTS && o.props.set(slot, { kind: "num", value: v }));
      for (const { name, value: v, line } of (o as AsmObject & { named?: { name: string; value: Value; line: number }[] }).named ?? []) {
        const slot = name.startsWith("#") ? Number(name.slice(1)) : sels.indexOf(selector(name, line));
        if (slot < HEADER_SLOTS || slot >= sels.length) throw new AsmError(`${o.label} has no property ${name}`, line);
        o.props.set(slot, v);
      }
    }
    o.size = o.propSelectors.length;
  }

  // --- Property names: byte offsets in the owner's layout -------------------------------
  for (const ins of instructions) {
    const a = ins.args[0];
    if (!a || typeof a !== "object" || !("property" in a)) continue;
    if (!ins.owner) throw new AsmError(`${ins.name} ${a.property}: no owner here (add \`owner Name\` or put it in a Name::method)`, ins.line);
    const local = objects.find((o) => o.label === ins.owner);
    const species = local ? undefined : ctx.classSpecies(ins.owner);
    const layout = local?.propSelectors ?? (species === undefined ? undefined : ctx.classPropSelectors(species));
    if (!layout) throw new AsmError(`unknown owner ${ins.owner}`, ins.line);
    const slot = layout.indexOf(selector(a.property, ins.line));
    if (slot < 0) throw new AsmError(`${ins.owner} has no property ${a.property}`, ins.line);
    ins.args[0] = slot * 2;
  }

  // --- Heap layout ---------------------------------------------------------------------
  const heapLabels = new Map<string, number>();
  let hp = 4 + locals.length * 2;
  for (const o of objects) {
    o.heapOffset = hp;
    if (heapLabels.has(o.label)) throw new AsmError(`duplicate object ${o.label}`, o.line);
    heapLabels.set(o.label, hp);
    hp += o.size * 2;
  }
  hp += 2; // the 0 word ending the object list
  const stringOffsets: number[] = [];
  for (const s of strings) {
    if (heapLabels.has(s.label)) throw new AsmError(`duplicate label ${s.label}`, s.line);
    heapLabels.set(s.label, hp);
    stringOffsets.push(hp);
    hp += s.bytes.length + 1;
  }
  const heapRelocOffset = hp;
  const heapAddress = (label: string, offset: number, line: number) => {
    const base = heapLabels.get(label) ?? (/^\d+$/.test(label) ? Number(label) : undefined);
    if (base === undefined) throw new AsmError(`unknown heap label @${label}`, line);
    return base + offset;
  };

  // --- Code layout: dictionaries, then instructions (with jump relaxation) -----------------
  let cp = 8 + exports.length * 2;
  const propDictAt = new Map<AsmObject, number>(), methDictAt = new Map<AsmObject, number>();
  for (const o of objects) {
    if (o.isClass) { propDictAt.set(o, cp); cp += o.size * 2; }
    methDictAt.set(o, cp);
    cp += 2 + o.methods.length * 4;
  }
  const codeStart = cp;
  const labelOffset = (label: string, line: number) => {
    if (/^\d+$/.test(label)) return Number(label);
    const idx = codeLabels.get(label);
    if (idx === undefined) throw new AsmError(`unknown code label ${label}`, line);
    return idx < instructions.length ? instructions[idx]!.offset : codeEnd;
  };
  let codeEnd = codeStart;
  const sizeOf = (ins: AsmInstruction) => {
    const info = opcodes[ins.opcode]!;
    let size = 1;
    for (const k of info.operands) size += k === "B" ? 1 : k === "U" ? 2 : ins.small ? 1 : 2;
    return size;
  };
  // Start with each instruction's default/forced form; unforced relative jumps start small
  // and grow until everything fits (sizes only grow, so this terminates).
  for (const ins of instructions) {
    const info = opcodes[ins.opcode]!;
    if (!info.operands.some(SIZED)) ins.small = ins.forced ?? false;
    else if (ins.forced !== undefined) ins.small = ins.forced;
    else if (WORD_DEFAULT.has(ins.name)) ins.small = false;
    else if (info.operands.some(RELATIVE)) ins.small = true;
    else ins.small = fitsSmall(info.operands, ins.args.map((a) => (typeof a === "number" ? a : 0x7fff)));
  }
  for (let pass = 0; ; pass++) {
    let pc = codeStart;
    for (const ins of instructions) { ins.offset = pc; pc += sizeOf(ins); }
    codeEnd = pc;
    let grew = false;
    for (const ins of instructions) {
      const info = opcodes[ins.opcode]!;
      if (!ins.small || ins.forced !== undefined || !info.operands.some(RELATIVE)) continue;
      const target = labelOffset((ins.args[0] as { label: string }).label, ins.line);
      const rel = target - (ins.offset + sizeOf(ins));
      if (rel < -128 || rel > 127) { ins.small = false; grew = true; }
    }
    if (!grew) break;
    if (pass > 1000) throw new AsmError("jump relaxation did not settle");
  }

  // --- Emit code -----------------------------------------------------------------------------
  const codeRelocs: number[] = [];
  const codeBytes: number[] = [];
  const w16 = (arr: number[], at: number, v: number) => { arr[at] = v & 0xff; arr[at + 1] = (v >> 8) & 0xff; };
  const resolveValue = (v: Value, line: number): { value: number; heap: boolean } => {
    if (v.kind === "num") return { value: v.value & 0xffff, heap: false };
    if (v.kind === "heap") return { value: heapAddress(v.label, v.offset, line), heap: true };
    return { value: labelOffset(v.label, line), heap: false };
  };
  w16(codeBytes, 0, 0); // relocation table offset, patched below
  w16(codeBytes, 2, 0);
  w16(codeBytes, 4, 0);
  w16(codeBytes, 6, exports.length);
  exports.forEach((e, i) => {
    const at = 8 + i * 2;
    if (e.kind === "num") { w16(codeBytes, at, e.value); return; }
    if (e.kind === "heap") { w16(codeBytes, at, heapAddress(e.label, e.offset, 0)); codeRelocs.push(at); return; }
    // A bare name: an object if there is one, else a code label.
    if (heapLabels.has(e.label) && objects.some((o) => o.label === e.label)) { w16(codeBytes, at, heapLabels.get(e.label)!); codeRelocs.push(at); }
    else w16(codeBytes, at, labelOffset(e.label, 0));
  });
  for (const o of objects) {
    if (o.isClass) o.propSelectors.forEach((s, i) => w16(codeBytes, propDictAt.get(o)! + i * 2, s));
    const md = methDictAt.get(o)!;
    w16(codeBytes, md, o.methods.length);
    o.methods.forEach((m, i) => {
      w16(codeBytes, md + 2 + i * 4, m.selector);
      w16(codeBytes, md + 4 + i * 4, labelOffset(m.label, o.line));
    });
  }
  for (const ins of instructions) {
    const info = opcodes[ins.opcode]!;
    let pc = ins.offset;
    codeBytes[pc++] = (ins.opcode << 1) | (ins.small ? 1 : 0);
    const next = ins.offset + sizeOf(ins);
    info.operands.forEach((k, i) => {
      const a = ins.args[i]!;
      let v: number;
      if (typeof a === "number") v = a;
      else if ("property" in a) throw new AsmError(`unresolved property ${a.property}`, ins.line);
      else if (a.heap) {
        v = heapAddress(a.label, a.offset, ins.line);
        if (ins.small) throw new AsmError(`${ins.name} with a heap address can't be .b (it's relocated)`, ins.line);
        codeRelocs.push(pc);
      } else v = k === "R" ? labelOffset(a.label, ins.line) - next : labelOffset(a.label, ins.line);
      const width = k === "B" ? 1 : k === "U" ? 2 : ins.small ? 1 : 2;
      if (width === 1) {
        const ok = k === "W" || k === "B" ? v >= 0 && v <= 0xff : v >= -128 && v <= 127;
        if (!ok) throw new AsmError(`${ins.name}: ${v} doesn't fit in a byte`, ins.line);
        codeBytes[pc++] = v & 0xff;
      } else {
        if (v < -0x8000 || v > 0xffff) throw new AsmError(`${ins.name}: ${v} doesn't fit in 16 bits`, ins.line);
        w16(codeBytes, pc, v & 0xffff);
        pc += 2;
      }
    });
  }
  const codeRelocOffset = codeEnd;
  w16(codeBytes, 0, codeRelocOffset);
  codeRelocs.sort((a, b) => a - b);
  w16(codeBytes, codeRelocOffset, codeRelocs.length);
  codeRelocs.forEach((r, i) => w16(codeBytes, codeRelocOffset + 2 + i * 2, r));

  // --- Emit heap -----------------------------------------------------------------------------
  const heapBytes: number[] = [];
  const heapRelocs: number[] = [];
  w16(heapBytes, 0, heapRelocOffset);
  w16(heapBytes, 2, locals.length);
  locals.forEach((v, i) => {
    const r = resolveValue(v, 0);
    w16(heapBytes, 4 + i * 2, r.value);
    if (r.heap) heapRelocs.push(4 + i * 2);
  });
  for (const o of objects) {
    const slot = (n: number, v: number | Value) => {
      const at = o.heapOffset + n * 2;
      if (typeof v === "number") { w16(heapBytes, at, v); return; }
      const r = resolveValue(v, o.line);
      w16(heapBytes, at, r.value);
      if (r.heap) heapRelocs.push(at);
    };
    slot(ObjectSlot.Magic, 0x1234);
    slot(ObjectSlot.Size, o.size);
    // Instances point both dictionary slots at their method dictionary.
    slot(ObjectSlot.PropDict, o.isClass ? propDictAt.get(o)! : methDictAt.get(o)!);
    slot(ObjectSlot.MethDict, methDictAt.get(o)!);
    slot(ObjectSlot.ClassScript, o.classScript);
    slot(ObjectSlot.Species, o.species);
    slot(ObjectSlot.Super, o.superclass);
    slot(ObjectSlot.Info, o.info);
    slot(ObjectSlot.Name, o.name);
    for (let n = HEADER_SLOTS; n < o.size; n++) slot(n, o.props.get(n) ?? 0);
  }
  const objectsEnd = objects.length ? objects.at(-1)!.heapOffset + objects.at(-1)!.size * 2 : 4 + locals.length * 2;
  w16(heapBytes, objectsEnd, 0);
  strings.forEach((s, i) => {
    const at = stringOffsets[i]!;
    s.bytes.forEach((b, j) => (heapBytes[at + j] = b));
    heapBytes[at + s.bytes.length] = 0;
  });
  heapRelocs.sort((a, b) => a - b);
  w16(heapBytes, heapRelocOffset, heapRelocs.length);
  heapRelocs.forEach((r, i) => w16(heapBytes, heapRelocOffset + 2 + i * 2, r));

  const fill = (a: number[]) => Uint8Array.from({ length: a.length }, (_, i) => a[i] ?? 0);
  return { number: scriptNumber, code: fill(codeBytes), heap: fill(heapBytes) };
}

/** Reads the heap string at an address (for tools that show assembled output). */
export const heapString = (heap: Uint8Array, offset: number) => readString(heap, offset);
