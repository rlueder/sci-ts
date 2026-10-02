import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameBuildError, buildGame } from "../../../tools/game/build.ts";
import { newGame } from "../../../tools/game/new.ts";
import { tagGameLines } from "../../../tools/game/lines.ts";
import { pixelFont } from "../../../tools/game/font.ts";
import { stringHelpers } from "../src/vm/kernels/arrays.ts";
import { paletteEffects, saves } from "../src/vm/kernels/index.ts";
import type { MemorySaveStore } from "../src/vm/kernels/saves.ts";
import {
  AudioIndex, EventType, ResourceManager, audio, ResourceType, decodeSol, speechKey, Vm, allKernels, graphics, input, parseClassTable, parseFont, parseSelectorNames,
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
    // He stands to the hero's right, so his portrait is at the top right (his view has no
    // left-facing loops, so it stays as drawn), and the line goes beside it, towards the middle.
    const part = (name: string) => [...g.items].find((it) => vm.object(it).name === name);
    const bust = part("travellerBust")!;
    expect([prop(bust, "x"), prop(bust, "y"), prop(bust, "loop")]).toEqual([320 - 8 - 34, 8, 0]);
    const box = vm.getProp(global("talking"), "box")!;
    expect([prop(box, "x"), prop(box, "y"), prop(box, "width")]).toEqual([6, 8, 320 - 8 - 34 - 12]);
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

    // Placed from the bottom of the screen, a box grows upwards: one line or three, it ends there.
    const g = graphics(vm);
    vm.invoke(global("narrator"), vm.selector("y"), [0x10000 - 4]);
    for (const text of ["One line.", "A line long enough to wrap onto a second line and then onto a third one as well."]) {
      vm.invoke(global("narrator"), vm.selector("say"), [stringHelpers.newString(vm, text)]);
      const b = vm.getProp(global("talking"), "box")!;
      expect(g.prop(b, "y") + g.prop(b, "height")).toBe(196);
    }

    // A menu is one framed box with the choices inside it, one under another.
    vm.invoke(global("game"), vm.selector("showMenu"), []);
    for (let i = 0; i < 2; i++) vm.run();
    const menu = global("dialog");
    const panel = vm.getProp(menu, "panel")!;
    const items: Value[] = [];
    for (let n = vm.memory.list(vm.getProp(vm.getProp(menu, "items")!, "elements")!)?.first; n; n = n.next) items.push(n.value);
    expect(items.length).toBeGreaterThan(3);
    expect(g.prop(panel, "frame")).toBe(260);
    expect(items.map((i) => g.prop(i, "frame"))).toEqual(items.map(() => -1));
    expect(g.prop(items[0]!, "y")).toBe(g.prop(panel, "y") + 3);
    items.slice(1).forEach((item, k) => expect(g.prop(item, "y")).toBe(g.prop(items[k]!, "y") + g.prop(items[k]!, "height")));
    const last = items.at(-1)!;
    expect(g.prop(panel, "y") + g.prop(panel, "height")).toBe(g.prop(last, "y") + g.prop(last, "height") + 3);
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
    expect(menu().some((m) => m.text.startsWith("Speech"))).toBe(false); // it has no recorded lines
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

    // The pointer at the top edge: the bar, walk picked; no item in use, so six icons. It
    // slides down from above the screen, quickly and then slowing, until it's all there.
    point(160, 1);
    expect(global("dialog")).toBe(global("iconBar"));
    expect(icons().map((i) => [prop(i, "cel"), prop(i, "loop")])).toEqual([[0, 1], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
    const ys: number[] = [prop(icons()[0]!, "y")];
    for (let i = 0; i < 12; i++) (frames(1), ys.push(prop(icons()[0]!, "y")));
    expect(ys[0]).toBeLessThan(0);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]!);
    expect(ys.at(-1)).toBe(ys.at(-2)); // at rest
    // Look: picked, the bar goes (it stops taking clicks at once, and slides away), the
    // cursor is look's.
    tap(1);
    expect([prop(user(), "verb"), global("dialog"), g.cursor.view]).toEqual([1, 0, 991]);
    expect(icons().length).toBe(6);
    frames(12);
    expect(icons().length).toBe(0);

    // A tap at the top (as on a touch screen), then the pointer well below closes it.
    point(160, 120);
    click(160, 2);
    point(160, 20);
    expect(global("dialog")).toBe(global("iconBar"));
    expect(prop(icons()[1]!, "loop")).toBe(1); // look is picked now
    point(160, 120);
    frames(12);
    expect([global("dialog"), icons().length]).toEqual([0, 0]);

    // The inventory icon: nothing carried yet.
    click(160, 2);
    frames(12);
    tap(4);
    const box = vm.getProp(global("talking"), "box")!;
    expect(stringHelpers.str(vm, vm.getProp(box, "text")!)).toBe("You aren't carrying anything.");
    click(160, 120);
    // The menu icon: the game menu.
    frames(12);
    click(160, 2);
    frames(12);
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

/** A 16-bit PCM WAV file; stereo frames repeat each sample on both channels. */
function wav(rate: number, channels: number, samples: number[]): Uint8Array {
  const size = samples.length * channels * 2;
  const v = new DataView(new ArrayBuffer(44 + size));
  const text = (at: number, t: string) => [...t].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); v.setUint32(4, 36 + size, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, size, true);
  samples.forEach((s, i) => { for (let c = 0; c < channels; c++) v.setInt16(44 + (i * channels + c) * 2, s, true); });
  return new Uint8Array(v.buffer);
}

