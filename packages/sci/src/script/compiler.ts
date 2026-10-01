import { read, show, ReadError, type Node } from "./sexpr.ts";

/**
 * The script compiler: SCI's Lisp-like source language to the assembly text that
 * `assemble` builds (see assembly.ts). All of a game's scripts are compiled together, so a
 * script can use classes, globals and procedures from any other.
 *
 *   (script 100)                                 the script's number
 *   (include "game.sh")                          defines from another file
 *   (define SPEED 6) (enum 1 LOOK DO TALK)       constants
 *   (public lantern 0 helper 1)                  exports, by index
 *   (local count [buf 10] (= name "x"))          script variables; script 0's are the globals
 *   (global ego (= speed 6))                     more globals, declared by any script
 *   (extern helper 100 1)                        a procedure exported by a script not compiled here
 *   (class Lantern of Prop                       a class (no `of`: a root class)
 *     (properties lit 0)
 *     (method (doVerb theVerb &tmp i) ...))
 *   (instance lamp of Lantern (properties x 10) (method ...))
 *   (procedure (helper a b &tmp t) ...)
 *
 * Expressions: (= v e) (+= v e) (++ v), arithmetic + - * / mod << >> & | ^ ~, comparison
 * == != < > <= >= u< u> u<= u>=, (and ...) (or ...) (not e), (if c ... else ...), (cond ...),
 * (switch v (k ...) (else ...)), (switchto v (...) (...)), (while c ...), (repeat ...),
 * (for (init) c (step) ...), (break), (continue), (return e). Sends: (obj sel: args sel2:
 * args), (self ...), (super ...), (send e sel: ...); `sel?` reads a property; (obj [s] args)
 * sends the selector in s. Calls: (proc args), (Kernel args),
 * `&rest` passes on the caller's remaining arguments. [buf i] is an array element, @buf its
 * address, #sel a selector, `a a character, $1F hex.
 */

export interface CompileSource {
  file: string;
  text: string;
}

/** A class defined outside the sources being compiled (an assembled script). */
export interface ExternalClass {
  species: number;
  /** Properties after the object header, in order, with their default values. */
  properties: { name: string; value: number }[];
}

export interface CompileContext {
  kernelNames: readonly string[];
  externalClass?(name: string): ExternalClass | undefined;
  /** Species numbers classes outside these sources already use. */
  takenSpecies?: ReadonlySet<number>;
  /** The text of an included file, or undefined if there's no such file. */
  include?(name: string, from: string): string | undefined;
  /**
   * Hears about likely mistakes that still compile: sends of a selector no class or object
   * defines (as a property or a method). Only checked when every class is compiled here.
   */
  onWarning?(warning: CompileWarning): void;
}

export interface CompileWarning {
  message: string;
  file: string;
  line: number;
}

export interface CompiledScript {
  file: string;
  number: number;
  assembly: string;
  /** Classes this script defines, by name. */
  classes: Map<string, number>;
  /** Its variables, by slot (an array's elements are name[i]); script 0's are the globals. */
  variables: string[];
}

export class CompileError extends Error {
  constructor(message: string, readonly file: string, readonly line: number) {
    super(`${file}:${line}: ${message}`);
  }
}

/** The object header slots, in order; every class and instance begins with them. */
export const OBJECT_HEADER = ["-objID-", "-size-", "-propDict-", "-methDict-", "-classScript-", "-species-", "-super-", "-info-", "name"];

// --- Declarations ----------------------------------------------------------------------

interface Var {
  name: string;
  size: number;
  init: Node[];
  line: number;
}

interface Func {
  name: string;
  params: string[];
  temps: Var[];
  body: Node[];
  line: number;
}

interface Obj {
  kind: "class" | "instance";
  name: string;
  superName?: string;
  props: { name: string; value: Node; line: number }[];
  methods: Func[];
  line: number;
  species: number;
}

interface Unit {
  file: string;
  number: number;
  defines: Map<string, Node>;
  locals: Var[];
  globals: Var[];
  publics: { name: string; index: number; line: number }[];
  externs: Map<string, { script: number; index: number }>;
  objects: Obj[];
  procedures: Func[];
}

const BUILTIN_DEFINES: Record<string, number> = { TRUE: 1, FALSE: 0, NULL: 0 };

