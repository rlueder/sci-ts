import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGame } from "../../../tools/game/build.ts";
import { CompileError, ResourceManager, Vm, allKernels, compileScripts, kernelNames, read, writeResourceArchive, type FileSource } from "../src/index.ts";

// The script compiler, tested by running what it compiles: each program writes its results
// into script 0's array `out`, which the test reads back.

const memoryFiles = (files: Record<string, Uint8Array>): FileSource => ({
  read: async (path) => files[path],
  readRange: async (path, offset, length) => files[path]!.slice(offset, offset + length),
  list: async (dir) => (dir === "" ? Object.keys(files) : []),
});

function gameDir(scripts: Record<number | string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sci-compile-"));
  mkdirSync(join(dir, "scripts"));
  for (const [name, text] of Object.entries(scripts)) {
    writeFileSync(join(dir, /^\d+$/.test(name) ? `scripts/${name}.sc` : name), text);
  }
  return dir;
}

/** Builds and runs a game whose test object's play method is `body`; returns `out`. */
async function run(body: string, more: { top?: string; scripts?: Record<number | string, string> } = {}): Promise<number[]> {
  const game = await buildGame(gameDir({
    0: `(script 0)
(public t 0)
(local [out 16] counter)
(class Obj)
${more.top ?? ""}
(instance t of Obj
  (method (play) ${body}))`,
    ...more.scripts,
  }), { library: false });
  const { map, volume } = writeResourceArchive(game.resources);
  const rm = await ResourceManager.open(memoryFiles({ "RESOURCE.MAP": map, "RESOURCE.000": volume }));
  await rm.preload();
  const vm = new Vm(rm);
  vm.registerKernels(allKernels);
  vm.start(vm.exportAddress(0, 0), "play");
  for (let i = 0; vm.running && i < 100; i++) vm.run();
  if (vm.running) throw new Error("still running");
  const locals = vm.loadedScripts.find((s) => s.number === 0)!.locals;
  return locals.slice(0, 16).map((v) => (typeof v === "number" ? (v >= 0x8000 ? v - 0x10000 : v) : -999));
}

describe("expressions", () => {
  it("arithmetic, with 16-bit wraparound", async () => {
    expect(await run(`
      (= [out 0] (+ 1 2 3))
      (= [out 1] (- 10 3))
      (= [out 2] (* -3 4))
      (= [out 3] (/ 7 2))
      (= [out 4] (mod -7 3))
      (= [out 5] (<< 1 4))
      (= [out 6] (>> 256 4))
      (= [out 7] (& 12 10))
      (= [out 8] (| 12 3))
      (= [out 9] (^ 5 1))
      (= [out 10] (- 5))
      (= [out 11] (~ 0))
      (= [out 12] (+ 32767 1))
      (= [out 13] (* 6 (+ 2 5) (- 4 1)))`)).toEqual([6, 7, -12, 3, 2, 16, 16, 8, 15, 4, -5, -1, -32768, 126, 0, 0]);
  });

  it("comparisons, signed and unsigned", async () => {
    const out = await run(`
      (= [out 0] (< -1 0))
      (= [out 1] (u< -1 0))
      (= [out 2] (== 3 3))
      (= [out 3] (!= 3 3))
      (= [out 4] (>= 2 2))
      (= [out 5] (> 2 2))
      (= [out 6] (u> -1 0))
      (= [out 7] (not 0))
      (= [out 8] (not 7))`);
    expect(out.slice(0, 9)).toEqual([1, 0, 1, 0, 1, 0, 1, 1, 0]);
  });

  it("and/or stop early", async () => {
    const out = await run(`
      (= [out 0] (or 0 5 (++ counter)))
      (= [out 1] (and 1 0 (++ counter)))
      (= [out 2] (and 1 2 3))
      (= [out 3] (or 0 0))
      (= [out 4] counter)`);
    expect(out.slice(0, 5)).toEqual([5, 0, 3, 0, 0]);
  });

  it("constants, enums, characters and hex", async () => {
    const out = await run(`
      (= [out 0] SPEED)
      (= [out 1] DOUBLE)
      (= [out 2] LOOK) (= [out 3] DO) (= [out 4] TALK)
      (= [out 5] \`A)
      (= [out 6] $1F)
      (= [out 7] %101)
      (= [out 8] TRUE)`, { top: "(define SPEED 6) (define DOUBLE (* SPEED 2)) (enum 1 LOOK DO (= TALK 10))" });
    expect(out.slice(0, 9)).toEqual([6, 12, 1, 2, 10, 65, 31, 5, 1]);
  });
});