describe("line ids", () => {
  it("are added to a game's lines, carried into the build with their recordings, and unique across rooms", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-lines-")), "lines"), "path");
    const untagged = await buildGame(dir);
    expect(untagged.lines.get(1)!.map((l) => l.id)).toEqual([undefined, undefined, undefined]);
    // A game with recordings is told which lines can't have one.
    mkdirSync(join(dir, "voices"));
    expect((await buildGame(dir)).warnings).toContainEqual(expect.stringMatching(/1\.yarn:4: 3 spoken lines have no #line: id/));

    expect(tagGameLines(dir).map((t) => t.added)).toEqual([["1-001", "1-002", "1-003"]]);
    expect(readFileSync(join(dir, "rooms/1.yarn"), "utf8")).toContain("An empty room, waiting for a story. #line:1-002");
    const tagged = await buildGame(dir);
    expect(tagged.lines.get(1)!.map((l) => [l.id, l.text])).toEqual([
      ["1-001", "You're here. Right-click for the next verb; click to use it."],
      ["1-002", "An empty room, waiting for a story."],
      ["1-003", "Nothing out there yet."],
    ]);
    expect(tagged.warnings.join("\n")).not.toContain("#line:");
    expect(tagGameLines(dir)).toEqual([]);

    // A recording for a line (stereo, 22,050 Hz), and one whose line is gone.
    writeFileSync(join(dir, "voices/1-002.wav"), wav(22050, 2, Array.from({ length: 22050 }, (_, i) => Math.round(Math.sin(i / 8) * 8000))));
    writeFileSync(join(dir, "voices/1-099.wav"), wav(22050, 1, [1, 2, 3]));
    const voiced = await buildGame(dir);
    expect(voiced.warnings).toContainEqual(expect.stringMatching(/voices\/1-099\.wav: no line has the id #line:1-099/));
    const line = voiced.lines.get(1)!.find((l) => l.id === "1-002")!;
    const rm = await open(voiced.resources, voiced.files);
    const clip = AudioIndex.build(rm).speech.get(speechKey(1, line.noun, line.verb, line.cond, line.seq))!;
    expect(AudioIndex.ticks(clip)).toBeGreaterThanOrEqual(60); // a second of it, trimmed edges and all
    expect(AudioIndex.ticks(clip)).toBeLessThanOrEqual(68);
    expect(decodeSol(voiced.files["RESOURCE.AUD"]!.subarray(clip.offset, clip.offset + clip.length))!.rate).toBe(11025);

    // The script: every line with an id, and which are recorded.
    const script = () => JSON.parse(readFileSync(join(dir, "voices/lines.json"), "utf8")).lines as { id: string; recording: string; speaker: string; text: string }[];
    expect(script().map((l) => [l.id, l.recording])).toEqual([["1-001", "missing"], ["1-002", "recorded"], ["1-003", "missing"]]);
    expect(script()[1]).toMatchObject({ speaker: "Narrator", text: "An empty room, waiting for a story.", node: "room.look", room: 1, where: "rooms/1.yarn:11" });
    expect(voiced.warnings).toContainEqual(expect.stringMatching(/lines\.json: 2 of 3 lines have no recording yet/));
    // The line changes: its recording is out of date, until it's recorded again.
    const yarn = readFileSync(join(dir, "rooms/1.yarn"), "utf8");
    writeFileSync(join(dir, "rooms/1.yarn"), yarn.replace("waiting for a story", "waiting for its story"));
    expect((await buildGame(dir)).warnings).toContainEqual(expect.stringMatching(/1-002\.wav: recorded before its line changed \(.*1\.yarn:11: "An empty room, waiting for its story\."\)/));
    expect(script()[1]!.recording).toBe("changed");
    expect((await buildGame(dir)).warnings.join("\n")).toContain("recorded before its line changed"); // it stays so
    writeFileSync(join(dir, "voices/1-002.wav"), wav(22050, 1, Array.from({ length: 11025 }, (_, i) => Math.round(Math.sin(i / 9) * 8000))));
    expect((await buildGame(dir)).warnings.join("\n")).not.toContain("recorded before its line changed");
    expect(script()[1]!.recording).toBe("recorded");
    writeFileSync(join(dir, "rooms/1.yarn"), yarn);

    writeFileSync(join(dir, "rooms/2.room.yaml"), "room: 2\n");
    writeFileSync(join(dir, "rooms/2.yarn"), "title: room.look\n---\nAnother room. #line:1-002\n===\n");
    await expect(buildGame(dir)).rejects.toThrow(/2\.yarn:3: #line:1-002 is already the id of .*1\.yarn:11/);
  });
});

describe("speech", () => {
  it("plays a line's recording, keeps the line up for it, stops it on a click, and follows the speech setting", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-speech-")), "talkie"), "path");
    const yarn = readFileSync(join(dir, "rooms/1.yarn"), "utf8");
    writeFileSync(join(dir, "rooms/1.yarn"), yarn.replace("Nothing out there yet.", "Nothing out there yet. #line:said\nThe glass is cold. #line:unsaid"));
    mkdirSync(join(dir, "voices"));
    // Five seconds: longer than reading the line takes (186 cycles at the normal speed).
    writeFileSync(join(dir, "voices/said.wav"), wav(11025, 1, Array.from({ length: 11025 * 5 }, (_, i) => Math.round(Math.sin(i / 6) * 12000))));
    const game = await buildGame(dir);
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
    const key = (message: number) => (inp.push({ type: EventType.KeyDown, message, modifiers: 0 }), frames(1));
    const showing = () => global("talking") !== 0;
    const heard = () => [...audio(vm).channels.keys()].some((k) => k.startsWith("aud:"));
    const shown = () => {
      const box = showing() ? vm.getProp(global("talking"), "box") : 0;
      return box ? stringHelpers.str(vm, vm.getProp(box, "text")!) : "";
    };
    const menu = () => {
      const items = global("dialog") ? vm.getProp(global("dialog"), "items") : 0;
      const out: { text: string; x: number; y: number }[] = [];
      for (let n = items ? vm.memory.list(vm.getProp(items, "elements")!)?.first : undefined; n; n = n.next) {
        out.push({ text: stringHelpers.str(vm, vm.getProp(n.value, "text")!), x: g.prop(n.value, "x"), y: g.prop(n.value, "y") });
      }
      return out;
    };
    const choose = (text: string) => {
      const item = menu().find((m) => m.text === text);
      expect(item, text).toBeDefined();
      click(item!.x + 4, item!.y + 4);
    };
    const until = (done: () => boolean) => {
      let n = 0;
      while (!done() && n < 3000) (frames(1), n++);
      return n;
    };

    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    while (showing()) key(13); // the arrival line
    click(0, 100, true);
    click(0, 100, true); // walk -> do -> look

    // Voice and text: heard and shown until the recording ends, then a moment; the next
    // line, with no recording, is up for its reading time.
    click(160, 70);
    expect(heard()).toBe(true);
    expect(shown()).toBe("Nothing out there yet.");
    const first = until(() => shown() === "The glass is cold.");
    expect(first).toBeGreaterThanOrEqual(300);
    expect(first).toBeLessThanOrEqual(300 + 20 + 3);
    expect(heard()).toBe(false);
    expect(until(() => !showing())).toBeGreaterThan(170);

    // A click ends the line and its recording.
    click(160, 70);
    frames(30);
    expect(heard()).toBe(true);
    click(160, 70);
    expect(heard()).toBe(false);
    expect(shown()).toBe("The glass is cold.");
    key(13);

    // Voice only: heard, not shown; a line without a recording is still shown.
    key(27);
    choose("Speech: voice and text");
    expect(menu().map((m) => m.text)).toContain("Speech: voice only");
    choose("Carry on");
    expect(global("speech")).toBe(2);
    click(160, 70);
    expect(showing() && heard()).toBe(true);
    expect(shown()).toBe("");
    expect(until(() => shown() === "The glass is cold.")).toBeGreaterThanOrEqual(300);
    key(13);

    // Text only: shown for as long as it takes to read, and not heard.
    key(27);
    choose("Speech: voice only");
    choose("Carry on");
    expect(global("speech")).toBe(1);
    click(160, 70);
    expect(heard()).toBe(false);
    expect(shown()).toBe("Nothing out there yet.");
    expect(until(() => shown() === "The glass is cold.")).toBeLessThan(200);
  });
});

describe("perspective", () => {
  it("sizes the hero and the props that move by how far below the horizon they stand, room by room", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-perspective-")), "deep"), "path");
    const yaml = readFileSync(join(dir, "rooms/1.room.yaml"), "utf8");
    writeFileSync(join(dir, "rooms/1.room.yaml"), `${yaml}perspective: { horizon: 72, fullSize: 176 }\nprops:\n  cat: { view: 100, at: [250, 160], moves: true }\n`);
    writeFileSync(join(dir, "rooms/2.room.yaml"), "room: 2\npicture: 100\nhero: { at: [60, 170] }\n");
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    const ego = () => global("ego");
    /** The size it's drawn at, in percent, and where its feet are. */
    const size = (obj: Value) => ({ y: g.prop(obj, "y"), pct: (g.prop(obj, "scaleSignal") & 1 ? g.prop(obj, "scaleX") : 128) / 1.28 });
    const expected = (y: number) => ((y - 72) / 104) * 100;

    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    while (global("talking")) (inp.push({ type: EventType.KeyDown, message: 13, modifiers: 0 }), frames(1));
    const front = size(ego());
    expect(front.y).toBe(170);
    expect(front.pct).toBeCloseTo(expected(170), -0.5);
    const cast = vm.memory.list(vm.getProp(global("cast"), "elements")!)!;
    let catObj = 0;
    for (let n = cast.first; n; n = n.next) if (g.prop(n.value, "x") === 250) catObj = n.value;
    expect(size(catObj).pct).toBeCloseTo(expected(160), -0.5);

    // He walks to the back of the floor and gets smaller as he goes.
    [inp.x, inp.y] = [200, 151];
    inp.push({ type: EventType.MouseDown, message: 0, modifiers: 0 });
    inp.push({ type: EventType.MouseUp, message: 0 });
    const seen: { y: number; pct: number }[] = [];
    for (let i = 0; i < 600 && g.prop(ego(), "y") > 151; i++) (frames(1), seen.push(size(ego())));
    const back = size(ego());
    expect(back.y).toBe(151);
    expect(back.pct).toBeCloseTo(expected(151), -0.5);
    for (const s of seen) expect(Math.abs(s.pct - expected(s.y))).toBeLessThan(2);

    // A room with no perspective draws him at full size.
    vm.invoke(global("game"), vm.selector("newRoom"), [2]);
    frames(5);
    expect(global("curRoomNum")).toBe(2);
    expect(size(ego()).pct).toBe(100);
  });
});

describe("portraits", () => {
  it("go on the side their character stands, facing the middle, framed, and the hero answers from the other side", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-portraits-")), "faces"), "path");
    const script = readFileSync(join(dir, "scripts/0.sc"), "utf8")
      .replace("(super init:)", "(super init:)\n    (textStyle portraitFrame: 302 portraitX: 12 portraitY: 22)")
      .replace("(instance heroVoice of Talker\n  (properties name \"You\"))", "(instance heroVoice of PortraitTalker\n  (properties name \"You\" view 301))");
    writeFileSync(join(dir, "scripts/0.sc"), script);
    writeFileSync(join(dir, "rooms/1.room.yaml"), `${readFileSync(join(dir, "rooms/1.room.yaml"), "utf8")}props:\n  cat: { view: 200, at: [20, 170] }\ncharacters:\n  cat: { name: Cat, portrait: 300 }\n`);
    writeFileSync(join(dir, "rooms/1.yarn"), `${readFileSync(join(dir, "rooms/1.yarn"), "utf8")}\ntitle: cat.talk\n---\nCat: Meow.\nHero: Hello, cat.\nCat: Meow again.\nCat: Purr.\n===\n`);
    // Portraits 300 and 301: six loops of one 20x24 cel (right-facing bust, mouth, eyes, then
    // left-facing), each loop its own colour, anchored top-left. View 302: a 36x40 surround
    // (loop 0) and frame (loop 1) that sit 8 left of and 10 above the face.
    renameSync(join(dir, "resources.ts"), join(dir, "art.ts"));
    const kit = new URL("../../../tools/game/kit.ts", import.meta.url).href;
    writeFileSync(join(dir, "resources.ts"), `import art from "./art.ts";
import { ResourceType, writeView } from ${JSON.stringify(kit)};
const cel = (w, h, c, dx = 0, dy = 0) => ({ width: w, height: h, displaceX: (w >> 1) + dx, displaceY: h - 1 + dy, skipColor: 254, pixels: new Uint8Array(w * h).fill(c) });
const view = (loops) => writeView({ flags: 1, loops: loops.map((cels) => ({ link: -1, mirror: false, cels })), palette: undefined });
const face = (base) => view([0, 1, 2, 3, 4, 5].map((l) => [cel(20, 24, base + l)]));
export default () => [...art(),
  { type: ResourceType.View, number: 300, data: face(40) },
  { type: ResourceType.View, number: 301, data: face(50) },
  { type: ResourceType.View, number: 302, data: view([[cel(36, 40, 60, 8, 10)], [cel(36, 40, 61, 8, 10)]]) }];`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    const key = (message: number) => (inp.push({ type: EventType.KeyDown, message, modifiers: 0 }), frames(1));
    const line = () => {
      const box = global("talking") ? vm.getProp(global("talking"), "box") : 0;
      return box ? stringHelpers.str(vm, vm.getProp(box, "text")!) : "";
    };
    /** The portrait on screen: each part's view, loop, place and priority, and the text box's place. */
    const shown = () => {
      const t = global("talking");
      const part = (p: string) => {
        const o = vm.getProp(t, p)!;
        return [g.prop(o, "view"), g.prop(o, "loop"), g.prop(o, "x"), g.prop(o, "y"), g.prop(o, "priority")];
      };
      const face = vm.getProp(t, "frame") || vm.getProp(t, "bust");
      const box = vm.getProp(t, "box")!;
      return { face: [g.prop(face!, "view"), g.prop(face!, "loop"), g.prop(face!, "x"), g.prop(face!, "y")], mouth: part("mouth"), back: part("back"), front: part("front"), box: [g.prop(box, "x"), g.prop(box, "width")] };
    };

    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    while (global("talking")) key(13);
    vm.invoke(global("user"), vm.selector("setVerb"), [2]);
    [inp.x, inp.y] = [20, 165];
    inp.push({ type: EventType.MouseDown, message: 0, modifiers: 0 });
    inp.push({ type: EventType.MouseUp, message: 0 });
    for (let i = 0; i < 600 && !line(); i++) frames(1);

    // The cat stands left of the hero: its portrait at the top left, facing right, framed;
    // the line to its right (12 + 20 + 8 of frame + 6).
    expect(line()).toBe("Cat: Meow.");
    expect(shown()).toEqual({
      face: [300, 0, 12, 22], mouth: [300, 1, 12, 22, 151], back: [302, 0, 12, 22, 149], front: [302, 1, 12, 22, 152], box: [46, 320 - 46 - 6],
    });
    // The hero answers from the right, facing left; the line to the left of him.
    key(13);
    expect(line()).toBe("You: Hello, cat.");
    const hero = shown();
    expect(hero).toEqual({
      face: [301, 3, 320 - 12 - 20, 22], mouth: [301, 4, 288, 22, 151], back: [302, 0, 288, 22, 149], front: [302, 1, 288, 22, 152], box: [6, 288 - 8 - 12],
    });
    const heroParts = ["bust", "mouth", "eyes"].map((p) => vm.getProp(global("heroTalker"), p)!);
    key(13);
    expect(line()).toBe("Cat: Meow again.");
    expect(shown().face).toEqual([300, 0, 12, 22]);
    // Between his lines the hero's portrait is off the screen, but kept for the next.
    const castHas = (o: Value) => { for (let n = vm.memory.list(vm.getProp(global("cast"), "elements")!)?.first; n; n = n.next) if (n.value === o) return true; return false; };
    expect(heroParts.some(castHas)).toBe(false);
    expect(["bust", "mouth", "eyes"].map((p) => vm.getProp(global("heroTalker"), p))).toEqual(heroParts);
    // Now the cat is up at the top right, right of the hero: its side, but its portrait there
    // would be over it, so it goes on the left.
    const cat = vm.loadedScripts.flatMap((sc) => [...g.items]).find((it) => vm.object(it).name === "cat") ?? 0;
    expect(cat).not.toBe(0);
    vm.setProp(cat, "x", 300);
    vm.setProp(cat, "y", 40);
    key(13);
    expect(line()).toBe("Cat: Purr.");
    expect(shown().face).toEqual([300, 0, 12, 22]);
    key(13);
    expect(global("talking")).toBe(0);
  });
});

describe("measured perspective", () => {
  it("sizes the hero by where he stands across the floor as well as how far back", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-floor-")), "angled"), "path");
    const yaml = readFileSync(join(dir, "rooms/1.room.yaml"), "utf8");
    writeFileSync(join(dir, "rooms/1.room.yaml"), `${yaml}perspective:
  columns:
    - { x: 40, back: [150, 50], front: [189, 80] }
    - { x: 160, back: [150, 70], front: [189, 100] }
    - { x: 280, back: [150, 90], front: [189, 120] }
`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    const sizeAt = (x: number, y: number) => {
      vm.setProp(global("ego"), "x", x);
      vm.setProp(global("ego"), "y", y);
      frames(1);
      return Math.round(g.prop(global("ego"), "scaleX") / 1.28);
    };
    // At each place, its back and front sizes, in a straight line between.
    expect([sizeAt(40, 150), sizeAt(40, 189), sizeAt(160, 150), sizeAt(280, 189)]).toEqual([50, 80, 70, 120]);
    // The same height on the screen is bigger to the right, where the floor is nearer.
    expect(sizeAt(280, 170)).toBeGreaterThan(sizeAt(40, 170));
    // Between places, in a straight line across: halfway from the left to the middle at
    // y 170 is between 65% (left) and 85% (middle).
    expect(sizeAt(100, 170)).toBe(75);
    // Beyond the outer places, their sizes.
    expect(sizeAt(5, 150)).toBe(50);
    expect(sizeAt(315, 150)).toBe(90);
  });
});

describe("walking at a distance", () => {
  /** The hero walking right across a template room for 120 cycles at `size` percent (100: no perspective). */
  async function walk(size: number) {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-pace-")), `pace${size}`), "path");
    if (size !== 100) {
      const yaml = readFileSync(join(dir, "rooms/1.room.yaml"), "utf8");
      writeFileSync(join(dir, "rooms/1.room.yaml"), `${yaml}perspective:\n  columns:\n    - { x: 160, back: [150, ${size}], front: [189, ${size}] }\n`);
    }
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    while (global("talking")) (inp.push({ type: EventType.KeyDown, message: 13, modifiers: 0 }), frames(1));
    const ego = global("ego");
    vm.setProp(ego, "x", 20);
    frames(1);
    [inp.x, inp.y] = [310, 170];
    inp.push({ type: EventType.MouseDown, message: 0, modifiers: 0 });
    inp.push({ type: EventType.MouseUp, message: 0 });
    let cels = 0, last = g.prop(ego, "cel");
    for (let i = 0; i < 120; i++) {
      frames(1);
      if (g.prop(ego, "cel") !== last) (cels++, (last = g.prop(ego, "cel")));
    }
    return { distance: g.prop(ego, "x") - 20, cels };
  }

  it("is slower, legs and all, in proportion to how small he's drawn", async () => {
    const [near, far] = [await walk(100), await walk(50)];
    expect(near.distance).toBeGreaterThan(100);
    expect(far.distance / near.distance).toBeCloseTo(0.5, 1);
    expect(far.cels / near.cels).toBeCloseTo(0.5, 1);
  });

  it("changes his size in steps, not every line he moves", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-steps-")), "steps"), "path");
    const yaml = readFileSync(join(dir, "rooms/1.room.yaml"), "utf8");
    writeFileSync(join(dir, "rooms/1.room.yaml"), `${yaml}perspective: { horizon: 72, fullSize: 176 }\n`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    vm.start(vm.exportAddress(0, 0), "play");
    for (let i = 0; i < 5; i++) vm.run();
    const ego = global("ego");
    const sizes: number[] = [];
    // A line at a time from the front of the floor to the back.
    for (let y = 189; y >= 150; y--) {
      vm.setProp(ego, "y", y);
      vm.run();
      const s = g.prop(vm.getProp(ego, "scaler")!, "shown");
      if (s !== sizes.at(-1)) sizes.push(s);
    }
    expect(sizes.length).toBeGreaterThan(5);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i - 1]! - sizes[i]!).toBeGreaterThanOrEqual(2);
  });
});