export function compileScripts(sources: readonly CompileSource[], ctx: CompileContext): CompiledScript[] {
  const units = sources.map((s) => declare(s, ctx));
  const byNumber = new Map<number, Unit>();
  for (const u of units) {
    const other = byNumber.get(u.number);
    if (other) throw new CompileError(`script ${u.number} is also ${other.file}`, u.file, 1);
    byNumber.set(u.number, u);
  }

  // Classes: numbered superclasses first, then in script order, skipping numbers used
  // elsewhere (so a root class like Obj gets 0).
  const classes = new Map<string, { obj: Obj; unit: Unit }>();
  for (const u of [...units].sort((a, b) => a.number - b.number)) {
    for (const o of u.objects) {
      if (o.kind !== "class") continue;
      if (classes.has(o.name) || ctx.externalClass?.(o.name)) throw new CompileError(`class ${o.name} is defined twice`, u.file, o.line);
      classes.set(o.name, { obj: o, unit: u });
    }
  }
  const taken = new Set(ctx.takenSpecies ?? []);
  let nextSpecies = 0;
  const number = (c: { obj: Obj; unit: Unit }, seen: Set<string>) => {
    if (c.obj.species !== 0xffff) return;
    if (seen.has(c.obj.name)) throw new CompileError(`class ${c.obj.name} is its own superclass`, c.unit.file, c.obj.line);
    seen.add(c.obj.name);
    const sup = c.obj.superName ? classes.get(c.obj.superName) : undefined;
    if (sup) number(sup, seen);
    while (taken.has(nextSpecies)) nextSpecies++;
    c.obj.species = nextSpecies;
    taken.add(nextSpecies);
  };
  for (const c of classes.values()) number(c, new Set());

  // Globals: script 0's variables, then those other scripts declare with (global ...), in
  // script order; they all live in script 0.
  const globals = new Map<string, { index: number; size: number }>();
  const zero = byNumber.get(0);
  const declared = [...units].sort((a, b) => a.number - b.number).flatMap((u) => u.globals.map((v) => ({ v, u })));
  if (declared.length && !zero) {
    throw new CompileError("(global ...) needs script 0 to be compiled with it (globals live there)", declared[0]!.u.file, declared[0]!.v.line);
  }
  for (const { v, u } of declared) {
    const other = zero!.locals.find((x) => x.name === v.name);
    if (other) throw new CompileError(`global ${v.name} is declared twice`, u.file, v.line);
    zero!.locals.push(v);
  }
  if (zero) {
    let i = 0;
    for (const v of zero.locals) (globals.set(v.name, { index: i, size: v.size }), (i += v.size));
  }

  // Procedures other scripts can call.
  const publicProcs = new Map<string, { script: number; index: number }>();
  for (const u of units) {
    for (const p of u.publics) if (u.procedures.some((f) => f.name === p.name)) publicProcs.set(p.name, { script: u.number, index: p.index });
  }

  const project: Project = { ctx, classes, globals, publicProcs, layouts: new Map(), sent: [] };
  const compiled = units.map((u) => ({
    file: u.file,
    number: u.number,
    assembly: new ScriptCompiler(u, project).compile(),
    classes: new Map(u.objects.filter((o) => o.kind === "class").map((o) => [o.name, o.species])),
    variables: u.locals.flatMap((v) => (v.size === 1 ? [v.name] : Array.from({ length: v.size }, (_, i) => `${v.name}[${i}]`))),
  }));

  // Selectors sent that nothing here defines: probably misspelt.
  if (ctx.onWarning) {
    const defined = new Set(OBJECT_HEADER);
    for (const u of units) {
      for (const o of u.objects) {
        for (const p of o.props) defined.add(p.name);
        for (const m of o.methods) defined.add(m.name);
      }
    }
    const reported = new Set<string>();
    for (const s of project.sent) {
      if (defined.has(s.name) || reported.has(s.name)) continue;
      reported.add(s.name);
      ctx.onWarning({ message: `nothing defines ${s.name} (no class or object has a property or method by that name)`, file: s.file, line: s.line });
    }
  }
  return compiled;
}

/** Reads a source file's top-level forms into declarations. */
function declare(src: CompileSource, ctx: CompileContext): Unit {
  const unit: Unit = { file: src.file, number: -1, defines: new Map(), locals: [], globals: [], publics: [], externs: new Map(), objects: [], procedures: [] };
  const fail = (msg: string, line: number, file = src.file): never => {
    throw new CompileError(msg, file, line);
  };
  const parse = (text: string, file: string) => {
    try {
      return read(text);
    } catch (e) {
      if (e instanceof ReadError) fail(e.message.replace(/^line \d+: /, ""), e.line, file);
      throw e;
    }
  };

  const topLevel = (forms: Node[], file: string, included: boolean) => {
    for (const form of forms) {
      if (form.kind !== "list" || form.items[0]?.kind !== "sym") fail(`expected a declaration like (script ...), got ${show(form)}`, form.line, file);
      const [head, ...rest] = (form as Node & { items: Node[] }).items as [Node & { kind: "sym" }, ...Node[]];
      const line = form.line;
      const sym = (n: Node | undefined, what: string): string => (n?.kind === "sym" ? n.name : fail(`expected ${what}`, n?.line ?? line, file));
      const num = (n: Node | undefined, what: string): number => (n?.kind === "num" ? n.value : fail(`expected ${what}`, n?.line ?? line, file));
      const onlyInScript = () => included && fail(`(${head.name}) can't be in an included file`, line, file);
      switch (head.name) {
        case "script":
          onlyInScript();
          if (unit.number >= 0) fail("a second (script N)", line);
          unit.number = num(rest[0], "the script's number");
          break;
        case "include": {
          const name = rest[0]?.kind === "str" ? rest[0].value : sym(rest[0], "a file name");
          const text = ctx.include?.(name, file);
          if (text === undefined) fail(`can't find ${name} to include`, line, file);
          topLevel(parse(text!, name), name, true);
          break;
        }
        case "define":
          unit.defines.set(sym(rest[0], "a name"), rest[1] ?? fail("(define NAME value)", line, file));
          break;
        case "enum": {
          // (enum [start] A B (= C 10) D): A = start (0 by default), B = A + 1, ...
          let i = 0;
          let names = rest;
          if (names[0]?.kind === "num") (i = names[0].value), (names = names.slice(1));
          for (const n of names) {
            if (n.kind === "list" && n.items[0]?.kind === "sym" && n.items[0].name === "=") {
              i = constValue(n.items[2]!, unit.defines, (m) => fail(m, n.line, file));
              unit.defines.set(sym(n.items[1], "a name"), { kind: "num", value: i++, line: n.line });
            } else unit.defines.set(sym(n, "a name"), { kind: "num", value: i++, line: n.line });
          }
          break;
        }
        case "extern":
          for (let i = 0; i < rest.length; i += 3) {
            unit.externs.set(sym(rest[i], "a procedure name"), { script: num(rest[i + 1], "a script number"), index: num(rest[i + 2], "an export index") });
          }
          break;
        case "public":
          onlyInScript();
          for (let i = 0; i < rest.length; i += 2) {
            unit.publics.push({ name: sym(rest[i], "a name"), index: num(rest[i + 1], "an export index"), line: rest[i]!.line });
          }
          break;
        case "local":
          onlyInScript();
          unit.locals.push(...variables(rest, (m, l) => fail(m, l)));
          break;
        case "global":
          onlyInScript();
          unit.globals.push(...variables(rest, (m, l) => fail(m, l)));
          break;
        case "class":
        case "instance":
          onlyInScript();
          unit.objects.push(object(head.name, rest, line, (m, l) => fail(m, l)));
          break;
        case "procedure": {
          onlyInScript();
          const sig = rest[0];
          if (sig?.kind === "sym") break; // a forward declaration
          unit.procedures.push(func(sig, rest.slice(1), line, (m, l) => fail(m, l)));
          break;
        }
        default:
          fail(`unknown declaration (${head.name} ...)`, line, file);
      }
    }
  };
  topLevel(parse(src.text, src.file), src.file, false);
  if (unit.number < 0) fail("missing (script N)", 1);
  return unit;
}

