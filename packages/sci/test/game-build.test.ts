import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameBuildError, buildGame } from "../../../tools/game/build.ts";
import { newGame } from "../../../tools/game/new.ts";
import { pixelFont } from "../../../tools/game/font.ts";
import { stringHelpers } from "../src/vm/kernels/arrays.ts";
import { paletteEffects, saves } from "../src/vm/kernels/index.ts";
import type { MemorySaveStore } from "../src/vm/kernels/saves.ts";
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
    click(0, 100, true);
    click(0, 100, true);
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
    click(0, 100, true);
    click(0, 100, true);
    click(0, 100, true);
    expect(g.cursor.view).toBe(994);
    click(160, 168);
    expect(prop(global("sfx"), "number")).toBe(50);
    expect(vm.getProp(global("sfx"), "handle")).not.toBe(0);
    expect(audio(vm).index.effects.has(50)).toBe(true);
    expect(line()).toBe("It's warm. Whoever left it will be back for it.");
    click(10, 10);
    click(0, 100, true); // do -> look

    // Back to walking (look -> talk -> walk), and east, off the edge of the hill.
    click(0, 100, true);
    click(0, 100, true);
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
    click(0, 100, true);
    click(0, 100, true);
    click(250, 135);
    expect(line()).toBe("The sign reads TOWN, 2 MILES.");
    click(10, 10);

    // Talk to the traveller: a menu of topics, one of them hidden for now.
    click(0, 100, true);
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

