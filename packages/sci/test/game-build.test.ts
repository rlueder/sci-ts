import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameBuildError, buildGame } from "../../../tools/game/build.ts";
import { newGame } from "../../../tools/game/new.ts";
import { pixelFont } from "../../../tools/game/font.ts";
import { stringHelpers } from "../src/vm/kernels/arrays.ts";
import {
  EventType, ResourceManager, audio, ResourceType, Vm, allKernels, graphics, input, parseClassTable, parseFont, parseSelectorNames,
  writeClassTable, writeFont, writeResourceArchive, writeSelectorNames, type FileSource, type Value,
} from "../src/index.ts";

// Building games from nothing: the writers a build needs, and games/hello built and played.

const memoryFiles = (files: Record<string, Uint8Array>): FileSource => ({
  read: async (path) => files[path],
  readRange: async (path, offset, length) => files[path]!.slice(offset, offset + length),
  list: async (dir) => (dir === "" ? Object.keys(files) : []),
});

async function open(resources: Parameters<typeof writeResourceArchive>[0], files: Record<string, Uint8Array> = {}) {
  const { map, volume } = writeResourceArchive(resources);
  const rm = await ResourceManager.open(memoryFiles({ "RESOURCE.MAP": map, "RESOURCE.000": volume, ...files }));
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
    expect(game.selectors.slice(0, 9)).toEqual(["-objID-", "-size-", "-propDict-", "-methDict-", "-classScript-", "-species-", "-super-", "-info-", "name"]);
    expect(game.classes.get(0)).toEqual({ name: "Obj", script: 999 });
    for (const name of ["Game", "Room", "Ego", "PolyPath", "Messager", "User", "Sound"]) {
      expect([...game.classes.values()].some((c) => c.name === name), name).toBe(true);
    }
  });

  it("plays: walks, looks, reads messages, goes to the next room and has a conversation", async () => {
    const vm = new Vm(await open(game.resources, game.files));
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
    /** The line being shown, or "" if none. */
    const line = () => {
      const who = global("talking");
      const box = who ? vm.getProp(who, "box") ?? 0 : 0;
      return box ? stringHelpers.str(vm, vm.getProp(box, "text")!) : "";
    };
    /** The open menu's choices. */
    const menu = () => {
      const d = global("dialog");
      if (!d) return [];
      const out: { text: string; x: number; y: number }[] = [];
      const list = vm.getProp(vm.getProp(d, "items")!, "elements")!;
      for (let n = vm.memory.list(list)?.first; n; n = n.next) {
        out.push({ text: stringHelpers.str(vm, vm.getProp(n.value, "text")!), x: prop(n.value, "x"), y: prop(n.value, "y") });
      }
      return out;
    };

    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    expect(vm.missingKernels.size).toBe(0);
    expect(global("curRoomNum")).toBe(1);
    const ego = global("ego");
    expect([prop(ego, "x"), prop(ego, "y")]).toEqual([40, 175]);
    // The night's tune (made in code: sound 100) is playing, on a loop.
    const music = global("music");
    expect(prop(music, "number")).toBe(100);
    const player = audio(vm).songs.get(music);
    expect(player?.loop).toBe(true);

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

    // Do on the lantern: it chimes (sounds/50.wav, a digital effect), then speaks.
    click(0, 0, true);
    click(0, 0, true);
    click(0, 0, true);
    expect(g.cursor.view).toBe(994);
    click(160, 168);
    expect(prop(global("sfx"), "number")).toBe(50);
    expect(vm.getProp(global("sfx"), "handle")).not.toBe(0);
    expect(audio(vm).index.effects.has(50)).toBe(true);
    expect(line()).toBe("It's warm. Whoever left it will be back for it.");
    click(10, 10);
    click(0, 0, true); // do -> look

    // Back to walking (look -> talk -> walk), and east, off the edge of the hill.
    click(0, 0, true);
    click(0, 0, true);
    expect(g.cursor.view).toBe(993);
    click(319, 175);
    for (let i = 0; i < 600 && global("curRoomNum") !== 2; i++) frames(1);
    expect(global("curRoomNum")).toBe(2);
    expect(global("prevRoomNum")).toBe(1);
    expect(prop(global("ego"), "x")).toBe(10);
    // The road plays the same tune: it carries on rather than starting again.
    expect(audio(vm).songs.get(global("music"))).toBe(player);

    // Room 2 is YAML and Yarn. Arriving the first time, a line (set by a flag).
    frames(3);
    expect(line()).toBe("A cold wind comes down the road.");
    click(10, 10);
    expect(line()).toBe("");

    // The sign (walk -> do -> look).
    click(0, 0, true);
    click(0, 0, true);
    click(250, 135);
    expect(line()).toBe("The sign reads TOWN, 2 MILES.");
    click(10, 10);

    // Talk to the traveller: a menu of topics, one of them hidden for now.
    click(0, 0, true);
    expect(g.cursor.view).toBe(992);
    click(180, 166);
    expect(menu().map((m) => m.text)).toEqual(["Where are you going?", "Was that your lantern on the hill?", "Goodbye."]);
    const choose = (text: string) => {
      const item = menu().find((m) => m.text === text)!;
      click(item.x + 4, item.y + 4);
    };
    choose("Was that your lantern on the hill?");
    expect(line()).toBe("Traveller: I left it burning for whoever came next.");
    // He has a portrait at the top left, and the line goes beside it.
    const part = (name: string) => [...g.items].find((it) => vm.object(it).name === name);
    const bust = part("travellerBust")!;
    expect([prop(bust, "x"), prop(bust, "y")]).toEqual([8, 8]);
    const box = vm.getProp(global("talking"), "box")!;
    expect([prop(box, "x"), prop(box, "y")]).toEqual([8 + 34 + 6, 8]);
    // His mouth moves while he says it, then closes while the line stays up; his eyes blink.
    const mouthCels = new Set<number>(), eyeCels = new Set<number>();
    for (let i = 0; i < 200; i++) {
      frames(1);
      mouthCels.add(prop(part("travellerMouth")!, "cel"));
      eyeCels.add(prop(part("travellerEyes")!, "cel"));
    }
    expect(mouthCels).toEqual(new Set([0, 1]));
    expect(eyeCels).toEqual(new Set([0, 1]));
    expect(line()).toBe("Traveller: I left it burning for whoever came next.");
    expect([prop(part("travellerMouth")!, "cel"), prop(part("travellerMouth")!, "cycler")]).toEqual([0, 0]);
    click(10, 10);
    expect(line()).toBe("You: That's kind of you.");
    click(10, 10);
    // The answer set a flag: the menu again, with the topic it opened.
    frames(1);
    expect(menu().map((m) => m.text)).toEqual(["Where are you going?", "Was that your lantern on the hill?", "What's at the fair?", "Goodbye."]);
    choose("What's at the fair?");
    expect(line()).toBe("Traveller: Lanterns, mostly.");
    click(10, 10);
    frames(1);
    choose("Goodbye.");
    expect(menu()).toEqual([]);
    expect(global("dialog")).toBe(0);
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

describe("the text style", () => {
  it("gives every box the game's font, colours and frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sci-style-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "0.sc"), `(script 0)
(include "system.sh")
(public t 0)
(instance t of Game
  (method (init)
    (super init:)
    (textStyle font: 1 fore: 7 back: 9 frame: 260)
    (narrator say: "Hi")))`);
    // Font 1, and a frame: eight 3x3 cels, each its own colour (10 + cel), anchored top-left.
    const kit = new URL("../../../tools/game/kit.ts", import.meta.url).href;
    writeFileSync(join(dir, "resources.ts"), `import { ResourceType, pixelFont, writeFont, writeView } from ${JSON.stringify(kit)};
const cel = (c) => ({ width: 3, height: 3, displaceX: 1, displaceY: 2, skipColor: 254, pixels: new Uint8Array(9).fill(10 + c) });
export default () => [
  { type: ResourceType.Font, number: 1, data: writeFont(pixelFont()) },
  { type: ResourceType.View, number: 260, data: writeView({ flags: 1, loops: [{ link: -1, mirror: false, cels: [0, 1, 2, 3, 4, 5, 6, 7].map(cel) }], palette: undefined }) },
];`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources));
    vm.registerKernels(allKernels);
    vm.start(vm.exportAddress(0, 0), "play");
    for (let i = 0; i < 3; i++) vm.run();
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const box = vm.getProp(global("talking"), "box")!;
    expect(["font", "fore", "back", "frame", "borderColor"].map((p) => graphics(vm).prop(box, p))).toEqual([1, 7, 9, 260, -1]);
    const bmp = vm.memory.bitmap(vm.getProp(box, "bitmap")!)!;
    const at = (x: number, y: number) => bmp.pixels[y * bmp.width + x];
    const [w, h] = [bmp.width, bmp.height];
    // Corners, then an edge from each side, then the paper inside (the margin, past the frame).
    expect([at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)]).toEqual([10, 11, 12, 13]);
    expect([at(w >> 1, 1), at(w >> 1, h - 2), at(1, h >> 1), at(w - 2, h >> 1)]).toEqual([14, 15, 16, 17]);
    expect(at(4, 4)).toBe(9);
    // Text is 10 pixels a line in font 1, inside 3 of frame and 4 of margin each side.
    expect(h).toBe(10 + 2 * (3 + 4));
    expect(bmp.pixels.includes(7)).toBe(true);
  });
});

describe("cursors", () => {
  it("are the game's own when it has them, and a wait cursor shows while hands are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sci-cursors-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "0.sc"), `(script 0)
(include "system.sh")
(public t 0)
(instance t of Game
  (method (init)
    (super init:)
    (user walkCursor: 261 lookCursor: 262 doCursor: 263 talkCursor: 264 waitCursor: 265)))`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.start(vm.exportAddress(0, 0), "play");
    vm.run();
    vm.run();
    expect(g.cursor.view).toBe(261);
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    inp.push({ type: EventType.MouseDown, message: 0, modifiers: 3 });
    vm.run();
    expect(g.cursor.view).toBe(263); // right-click: walk -> do
    // The library's own: an hourglass while the player can't act.
    expect(game.resources.some((r) => r.type === ResourceType.View && r.number === 995)).toBe(true);
    vm.setProp(global("user"), "canInput", 0);
    vm.run();
    expect(g.cursor.view).toBe(265);
    vm.setProp(global("user"), "canInput", 1);
    vm.run();
    expect(g.cursor.view).toBe(263);
  });
});

describe("pnpm game new", () => {
  it("starts a game that builds and plays: a room, a hero, a first line", async () => {
    const games = mkdtempSync(join(tmpdir(), "sci-new-"));
    const dir = newGame(join(games, "night-walk"), "path");
    const game = await buildGame(dir);
    expect(game.warnings).toEqual([]);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    vm.start(vm.exportAddress(0, 0), "play");
    for (let i = 0; i < 5; i++) vm.run();
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    expect(global("curRoomNum")).toBe(1);
    const box = vm.getProp(global("talking"), "box")!;
    expect(stringHelpers.str(vm, vm.getProp(box, "text")!)).toMatch(/^You're here\./);
    expect(() => newGame(join(games, "night-walk"))).toThrow(/already there/);
    expect(() => newGame(join(games, "Bad Name"))).toThrow(/lower-case/);
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