type Fail = (message: string, line: number) => never;

/** `a [b 4] (= c 5) [d 2] = (1 2)`: names, array sizes, initial values. */
function variables(nodes: Node[], fail: Fail): Var[] {
  const out: Var[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.kind === "sym" && n.name !== "=") {
      const v: Var = { name: n.name, size: 1, init: [], line: n.line };
      if (nodes[i + 1]?.kind === "sym" && (nodes[i + 1] as { name: string }).name === "=") {
        v.init = [nodes[i + 2] ?? fail("= needs a value", n.line)];
        i += 2;
      }
      out.push(v);
    } else if (n.kind === "index") {
      const [name, size] = n.items;
      if (name?.kind !== "sym" || size?.kind !== "num") fail("an array is [name size]", n.line);
      const v: Var = { name: (name as { name: string }).name, size: (size as { value: number }).value, init: [], line: n.line };
      if (nodes[i + 1]?.kind === "sym" && (nodes[i + 1] as { name: string }).name === "=") {
        const values = nodes[i + 2];
        v.init = values?.kind === "list" || values?.kind === "index" ? values.items : [values ?? fail("= needs values", n.line)];
        if (v.init.length > v.size) fail(`${v.name} has ${v.size} elements, but ${v.init.length} values`, n.line);
        i += 2;
      }
      out.push(v);
    } else if (n.kind === "list" && n.items[0]?.kind === "sym" && n.items[0].name === "=" && n.items[1]?.kind === "sym") {
      out.push({ name: n.items[1].name, size: 1, init: [n.items[2] ?? fail("(= name value)", n.line)], line: n.line });
    } else fail(`expected a variable name, got ${show(n)}`, n.line);
  }
  return out;
}

/** `(name a b &tmp t [buf 4])` and a body. */
function func(sig: Node | undefined, body: Node[], line: number, fail: Fail): Func {
  if (sig?.kind !== "list" || sig.items[0]?.kind !== "sym") return fail("expected (name params...)", sig?.line ?? line);
  const [name, ...rest] = sig.items as [Node & { kind: "sym" }, ...Node[]];
  const tmp = rest.findIndex((n) => n.kind === "sym" && n.name === "&tmp");
  const params = (tmp < 0 ? rest : rest.slice(0, tmp)).map((n) => (n.kind === "sym" ? n.name : fail(`expected a parameter name, got ${show(n)}`, n.line)));
  const temps = tmp < 0 ? [] : variables(rest.slice(tmp + 1), fail);
  for (const t of temps) if (t.init.length) fail("temporaries can't have initial values", t.line);
  return { name: name.name, params, temps, body, line: sig.line };
}

function object(kind: string, rest: Node[], line: number, fail: Fail): Obj {
  const [name, ...more] = rest;
  if (name?.kind !== "sym") return fail(`expected (${kind} Name of Class ...)`, line);
  const o: Obj = { kind: kind as Obj["kind"], name: name.name, props: [], methods: [], line, species: 0xffff };
  let i = 0;
  if (more[0]?.kind === "sym" && (more[0].name === "of" || more[0].name === "kindof")) {
    if (more[1]?.kind !== "sym") fail(`${o.name}: expected a class name after ${more[0].name}`, line);
    o.superName = (more[1] as { name: string }).name;
    i = 2;
  } else if (kind === "instance") fail(`instance ${o.name} needs "of Class"`, line);
  for (const n of more.slice(i)) {
    if (n.kind !== "list" || n.items[0]?.kind !== "sym") fail(`${o.name}: expected (properties ...) or (method ...), got ${show(n)}`, n.line);
    const [head, ...body] = (n as { items: Node[] }).items as [Node & { kind: "sym" }, ...Node[]];
    if (head.name === "properties") {
      for (let k = 0; k < body.length; k += 2) {
        const p = body[k]!;
        if (p.kind !== "sym") fail(`expected a property name, got ${show(p)}`, p.line);
        o.props.push({ name: (p as { name: string }).name, value: body[k + 1] ?? fail(`property ${(p as { name: string }).name} needs a value`, p.line), line: p.line });
      }
    } else if (head.name === "method") {
      const m = func(body[0], body.slice(1), n.line, fail);
      if (o.methods.some((x) => x.name === m.name)) fail(`${o.name} has two ${m.name} methods`, n.line);
      o.methods.push(m);
    } else fail(`${o.name}: expected (properties ...) or (method ...), got (${head.name} ...)`, n.line);
  }
  return o;
}