describe("styled text in the game", () => {
  it("draws a speaker's name in the name font and italics into the margin, as measured", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-styles-")), "styles"), "path");
    const script = readFileSync(join(dir, "scripts/0.sc"), "utf8")
      .replace("(super init:)", "(super init:)\n    (textStyle font: 1 nameFont: 3 margin: 4 border: -1)");
    writeFileSync(join(dir, "scripts/0.sc"), script);
    writeFileSync(join(dir, "rooms/1.yarn"), `${readFileSync(join(dir, "rooms/1.yarn"), "utf8")}\ntitle: window.talk\n---\nHero: j[i]j[/i]\n===\n`);
    writeFileSync(join(dir, "game.json"), JSON.stringify({ fonts: { bold: 3, italic: 4, boldItalic: 5 } }));
    // Font 1: every glyph a 2x3 block, advancing 3. Font 3: 4x3, advancing 5. Font 4: 2x3
    // drawn 2 left of the pen, advancing 3.
    renameSync(join(dir, "resources.ts"), join(dir, "art.ts"));
    const kit = new URL("../../../tools/game/kit.ts", import.meta.url).href;
    writeFileSync(join(dir, "resources.ts"), `import art from "./art.ts";
import { ResourceType, writeFont } from ${JSON.stringify(kit)};
const face = (w, bearingX, advance) => writeFont({ height: 3, glyphs: Array.from({ length: 128 }, (_, c) => c === 32 ? { width: 0, height: 0, pixels: new Uint8Array(0), advance } : { width: w, height: 3, pixels: new Uint8Array(w * 3).fill(1), bearingX, advance }) });
export default () => [...art(),
  { type: ResourceType.Font, number: 1, data: face(2, 0, 3) },
  { type: ResourceType.Font, number: 3, data: face(4, 0, 5) },
  { type: ResourceType.Font, number: 4, data: face(2, -2, 3) }];`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    while (global("talking")) (inp.push({ type: EventType.KeyDown, message: 13, modifiers: 0 }), frames(1));
    vm.invoke(global("user"), vm.selector("setVerb"), [2]);
    [inp.x, inp.y] = [160, 70];
    inp.push({ type: EventType.MouseDown, message: 0, modifiers: 0 });
    inp.push({ type: EventType.MouseUp, message: 0 });
    for (let i = 0; i < 300 && !global("talking"); i++) frames(1);
    const box = vm.getProp(global("talking"), "box")!;
    const text = stringHelpers.str(vm, vm.getProp(box, "text")!);
    expect(text).toBe("|f3|You:|f| j|f4|j");
    // Measured: "You:" in font 3 (4 x 5), then " j" and "j" in fonts 1 and 4 (3 each): 29.
    const size = stringHelpers.newString(vm, text);
    expect(allKernels.TextWidth!(vm, [size, 1])).toBe(4 * 5 + 3 + 3 + 3);
    // Drawn: the line starts at the margin (4); its glyphs where the pen and bearings put them.
    const bmp = vm.memory.bitmap(vm.getProp(box, "bitmap")!)!;
    const row = [...bmp.pixels.slice(4 * bmp.width, 5 * bmp.width)].map((p) => (p === g.prop(box, "fore") ? 1 : 0)).join("");
    // Y o u : at 4, 9, 14, 19 (4 wide); a space; j at 27 (2 wide); the italic j's pen at 30,
    // its ink 2 left of that, over 28 and 29.
    expect(row.slice(0, 34)).toBe("0000111101111011110111100001110000");
  });
});

