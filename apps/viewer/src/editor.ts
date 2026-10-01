import { indentWithTab } from "@codemirror/commands";
import { yaml as yamlLanguage } from "@codemirror/lang-yaml";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { ResourceManager, gameGlobal, drawnItems, graphics, heroInPlay, replaceResources, requestRoom, roomPlane, type ResourceType, type VmSnapshot } from "@sci-ts/sci";
import { basicSetup } from "codemirror";
import { parse as parseYaml } from "yaml";
import { EditLayer, type EditMode } from "./editor-handles.ts";
import { sciAssembly, sciMessages, yarn } from "./editor-languages.ts";
import { httpFiles } from "./files.ts";
import { OVERLAY_COLORS, createOverlay, drawRoomOverlay } from "./overlay.ts";
import { gameProfile } from "./game-profile.ts";
import { GameSession } from "./session.ts";

/**
 * The live room editor: a room's .room.yaml and .yarn on the left, the game on the right.
 * Saving (⌘S, or a pause in typing with "live" on) writes the files into the mod and builds
 * it on the dev server (tools/editor-server.ts); the built resources are swapped into the
 * running game, which goes back to a snapshot taken just before entering the room and
 * walks in again. The snapshot comes from a quick new hero (the game's profile in games/), so it
 * never holds the room being edited. Outlines show what the room is made of, by name.
 */

interface BuildResult {
  ok: boolean;
  resources?: { type: ResourceType; number: number; data: string }[];
  generated?: Record<string, string>;
  flags?: string;
  reload?: boolean;
  ms?: number;
  error?: { message: string; file?: string; line?: number };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const statusEl = $("status");
const status = (text: string, kind: "" | "ok" | "error" = "") => {
  statusEl.textContent = text;
  statusEl.className = kind;
};

// --- Which mod and room ---------------------------------------------------------------

// A mod of Sierra's game, or the game of ours the dev server is serving (its rooms/).
const mods = (await (await fetch("/__editor/mods")).json()) as { name: string; kind: "mod" | "game"; rooms: number[] }[];
const editable = mods.filter((m) => m.rooms.length);
if (!editable.length) {
  status(mods[0]?.kind === "game" ? `${mods[0].name} has no rooms/<n>.room.yaml yet.` : "No mod has a <n>.room.yaml yet (see mods/README.md).", "error");
  throw new Error("nothing to edit");
}
const mod = editable.find((m) => m.name === params.get("mod")) ?? editable[0]!;
const room = mod.rooms.includes(Number(params.get("room"))) ? Number(params.get("room")) : mod.rooms[0]!;
const modSelect = $<HTMLSelectElement>("mod"), roomSelect = $<HTMLSelectElement>("room");
modSelect.append(...editable.map((m) => new Option(m.name, m.name, false, m === mod)));
roomSelect.append(...mod.rooms.map((r) => new Option(String(r), String(r), false, r === room)));
const go = (m: string, r?: number) => {
  const q = new URLSearchParams({ mod: m, ...(r !== undefined ? { room: String(r) } : {}) });
  location.search = q.toString();
};
modSelect.onchange = () => go(modSelect.value);
roomSelect.onchange = () => go(mod.name, Number(roomSelect.value));
document.title = `${mod.name} ${room} · Room Editor`;

// --- Files, tabs and the code editor ----------------------------------------------------

const files = (await (await fetch(`/__editor/files?mod=${mod.name}`)).json()) as Record<string, string>;
const yamlName = `${room}.room.yaml`, yarnName = `${room}.yarn`;
const scaName = `${room}.sca (compiled)`, msgName = `${room}.msg (compiled)`;
const editableNames = [yamlName, yarnName];
const tabNames = [...editableNames, "flags.yaml", scaName, msgName];
/** What was last sent to the server, per editable file. */
const saved = new Map(editableNames.map((n) => [n, files[n] ?? ""]));

const languageOf = (name: string): Extension =>
  name.endsWith(".yaml") ? yamlLanguage() : name.endsWith(".yarn") ? yarn : name === scaName ? sciAssembly : name === msgName ? sciMessages : [];

const theme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-content": { fontFamily: "inherit" },
  ".cm-gutters": { fontFamily: "inherit" },
});