/** A constant expression: numbers, defines and arithmetic on them. */
function constValue(n: Node, defines: Map<string, Node>, fail: (m: string) => never, depth = 0): number {
  if (depth > 50) fail("a define refers to itself");
  if (n.kind === "num") return n.value;
  if (n.kind === "sym") {
    if (n.name in BUILTIN_DEFINES) return BUILTIN_DEFINES[n.name]!;
    const d = defines.get(n.name);
    if (!d) return fail(`${n.name} isn't a constant`);
    return constValue(d, defines, fail, depth + 1);
  }
  if (n.kind === "list" && n.items[0]?.kind === "sym") {
    const op = n.items[0].name;
    const args = n.items.slice(1).map((a) => constValue(a, defines, fail, depth + 1));
    const fold = (f: (a: number, b: number) => number) => args.reduce(f);
    switch (op) {
      case "+": return fold((a, b) => a + b);
      case "-": return args.length === 1 ? -args[0]! : fold((a, b) => a - b);
      case "*": return fold((a, b) => a * b);
      case "/": return fold((a, b) => Math.trunc(a / b));
      case "|": return fold((a, b) => a | b);
      case "&": return fold((a, b) => a & b);
      case "^": return fold((a, b) => a ^ b);
      case "<<": return fold((a, b) => a << b);
      case ">>": return fold((a, b) => a >> b);
      case "~": return ~args[0]! & 0xffff;
    }
  }
  return fail(`${show(n)} isn't a constant`);
}

// --- Code generation ---------------------------------------------------------------------

interface Project {
  ctx: CompileContext;
  classes: Map<string, { obj: Obj; unit: Unit }>;
  globals: Map<string, { index: number; size: number }>;
  publicProcs: Map<string, { script: number; index: number }>;
  layouts: Map<string, Layout>;
  /** Selectors sent or named (#sel), and where: for the misspelling check. */
  sent: { name: string; file: string; line: number }[];
}

/** A class's properties after the header: names and default values. */
type Layout = { species: number; props: { name: string; value: Node | number }[] };

type VarKind = "g" | "l" | "t" | "p";

type Ref =
  | { kind: "var"; type: VarKind; index: number; size: number }
  | { kind: "prop"; name: string }
  | { kind: "const"; node: Node }
  | { kind: "object"; label: string }
  | { kind: "class"; species: number; name: string }
  | { kind: "self" }
  | { kind: "argc" };

interface FnState {
  func: Func;
  owner?: { obj: Obj; layout: string[]; superSpecies?: number };
  params: Map<string, number>;
  temps: Map<string, { index: number; size: number }>;
  loops: { brk: string; cont: string; switches: number }[];
  switches: number;
}

const SEND_SELECTOR = /^([A-Za-z_-][\w-]*)[:?]$/;
/** A message in a send starts with a selector (`x:`, `x?`) or `[expr]`, a selector computed at run time. */
const isMessageHead = (n: Node | undefined) =>
  (n?.kind === "sym" && SEND_SELECTOR.test(n.name)) || (n?.kind === "index" && n.items.length === 1);

const BINARY: Record<string, string> = {
  "+": "add", "-": "sub", "*": "mul", "/": "div", mod: "mod", "<<": "shl", ">>": "shr", "&": "and", "|": "or", "^": "xor",
};
const COMPARE: Record<string, string> = {
  "==": "eq?", "!=": "ne?", "<": "lt?", ">": "gt?", "<=": "le?", ">=": "ge?", "u<": "ult?", "u>": "ugt?", "u<=": "ule?", "u>=": "uge?",
};
const COMPOUND: Record<string, string> = { "+=": "+", "-=": "-", "*=": "*", "/=": "/", "|=": "|", "&=": "&", "^=": "^", "<<=": "<<", ">>=": ">>" };

class ScriptCompiler {
  private readonly out: string[] = [];
  private readonly strings = new Map<string, string>();
  private labels = 0;
  private fn: FnState | undefined;
  private readonly locals = new Map<string, { index: number; size: number }>();
  private readonly procedures: Set<string>;
  private readonly objects: Map<string, Obj>;

  constructor(private readonly unit: Unit, private readonly project: Project) {
    let i = 0;
    for (const v of unit.locals) {
      if (this.locals.has(v.name)) this.fail(`variable ${v.name} is declared twice`, v.line);
      this.locals.set(v.name, { index: i, size: v.size });
      i += v.size;
    }
    this.procedures = new Set(unit.procedures.map((p) => p.name));
    this.objects = new Map(unit.objects.map((o) => [o.name, o]));
  }

  private fail(message: string, line: number): never {
    throw new CompileError(message, this.unit.file, line);
  }

  compile(): string {
    const u = this.unit;
    const head: string[] = [`; compiled from ${u.file}`, `script ${u.number}`];

    // Locals: initial values (numbers, strings, objects in this script).
    const localValues: string[] = [];
    for (const v of u.locals) {
      for (let k = 0; k < v.size; k++) localValues.push(v.init[k] ? this.initValue(v.init[k]!) : "0");
    }
    if (localValues.length) head.push(`locals ${localValues.join(" ")}`);

    // Exports.
    const exports: string[] = [];
    for (const p of u.publics) {
      if (!this.procedures.has(p.name) && !this.objects.has(p.name)) this.fail(`public ${p.name} is neither a procedure nor an object here`, p.line);
      if (exports[p.index] !== undefined) this.fail(`export ${p.index} is used twice`, p.line);
      exports[p.index] = p.name;
    }
    if (exports.length) head.push("exports", ...Array.from(exports, (e) => `  ${e ?? 0}`));

    // Objects.
    const body: string[] = [];
    for (const o of u.objects) body.push(...this.objectLines(o));

    // Code.
    const code: string[] = [];
    for (const o of u.objects) {
      const owner = this.ownerOf(o);
      for (const m of o.methods) code.push(...this.function(m, `${o.name}::${m.name}`, owner));
    }
    for (const p of u.procedures) code.push(...this.function(p, p.name, undefined));

    const strings = [...this.strings].map(([text, label]) => `  ${label} ${quote(text)}`);
    return [...head, ...body, ...(strings.length ? ["strings", ...strings] : []), "code", ...code, ""].join("\n");
  }

