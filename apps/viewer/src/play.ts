import { activeMods, availableMods, openGame, rememberMods } from "./files.ts";
import { GameSession } from "./session.ts";
import { ROOM_NUM_GLOBAL, ResourceType, heroInPlay, requestRoom, saves, savesToJson, type MemorySaveStore } from "@sci-ts/sci";
import { APP_ID } from "./app.ts";
import { gameProfile } from "./game-profile.ts";

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const status = document.getElementById("status")!;
const errorBox = document.getElementById("error")!;
const musicButton = document.getElementById("music") as HTMLButtonElement;

// Mods (?mods=a,b or the last choice) load as patch directories over the game.
const { rm, mods } = await openGame();
// `?mute` keeps audio off (e.g. automated testing in a background tab).
const params = new URLSearchParams(location.search);
// `?debug` turns on Sierra's own debug room (Alt-T teleport, Alt-G flags, Alt-I items...).
const session = await GameSession.create({ canvas, rm, mods, muted: params.has("mute"), debug: params.has("debug") });
await setUpModPicker();
// For poking at the running game from the browser console (and automated checks).
(window as unknown as { sci: unknown }).sci = { session };

// Saved games as a JSON file, to replay them headlessly (tools/explore.ts loadsaves:<file>).
document.getElementById("export-saves")!.addEventListener("click", () => {
  const store = saves(session.vm).store as MemorySaveStore;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([savesToJson([...store.saves.values()])], { type: "application/json" }));
  a.download = `${APP_ID}-saves${mods.length ? `-${mods.join("+")}` : ""}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
const startRoom = /^#room\/(\d+)$/.exec(location.hash) ? Number(location.hash.slice(6)) : undefined;
/** What room navigation is doing, shown on the status line. */
let roomStatus: string | undefined;
setUpRoomNavigation();

/**
 * Rooms in the address bar: `#room/250` goes there. Opened that way, the game doesn't make
 * you sit through the intro: it loads your newest saved game (your hero, your progress), or
 * with none (or `?fresh`), fast-forwards through character creation to a new Wizard called
 * Hero. Then it jumps. Editing the hash jumps again, and Back returns to the last jump; the
 * hash follows the game's own room changes without adding history entries.
 */
function setUpRoomNavigation() {
  /** The room asked for, kept until the game gets there (or gives up). */
  let wanted: { room: number; since: number } | undefined;
  let shown = 0;
  const readHash = () => {
    const m = /^#room\/(\d+)$/.exec(location.hash);
    if (!m) return;
    const room = Number(m[1]);
    if (room === shown && !wanted) return; // the hash we wrote ourselves
    if (!rm.has({ type: ResourceType.Script, number: room })) {
      roomStatus = `There's no room ${room}`;
      return;
    }
    wanted = { room, since: performance.now() };
  };
  readHash();
  // Editing the address bar fires hashchange (and popstate, in some browsers and for Back).
  addEventListener("hashchange", readHash);
  addEventListener("popstate", readHash);

  session.onDraw.push(() => {
    const vm = session.vm;
    // The 20 s allowance only counts while a hero is in play (making one takes a while).
    if (session.fastForwarding || !heroInPlay(vm)) {
      if (wanted) wanted.since = performance.now();
      if (session.fastForwarding) return;
    }
    const room = vm.loadedScripts.find((s) => s.number === 0)?.locals[ROOM_NUM_GLOBAL] ?? 0;
    if (wanted) {
      if (room === wanted.room) {
        roomStatus = undefined;
        wanted = undefined;
      } else if (!heroInPlay(vm)) {
        roomStatus = `Room ${wanted.room}: waiting for a hero (create one, or restore a save)`;
      } else if (performance.now() - wanted.since > 20_000) {
        roomStatus = `Couldn't get to room ${wanted.room} (the game didn't leave room ${room})`;
        wanted = undefined;
      } else {
        // Ask again every frame: while a message or a scripted scene holds the game, its
        // main loop isn't checking, and a room may reset the request when it starts.
        requestRoom(vm, wanted.room);
        roomStatus = performance.now() - wanted.since > 1500
          ? `Going to room ${wanted.room}… (close any message on screen)`
          : `Going to room ${wanted.room}…`;
      }
    }
    if (room && room !== shown && heroInPlay(vm)) {
      shown = room;
      if (location.hash !== `#room/${room}`) history.replaceState(null, "", `#room/${room}`);
    }
  });
}

/** How a `#room/N` visit gets a hero: the newest save, or a quick new one. */
const quickStart = gameProfile(session.vm)?.quickStart(session.vm);

function startGame() {
  const store = saves(session.vm).store;
  const info = params.has("fresh") ? undefined : store.list()[0];
  const newest = info && store.get(info.id);
  if (startRoom === undefined) return session.start();
  if (newest) {
    status.textContent = `Loading "${newest.info.description}" to go to room ${startRoom}…`;
    session.start();
    // Restore once the game is up (it needs its first frame to exist), like the game's own Restore.
    let done = false;
    session.onDraw.push(() => {
      if (done) return;
      done = true;
      session.restore(newest.snapshot);
    });
    return;
  }
  if (!quickStart) {
    status.textContent = `Play until your character can walk around, then it goes to room ${startRoom}`;
    return session.start();
  }
  status.textContent = `Creating a hero to go to room ${startRoom}…`;
  session.start({ fastForward: quickStart });
}

/** Checkboxes for the built mods; applying reloads the page with the new set. */
async function setUpModPicker() {
  const list = document.getElementById("mod-list")!;
  const apply = document.getElementById("mods-apply") as HTMLButtonElement;
  const summary = document.querySelector("#mods summary")!;
  const built = await availableMods();
  const on = new Set(activeMods());
  summary.textContent = on.size ? `Mods: ${[...on].join(", ")}` : "Mods";
  if (!built.length) {
    list.innerHTML = '<span class="none">No mods built. Try <code>pnpm mod build mods/altar-hello</code>.</span>';
    apply.hidden = true;
    return;
  }
  for (const name of built) {
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: on.has(name), value: name });
    const label = document.createElement("label");
    label.append(box, ` ${name}`);
    list.append(label);
  }
  apply.addEventListener("click", () => {
    const chosen = [...list.querySelectorAll<HTMLInputElement>("input:checked")].map((b) => b.value);
    rememberMods(chosen);
    const url = new URL(location.href);
    url.searchParams.set("mods", chosen.join(","));
    location.href = url.toString();
  });
}