function makeState(name: string, text: string): EditorState {
  const isEditable = editableNames.includes(name);
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      oneDark,
      theme,
      languageOf(name),
      lintGutter(),
      keymap.of([indentWithTab, { key: "Mod-s", run: () => (void build(), true) }]),
      EditorState.readOnly.of(!isEditable),
      EditorView.editable.of(isEditable),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && isEditable) {
          renderTabs();
          scheduleBuild();
        }
      }),
    ],
  });
}

const states = new Map<string, EditorState>(tabNames.map((n) => [
  n,
  makeState(n, n === "flags.yaml" ? files[n] ?? "# No variables yet: <<set $name to true>> in Yarn adds them here.\n" : editableNames.includes(n) ? files[n] ?? "" : "Builds on save."),
]));
let current = yamlName;
const view = new EditorView({ parent: $("code"), state: states.get(current)! });
let error: BuildResult["error"];

const textOf = (name: string) => (name === current ? view.state : states.get(name)!).doc.toString();

const tabs = $("tabs"), problems = $("problems");
function renderTabs(): void {
  tabs.replaceChildren(
    ...tabNames.map((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name;
      b.classList.toggle("active", name === current);
      b.classList.toggle("dirty", editableNames.includes(name) && textOf(name) !== saved.get(name));
      b.classList.toggle("has-error", error?.file === name);
      b.onclick = () => show(name);
      return b;
    }),
  );
}

/** The error as a diagnostic on its line, in the tab it belongs to. */
function diagnostics(name: string, state: EditorState): Diagnostic[] {
  if (!error || error.file !== name || !error.line || error.line > state.doc.lines) return [];
  const line = state.doc.line(error.line);
  return [{ from: line.from, to: Math.max(line.to, line.from), severity: "error", message: error.message.replace(/^[^:]+:\d+:\s*/, "") }];
}

function show(name: string, line?: number): void {
  states.set(current, view.state);
  current = name;
  view.setState(states.get(name)!);
  view.dispatch(setDiagnostics(view.state, diagnostics(name, view.state)));
  if (line && line <= view.state.doc.lines) {
    const pos = view.state.doc.line(line).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
  }
  renderTabs();
}

/**
 * Replaces an editable file's text with the smallest change (so the cursor, scrolling and
 * undo behave), shown in its tab: what dragging and drawing on the game do to the YAML.
 */
function editText(name: string, text: string): void {
  if (current !== name) show(name);
  const old = view.state.doc.toString();
  if (old === text) return;
  let from = 0;
  while (from < old.length && from < text.length && old[from] === text[from]) from++;
  let oldEnd = old.length, newEnd = text.length;
  while (oldEnd > from && newEnd > from && old[oldEnd - 1] === text[newEnd - 1]) (oldEnd--, newEnd--);
  view.dispatch({
    changes: { from, to: oldEnd, insert: text.slice(from, newEnd) },
    effects: EditorView.scrollIntoView(from, { y: "nearest", yMargin: 40 }),
  });
}

/** Replaces a read-only tab's text (flags, compiled output). */
function setView(name: string, text: string): void {
  const state = makeState(name, text);
  if (name === current) view.setState(state);
  else states.set(name, state);
}

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void build();
  }
});
problems.onclick = () => error?.file && editableNames.includes(error.file) && show(error.file, error.line);
$("save").onclick = () => void build();
renderTabs();

// --- Building -------------------------------------------------------------------------

const auto = $<HTMLInputElement>("auto");
let timer: ReturnType<typeof setTimeout> | undefined;
/** While a drag or brush stroke is in progress, builds wait for it to end. */
let held = false;
function scheduleBuild(): void {
  clearTimeout(timer);
  if (auto.checked && !held) timer = setTimeout(() => void build(), 700);
}