  /** A class's layout: inherited properties first, then its own. */
  private layout(name: string, line: number): Layout {
    const cached = this.project.layouts.get(name);
    if (cached) return cached;
    const local = this.project.classes.get(name);
    let layout: Layout;
    if (local) {
      const { obj } = local;
      const props = obj.superName ? this.layout(obj.superName, obj.line).props.map((p) => ({ ...p })) : [];
      for (const p of obj.props) {
        if (OBJECT_HEADER.includes(p.name)) continue;
        const inherited = props.find((x) => x.name === p.name);
        if (inherited) inherited.value = p.value;
        else props.push({ name: p.name, value: p.value });
      }
      layout = { species: obj.species, props };
    } else {
      const ext = this.project.ctx.externalClass?.(name);
      if (!ext) this.fail(`unknown class ${name}`, line);
      layout = { species: ext!.species, props: ext!.properties.map((p) => ({ ...p })) };
    }
    this.project.layouts.set(name, layout);
    return layout;
  }

  private ownerOf(o: Obj): FnState["owner"] {
    const layout = this.objectLayout(o);
    const superSpecies = o.kind === "instance" ? this.layout(o.superName!, o.line).species : o.superName ? this.layout(o.superName, o.line).species : undefined;
    return { obj: o, layout: [...OBJECT_HEADER, ...layout.map((p) => p.name)], superSpecies };
  }

  /** An object's properties after the header, with the values it gives them. */
  private objectLayout(o: Obj): { name: string; value: Node | number }[] {
    if (o.kind === "class") return this.layout(o.name, o.line).props;
    const props = this.layout(o.superName!, o.line).props.map((p) => ({ ...p }));
    for (const p of o.props) {
      if (p.name === "name") continue;
      const slot = props.find((x) => x.name === p.name);
      if (!slot) this.fail(`${o.name}: ${o.superName} has no property ${p.name}`, p.line);
      slot!.value = p.value;
    }
    return props;
  }

  private objectLines(o: Obj): string[] {
    const lines: string[] = [""];
    const own = o.props.find((p) => p.name === "name");
    const name = own ? this.initValue(own.value) : `@${this.string(o.name)}`;
    if (o.kind === "class") {
      const sup = o.superName ? `$${this.layout(o.superName, o.line).species.toString(16)}` : "-";
      lines.push(`class ${o.name} of ${sup} species ${o.species}${o.superName ? ` ; ${o.superName}` : ""}`);
      lines.push(`  header ${OBJECT_HEADER.join(" ")}`, `  name ${name}`);
      for (const p of this.objectLayout(o)) lines.push(`  prop ${p.name} ${this.propValue(p.value)}`);
    } else {
      const layout = this.objectLayout(o);
      lines.push(`instance ${o.name} of $${this.layout(o.superName!, o.line).species.toString(16)} ; ${o.superName}`);
      lines.push(`  layout ${[...OBJECT_HEADER, ...layout.map((p) => p.name)].join(" ")}`, `  name ${name}`);
      for (const p of layout) lines.push(`  ${p.name} ${this.propValue(p.value)}`);
    }
    for (const m of o.methods) lines.push(`  method ${m.name} ${o.name}::${m.name}`);
    return lines;
  }

  private propValue(v: Node | number): string {
    return typeof v === "number" ? String(toWord(v)) : this.initValue(v);
  }

  /** A value fixed when the script loads: a number, a string, a selector, or an object in this script. */
  private initValue(n: Node): string {
    if (n.kind === "str") return `@${this.string(n.value)}`;
    if (n.kind === "sel") {
      this.project.sent.push({ name: n.name, file: this.unit.file, line: n.line });
      return `#${n.name}`;
    }
    if (n.kind === "sym" && this.objects.has(n.name) && this.objects.get(n.name)!.kind === "instance") return `@${n.name}`;
    return String(toWord(constValue(n, this.unit.defines, (m) => this.fail(m, n.line))));
  }

  private string(text: string): string {
    let label = this.strings.get(text);
    if (!label) this.strings.set(text, (label = `s_${this.strings.size}`));
    return label;
  }

  private label(): string {
    return `.L${++this.labels}`;
  }

  // --- Functions ---

  private function(f: Func, label: string, owner: FnState["owner"]): string[] {
    this.out.length = 0;
    const params = new Map(f.params.map((p, i) => [p, i + 1] as const));
    const temps = new Map<string, { index: number; size: number }>();
    let size = 0;
    for (const t of f.temps) (temps.set(t.name, { index: size, size: t.size }), (size += t.size));
    this.fn = { func: f, owner, params, temps, loops: [], switches: 0 };
    this.emit(`${label}:`);
    if (size) this.emit(`  link ${size}`);
    this.body(f.body);
    this.emit("  ret");
    this.fn = undefined;
    return ["", ...this.out];
  }

  private emit(line: string): void {
    this.out.push(line);
  }

  private op(line: string): void {
    this.out.push(`  ${line}`);
  }

  private body(nodes: Node[]): void {
    for (const n of nodes) this.expr(n);
  }

  /** What a name means here: variables first, then properties, then everything else. */
  private resolve(name: string, line: number): Ref {
    const fn = this.fn!;
    const temp = fn.temps.get(name);
    if (temp) return { kind: "var", type: "t", index: temp.index, size: temp.size };
    const param = fn.params.get(name);
    if (param !== undefined) return { kind: "var", type: "p", index: param, size: 1 };
    if (fn.owner?.layout.includes(name)) return { kind: "prop", name };
    const local = this.locals.get(name);
    if (local) return { kind: "var", type: this.unit.number === 0 ? "g" : "l", ...local };
    const global = this.project.globals.get(name);
    if (global) return { kind: "var", type: "g", ...global };
    if (name === "self") return { kind: "self" };
    if (name === "argc") return { kind: "argc" };
    const define = this.unit.defines.get(name);
    if (define) return { kind: "const", node: define };
    if (name in BUILTIN_DEFINES) return { kind: "const", node: { kind: "num", value: BUILTIN_DEFINES[name]!, line } };
    const obj = this.objects.get(name);
    if (obj?.kind === "instance") return { kind: "object", label: name };
    if (obj?.kind === "class" || this.project.classes.has(name) || this.project.ctx.externalClass?.(name)) {
      return { kind: "class", species: this.layout(name, line).species, name };
    }
    return this.fail(`unknown name ${name}`, line);
  }

