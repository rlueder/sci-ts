import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameBuildError, buildGame } from "../../../tools/game/build.ts";
import { pixelFont } from "../../../tools/game/font.ts";
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

describe("games/hello", async () => {
  const game = await buildGame("games/hello");

  it("numbers selectors from the object header on, and lists its classes", () => {
    expect(game.selectors.slice(0, 9)).toEqual(["-objID-", "-size-", "-propDict-", "-methDict-", "-classScript-", "-script-", "-super-", "-info-", "name"]);
    expect([...game.classes.values()].map((c) => c.name).sort()).toEqual(["Event", "Game", "Obj", "Plane", "Sprite"]);
    expect(game.classes.get(0)).toEqual({ name: "Obj", script: 999 });
  });

  it("runs: draws its picture, text and lantern, and moves the lantern to a click", async () => {
    const vm = new Vm(await open(game.resources));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frame = () => {
      vm.run();
      if (!vm.yieldRequested) throw new Error("no frame");
    };
    vm.start(vm.exportAddress(0, 0), "play");
    frame();
    expect(vm.missingKernels.size).toBe(0);

    const pixels = g.compose().pixels;
    // White text in the title's rows.
    let white = 0;
    for (let y = 12; y < 24; y++) for (let x = 0; x < 320; x++) white += pixels[y * 320 + x] === 255 ? 1 : 0;
    expect(white).toBeGreaterThan(100);

    const lantern = [...g.items].find((item: Value) => vm.object(item).name === "lantern")!;
    expect([g.prop(lantern, "x"), g.prop(lantern, "y")]).toEqual([160, 150]);
    const inp = input(vm);
    [inp.x, inp.y] = [50, 120];
    inp.push({ type: EventType.MouseDown, message: 0 });
    frame();
    expect([g.prop(lantern, "x"), g.prop(lantern, "y")]).toEqual([50, 120]);
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
    await expect(buildGame(game({ 0: "script 0\ninstance x of Nothing\n" }))).rejects.toThrow(/0\.sca: line 2: unknown class Nothing/);
  });

  it("refuses two classes with one species number", async () => {
    await expect(buildGame(game({ 999: obj, 0: "script 0\nclass A of Obj species 0\n" }))).rejects.toThrow(GameBuildError);
  });

  it("needs script 0", async () => {
    await expect(buildGame(game({ 999: obj }))).rejects.toThrow(/no scripts\/0\.sca/);
  });
});