describe("a skinned interface", () => {
  it("puts the icon bar's icons and the inventory's items where the skins have room for them", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-skins-")), "skins"), "path");
    const script = readFileSync(join(dir, "scripts/0.sc"), "utf8")
      .replace("(super init:)", `(super init:)
    (inventory add: lens skin: 268 x: 32 y: 30 cols: 4 slotLeft: 13 slotTop: 28 slotWidth: 60 slotHeight: 47 inset: 7 iconSize: 32)
    (iconBar view: 266 skin: 267 size: 32 left: 16 spacing: 42 top: 8)`)
      .concat(`\n(instance lens of InvItem (properties view 250 verb 10 description "A lens."))\n`);
    writeFileSync(join(dir, "scripts/0.sc"), script);
    writeFileSync(join(dir, "items.yaml"), "lens: 10\n");
    renameSync(join(dir, "resources.ts"), join(dir, "art.ts"));
    const kit = new URL("../../../tools/game/kit.ts", import.meta.url).href;
    writeFileSync(join(dir, "resources.ts"), `import art from "./art.ts";
import { ResourceType, writeView } from ${JSON.stringify(kit)};
const cel = (w, h, c) => ({ width: w, height: h, displaceX: w >> 1, displaceY: h - 1, skipColor: 254, pixels: new Uint8Array(w * h).fill(c) });
const view = (loops) => writeView({ flags: 1, loops: loops.map((cels) => ({ link: -1, mirror: false, cels })), palette: undefined });
export default () => [...art(),
  { type: ResourceType.View, number: 266, data: view([[0, 1, 2, 3, 4, 5].map((c) => cel(32, 32, 40 + c)), [0, 1, 2, 3, 4, 5].map((c) => cel(32, 32, 50 + c))]) },
  { type: ResourceType.View, number: 267, data: view([[cel(320, 48, 60)]]) },
  { type: ResourceType.View, number: 268, data: view([[cel(256, 144, 61)]]) },
  { type: ResourceType.View, number: 250, data: view([[cel(32, 32, 62)], [cel(16, 16, 63)]]) }];`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    while (global("talking")) (inp.push({ type: EventType.KeyDown, message: 13, modifiers: 0 }), frames(1));
    const listed = (list: Value) => {
      const out: Value[] = [];
      for (let n = vm.memory.list(vm.getProp(list, "elements")!)?.first; n; n = n.next) out.push(n.value);
      return out;
    };
    // The inventory: the case at (32, 30), the lens in its first slot, 7 into it.
    vm.invoke(global("inventory"), vm.selector("showSelf"), []);
    frames(1);
    const [lensIcon] = listed(vm.getProp(global("inventory"), "icons")!);
    expect([g.prop(lensIcon!, "x"), g.prop(lensIcon!, "y"), g.prop(lensIcon!, "size")]).toEqual([32 + 13 + 7, 30 + 28 + 7, 32]);
    expect([g.prop(vm.getProp(global("inventory"), "window")!, "x"), g.prop(vm.getProp(global("inventory"), "window")!, "view")]).toEqual([32, 268]);
    // Picking it: it's in use, and the icon bar shows it in the fifth place.
    [inp.x, inp.y] = [60, 70];
    inp.push({ type: EventType.MouseDown, message: 0, modifiers: 0 });
    inp.push({ type: EventType.MouseUp, message: 0 });
    frames(2);
    expect(global("theItem")).not.toBe(0);
    [inp.x, inp.y] = [40, 10]; // over the bar, or it closes again
    vm.invoke(global("iconBar"), vm.selector("show"), []);
    frames(15); // slid all the way down
    const icons = listed(vm.getProp(global("iconBar"), "icons")!);
    expect(icons.map((i) => g.prop(i, "x"))).toEqual([16, 58, 100, 142, 184, 226, 268]);
    expect(icons.map((i) => g.prop(i, "y"))).toEqual(icons.map(() => 8));
    expect(g.prop(icons[4]!, "view")).toBe(250);
    expect(g.prop(vm.getProp(global("iconBar"), "box")!, "view")).toBe(267);
    expect(g.prop(global("iconBar"), "height")).toBe(48);
  });
});