  private varOp(action: "l" | "s" | "+" | "-", stack: boolean, ref: Ref & { kind: "var" }, indexed = false): string {
    // Script 0's own variables are the globals; elsewhere, its locals.
    const type = ref.type === "g" && this.unit.number === 0 ? "l" : ref.type;
    return `${action}${stack ? "s" : "a"}${type}${indexed ? "i" : ""} ${ref.index}`;
  }

  /** Evaluates into acc. */
  private expr(n: Node): void {
    switch (n.kind) {
      case "num": return this.op(`ldi ${toSigned(n.value)}`);
      case "str": return this.op(`lofsa @${this.string(n.value)}`);
      case "sel":
        this.project.sent.push({ name: n.name, file: this.unit.file, line: n.line });
        return this.op(`ldi #${n.name}`);
      case "addr": return this.address(n.name, n.index, n.line);
      case "index": {
        const [arr, i] = n.items;
        if (arr?.kind !== "sym" || !i || n.items.length !== 2) this.fail("an array element is [name index]", n.line);
        const ref = this.arrayRef((arr as { name: string }).name, n.line);
        this.expr(i!);
        return this.op(this.varOp("l", false, ref, true));
      }
      case "sym": {
        if (n.name === "&rest" || SEND_SELECTOR.test(n.name)) this.fail(`${n.name} only makes sense in a call or send`, n.line);
        const ref = this.resolve(n.name, n.line);
        switch (ref.kind) {
          case "var": return this.op(this.varOp("l", false, ref));
          case "prop": return this.op(`pToa ${ref.name}`);
          case "const": return this.op(`ldi ${toSigned(constValue(ref.node, this.unit.defines, (m) => this.fail(m, n.line)))}`);
          case "object": return this.op(`lofsa @${ref.label}`);
          case "class": return this.op(`class $${ref.species.toString(16)}`);
          case "self": return this.op("selfID");
          case "argc": return this.op("lap 0");
        }
        return;
      }
      case "list": return this.form(n);
    }
  }

  /** Pushes a value, in one instruction where there is one. */
  private push(n: Node): void {
    if (n.kind === "num" || (n.kind === "sym" && this.isConst(n.name))) {
      const v = n.kind === "num" ? n.value : constValue({ ...n }, this.unit.defines, (m) => this.fail(m, n.line));
      const w = toWord(v);
      return this.op(w === 0 ? "push0" : w === 1 ? "push1" : w === 2 ? "push2" : `pushi ${toSigned(w)}`);
    }
    if (n.kind === "sel") {
      this.project.sent.push({ name: n.name, file: this.unit.file, line: n.line });
      return this.op(`pushi #${n.name}`);
    }
    if (n.kind === "str") return this.op(`lofss @${this.string(n.value)}`);
    if (n.kind === "sym") {
      const ref = this.resolve(n.name, n.line);
      if (ref.kind === "var") return this.op(this.varOp("l", true, ref));
      if (ref.kind === "prop") return this.op(`pTos ${ref.name}`);
      if (ref.kind === "object") return this.op(`lofss @${ref.label}`);
      if (ref.kind === "self") return this.op("pushSelf");
    }
    this.expr(n);
    this.op("push");
  }

  private isConst(name: string): boolean {
    if (!this.fn) return true;
    const ref = (() => {
      try {
        return this.resolve(name, 0);
      } catch {
        return undefined;
      }
    })();
    return ref?.kind === "const";
  }

  private arrayRef(name: string, line: number): Ref & { kind: "var" } {
    const ref = this.resolve(name, line);
    if (ref.kind !== "var") this.fail(`${name} isn't a variable, so it can't be indexed`, line);
    return ref as Ref & { kind: "var" };
  }

  /** @name or @[name i]: the address of a variable, for kernels that write into it. */
  private address(name: string, index: Node | undefined, line: number): void {
    const ref = this.arrayRef(name, line);
    const kind = { g: 0, l: 1, t: 2, p: 3 }[ref.type === "g" && this.unit.number === 0 ? "l" : ref.type];
    if (index) this.expr(index);
    this.op(`lea ${(kind | (index ? 8 : 0)) << 1} ${ref.index}`);
  }