describe("things: the inventory and close-ups", () => {
  it("picks an item in the window, uses it on a feature, and shows a close-up over a dimmed room", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-inv-")), "lens-test"), "path");
    // The game gives the hero a lens, and shows a close-up once it starts.
    const script = readFileSync(join(dir, "scripts/0.sc"), "utf8")
      .replace("(super init:)", "(super init:)\n    (inventory add: lens)\n    (self setScript: peek)")
      .concat(`
(instance lens of InvItem (properties view 250 verb 10 description "A brass lens."))
(instance peek of Script
  (method (changeState newState)
    (= state newState)
    (switch state
      (0 (= cycles 3))
      (1 ((CloseUp new:) show: 250 0 0 self))
      (2 (self dispose:)))))
`);
    writeFileSync(join(dir, "scripts/0.sc"), script);
    writeFileSync(join(dir, "items.yaml"), "# Things the hero can carry: their verbs.\nlens: 10\n");
    writeFileSync(join(dir, "rooms/1.yarn"), `${readFileSync(join(dir, "rooms/1.yarn"), "utf8").replace("Nothing out there yet.", "<<closeup 250>>\nNothing out there yet.")}
title: window.lens
---
The glass shows a fingerprint.
===
`);
    // View 250: a 24x24 icon (loop 0) and an 8x8 cursor (loop 1), both anchored top-left.
    renameSync(join(dir, "resources.ts"), join(dir, "art.ts"));
    const kit = new URL("../../../tools/game/kit.ts", import.meta.url).href;
    writeFileSync(join(dir, "resources.ts"), `import art from "./art.ts";
import { ResourceType, writeView } from ${JSON.stringify(kit)};
const cel = (size, c) => ({ width: size, height: size, displaceX: size >> 1, displaceY: size - 1, skipColor: 254, pixels: new Uint8Array(size * size).fill(c) });
export default () => [...art(), { type: ResourceType.View, number: 250, data: writeView({ flags: 1, loops: [
  { link: -1, mirror: false, cels: [cel(24, 40)] }, { link: -1, mirror: false, cels: [cel(8, 41)] }], palette: undefined }) }];`);
    const game = await buildGame(dir);
    expect(game.warnings).toEqual([]);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const prop = (obj: Value, name: string) => g.prop(obj, name);
    const inp = input(vm);
    const click = (x: number, y: number, right = false) => {
      [inp.x, inp.y] = [x, y];
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: right ? 3 : 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
      frames(1);
    };
    const line = () => {
      const who = global("talking");
      const box = who ? vm.getProp(who, "box") ?? 0 : 0;
      return box ? stringHelpers.str(vm, vm.getProp(box, "text")!) : "";
    };
    const shown = (view: number) => [...g.items].filter((it) => prop(it, "view") === view);
    vm.start(vm.exportAddress(0, 0), "play");
    frames(6);

    // The close-up: view 250 in the middle, the room dimmed behind it by the shade (view
    // 996, colour 253 remapped), until a click.
    expect(vm.object(global("dialog")).name).toBe("CloseUp");
    expect(shown(996)).toHaveLength(1);
    const [closeUp] = shown(250);
    expect([prop(closeUp!, "x"), prop(closeUp!, "y")]).toEqual([(320 - 24) / 2, (200 - 24) / 2]);
    expect(paletteEffects(vm).remaps.has(253)).toBe(true);
    const brightness = () => {
      const f = g.compose(), c = f.pixels[(f.height - 5) * f.width + 5]!;
      return f.palette.rgb[c * 3]! + f.palette.rgb[c * 3 + 1]! + f.palette.rgb[c * 3 + 2]!;
    };
    const dimmed = brightness();
    click(10, 10); // the room's first line
    click(10, 10);
    frames(1);
    expect(brightness()).toBeGreaterThan(dimmed);
    expect(global("dialog")).toBe(0);
    expect([shown(996), shown(250)]).toEqual([[], []]);
    expect(paletteEffects(vm).remaps.has(253)).toBe(false);

    // I opens the inventory: the lens's icon in a box at the top.
    inp.push({ type: EventType.KeyDown, message: 105, modifiers: 0 });
    frames(1);
    const inv = global("inventory");
    expect(global("dialog")).toBe(inv);
    const [icon] = shown(250);
    const [ix, iy] = [prop(icon!, "x"), prop(icon!, "y")];
    // Right-click on it looks at it; a click dismisses the line and leaves the window open.
    click(ix + 4, iy + 4, true);
    expect(line()).toBe("A brass lens.");
    click(ix + 4, iy + 4);
    expect(global("dialog")).toBe(inv);
    // A click picks it: the window goes, and the lens is the cursor.
    click(ix + 4, iy + 4);
    expect(global("dialog")).toBe(0);
    expect(shown(250)).toEqual([]);
    expect(prop(global("user"), "verb")).toBe(5);
    expect([g.cursor.view, g.cursor.loop]).toEqual([250, 1]);
    // Used on the window: the room's Yarn answers window.lens.
    click(160, 70);
    expect(line()).toBe("The glass shows a fingerprint.");
    click(10, 10);
    // Right-click goes back to walking.
    click(10, 10, true);
    expect([prop(global("user"), "verb"), g.cursor.view]).toEqual([3, 993]);
    // Yarn shows close-ups too (<<closeup 250>>), and goes on when it's dismissed: walk, do,
    // look; look at the window.
    click(10, 10, true);
    click(10, 10, true);
    click(160, 70);
    expect(vm.object(global("dialog")).name).toBe("CloseUp");
    expect(line()).toBe("");
    click(10, 10);
    frames(2);
    expect(line()).toBe("Nothing out there yet.");
  });

  it("refuses an item verb the player's verbs already use", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-inv-")), "bad-items"), "path");
    writeFileSync(join(dir, "items.yaml"), "lens: 4\n");
    await expect(buildGame(dir)).rejects.toThrow(/items\.yaml: lens: the verb is a number from 10 to 255/);
  });

  it("makes the items items.yaml describes, which rooms give and take", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-inv-")), "made-items"), "path");
    writeFileSync(join(dir, "items.yaml"), "key: { verb: 11, view: 250, description: A small iron key. }\n");
    writeFileSync(join(dir, "rooms/1.yarn"), `${readFileSync(join(dir, "rooms/1.yarn"), "utf8")}
title: window.do
---
<<if not $tookKey>>
A key on the sill.
<<get key>>
<<set $tookKey to true>>
<<else>>
<<drop key>>
You leave the key on the sill.
<<set $tookKey to false>>
<<endif>>
===
`);
    renameSync(join(dir, "resources.ts"), join(dir, "art.ts"));
    const kit = new URL("../../../tools/game/kit.ts", import.meta.url).href;
    writeFileSync(join(dir, "resources.ts"), `import art from "./art.ts";
import { ResourceType, writeView } from ${JSON.stringify(kit)};
const cel = (size, c) => ({ width: size, height: size, displaceX: size >> 1, displaceY: size - 1, skipColor: 254, pixels: new Uint8Array(size * size).fill(c) });
export default () => [...art(), { type: ResourceType.View, number: 250, data: writeView({ flags: 1, loops: [
  { link: -1, mirror: false, cels: [cel(24, 40)] }, { link: -1, mirror: false, cels: [cel(8, 41)] }], palette: undefined }) }];`);
    const game = await buildGame(dir);
    expect(game.warnings).toEqual([]);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    const click = (x: number, y: number, right = false) => {
      [inp.x, inp.y] = [x, y];
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: right ? 3 : 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
      frames(1);
    };
    const carried = () => vm.getProp(global("inventory"), "size");
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    click(10, 100); // the first line
    click(10, 100, true); // walk -> do
    expect(carried()).toBe(0);
    click(160, 70);
    frames(3);
    expect(carried()).toBe(0); // the line first, then the key
    click(10, 100);
    frames(3);
    expect(carried()).toBe(1);
    const key = vm.memory.list(vm.getProp(global("inventory"), "elements")!)!.first!.value;
    expect([vm.object(key).name, g.prop(key, "view"), g.prop(key, "verb")]).toEqual(["key", 250, 11]);
    expect(stringHelpers.str(vm, vm.getProp(key, "description")!)).toBe("A small iron key.");
    click(160, 70);
    frames(3);
    expect(carried()).toBe(0);
  });
});

