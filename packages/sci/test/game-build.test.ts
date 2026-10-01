import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameBuildError, buildGame } from "../../../tools/game/build.ts";
import { pixelFont } from "../../../tools/game/font.ts";
import { stringHelpers } from "../src/vm/kernels/arrays.ts";
import {
  EventType, ResourceManager, ResourceType, Vm, allKernels, graphics, input, parseClassTable, parseFont, parseSelectorNames,
  writeClassTable, writeFont, writeResourceArchive, writeSelectorNames, type FileSource, type Value,
} from "../src/index.ts";

// Building games from nothing: the writers a build needs, and games/hello built and played.

const memoryFiles = (files: Record<string, Uint8Array>): FileSource => ({
  read: async (path) => files[path],
  readRange: async (path, offset, length) => files[path]!.slice(offset, offset + length),
  list: async (dir) => (dir === "" ? Object.keys(files) : []),
});

async function open(resources: Parameters<typeof writeResourceArchive>[0]) {
  const { map, volume } = writeResourceArchive(resources);
  const rm = await ResourceManager.open(memoryFiles({ "RESOURCE.MAP": map, "RESOURCE.000": volume }));
  await rm.preload();
  return rm;
}

describe("resource archives", () => {
  const resources = [
    { type: ResourceType.View, number: 900, data: Uint8Array.from([1, 2, 3]) },
    { type: ResourceType.Script, number: 0, data: new Uint8Array(70_000).fill(7) },
    { type: ResourceType.View, number: 0, data: new Uint8Array(0) },
    { type: ResourceType.Vocab, number: 997, data: Uint8Array.from([9]) },
  ];

  it("open with the resource manager and give back what went in", async () => {
    const rm = await open(resources);
    expect(rm.list().map((r) => `${r.type}:${r.number}`)).toEqual(["0:0", "0:900", "2:0", "6:997"]);
    for (const r of resources) expect((await rm.load(r)).data).toEqual(r.data);
  });

  it("refuse the same resource twice", () => {
    expect(() => writeResourceArchive([resources[0]!, resources[0]!])).toThrow(/twice/);
  });
});

describe("vocabularies", () => {
  it("selector names round-trip", () => {
    const names = ["-objID-", "name", "x", "doVerb", "", "a-long-selector-name"];
    expect(parseSelectorNames(writeSelectorNames(names))).toEqual(names);
  });

  it("the class table round-trips", () => {
    expect(parseClassTable(writeClassTable([999, 0, 0, 12]))).toEqual([999, 0, 0, 12]);
  });
});

describe("the default font", () => {
  const font = pixelFont();

  it("has a glyph for every printable character", () => {
    for (let c = 32; c < 127; c++) expect(font.glyphs[c]!.width, String.fromCharCode(c)).toBeGreaterThan(0);
  });

  it("round-trips through the font format", () => {
    const back = parseFont(writeFont(font));
    expect(back.height).toBe(font.height);
    for (let c = 32; c < 127; c++) expect(back.glyphs[c]).toEqual(font.glyphs[c]);
  });
});