  private form(n: Node & { kind: "list" }): void {
    const [head, ...args] = n.items;
    if (!head) this.fail("() is empty", n.line);
    // A send: (target sel: ...), or (target [s] ...) with the selector in s.
    if (isMessageHead(args[0])) return this.send(head!, args, n.line);
    if (head!.kind !== "sym") {
      if (head!.kind === "list" || head!.kind === "index") this.fail(`expected a selector after ${show(head!)} (a send)`, n.line);
      this.fail(`can't call ${show(head!)}`, n.line);
    }
    const name = (head as { name: string }).name;
    const arity = (min: number, max = min) => {
      if (args.length < min || args.length > max) this.fail(`(${name} ...) takes ${min === max ? min : `${min} to ${max === Infinity ? "any number of" : max}`} argument(s)`, n.line);
    };
    switch (name) {
      case "send": {
        if (!args[0]) this.fail("(send target sel: ...)", n.line);
        return this.send(args[0]!, args.slice(1), n.line);
      }
      case "=": arity(2); return this.assign(args[0]!, args[1]!, n.line);
      case "++": case "--": arity(1); return this.increment(args[0]!, name === "++" ? "+" : "-", n.line);
      case "not": arity(1); this.expr(args[0]!); return this.op("not");
      case "~": arity(1); this.expr(args[0]!); return this.op("bnot");
      case "and": case "or": {
        arity(1, Infinity);
        const end = this.label();
        args.forEach((a, i) => {
          this.expr(a);
          if (i < args.length - 1) this.op(`${name === "and" ? "bnt" : "bt"} ${end}`);
        });
        return this.emit(`${end}:`);
      }
      case "if": return this.ifForm(args, n.line);
      case "cond": return this.cond(args, n.line);
      case "switch": return this.switchForm(args, n.line);
      case "switchto": {
        // (switchto value (body for 0...) (body for 1...) ...): cases by position.
        if (!args.length) this.fail("(switchto value (body...)...)", n.line);
        const cases = args.slice(1).map((c, i) => {
          if (c.kind !== "list") this.fail("a switchto case is (body...)", c.line);
          return { kind: "list", items: [{ kind: "num", value: i, line: c.line }, ...(c as { items: Node[] }).items], line: c.line } as Node;
        });
        return this.switchForm([args[0]!, ...cases], n.line);
      }
      case "while": {
        arity(1, Infinity);
        const top = this.label(), end = this.label();
        this.emit(`${top}:`);
        this.expr(args[0]!);
        this.op(`bnt ${end}`);
        this.loop(top, end, () => this.body(args.slice(1)));
        this.op(`jmp ${top}`);
        return this.emit(`${end}:`);
      }
      case "repeat": {
        const top = this.label(), end = this.label();
        this.emit(`${top}:`);
        this.loop(top, end, () => this.body(args));
        this.op(`jmp ${top}`);
        return this.emit(`${end}:`);
      }
      case "for": {
        arity(3, Infinity);
        const [init, test, step] = args;
        const list = (x: Node) => (x.kind === "list" && (x.items.length === 0 || x.items[0]!.kind === "list") ? x.items : [x]);
        this.body(list(init!));
        const top = this.label(), next = this.label(), end = this.label();
        this.emit(`${top}:`);
        this.expr(test!);
        this.op(`bnt ${end}`);
        this.loop(next, end, () => this.body(args.slice(3)));
        this.emit(`${next}:`);
        this.body(list(step!));
        this.op(`jmp ${top}`);
        return this.emit(`${end}:`);
      }
      case "break": case "continue": {
        arity(0);
        const loop = this.fn!.loops[this.fn!.loops.length - 1];
        if (!loop) this.fail(`(${name}) outside a loop`, n.line);
        // Leave the values of switches entered since the loop began.
        for (let i = loop!.switches; i < this.fn!.switches; i++) this.op("toss");
        return this.op(`jmp ${name === "break" ? loop!.brk : loop!.cont}`);
      }
      case "return":
        arity(0, 1);
        if (args[0]) this.expr(args[0]);
        return this.op("ret");
    }
    if (name in COMPOUND) {
      arity(2);
      const [target, value] = args as [Node, Node];
      return this.assign(target, { kind: "list", items: [{ kind: "sym", name: COMPOUND[name]!, line: n.line }, target, value], line: n.line }, n.line);
    }
    if (name in BINARY) {
      if (name === "-" && args.length === 1) {
        this.expr(args[0]!);
        return this.op("neg");
      }
      arity(2, name === "-" || name === "/" || name === "mod" || name === "<<" || name === ">>" ? 2 : Infinity);
      this.expr(args[0]!);
      for (const a of args.slice(1)) {
        this.op("push");
        this.expr(a);
        this.op(BINARY[name]!);
      }
      return;
    }
    if (name in COMPARE) {
      arity(2);
      this.push(args[0]!);
      this.expr(args[1]!);
      return this.op(COMPARE[name]!);
    }
    return this.call(name, args, n.line);
  }

  private loop(cont: string, brk: string, body: () => void): void {
    this.fn!.loops.push({ brk, cont, switches: this.fn!.switches });
    body();
    this.fn!.loops.pop();
  }

  private ifForm(args: Node[], line: number): void {
    if (!args.length) this.fail("(if condition ...)", line);
    const split = args.findIndex((a) => a.kind === "sym" && a.name === "else");
    const then = split < 0 ? args.slice(1) : args.slice(1, split);
    const otherwise = split < 0 ? undefined : args.slice(split + 1);
    const elseLabel = this.label(), end = this.label();
    this.expr(args[0]!);
    this.op(`bnt ${otherwise ? elseLabel : end}`);
    this.body(then);
    if (otherwise) {
      this.op(`jmp ${end}`);
      this.emit(`${elseLabel}:`);
      this.body(otherwise);
    }
    this.emit(`${end}:`);
  }

  private cond(clauses: Node[], line: number): void {
    const end = this.label();
    for (const c of clauses) {
      if (c.kind !== "list" || !c.items.length) this.fail("a cond clause is (condition body...)", c.line ?? line);
      const [test, ...body] = (c as { items: Node[] }).items as [Node, ...Node[]];
      if (test.kind === "sym" && test.name === "else") {
        this.body(body);
        break;
      }
      const next = this.label();
      this.expr(test);
      this.op(`bnt ${next}`);
      this.body(body);
      this.op(`jmp ${end}`);
      this.emit(`${next}:`);
    }
    this.emit(`${end}:`);
  }

  private switchForm(args: Node[], line: number): void {
    if (!args.length) this.fail("(switch value (case body...)...)", line);
    const end = this.label();
    this.expr(args[0]!);
    this.op("push");
    this.fn!.switches++;
    for (const c of args.slice(1)) {
      if (c.kind !== "list" || !c.items.length) this.fail("a switch case is (value body...)", c.line ?? line);
      const [value, ...body] = (c as { items: Node[] }).items as [Node, ...Node[]];
      if (value.kind === "sym" && value.name === "else") {
        this.body(body);
        break;
      }
      const next = this.label();
      this.op("dup");
      this.expr(value);
      this.op("eq?");
      this.op(`bnt ${next}`);
      this.body(body);
      this.op(`jmp ${end}`);
      this.emit(`${next}:`);
    }
    this.fn!.switches--;
    this.emit(`${end}:`);
    this.op("toss");
  }