describe("saving and restoring", async () => {
  const game = await buildGame("games/hello");

  it("saves from the game menu, restores with F7 into the same place, and offers only its own saves", async () => {
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const prop = (obj: Value, name: string) => g.prop(obj, name);
    const inp = input(vm);
    const click = (x: number, y: number) => {
      [inp.x, inp.y] = [x, y];
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
      frames(1);
    };
    const key = (message: number) => (inp.push({ type: EventType.KeyDown, message, modifiers: 0 }), frames(1));
    const line = () => {
      const who = global("talking");
      const box = who ? vm.getProp(who, "box") ?? 0 : 0;
      return box ? stringHelpers.str(vm, vm.getProp(box, "text")!) : "";
    };
    const menu = () => {
      const d = global("dialog");
      const items = d ? vm.getProp(d, "items") : 0;
      if (!items) return [];
      const out: { text: string; x: number; y: number }[] = [];
      for (let n = vm.memory.list(vm.getProp(items, "elements")!)?.first; n; n = n.next) {
        out.push({ text: stringHelpers.str(vm, vm.getProp(n.value, "text")!), x: prop(n.value, "x"), y: prop(n.value, "y") });
      }
      return out;
    };
    const choose = (text: string) => {
      const item = menu().find((m) => m.text === text);
      expect(item, `${text} in ${menu().map((m) => m.text).join(" / ")}`).toBeDefined();
      click(item!.x + 4, item!.y + 4);
    };
    const store = saves(vm).store as MemorySaveStore;
    // A save from other scripts (another build of the game): never offered.
    store.saves.set(7, { info: { id: 7, description: "From another build", version: "", date: 1, scripts: "deadbeef" }, snapshot: undefined! });

    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    const ego = () => global("ego");
    click(200, 180);
    frames(400);
    expect([prop(ego(), "x"), prop(ego(), "y")]).toEqual([200, 180]);

    // Escape: the game menu. Save, a new saved game, a description typed over "Room 1".
    key(27);
    expect(menu().map((m) => m.text)).toEqual(["Save the game", "Restore a game", "Start again", "Text speed: normal", "Carry on"]);
    choose("Save the game");
    expect(menu().map((m) => m.text)).toEqual(["A new saved game", "Cancel"]);
    choose("A new saved game");
    for (const c of " on the hill") key(c.charCodeAt(0));
    key(13);
    frames(1);
    expect(line()).toBe("Saved.");
    const mine = [...store.saves.values()].find((s) => s.info.id !== 7)!;
    expect(mine.info.description).toBe("Room 1 on the hill");
    expect(mine.info.scripts).toMatch(/^[0-9a-f]{8}$/);
    click(10, 10);
    expect(global("dialog")).toBe(0);

    // Somewhere else, then F7: the save is there (not the other build's), and restoring it
    // puts the hero back, the room on screen and the night's tune playing again.
    click(100, 170);
    frames(400);
    expect(prop(ego(), "x")).toBe(100);
    key(0x4100);
    expect(menu().map((m) => m.text)).toEqual(["Room 1 on the hill", "Cancel"]);
    choose("Room 1 on the hill");
    frames(3);
    expect([prop(ego(), "x"), prop(ego(), "y")]).toEqual([200, 180]);
    expect(global("curRoomNum")).toBe(1);
    expect(g.items.has(ego())).toBe(true);
    expect(g.planes.size).toBe(2);
    expect(audio(vm).songs.get(global("music"))?.loop).toBe(true);
    // And it plays on: a click walks.
    click(150, 175);
    frames(400);
    expect(prop(ego(), "x")).toBe(150);
  });

  it("keeps lines up as long as the text speed says, and lets Enter dismiss one", async () => {
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const prop = (obj: Value, name: string) => g.prop(obj, name);
    const inp = input(vm);
    const click = (x: number, y: number, right = false) => {
      [inp.x, inp.y] = [x, y];
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: right ? 3 : 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
      frames(1);
    };
    const key = (message: number) => (inp.push({ type: EventType.KeyDown, message, modifiers: 0 }), frames(1));
    const showing = () => global("talking") !== 0;
    const menu = () => {
      const d = global("dialog");
      const items = d ? vm.getProp(d, "items") : 0;
      if (!items) return [];
      const out: { text: string; x: number; y: number }[] = [];
      for (let n = vm.memory.list(vm.getProp(items, "elements")!)?.first; n; n = n.next) {
        out.push({ text: stringHelpers.str(vm, vm.getProp(n.value, "text")!), x: prop(n.value, "x"), y: prop(n.value, "y") });
      }
      return out;
    };
    const choose = (text: string) => {
      const item = menu().find((m) => m.text === text)!;
      click(item.x + 4, item.y + 4);
    };
    /** Frames a line about the moon stays up. */
    const moon = () => {
      click(260, 30);
      expect(showing()).toBe(true);
      let n = 0;
      while (showing() && n < 3000) (frames(1), n++);
      if (showing()) key(13); // its second line, likewise
      while (showing() && n < 6000) frames(1);
      return n;
    };
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    click(0, 100, true);
    click(0, 100, true); // walk -> do -> look
    const normal = moon();

    // Faster, from the game menu: Escape, then the text speed item, which changes in place.
    key(27);
    choose("Text speed: normal");
    expect(menu().map((m) => m.text)).toContain("Text speed: fast");
    choose("Carry on");
    expect(global("textSpeed")).toBe(2);
    const fast = moon();
    expect(fast).toBeLessThan(normal * 0.7);

    // Until a click: it stays; Enter dismisses it.
    key(27);
    choose("Text speed: fast");
    choose("Carry on");
    click(260, 30);
    frames(2000);
    expect(showing()).toBe(true);
    key(13);
    expect(stringHelpers.str(vm, vm.getProp(vm.getProp(global("talking"), "box")!, "text")!)).toBe("Bright enough to read by.");
    key(32);
    expect(showing()).toBe(false);
  });
});