const showMusicMode = () =>
  (musicButton.textContent = session.musicMode === "adlib" ? "Music: AdLib (OPL2 FM, 1994 Sound Blaster)" : "Music: General MIDI (SoundFont)");
musicButton.addEventListener("click", () => {
  session.setMusicMode(session.musicMode === "adlib" ? "gm" : "adlib");
  showMusicMode();
});
showMusicMode();

let lastStatus = 0;
session.onDraw.push(() => {
  if (session.error) {
    errorBox.hidden = false;
    errorBox.textContent = `${session.error.message}\n${session.error.backtrace.map((l) => `  at ${l}`).join("\n")}`;
    return;
  }
  const now = performance.now();
  if (session.fastForwarding) {
    if (now - lastStatus > 250) (status.textContent = `Creating a hero… (${Math.min(100, Math.round((session.frames / (quickStart?.until ?? 1)) * 100))}%)`), (lastStatus = now);
    return;
  }
  if (now - lastStatus < 1000) return;
  lastStatus = now;
  status.textContent = !session.vm.running ? "Game exited." : roomStatus ?? `${session.fps} fps · ${session.vm.instructions.toLocaleString()} instructions${mods.length ? ` · mods: ${mods.join(", ")}` : ""}${params.has("debug") ? " · debug: Alt-T teleport" : ""}${session.musicMode === "gm" && !session.music.ready ? " · SoundFont loading" : ""}`;
});
status.textContent = "Running";
startGame();