  private assign(target: Node, value: Node, line: number): void {
    if (target.kind === "index") {
      const [arr, i] = target.items;
      if (arr?.kind !== "sym" || !i) this.fail("an array element is [name index]", line);
      const ref = this.arrayRef((arr as { name: string }).name, line);
      this.push(value);
      this.expr(i!);
      return this.op(this.varOp("s", false, ref, true));
    }
    if (target.kind !== "sym") this.fail(`can't assign to ${show(target)}`, line);
    const ref = this.resolve((target as { name: string }).name, line);
    this.expr(value);
    if (ref.kind === "var") return this.op(this.varOp("s", false, ref));
    if (ref.kind === "prop") return this.op(`aTop ${ref.name}`);
    this.fail(`can't assign to ${(target as { name: string }).name}`, line);
  }

  private increment(target: Node, dir: "+" | "-", line: number): void {
    if (target.kind === "index") {
      const [arr, i] = target.items;
      if (arr?.kind !== "sym" || !i) this.fail("an array element is [name index]", line);
      const ref = this.arrayRef((arr as { name: string }).name, line);
      this.expr(i!);
      return this.op(this.varOp(dir, false, ref, true));
    }
    if (target.kind !== "sym") this.fail(`can't change ${show(target)}`, line);
    const ref = this.resolve((target as { name: string }).name, line);
    if (ref.kind === "var") return this.op(this.varOp(dir, false, ref));
    if (ref.kind === "prop") return this.op(`${dir === "+" ? "ipToa" : "dpToa"} ${ref.name}`);
    this.fail(`can't change ${(target as { name: string }).name}`, line);
  }

  /**
   * Splits arguments from a trailing `&rest` (the caller's arguments after its named ones) or
   * `&rest param` (from that parameter on).
   */
  private restSplit(args: Node[], line: number): { explicit: Node[]; rest?: number } {
    const at = args.findIndex((a) => a.kind === "sym" && a.name === "&rest");
    if (at < 0) return { explicit: args };
    const from = args[at + 1];
    const fromParam = from?.kind === "sym" ? this.fn!.params.get(from.name) : undefined;
    if (args.length > at + (fromParam === undefined ? 1 : 2)) this.fail("&rest goes last", line);
    return { explicit: args.slice(0, at), rest: fromParam ?? this.fn!.func.params.length + 1 };
  }

  /** Pushes arguments; returns the frame size in bytes (what &rest adds is counted at run time). */
  private pushArgs(args: { explicit: Node[]; rest?: number }): number {
    for (const a of args.explicit) this.push(a);
    if (args.rest !== undefined) this.op(`&rest ${args.rest}`);
    return args.explicit.length * 2;
  }

  private send(target: Node, messages: Node[], line: number): void {
    let frame = 0;
    for (let i = 0; i < messages.length; ) {
      const sel = messages[i]!;
      if (!isMessageHead(sel)) this.fail(`expected a selector like x: or init:, got ${show(sel)}`, sel.line);
      let j = i + 1;
      while (j < messages.length && !isMessageHead(messages[j])) j++;
      const args = this.restSplit(messages.slice(i + 1, j), sel.line);
      if (sel.kind === "sym") {
        const name = SEND_SELECTOR.exec(sel.name)![1]!;
        this.project.sent.push({ name, file: this.unit.file, line: sel.line });
        this.op(`pushi #${name}`);
      }
      else this.push((sel as { items: Node[] }).items[0]!);
      this.push({ kind: "num", value: args.explicit.length, line });
      frame += 4 + this.pushArgs(args);
      i = j;
    }
    if (!messages.length) this.fail("a send needs at least one selector", line);
    if (target.kind === "sym" && target.name === "self") return this.op(`self ${frame}`);
    if (target.kind === "sym" && target.name === "super") {
      const sup = this.fn!.owner?.superSpecies;
      if (sup === undefined) this.fail("super: this object has no superclass", line);
      return this.op(`super $${sup!.toString(16)} ${frame}`);
    }
    this.expr(target);
    this.op(`send ${frame}`);
  }

  private call(name: string, args: Node[], line: number): void {
    const local = this.procedures.has(name);
    const ext = local ? undefined : this.unit.externs.get(name) ?? this.project.publicProcs.get(name);
    const kernel = local || ext ? -1 : this.project.ctx.kernelNames.indexOf(name);
    if (!local && !ext && kernel < 0) {
      if (this.objects.has(name) || this.project.classes.has(name)) this.fail(`${name} is an object: send it a message, like (${name} init:)`, line);
      this.fail(`unknown procedure or kernel ${name}`, line);
    }
    const split = this.restSplit(args, line);
    this.push({ kind: "num", value: split.explicit.length, line });
    const frame = this.pushArgs(split);
    if (local) this.op(`call ${name} ${frame}`);
    else if (ext) this.op(ext.script === 0 ? `callb ${ext.index} ${frame}` : `calle ${ext.script} ${ext.index} ${frame}`);
    else this.op(`callk ${name} ${frame}`);
  }
}

const toWord = (v: number) => ((v % 0x10000) + 0x10000) % 0x10000;
const toSigned = (v: number) => {
  const w = toWord(v);
  return w >= 0x8000 ? w - 0x10000 : w;
};

function quote(text: string): string {
  let s = '"';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (ch === '"' || ch === "\\") s += `\\${ch}`;
    else if (ch === "\n") s += "\\n";
    else if (c >= 0x20 && c < 0x7f) s += ch;
    else s += `\\x${(c & 0xff).toString(16).padStart(2, "0")}`;
  }
  return `${s}"`;
}