let building: Promise<void> | undefined;
let again = false;
async function build(): Promise<void> {
  clearTimeout(timer);
  if (building) {
    again = true;
    return building;
  }
  building = (async () => {
    const sent = new Map(editableNames.map((n) => [n, textOf(n)]));
    status("Building…");
    const body = { files: Object.fromEntries([...sent].filter(([name, t]) => t !== "" || files[name] !== undefined)) };
    let result: BuildResult;
    try {
      result = await (await fetch(`/__editor/save?mod=${mod.name}`, { method: "POST", body: JSON.stringify(body) })).json();
    } catch (e) {
      result = { ok: false, error: { message: `The dev server didn't answer: ${(e as Error).message}` } };
    }
    for (const [name, t] of sent) saved.set(name, t);
    applyResult(result);
  })();
  await building;
  building = undefined;
  if (again) {
    again = false;
    await build();
  }
}

function applyResult(result: BuildResult): void {
  error = result.ok ? undefined : result.error;
  problems.hidden = result.ok;
  problems.textContent = error ? `${error.message}${error.file && editableNames.includes(error.file) ? "\n(click to go there)" : ""}` : "";
  view.dispatch(setDiagnostics(view.state, diagnostics(current, view.state)));
  if (result.ok) {
    if (result.reload) {
      // The game's selector or class tables changed: the running game can't take that.
      status("Rebuilt: reloading…");
      location.reload();
      return;
    }
    if (result.flags !== undefined) setView("flags.yaml", result.flags);
    setView(scaName, result.generated?.[`${room}.sca`] ?? "");
    setView(msgName, result.generated?.[`${room}.msg`] ?? "");
    readExits();
    const resources = (result.resources ?? []).map((r) => ({ type: r.type, number: r.number, data: Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)) }));
    if (session) {
      replaceResources(session.vm, resources);
      restartScene();
    } else for (const r of resources) rm.override(r, r.data);
    status(`Built in ${result.ms} ms`, "ok");
  } else status("Build failed: see below", "error");
  renderTabs();
}

/** The room's exits, by name, from the YAML that built (they're outlined in their own colour). */
let exits = new Set<string>();
function readExits(): void {
  try {
    exits = new Set(Object.keys((parseYaml(saved.get(yamlName) ?? "") as { exits?: object } | null)?.exits ?? {}));
  } catch {
    /* keep the last good set */
  }
}

// --- The game -------------------------------------------------------------------------

// A mod's resources come from the builds (swapped in memory), not from out/mods; a game's
// from out/games, with the builds' changes swapped in.
const rm = await ResourceManager.open(httpFiles, ["", "PATCHES"]);
let session: GameSession | undefined;
await build();
while (error) {
  // Nothing to run until the mod builds: wait for the next successful save.
  await new Promise((r) => setTimeout(r, 300));
}
session = await GameSession.create({
  canvas: $<HTMLCanvasElement>("screen"), rm, mods: mod.kind === "mod" ? [mod.name] : [], saveNamespace: `editor:${mod.name}`, muted: true,
});
const vm = session.vm;

/**
 * The game just before entering the room: a hero, outside it (a new one, made by the quick
 * route, awake in the first cave; or one made by hand if that didn't work out).
 */
let base: VmSnapshot | undefined;
let entering = false;
let readyAt = 0;
const quickStart = gameProfile(vm)?.quickStart(vm);
if (quickStart) {
  status("Creating a hero…");
  session.start({
    fastForward: {
      ...quickStart,
      done: () => {
        entering = true;
        readyAt = performance.now();
      },
    },
  });
} else {
  // No quick route for this game: the player makes a character, then it goes to the room.
  session.start();
  entering = true;
  readyAt = performance.now();
}

function restartScene(): void {
  if (!base || !session) return;
  session.restore(base);
  entering = true;
}
$("restart").onclick = restartScene;