describe("control flow", () => {
  it("if, cond and switch", async () => {
    const out = await run(`
      (= [out 0] (if (> 3 2) 10 else 20))
      (= [out 1] (if 0 10 else 20))
      (if 0 (= [out 2] 99))
      (= [out 3] (cond ((== counter 1) 1) ((== counter 0) 2) (else 3)))
      (= [out 4] (switch 3 (1 10) (3 30) (else 50)))
      (= [out 5] (switch 9 (1 10) (3 30) (else 50)))`);
    expect(out.slice(0, 6)).toEqual([10, 20, 0, 2, 30, 50]);
  });

  it("loops: while, for, repeat, break and continue", async () => {
    const out = await run(`
      (= counter 0)
      (while (< counter 10) (++ counter))
      (= [out 0] counter)
      (for ((= counter 0) (= [out 1] 0)) (<= counter 100) ((++ counter)) (+= [out 1] counter))
      (= counter 0)
      (repeat (if (== (++ counter) 7) (break)))
      (= [out 2] counter)
      (for ((= counter 0)) (< counter 10) ((++ counter))
        (if (mod counter 2) (continue))
        (++ [out 3]))`);
    expect(out.slice(0, 4)).toEqual([10, 5050, 7, 5]);
  });

  it("break and continue inside a switch keep the stack balanced", async () => {
    // 2000 rounds of leaving a switch early: any word left on the stack would overflow it.
    const out = await run(`
      (for ((= counter 0)) (< counter 2000) ((++ counter))
        (switch (mod counter 3)
          (0 (continue))
          (1 (++ [out 0]))
          (else (++ [out 1])))
        (if (== counter 1999) (break)))
      (= [out 2] counter)`);
    expect(out.slice(0, 3)).toEqual([667, 666, 1999]);
  });
});

describe("procedures and variables", () => {
  const top = `
(procedure (factorial n)
  (if (<= n 1) (return 1))
  (return (* n (factorial (- n 1)))))

(procedure (sum3 a b c)
  (return (+ a b c)))

(procedure (forward)
  (return (sum3 &rest)))

(procedure (count)
  (return argc))

(procedure (fill &tmp i [buf 4])
  (for ((= i 0)) (< i 4) ((++ i)) (= [buf i] (* i i)))
  (return (+ [buf 1] [buf 2] [buf 3])))`;

  it("calls, recursion, &rest, argc and temporaries", async () => {
    const out = await run(`
      (= [out 0] (factorial 7))
      (= [out 1] (forward 1 2 3))
      (= [out 2] (count 4 5 6 7))
      (= [out 3] (fill))
      (= [out 4] (count))`, { top });
    expect(out.slice(0, 5)).toEqual([5040, 6, 4, 14, 0]);
  });

  it("arrays: indexed reads, writes and increments", async () => {
    const out = await run(`
      (= counter 3)
      (= [out counter] 42)
      (++ [out counter])
      (-- [out 0])
      (= [out 1] [out counter])`);
    expect(out.slice(0, 4)).toEqual([-1, 43, 0, 43]);
  });
});

describe("objects", () => {
  const top = `
(class Thing of Obj
  (properties size 1 weight 10)
  (method (heavier n) (+= weight n) (return weight))
  (method (describe) (return (* size 100))))

(class Box of Thing
  (properties size 2 lid 0)
  (method (describe) (return (+ (super describe:) lid))))

(instance box of Box (properties lid 7))
(instance thing of Thing)`;

  it("properties, inheritance, overriding and super", async () => {
    const out = await run(`
      (= [out 0] (box size?))
      (= [out 1] (box weight?))
      (= [out 2] (box describe:))
      (= [out 3] (thing describe:))
      (box lid: 1 size: 3)
      (= [out 4] (box describe:))
      (= [out 5] (box heavier: 5))
      (= [out 6] (thing weight?))
      (= [out 7] (box respondsTo: #describe))`, { top: `${top}\n(class Base of Obj (method (respondsTo s) (RespondsTo self s)))`.replace("(class Thing of Obj", "(class Thing of Base") });
    expect(out.slice(0, 8)).toEqual([2, 10, 207, 100, 301, 15, 10, 1]);
  });
});

describe("several scripts", () => {
  it("shares classes, globals and procedures between scripts", async () => {
    const out = await run(`
      (= [out 0] (triple 5))
      (= counter 4)
      (bump)
      (= [out 1] counter)
      (= [out 2] ((Widget new:) value:))
      (= [out 3] ((ScriptID 11 0) describe:))`, {
      top: "(public twice 1)\n(procedure (twice n) (return (* n 2)))\n(define LIBRARY 10)",
      scripts: {
        10: `(script 10)
(include "shared.sh")
(public triple 0 bump 1)
(procedure (triple n) (return (+ (twice n) n)))
(procedure (bump) (+= counter BUMP))
(class Widget of Obj
  (properties value 77)
  (method (new) (return (Clone self))))`,
        11: `(script 11)
(public lib 0)
(instance lib of Widget
  (method (describe) (return (+ value 1))))`,
        "shared.sh": "(define BUMP 3)",
      },
    });
    expect(out.slice(0, 4)).toEqual([15, 7, 77, 78]);
  });
});