describe("a magnifying lens", () => {
  it("shows the room under its glass twice as large while it's in use", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-lens-")), "lens"), "path");
    writeFileSync(join(dir, "items.yaml"), "lens: { verb: 10, view: 250, magnify: 2, description: \"A lens.\" }\n");
    writeFileSync(join(dir, "rooms/1.yarn"), readFileSync(join(dir, "rooms/1.yarn"), "utf8").replace("<<set $started to true>>", "<<set $started to true>>\n<<get lens>>"));
    renameSync(join(dir, "resources.ts"), join(dir, "art.ts"));
    const kit = new URL("../../../tools/game/kit.ts", import.meta.url).href;
    // View 250: an icon; a cursor that's all clear but one pixel (hotspot at its middle); a
    // 6x6 glass around the hotspot.
    writeFileSync(join(dir, "resources.ts"), `import art from "./art.ts";
import { ResourceType, writeView } from ${JSON.stringify(kit)};
const cel = (w, h, px, ax = w >> 1, ay = h - 1) => ({ width: w, height: h, displaceX: ax, displaceY: ay, skipColor: 254, pixels: Uint8Array.from({ length: w * h }, (_, i) => px(i % w, Math.floor(i / w))) });
const view = (loops) => writeView({ flags: 1, loops: loops.map((cels) => ({ link: -1, mirror: false, cels })), palette: undefined });
// Anchored with the hotspot at (3, 3): displaceX = w/2 - 3, displaceY = h - 1 - 3.
const at3 = (w, h, px) => cel(w, h, px, (w >> 1) - 3, h - 1 - 3);
export default () => [...art(),
  { type: ResourceType.View, number: 250, data: view([[cel(24, 24, () => 40)], [at3(8, 8, (x, y) => (x === 7 && y === 7 ? 41 : 254))], [at3(6, 6, () => 42)]]) }];`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    let latest: { pixels: Uint8Array } | undefined;
    g.onFrame = (f) => { latest = f; };
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    while (global("talking")) (inp.push({ type: EventType.KeyDown, message: 13, modifiers: 0 }), frames(1));
    // Over the hero's head and shoulders (60, 162), where the picture has some detail.
    [inp.x, inp.y] = [60, 162];
    g.cursor.visible = false; // the room as it is, without a cursor on it
    frames(1);
    const plain = latest!.pixels.slice();
    g.cursor.visible = true;
    expect(g.magnify).toBeUndefined();
    const lens = vm.memory.list(vm.getProp(global("inventory"), "elements")!)!.first!.value;
    vm.invoke(global("user"), vm.selector("useItem"), [lens]);
    frames(1);
    expect(g.magnify).toEqual({ view: 250, loop: 2, cel: 0, zoom: 2 });
    const at = (px: Uint8Array, x: number, y: number) => px[y * 320 + x];
    // The glass is 6x6 around the hotspot: each of its pixels shows the room half as far from it.
    let differs = 0;
    for (let y = 159; y <= 164; y++) {
      for (let x = 57; x <= 62; x++) {
        expect(at(latest!.pixels, x, y)).toBe(at(plain, 60 + Math.floor((x - 60) / 2), 162 + Math.floor((y - 162) / 2)));
        if (at(latest!.pixels, x, y) !== at(plain, x, y)) differs++;
      }
    }
    expect(differs).toBeGreaterThan(3); // it isn't just what's under it
    // Put away (right-click goes back to walking), it's a plain cursor again.
    vm.invoke(global("user"), vm.selector("useItem"), [0]);
    frames(1);
    expect(g.magnify).toBeUndefined();
  });
});