const roomNow = () => gameGlobal(vm, "curRoomNum");
session.onDraw.push(() => {
  if (!entering || session!.fastForwarding) return;
  if (roomNow() === room) {
    entering = false;
    if (!error) status(`In room ${room}`, "ok");
  } else if (heroInPlay(vm)) {
    base ??= session!.snapshot();
    requestRoom(vm, room);
  } else if (performance.now() - readyAt > 4000) {
    status("No hero yet: finish creating one in the game (Play), then it goes to the room", "error");
  }
});

// Outlines: features, exits, sprites, walk areas, by name (on by default).
const overlay = createOverlay();
$("screen-box").append(overlay);
const outlines = $<HTMLInputElement>("outlines");
$("legend").replaceChildren(
  ...([["features", OVERLAY_COLORS.feature], ["exits", OVERLAY_COLORS.exit], ["props", OVERLAY_COLORS.sprite], ["hero", OVERLAY_COLORS.hero], ["walkable", OVERLAY_COLORS.polygons[3]!], ["obstacles", OVERLAY_COLORS.polygons[2]!]] as const).map(([name, color]) => {
    const s = document.createElement("span");
    s.textContent = name;
    s.style.setProperty("--swatch", color);
    return s;
  }),
);
const legend = $("legend");
const drawOutlines = () => {
  legend.style.display = outlines.checked ? "" : "none";
  if (!outlines.checked || roomNow() !== room) overlay.replaceChildren();
  else {
    drawRoomOverlay(overlay, vm, { sprites: true, features: true, polygons: true, paths: true, isExit: (n) => exits.has(n) });
    // A dialog (a plane above the room's and the status bar's) is what matters then.
    overlay.style.opacity = dialogOpen() ? "0.12" : "1";
  }
};
function dialogOpen(): boolean {
  const g = graphics(vm);
  const roomPriority = roomPlane(vm) ? g.prop(roomPlane(vm)!.address, "priority") : 0;
  return [...g.planes].some((p) => vm.memory.object(p) && g.prop(p, "priority") > roomPriority + 1);
}
outlines.onchange = drawOutlines;
session.onDraw.push(drawOutlines);
readExits();

// Moving things by dragging them, and painting walk areas: edits to the YAML.
const roomOffset = (): [number, number] => {
  const plane = roomPlane(vm);
  return plane ? [plane.left, plane.top] : [0, 10];
};
const editLayer = new EditLayer({
  yaml: () => textOf(yamlName),
  setYaml: (text) => editText(yamlName, text),
  roomOffset,
  spriteBox: (name) => {
    const [ox, oy] = roomOffset();
    const d = drawnItems(vm).find((item) => item.item.name === name);
    return d && { x: d.x - ox, y: d.y - oy, w: d.w, h: d.h };
  },
  previewProp: (name, [x, y]) => {
    const prop = [...vm.memory.objects.values()].find((o) => o.name === name && !o.isClone);
    if (!prop) return;
    vm.setProp(prop, "x", x);
    vm.setProp(prop, "y", y);
  },
  holdBuild: (hold) => {
    held = hold;
    if (hold) clearTimeout(timer);
    else if (auto.checked) void build();
  },
});
$("screen-box").append(editLayer.svg);
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("#modes button")];
const setMode = (mode: EditMode) => {
  editLayer.setMode(mode);
  for (const b of modeButtons) b.classList.toggle("active", b.dataset.mode === mode);
  // The game's own outlines step back while the handles are up.
  overlay.style.filter = mode === "play" ? "" : "opacity(0.35)";
};
for (const b of modeButtons) b.onclick = () => setMode(b.dataset.mode as EditMode);
setMode("play");
// Handles follow what's drawn (props move, the YAML changes); not mid-drag, which redraws itself.
session.onDraw.push(() => {
  if (editLayer.mode === "play") return;
  if (!held) editLayer.render();
  editLayer.svg.style.opacity = !held && dialogOpen() ? "0.3" : "1";
});

const sound = $("sound");
sound.onclick = () => {
  session!.setMuted(!session!.muted);
  sound.textContent = session!.muted ? "Sound off" : "Sound on";
};