describe("more forms", () => {
  it("switchto picks a case by position", async () => {
    const out = await run(`
      (= [out 0] (switchto 2 (10) (20) (30)))
      (= [out 1] (switchto 0 (10) (20)))`);
    expect(out.slice(0, 2)).toEqual([30, 10]);
  });

  it("selectors as property values, sent later", async () => {
    const out = await run(`(= [out 0] (doer act:))`, {
      top: `(instance doer of Obj
  (properties action #twice)
  (method (act) (return (self [action] 21)))
  (method (twice n) (return (* n 2))))`.replace("(instance doer of Obj\n  (properties action #twice)", "(class Doer of Obj (properties action 0))\n(instance doer of Doer\n  (properties action #twice)"),
    });
    expect(out[0]).toBe(42);
  });

  it("@[buf i] is the address of an element", () => {
    const [script] = compileScripts([{ file: "x.sc", text: "(script 1)\n(local [buf 4])\n(procedure (f) (return @[buf 2]))" }], { kernelNames });
    // lea: locals (1), indexed (8), shifted left once; then buf's first slot.
    expect(script!.assembly).toMatch(/ldi 2\n\s+lea 18 0/);
  });
});

describe("warnings", () => {
  it("name sends of selectors nothing defines", () => {
    const warnings: string[] = [];
    compileScripts(
      [{ file: "x.sc", text: "(script 1)\n(class Obj (properties x 0) (method (show)))\n(instance a of Obj)\n(procedure (f)\n  (a show: x: 1)\n  (a shwo:)\n  (a respondsTo: #hide))" }],
      { kernelNames, onWarning: (w) => warnings.push(`${w.file}:${w.line}: ${w.message}`) },
    );
    expect(warnings).toEqual([
      "x.sc:6: nothing defines shwo (no class or object has a property or method by that name)",
      "x.sc:7: nothing defines respondsTo (no class or object has a property or method by that name)",
      "x.sc:7: nothing defines hide (no class or object has a property or method by that name)",
    ]);
  });
});

describe("errors", () => {
  const compile = (text: string) => compileScripts([{ file: "x.sc", text }], { kernelNames });
  const fails = (text: string, message: RegExp) => expect(() => compile(text)).toThrow(message);

  it("say where", () => {
    fails("(script 1)\n(procedure (f)\n  (+ nope 1))", /x\.sc:3: unknown name nope/);
    fails("(script 1)\n(instance a of Nothing)", /x\.sc:2: unknown class Nothing/);
    fails("(script 1)\n(procedure (f) (break))", /\(break\) outside a loop/);
    fails("(script 1)\n(procedure (g))\n(procedure (f) (g 1 &rest 2))", /&rest goes last/);
    fails("(script 1)\n(procedure (f) (not 1 2))", /takes 1 argument/);
    fails("(script 1)\n(procedure (f) (Frobnicate))", /unknown procedure or kernel Frobnicate/);
    fails("(script 1)\n(public f 0 g 0)\n(procedure (f))\n(procedure (g))", /export 0 is used twice/);
    fails("(script 1)\n(procedure (f) (+ 1 2)", /never closed/);
    fails("(procedure (f))", /missing \(script N\)/);
    fails("(script 1)\n(class A of Obj (properties x))", /x needs a value/);
  });

  it("are CompileErrors with a file and line", () => {
    try {
      compile("(script 1)\n\n(procedure (f) (+ nope 1))");
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      expect((e as CompileError).line).toBe(3);
    }
  });
});

describe("the reader", () => {
  it("reads lists, arrays, strings, selectors, addresses and characters", () => {
    expect(read('(a [b 1] "s\\"x" {braces} #init @buf `a ; comment\n -$10 %11)')[0]).toMatchObject({
      kind: "list",
      items: [
        { kind: "sym", name: "a" },
        { kind: "index", items: [{ kind: "sym", name: "b" }, { kind: "num", value: 1 }] },
        { kind: "str", value: 's"x' },
        { kind: "str", value: "braces" },
        { kind: "sel", name: "init" },
        { kind: "addr", name: "buf" },
        { kind: "num", value: 97 },
        { kind: "num", value: -16, line: 2 },
        { kind: "num", value: 3 },
      ],
    });
  });
});