describe("games/hello, on the class library", async () => {
  const game = await buildGame("games/hello");

  it("numbers selectors from the object header on, and the root class first", () => {
    expect(game.selectors.slice(0, 9)).toEqual(["-objID-", "-size-", "-propDict-", "-methDict-", "-classScript-", "-script-", "-super-", "-info-", "name"]);
    expect(game.classes.get(0)).toEqual({ name: "Obj", script: 999 });
    for (const name of ["Game", "Room", "Ego", "PolyPath", "Messager", "User", "Sound"]) {
      expect([...game.classes.values()].some((c) => c.name === name), name).toBe(true);
    }
  });

  it("plays: walks, looks, reads a message, and goes to the next room", async () => {
    const vm = new Vm(await open(game.resources));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) {
        vm.run();
        if (!vm.yieldRequested) throw new Error(`no frame: ${vm.backtrace().join(" / ")}`);
      }
    };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const prop = (obj: Value, name: string) => g.prop(obj, name);
    const inp = input(vm);
    const click = (x: number, y: number, right = false) => {
      [inp.x, inp.y] = [x, y];
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: right ? 3 : 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
      frames(1);
    };
    /** The line the narrator is showing, or "" if none. */
    const line = () => {
      const box = vm.getProp(global("narrator"), "box") ?? 0;
      return box ? stringHelpers.str(vm, vm.getProp(box, "text")!) : "";
    };

    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    expect(vm.missingKernels.size).toBe(0);
    expect(global("curRoomNum")).toBe(1);
    const ego = global("ego");
    expect([prop(ego, "x"), prop(ego, "y")]).toEqual([40, 175]);

    // Walk (the first verb) to a point on the grass, facing east as he goes.
    click(200, 180);
    frames(2);
    expect(prop(ego, "loop")).toBe(0);
    frames(400);
    expect([prop(ego, "x"), prop(ego, "y")]).toEqual([200, 180]);
    expect(prop(ego, "cel")).toBe(0);

    // A click above the crest goes as far as the grass does.
    click(100, 60);
    frames(400);
    expect(prop(ego, "y")).toBe(158);

    // Right-click: walk -> do -> look. Look at the moon: two lines, a click for each.
    click(0, 0, true);
    click(0, 0, true);
    expect(g.cursor.view).toBe(991);
    click(260, 30);
    expect(line()).toBe("The moon is full tonight.");
    click(10, 10);
    expect(line()).toBe("Bright enough to read by.");
    click(10, 10);
    expect(line()).toBe("");
    // The lantern, which animates.
    click(160, 168);
    expect(line()).toBe("A brass lantern, left burning in the grass.");
    // Lines go by themselves too.
    frames(300);
    expect(line()).toBe("");

    // Back to walking (look -> talk -> walk), and east, off the edge of the hill.
    click(0, 0, true);
    click(0, 0, true);
    expect(g.cursor.view).toBe(993);
    click(319, 175);
    frames(600);
    expect(global("curRoomNum")).toBe(2);
    expect(global("prevRoomNum")).toBe(1);
    expect(prop(global("ego"), "x")).toBe(10);
    expect(g.compose().pixels.length).toBe(320 * 200);

    // The sign on the road.
    click(0, 0, true);
    click(0, 0, true);
    click(250, 135);
    expect(line()).toBe("The sign says: TOWN, 2 MILES.");
  });
});

describe("the class library", () => {
  it("plays and stops a Sound (one with no resource just doesn't sound)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sci-lib-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "0.sc"), `(script 0)
(include "system.sh")
(public t 0)
(local [out 4])
(instance t of Game
  (method (play)
    (self init:)
    (song number: 123 play:)
    (= [out 0] (song handle?))
    (song stop:)
    (= [out 1] (song handle?))
    (= [out 2] (sounds size?))
    (song dispose:)
    (= [out 3] (sounds size?))))
(instance song of Sound)`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources));
    vm.registerKernels(allKernels);
    vm.start(vm.exportAddress(0, 0), "play");
    for (let i = 0; vm.running && i < 10; i++) vm.run();
    const out = vm.loadedScripts.find((s) => s.number === 0)!.locals.slice(0, 4);
    expect(out[0]).not.toBe(0);
    expect(out.slice(1)).toEqual([0, 1, 0]);
  });
});

describe("game build errors", () => {
  const game = (scripts: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "sci-game-"));
    mkdirSync(join(dir, "scripts"));
    for (const [n, text] of Object.entries(scripts)) writeFileSync(join(dir, "scripts", `${n}.sca`), text);
    return dir;
  };
  const obj = "script 999\nclass Obj of - species 0\n  header -objID- -size- -propDict- -methDict- -classScript- -script- -super- -info- name\n";

  it("names the file and the problem", async () => {
    await expect(buildGame(game({ 0: "script 0\ninstance x of Nothing\n" }), { library: false })).rejects.toThrow(/0\.sca: line 2: unknown class Nothing/);
  });

  it("refuses two classes with one species number", async () => {
    await expect(buildGame(game({ 999: obj, 0: "script 0\nclass A of Obj species 0\n" }), { library: false })).rejects.toThrow(GameBuildError);
  });

  it("needs script 0", async () => {
    await expect(buildGame(game({ 999: obj }), { library: false })).rejects.toThrow(/no scripts\/0\.sc or 0\.sca/);
  });
});