describe("the icon bar", async () => {
  const game = await buildGame("games/hello");

  it("comes down at the top edge, picks verbs, opens the inventory and the menu, and goes away", async () => {
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const prop = (obj: Value, name: string) => g.prop(obj, name);
    const inp = input(vm);
    const point = (x: number, y: number) => (([inp.x, inp.y] = [x, y]), frames(1));
    const click = (x: number, y: number) => {
      [inp.x, inp.y] = [x, y];
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
      frames(1);
    };
    const icons = () => [...g.items].filter((it) => prop(it, "view") === 990).sort((a, b) => prop(a, "x") - prop(b, "x"));
    const tap = (n: number) => click(prop(icons()[n]!, "x") + 12, prop(icons()[n]!, "y") + 12);
    const user = () => global("user");
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);

    // The pointer at the top edge: the bar, walk picked; no item in use, so six icons.
    point(160, 1);
    expect(global("dialog")).toBe(global("iconBar"));
    expect(icons().map((i) => [prop(i, "cel"), prop(i, "loop")])).toEqual([[0, 1], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
    // Look: picked, the bar goes, the cursor is look's.
    tap(1);
    expect([prop(user(), "verb"), global("dialog"), icons().length, g.cursor.view]).toEqual([1, 0, 0, 991]);

    // A tap at the top (as on a touch screen), then the pointer well below closes it.
    point(160, 120);
    click(160, 2);
    point(160, 20);
    expect(global("dialog")).toBe(global("iconBar"));
    expect(prop(icons()[1]!, "loop")).toBe(1); // look is picked now
    point(160, 120);
    expect([global("dialog"), icons().length]).toEqual([0, 0]);

    // The inventory icon: nothing carried yet.
    click(160, 2);
    tap(4);
    const box = vm.getProp(global("talking"), "box")!;
    expect(stringHelpers.str(vm, vm.getProp(box, "text")!)).toBe("You aren't carrying anything.");
    click(160, 120);
    // The menu icon: the game menu.
    click(160, 2);
    tap(5);
    expect(vm.object(global("dialog")).name).toBe("Menu");
  });
});

describe("behaviours, poses and idles", () => {
  it("runs a prop's script, switches the hero's view in Yarn and back, and plays idles", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-poses-")), "poses"), "path");
    // A prop that a Script class of the game's moves along; idles for the hero (view 999, the
    // arrow cursor, will do as a pose); a node that changes his view and then restores it.
    writeFileSync(join(dir, "scripts/5.sc"), `(script 5)
(include "system.sh")
(class Drift of Script
  (method (changeState newState)
    (= state newState)
    (switch state
      (0 (= cycles 2))
      (1 (client x: 250)))))`);
    writeFileSync(join(dir, "scripts/0.sc"), readFileSync(join(dir, "scripts/0.sc"), "utf8").replace("(= ego hero)", "(= ego hero)\n    (hero idleView: 999 idleAfter: 1)"));
    writeFileSync(join(dir, "rooms/1.room.yaml"), `${readFileSync(join(dir, "rooms/1.room.yaml"), "utf8")}props:
  drifter: { view: 200, at: [200, 170], script: Drift }
  veil: { view: 200, at: [160, 70] }
properties:
  veil: { clickable: 0 }
`);
    writeFileSync(join(dir, "rooms/1.yarn"), `${readFileSync(join(dir, "rooms/1.yarn"), "utf8")}
title: window.do
---
<<view hero 999>>
<<wait 1>>
<<normal hero>>
===
`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const prop = (obj: Value, name: string) => g.prop(obj, name);
    const inp = input(vm);
    const click = (x: number, y: number, right = false) => {
      [inp.x, inp.y] = [x, y];
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: right ? 3 : 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
      frames(1);
    };
    vm.start(vm.exportAddress(0, 0), "play");
    frames(6);
    const drifter = [...g.items].find((it) => vm.object(it).name === "drifter")!;
    expect(prop(drifter, "x")).toBe(250);
    click(10, 100); // the first line
    const ego = global("ego");
    expect([prop(ego, "view"), prop(ego, "normalView")]).toEqual([200, 200]);

    // Standing still a second: an idle (view 999), then back to standing.
    const until = (cond: () => boolean, max: number) => { let n = 0; while (!cond() && n < max) (frames(1), n++); return n; };
    expect(until(() => prop(ego, "view") === 999, 120)).toBeGreaterThan(50);
    expect(until(() => prop(ego, "view") === 200, 60)).toBeLessThan(60);
    // Walking interrupts an idle at once.
    expect(until(() => prop(ego, "view") === 999, 120)).toBeLessThan(120);
    click(120, 170);
    expect(prop(ego, "view")).toBe(200);
    frames(200);

    // A prop that isn't clickable lets clicks through to the window behind it.
    const veil = [...g.items].find((it) => vm.object(it).name === "veil")!;
    expect(vm.invoke(veil, vm.selector("onMe"), [160, 60])).toBe(0);

    // <<view hero 999>> for a moment, then <<normal hero>>.
    click(10, 100, true); // walk -> do
    click(160, 70);
    frames(5);
    expect(prop(ego, "view")).toBe(999);
    frames(70);
    expect(prop(ego, "view")).toBe(200);
  });
});

describe("game time", async () => {
  const game = await buildGame("games/hello");

  it("keeps a line up for its reading time when the cycle count passes 32767", async () => {
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const script0 = () => vm.loadedScripts.find((s) => s.number === 0)!;
    const global = (name: string) => script0().locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    const click = (x: number, y: number, right = false) => {
      [inp.x, inp.y] = [x, y];
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: right ? 3 : 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
      frames(1);
    };
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    click(0, 100, true);
    click(0, 100, true); // walk -> do -> look
    // A minute short of where a 16-bit count turns negative.
    script0().locals[game.globals.indexOf("gameTime")] = 32767 - 60;
    click(260, 30);
    expect(global("talking")).not.toBe(0);
    let n = 0;
    while (global("talking") !== 0 && n < 1000) (frames(1), n++);
    // About two seconds and a little more for the line, not at once nor never.
    expect(n).toBeGreaterThan(120);
    expect(n).toBeLessThan(400);
  });
});

describe("sounds that aren't there", () => {
  it("end at once, so a script waiting for one carries on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sci-nosound-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "0.sc"), `(script 0)
(include "system.sh")
(public t 0)
(local [out 2])
(instance t of Game
  (method (init)
    (super init:)
    (self setScript: waiter)))
(instance waiter of Script
  (method (changeState newState)
    (= state newState)
    (switch state
      (0 (= [out 0] 1) (sfx number: 777 play: self))
      (1 (= [out 1] 1)))))`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources));
    vm.registerKernels(allKernels);
    vm.start(vm.exportAddress(0, 0), "play");
    for (let i = 0; i < 10; i++) vm.run();
    expect(vm.loadedScripts.find((s) => s.number === 0)!.locals.slice(0, 2)).toEqual([1, 1]);
  });
});

describe("actors", () => {
  it("walk past each other in a cutscene rather than stopping", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-actors-")), "actors"), "path");
    // A walker on the hero's line (he stands at 60, 170) has to cross where he stands.
    writeFileSync(join(dir, "rooms/1.room.yaml"), `${readFileSync(join(dir, "rooms/1.room.yaml"), "utf8")}props:
  walker: { view: 200, at: [20, 170], moves: true }
`);
    writeFileSync(join(dir, "rooms/1.yarn"), `${readFileSync(join(dir, "rooms/1.yarn"), "utf8")}
title: window.do
---
<<walk walker 200 170>>
===
`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const inp = input(vm);
    const click = (x: number, y: number, right = false) => {
      [inp.x, inp.y] = [x, y];
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: right ? 3 : 0 });
      inp.push({ type: EventType.MouseUp, message: 0 });
      frames(1);
    };
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    click(10, 100); // the first line
    click(10, 100, true); // walk -> do
    click(160, 70);
    frames(600);
    const walker = [...g.items].find((it) => vm.object(it).name === "walker")!;
    expect(vm.getProp(walker, "x")).toBe(200);
  });

  it("are hit only where they're drawn, not anywhere in their cel", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-actors-")), "pixels"), "path");
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.start(vm.exportAddress(0, 0), "play");
    for (let i = 0; i < 3; i++) vm.run();
    const ego = vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf("ego")]!;
    const r = g.viewRect(ego)!;
    // A transparent pixel and a drawn one inside the hero's cel.
    const at = (want: (c: number) => boolean) => {
      for (let i = 0; i < r.cel.pixels.length; i++) if (want(r.cel.pixels[i]!)) return [r.x + (r.mirror ? r.cel.width - 1 - (i % r.cel.width) : i % r.cel.width), r.y + Math.floor(i / r.cel.width)];
      throw new Error("no such pixel");
    };
    const onMe = (p: number[]) => vm.invoke(ego, vm.selector("onMe"), p);
    expect(onMe(at((c) => c === r.cel.skipColor))).toBe(0);
    expect(onMe(at((c) => c !== r.cel.skipColor))).toBe(1);
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