describe("portraits at the bottom of the screen", () => {
  it("sit their face's bottom above the screen's, with the text ending level with the frame", async () => {
    const dir = newGame(join(mkdtempSync(join(tmpdir(), "sci-low-")), "low"), "path");
    const script = readFileSync(join(dir, "scripts/0.sc"), "utf8")
      .replace("(super init:)", "(super init:)\n    (textStyle portraitFrame: 302 portraitX: 12 portraitY: -10)");
    writeFileSync(join(dir, "scripts/0.sc"), script);
    writeFileSync(join(dir, "rooms/1.room.yaml"), `${readFileSync(join(dir, "rooms/1.room.yaml"), "utf8")}props:\n  cat: { view: 200, at: [20, 170] }\ncharacters:\n  cat: { name: Cat, portrait: 300 }\n`);
    writeFileSync(join(dir, "rooms/1.yarn"), `${readFileSync(join(dir, "rooms/1.yarn"), "utf8")}\ntitle: cat.talk\n---\nCat: Meow.\n===\n`);
    renameSync(join(dir, "resources.ts"), join(dir, "art.ts"));
    const kit = new URL("../../../tools/game/kit.ts", import.meta.url).href;
    writeFileSync(join(dir, "resources.ts"), `import art from "./art.ts";
import { ResourceType, writeView } from ${JSON.stringify(kit)};
const cel = (w, h, c, dx = 0, dy = 0) => ({ width: w, height: h, displaceX: (w >> 1) + dx, displaceY: h - 1 + dy, skipColor: 254, pixels: new Uint8Array(w * h).fill(c) });
const view = (loops) => writeView({ flags: 1, loops: loops.map((cels) => ({ link: -1, mirror: false, cels })), palette: undefined });
export default () => [...art(),
  { type: ResourceType.View, number: 300, data: view([0, 1, 2, 3, 4, 5].map((l) => [cel(20, 24, 40 + l)])) },
  { type: ResourceType.View, number: 302, data: view([[cel(36, 40, 60, 8, 10)], [cel(36, 40, 61, 8, 10)]]) }];`);
    const game = await buildGame(dir);
    const vm = new Vm(await open(game.resources, game.files));
    vm.registerKernels(allKernels);
    const g = graphics(vm);
    vm.clock = () => (g.frames * 1000) / 60;
    const frames = (n: number) => { for (let i = 0; i < n; i++) vm.run(); };
    const global = (name: string) => vm.loadedScripts.find((s) => s.number === 0)!.locals[game.globals.indexOf(name)]!;
    const inp = input(vm);
    vm.start(vm.exportAddress(0, 0), "play");
    frames(5);
    while (global("talking")) (inp.push({ type: EventType.KeyDown, message: 13, modifiers: 0 }), frames(1));
    vm.invoke(global("user"), vm.selector("setVerb"), [2]);
    [inp.x, inp.y] = [20, 165];
    inp.push({ type: EventType.MouseDown, message: 0, modifiers: 0 });
    inp.push({ type: EventType.MouseUp, message: 0 });
    for (let i = 0; i < 600 && !global("talking"); i++) frames(1);
    const t = global("talking");
    const face = vm.getProp(t, "frame") || vm.getProp(t, "bust");
    // The face (24 high) ends 10 above the bottom: its top at 166. The frame reaches 8 below
    // it (the surround is 8 wider each side), so the text ends at 198. The cat is small and
    // at the bottom left, its head where the left portrait would be: it's on the right.
    expect([g.prop(face!, "x"), g.prop(face!, "y")]).toEqual([320 - 12 - 20, 200 - 10 - 24]);
    const box = vm.getProp(t, "box")!;
    expect(g.prop(box, "y") + g.prop(box, "height")).toBe(198);
  });
});
