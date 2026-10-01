/**
 * Headless exploration from a checkpoint.
 *   pnpm tsx tools/explore.ts <checkpoint> [actions...] [--frames N] [--png-every K]
 *
 * Checkpoints live in out/checkpoints/<name>.bin (a VM snapshot). "cave-start" (a new Wizard in
 * the first cave) and "cave-exit" (the cave solved, room 720) are built on first use by
 * playing the opening. SCI_MODS=out/mods/<name> loads built mods (see tools/mod.ts); checkpoints
 * then are rebuilt each run, since a snapshot only fits the scripts it was made with.
 *
 * Actions run in order, each after the previous one's wait:
 *   click:x,y   move:x,y   key:text   enter   wait:N (frames)   icon:walk|look|do|talk|cast
 *   save:<name> (writes a new checkpoint from the current state)
 *   props:<object>,<prop>,...   planes   items   snap / diff (frame index + palette diff)
 *   room:<n> (jump there, as the player's #room/<n>)   alt:<letter> (Alt+key; --debug enables
 *   Sierra's debug room: alt:t teleports, alt:h sets the hour)   fkey:<n> (F1-F10; F7 restore)
 *   objs:<name>,<prop>,... (every instance, full references)   fakesaves:<n> (fill the save list)
 *   loadsaves:<file.json> (saves from the player "Export saves" button; restores the newest)
 * WATCH=<object>.<prop> logs every change to a property with the send that was running.
 * Coordinates are screen coordinates; room features are local to the room plane (y - 10).
 * KTRACE=<regex> logs matching kernel calls; --trace-sends <regex> logs method calls.
 * Every message the game shows is printed with its text.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { deserialize, serialize } from "node:v8";
import {
  EventType, ResourceManager, ResourceType, Vm, allKernels, audio, findMessage, hostFiles, saves, readingTime, requestRoom, graphics, input, parseMessages, restore, restoreGame, savesFromJson, snapshot, stringHelpers,
  type MessageFile, type SaveInfo, type VmSnapshot,
} from "@sci-ts/sci";
import { nodeFiles } from "./node-files.ts";
import { framePng } from "./png.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const checkpoint = argv[0] ?? "cave-exit";
const valued = new Set(["--frames", "--png-every", "--trace-sends"]);
const actions = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !valued.has(all[i]!) && !valued.has(all[i - 1]!));
const pngEvery = Number(opt("--png-every") ?? 0);
const tail = Number(opt("--frames") ?? 300);

// SCI_MODS=out/mods/<name>[,...] loads built mods over the game (see tools/mod.ts).
const gameDir = process.env.SCI_GAME ?? "original";
const mods = (process.env.SCI_MODS ?? "").split(",").filter(Boolean).map((dir) => relative(gameDir, dir));
const rm = await ResourceManager.open(nodeFiles(gameDir), ["", "PATCHES", ...mods]);
await rm.preload();
const vm = new Vm(rm);
vm.registerKernels(allKernels);
// --debug: Sierra's debug room (it loads when "18.scr" exists), as the player's ?debug.
if (argv.includes("--debug")) hostFiles(vm).add("18.scr");
// As in the browser: with mods, lines without recordings stay up long enough to read.
if (mods.length) audio(vm).missingSpeechTicks = readingTime(vm);
const g = graphics(vm);
vm.clock = () => (g.frames * 1000) / 60;
const inp = input(vm);

const files = new Map<number, MessageFile>();
const text = (m: number, noun: number, verb: number, cond: number, seq: number) => {
  if (!files.has(m)) files.set(m, parseMessages(rm.loadSync({ type: ResourceType.Message, number: m }).data));
  return findMessage(files.get(m)!, { noun, verb, cond, seq })?.text ?? "(no text)";
};
const kernelStats = new Map<string, number>();
vm.onKernelCall = (name, args, result) => {
  // KDUMP=<kernel>: after each call, show what its reference arguments point at (debugging).
  if (process.env.KDUMP === name) for (const a of args) {
    const arr = vm.memory.array(a), o = vm.memory.object(a);
    if (arr) console.log(`    ${a.toString(16)}: ${arr.type}[${arr.data.length}] ${arr.data.slice(0, 12).join(",")}`);
    else if (o) console.log(`    ${a.toString(16)}: object ${o.name} data=${(vm.getProp(o, "data") ?? 0).toString(16)}`);
  }
  if (process.env.KSTATS) kernelStats.set(name, (kernelStats.get(name) ?? 0) + 1);
  if (process.env.KTRACE && new RegExp(process.env.KTRACE).test(name)) console.log(`  [${g.frames}] ${name}(${args.map((a) => a.toString(16)).join(", ")}) = ${result === undefined ? "-" : Number(result).toString(16)}`);
  if (name === "Message" && args[0] === 0 && args.length === 7) {
    const [, m = 0, n = 0, v = 0, c = 0, s = 0] = args;
    console.log(`[${g.frames}] ${m}/${n}/${v}/${c}/${s}: ${text(m, n, v, c, s)}`);
  }
  // Subop 1: the next message of the current sequence, written into the buffer.
  if (name === "Message" && args[0] === 1 && args[1] && result) console.log(`[${g.frames}]   ...next: ${stringHelpers.str(vm, args[1])}`);
};

// --trace-sends <regex>: log method calls on objects whose name matches, during actions.
const traceSends = opt("--trace-sends");
let tracing = false;
if (traceSends) {
  const re = new RegExp(traceSends);
  vm.onSend = (obj, sel, argc) => {
    if (tracing && re.test(obj.name)) console.log(`  [${g.frames}] ${obj.name} ${sel}${argc ? `(${argc})` : ""}`);
  };
}

// WATCH=object.property: log every change to it, with the send that was running (debugging).
if (process.env.WATCH) {
  const [objName, propName] = process.env.WATCH.split(".") as [string, string];
  let last: number | undefined;
  const previous = vm.onSend;
  vm.onSend = (obj, sel, argc) => {
    previous?.(obj, sel, argc);
    const target = [...vm.memory.objects.values()].find((o) => o.name === objName);
    const v = target ? vm.getProp(target.address, propName) : undefined;
    if (v !== last) console.log(`  [${g.frames}] ${objName}.${propName}: ${last?.toString(16)} → ${v?.toString(16)} (before ${obj.name} ${sel})`);
    last = v;
  };
}
mkdirSync("out/checkpoints", { recursive: true });
mkdirSync("out/explore", { recursive: true });
const path = (name: string) => `out/checkpoints/${name}.bin`;
const move = (x: number, y: number) => ([inp.x, inp.y] = [x, y]);
const click = (x: number, y: number) => {
  move(x, y);
  inp.push({ type: EventType.MouseDown, message: 0 });
  inp.push({ type: EventType.MouseUp, message: 0 });
};
// A modal loop (a dialog waiting for a click) may poll events without drawing frames, so
// run in small slices and count five slices without a frame as one, letting input through.
let idle = 0;
const run = (frames: number) => {
  const end = g.frames + frames;
  while (g.frames < end && vm.running) {
    const before = g.frames;
    vm.run(200_000);
    if (g.frames !== before) idle = 0;
    else if (++idle >= 5) {
      idle = 0;
      g.frames++;
      if (process.env.KSTATS) console.log("  (no frame drawn: modal loop?)", Object.fromEntries(kernelStats));
    }
    if (pngEvery && g.frames % pngEvery === 0) writeFileSync(`out/explore/${String(g.frames).padStart(6, "0")}.png`, framePng(g.compose()));
  }
};

if (existsSync(path(checkpoint)) && !(mods.length && checkpoint.startsWith("cave-"))) {
  vm.start(vm.exportAddress(0, 0), "play");
  vm.run(); // initialise the game object before replacing memory
  restore(vm, deserialize(readFileSync(path(checkpoint))) as VmSnapshot);
  vm.resetExecution();
  vm.start(vm.exportAddress(0, 0), "replay");
  run(60);
} else if (checkpoint === "cave-exit" || checkpoint === "cave-start") {
  // cave-start: just created a Wizard, standing in the first cave. cave-exit: solved it.
  // Not saved when mods are loaded: a snapshot only fits the scripts it was made with.
  const until = checkpoint === "cave-start" ? 5300 : 10200;
  console.log(`building checkpoint ${checkpoint} (plays the opening route)...`);
  const type = (t: string) => {
    for (const ch of t) inp.push({ type: EventType.KeyDown, message: ch.charCodeAt(0) });
    inp.push({ type: EventType.KeyDown, message: 13 });
  };
  const script: Record<number, () => void> = {
    1401: () => click(160, 60), 1800: () => click(185, 110), 2000: () => click(100, 185), 2100: () => type("Hero"),
    2300: () => click(30, 185), 2600: () => click(170, 112), 5300: () => move(35, 2), 5360: () => click(35, 14),
    5400: () => click(250, 140), 6400: () => move(172, 2), 6460: () => click(172, 14), 6600: () => click(122, 98),
    6900: () => click(253, 80), 7200: () => click(253, 80), 7800: () => move(89, 2), 7860: () => click(89, 14),
    7950: () => click(253, 80), 8600: () => move(89, 2), 8660: () => click(89, 14), 8800: () => click(156, 57),
  };
  vm.start(vm.exportAddress(0, 0), "play");
  while (g.frames < until) {
    script[g.frames]?.();
    vm.run();
  }
  if (!mods.length) writeFileSync(path(checkpoint), serialize(snapshot(vm)));
} else throw new Error(`no checkpoint ${checkpoint}`);

tracing = true;
let snapFrame: ReturnType<typeof g.compose> | undefined;
const ALT_SCAN: Record<string, number> = Object.fromEntries([..."QWERTYUIOP"].map((k, i) => [k, 0x10 + i]).concat([..."ASDFGHJKL"].map((k, i) => [k, 0x1e + i]), [..."ZXCVBNM"].map((k, i) => [k, 0x2c + i])));
const ICON_X: Record<string, number> = { walk: 35, look: 60, do: 89, talk: 117, actions: 143, cast: 172 };
for (const a of actions) {
  const [kind, arg = ""] = a.split(/:(.*)/);
  const [x = 0, y = 0] = arg.split(",").map(Number);
  switch (kind) {
    // Hover first, like a real mouse: some UIs (the spell window) select what's highlighted.
    case "click": move(x, y); run(6); click(x, y); run(90); break;
    case "move": move(x, y); run(30); break;
    case "wait": run(x); break;
    case "enter": inp.push({ type: EventType.KeyDown, message: 13 }); run(30); break;
    case "key": for (const ch of arg) inp.push({ type: EventType.KeyDown, message: ch.charCodeAt(0) }); run(30); break;
    case "icon": move(ICON_X[arg]!, 2); run(40); click(ICON_X[arg]!, 14); run(40); break;
    case "planes":
      for (const pl of g.planes) {
        const props = ["priority", "picture", "left", "top", "right", "bottom", "inLeft", "inTop", "inRight", "inBottom", "vanishingX", "vanishingY"].map((k) => `${k}=${g.prop(pl, k)}`);
        console.log(`  plane ${vm.memory.object(pl)?.name} ${pl.toString(16)} ${props.join(" ")}`);
      }
      break;
    case "items":
      for (const it of g.items) {
        const props = ["plane", "view", "loop", "cel", "x", "y", "z", "priority", "fixPriority", "scaleSignal", "scaleX", "scaleY", "bitmap"].map((k) => `${k}=${(g.prop(it, k) >>> 0).toString(16)}`);
        console.log(`  item ${vm.memory.object(it)?.name} ${props.join(" ")}`);
      }
      break;
    case "room": requestRoom(vm, x); run(1); break; // as the player's #room/N does
    case "png": writeFileSync(`out/explore/${arg}.png`, framePng(g.compose())); break; // snapshot mid-script
    case "addsave": { // a checkpoint file (an earlier session's snapshot) as a saved game
      const version = saves(vm).store.list()[0]?.version ?? "";
      saves(vm).store.put({ id: 90, description: `checkpoint ${arg}`, version, date: Date.now() + 1000 }, deserialize(readFileSync(path(arg))) as VmSnapshot);
      console.log(`  added checkpoint ${arg} as a save (version ${JSON.stringify(version)})`);
      break;
    }
    case "loadsaves": { // saves exported from the player (Export saves); restores the newest, as #room/N does
      const list = savesFromJson<SaveInfo>(readFileSync(arg, "utf8"));
      for (const s of list) saves(vm).store.put(s.info, s.snapshot);
      const newest = saves(vm).store.list()[0];
      console.log(`  loaded ${list.length} saves; restoring "${newest?.description}" (id ${newest?.id})`);
      if (newest) restoreGame(vm, saves(vm).store.get(newest.id)!.snapshot);
      run(120);
      break;
    }
    case "fakesaves": { // n saved games (copies of the current state), for testing the Restore dialog
      const snap = snapshot(vm);
      const odd = process.env.ODD_SAVES ? JSON.parse(process.env.ODD_SAVES) as { description: string; version?: string }[] : [];
      for (let i = 0; i < x; i++) {
        const o = odd[i];
        saves(vm).store.put({ id: 100 + i, description: o?.description ?? `Save number ${i + 1} ${"x".repeat(i % 12)}`, version: o?.version ?? "", date: Date.now() - i }, snap);
      }
      break;
    }
    case "fkey": inp.push({ type: EventType.KeyDown, message: (0x3a + x) << 8 }); run(30); break; // F1-F10
    case "alt": inp.push({ type: EventType.KeyDown, message: ALT_SCAN[arg.toUpperCase()]! << 8, modifiers: 8 }); run(30); break;
    case "objs": { // every object with this name, full references: objs:Scaler,client,lastY
      const [name, ...keys] = arg.split(",");
      for (const o of vm.memory.objects.values()) {
        if (o.name !== name || o.isClass) continue;
        const show = (v: number) => { const t = vm.memory.object(v); return t ? `${t.name}@${v.toString(16)}` : String(v >= 0x8000 && v < 0x10000 ? v - 0x10000 : v); };
        console.log(`  ${name}@${o.address.toString(16)} ${keys.map((k) => `${k}=${show(vm.getProp(o.address, k) ?? 0)}`).join(" ")}`);
      }
      break;
    }
    case "props": {
      const [name, ...keys] = arg.split(",");
      for (const o of vm.memory.objects.values()) {
        if (o.name !== name) continue;
        console.log(`  ${name}${o.isClass ? " (class)" : ""} ${keys.map((k) => `${k}=${(vm.getProp(o.address, k) ?? NaN) << 16 >> 16}`).join(" ")}`);
      }
      break;
    }
    case "snap": snapFrame = g.compose(); break;
    case "diff": {
      const now = g.compose(), before = snapFrame!;
      let idx = 0;
      for (let i = 160 * 320; i < 199 * 320; i++) if (now.pixels[i] !== before.pixels[i]) idx++;
      const changed: number[] = [];
      for (let c = 0; c < 256; c++) if ([0, 1, 2].some((k) => now.palette.rgb[c * 3 + k] !== before.palette.rgb[c * 3 + k])) changed.push(c);
      console.log(`  diff: ${idx} index changes in rows 160-198; palette entries changed: ${changed.length} [${changed.slice(0, 40).join(",")}]`);
      break;
    }
    case "save": writeFileSync(path(arg), serialize(snapshot(vm))); console.log(`checkpoint ${arg} saved at frame ${g.frames}`); break;
    default: throw new Error(`unknown action ${a}`);
  }
}
run(tail);
writeFileSync("out/explore/last.png", framePng(g.compose()));
const ego = vm.object(vm.loadedScripts.find((s) => s.number === 0)!.locals[0]!);
const room = vm.loadedScripts.find((s) => s.number === 0)!.locals[11]; // curRoomNum
console.log(`done at frame ${g.frames} · room ${room} · ego ${g.prop(ego.address, "x")},${g.prop(ego.address, "y")} · missing kernels:`, Object.fromEntries(vm.missingKernels));
