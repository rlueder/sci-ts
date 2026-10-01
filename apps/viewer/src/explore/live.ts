import {
  collectionElements, drawnItems, findMessage, gameGlobal, isKindOf, namedObject, objectAt,
  ResourceType, heroInPlay, polygonOf, requestRoom, roomPlane, signedProp, type SciObject, type Value, type Vm, type VmSnapshot,
} from "@sci-ts/sci";
import { createOverlay, drawRoomOverlay } from "../overlay.ts";
import { GameSession } from "../session.ts";
import { editorUrl, el, showValue, type Explorer } from "./context.ts";

/**
 * The live view: the game running in the explorer, with overlays of what the interpreter
 * knows (sprites, clickable features, walk polygons, paths) and inspectors that follow
 * objects' properties as they change.
 */
export interface LiveView {
  element: HTMLElement;
  /** Starts the game on first use; resumes if the view paused it on leaving. */
  activate(): Promise<void>;
  /** Pauses the game (and its audio) while another tab is shown. */
  deactivate(): void;
  /** Inspector panel for the running room, refreshed while shown. */
  roomPanel(): LivePanel;
  /** Inspector panel for one live object by address. */
  objectPanel(address: number): LivePanel;
}

export interface LivePanel {
  element: HTMLElement;
  refresh(): void;
}

// --- The view -------------------------------------------------------------------------

export function createLiveView(ex: Explorer, inspect: (address: number) => void): LiveView {
  const canvas = el("canvas", { width: 320, height: 200 });
  const overlay = createOverlay();
  const screen = el("div", { className: "live-screen" }, canvas);
  screen.append(overlay);

  const toggles = {
    sprites: toggle("Sprites", true),
    features: toggle("Features", false),
    polygons: toggle("Polygons", true, "Walk polygons: green total access, yellow near point, red barred, blue contained"),
    paths: toggle("Paths", true),
  };
  const inspectMode = toggle("Inspect clicks", false);
  const pauseButton = el("button", { type: "button" }, "Pause");
  const stepButton = el("button", { type: "button", disabled: true }, "Step");
  const soundButton = el("button", { type: "button" }, "Sound: off");
  const snapButton = el("button", { type: "button" }, "Snapshot");
  const restoreButton = el("button", { type: "button", disabled: true }, "Restore");
  const info = el("span", { className: "meta" }, "Starting…");
  // Jump to any room once a hero is in play (the game changes rooms itself: global 13).
  const roomInput = el("input", { type: "number", placeholder: "room", min: "1", max: "999" });
  roomInput.style.width = "5.5em";
  const goButton = el("button", { type: "button", title: "Rooms may expect story state (flags, items); ?debug adds Sierra's debug keys" }, "Teleport");
  goButton.addEventListener("click", () => {
    const room = Number(roomInput.value);
    if (!session || !room) return;
    if (!heroInPlay(session.vm)) info.textContent = "Create a hero (or restore a save) first";
    else if (!ex.rm.has({ type: ResourceType.Script, number: room })) info.textContent = `No room ${room}`;
    else requestRoom(session.vm, room);
  });
  // The room the game is in, in the room editor (when a mod describes it in YAML).
  const editLink = el("a", { className: "edit-link", target: "_blank", hidden: true, title: "Open this room in the room editor" });
  let editRoom: number | undefined;
  const errorBox = el("pre", { className: "error", hidden: true });
  const element = el("div", { className: "live" },
    el("div", { className: "live-bar" }, pauseButton, stepButton, soundButton, snapButton, restoreButton, roomInput, goButton, info, editLink),
    el("div", { className: "live-bar" }, ...Object.values(toggles).map((t) => t.label), inspectMode.label,
      el("span", { className: "meta" }, "Alt+click also inspects")),
    screen,
    errorBox,
  );

  let session: GameSession | undefined;
  let starting: Promise<void> | undefined;
  let pausedByTab = false;
  /** The object shown in the inspector, outlined on the overlay. */
  let selected: number | undefined;
  let quickSave: VmSnapshot | undefined;
  const log: { frame: number; text: string }[] = [];
  const rooms: { frame: number; room: number }[] = [];

  function toggle(name: string, on: boolean, title = "") {
    const input = el("input", { type: "checkbox", checked: on });
    return { input, label: el("label", { title }, input, ` ${name}`) };
  }

  const setPaused = (paused: boolean) => {
    if (!session) return;
    session.paused = paused;
    pauseButton.textContent = paused ? "Resume" : "Pause";
    stepButton.disabled = !paused;
  };
  pauseButton.addEventListener("click", () => setPaused(!session?.paused));
  stepButton.addEventListener("click", () => session?.step(1));
  soundButton.addEventListener("click", () => {
    if (!session) return;
    session.setMuted(!session.muted);
    soundButton.textContent = session.muted ? "Sound: off" : "Sound: on";
  });
  snapButton.addEventListener("click", () => {
    if (!session) return;
    quickSave = session.snapshot();
    restoreButton.disabled = false;
    restoreButton.title = `Snapshot from room ${gameGlobal(session.vm, "curRoomNum")}, frame ${session.frames}`;
  });
  restoreButton.addEventListener("click", () => quickSave && session?.restore(quickSave));

  /** What's under a screen point: the frontmost sprite, else a feature of the room. */
  function hitTest(x: number, y: number): SciObject | undefined {
    const vm = session!.vm;
    const hit = drawnItems(vm).find((d) => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h);
    if (hit) return hit.item;
    const plane = roomPlane(vm);
    if (!plane) return undefined;
    const px = x - plane.left, py = y - plane.top;
    return collectionElements(vm, namedObject(vm, "features")).find((f) => {
      const check = objectAt(vm, vm.getProp(f, "onMeCheck"));
      if (check && isKindOf(vm, check, "Polygon")) return pointInPolygon(px, py, polygonOf(vm, check).points);
      const [l, t, r, b] = ["nsLeft", "nsTop", "nsRight", "nsBottom"].map((n) => signedProp(vm, f, n)) as [number, number, number, number];
      return r > l && px >= l && px <= r && py >= t && py <= b;
    });
  }

  function drawOverlay() {
    if (!session) return;
    drawRoomOverlay(overlay, session.vm, {
      sprites: toggles.sprites.input.checked,
      features: toggles.features.input.checked,
      polygons: toggles.polygons.input.checked,
      paths: toggles.paths.input.checked,
      selected,
    });
  }

  let lastInfo = 0;
  async function start() {
    session = await GameSession.create({
      canvas,
      rm: ex.rm,
      mods: ex.mods,
      muted: true,
      runHidden: new URLSearchParams(location.search).has("background"),
      debug: new URLSearchParams(location.search).has("debug"),
      interceptClick: (x, y, e) => {
        if (!inspectMode.input.checked && !e.altKey) return false;
        const hit = hitTest(x, y);
        if (hit) inspect(hit.address);
        return true;
      },
    });
    const vm = session.vm;
    // Log what the game says: messages fetched by a Messager (`nextMsg`), not every UI label.
    let saying = false;
    vm.onSend = (_object, selector) => {
      if (selector === "nextMsg") saying = true;
    };
    vm.onKernelCall = (name, args) => {
      if (name === "Message" && args[0] === 0 && args.length === 7 && saying) {
        saying = false;
        const [, module = 0, noun = 0, verb = 0, cond = 0, seq = 0] = args;
        const frame = session!.frames;
        void ex.messages(module).then((file) => {
          const text = (file && findMessage(file, { noun, verb, cond, seq })?.text) || `${module}/${noun}/${verb}/${cond}/${seq}`;
          log.push({ frame, text });
          if (log.length > 30) log.shift();
        });
      }
    };
    session.onDraw.push(() => {
      if (session!.error) {
        errorBox.hidden = false;
        errorBox.textContent = `${session!.error.message}\n${session!.error.backtrace.map((l) => `  at ${l}`).join("\n")}`;
      }
      const room = gameGlobal(vm, "curRoomNum") ?? 0;
      if (room && rooms.at(-1)?.room !== room) rooms.push({ frame: session!.frames, room });
      drawOverlay();
      const now = performance.now();
      if (now - lastInfo > 500) {
        lastInfo = now;
        info.textContent = `room ${room} · frame ${session!.frames} · ${session!.paused ? "paused" : `${session!.fps} fps`}`;
        if (room !== editRoom) {
          editRoom = room;
          editLink.hidden = true;
          if (room) {
            void editorUrl(room, ex.mods).then((url) => {
              if (!url || editRoom !== room) return;
              editLink.href = url;
              editLink.textContent = `Edit room ${room}`;
              editLink.hidden = false;
            });
          }
        }
        if (activePanel?.element.isConnected) activePanel.refresh();
      }
    });
    // Automated testing (?background) can reach the session from the console.
    if (new URLSearchParams(location.search).has("background")) (globalThis as Record<string, unknown>).liveSession = session;
    session.start();
  }

  let activePanel: LivePanel | undefined;
  const track = (panel: LivePanel) => {
    activePanel = panel;
    panel.refresh();
    return panel;
  };

  return {
    element,
    async activate() {
      await (starting ??= start());
      if (pausedByTab) setPaused(false);
      pausedByTab = false;
    },
    deactivate() {
      if (session && !session.paused) {
        setPaused(true);
        pausedByTab = true;
      }
    },
    roomPanel: () => {
      selected = undefined;
      return track(roomPanel(ex, () => session, log, rooms));
    },
    objectPanel: (address) => {
      selected = address;
      return track(objectPanel(ex, () => session, address));
    },
  };
}

function pointInPolygon(x: number, y: number, points: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!, [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// --- Inspector panels ---------------------------------------------------------------

const liveHref = (ex: Explorer, o: SciObject) => ex.href(`live/${o.address.toString(16)}`);
const liveLink = (ex: Explorer, o: SciObject | undefined) => (o ? el("a", { href: liveHref(ex, o) }, o.name) : el("span", { className: "meta" }, "—"));

/** Where an object is defined, for a link to the static inspector. */
function staticRoute(o: SciObject): string {
  if (o.isClass) return `class/${o.species}`;
  const def = o.isClone && o.template ? o.template : o;
  return def.isClass ? `class/${def.species}` : `object/${def.script.number}/${def.address & 0xffff}`;
}

function roomPanel(ex: Explorer, getSession: () => GameSession | undefined, log: { frame: number; text: string }[], rooms: { frame: number; room: number }[]): LivePanel {
  const element = el("div", {}, el("p", { className: "meta" }, "Starting the game…"));
  return {
    element,
    refresh() {
      const session = getSession();
      if (!session) return;
      const vm = session.vm;
      const room = objectAt(vm, gameGlobal(vm, "curRoom"));
      const roomNum = gameGlobal(vm, "curRoomNum") ?? 0;
      const ego = objectAt(vm, gameGlobal(vm, "ego"));
      const scriptState = (o: SciObject) => {
        const s = objectAt(vm, vm.getProp(o, "script"));
        return s ? el("span", {}, liveLink(ex, s), el("span", { className: "meta" }, ` state ${signedProp(vm, s, "state")}`)) : "";
      };
      const table = (list: SciObject[], extra: (o: SciObject) => (Node | string)[]) => {
        const t = el("table");
        for (const o of list) t.append(el("tr", {}, el("td", {}, liveLink(ex, o)), ...extra(o).map((c) => el("td", { className: "num" }, c))));
        return list.length ? t : el("p", { className: "meta" }, "none");
      };
      const cast = collectionElements(vm, namedObject(vm, "cast"));
      const features = collectionElements(vm, namedObject(vm, "features"));
      const regions = collectionElements(vm, namedObject(vm, "regions"));
      element.replaceChildren(
        el("h2", {}, `Live: room ${roomNum}`),
        el("p", { className: "meta" }, room ? liveLink(ex, room) : "", " · ", el("a", { href: ex.href(`room/${roomNum}`) }, "static view"),
          room ? el("span", {}, " · script ", scriptState(room)) : ""),
        ego ? el("p", {}, "ego ", liveLink(ex, ego), el("span", { className: "meta" }, ` at ${signedProp(vm, ego, "x")},${signedProp(vm, ego, "y")} · view ${signedProp(vm, ego, "view")} loop ${signedProp(vm, ego, "loop")} cel ${signedProp(vm, ego, "cel")} `), scriptState(ego)) : "",
        el("h3", {}, `Cast (${cast.length})`),
        table(cast, (o) => [`${signedProp(vm, o, "x")},${signedProp(vm, o, "y")}`, `view ${signedProp(vm, o, "view")}`, scriptState(o)]),
        el("h3", {}, `Features (${features.length})`),
        table(features, (o) => [`noun ${signedProp(vm, o, "noun")}`]),
        el("h3", {}, `Regions (${regions.length})`),
        table(regions, (o) => [scriptState(o)]),
        el("h3", {}, "Messages"),
        log.length ? el("div", {}, ...[...log].reverse().map((m) => el("p", {}, el("span", { className: "meta" }, `${m.frame} `), m.text))) : el("p", { className: "meta" }, "none yet"),
        el("h3", {}, "Rooms visited"),
        el("div", { className: "chips" }, ...rooms.map((r) => el("a", { href: ex.href(`room/${r.room}`), title: `frame ${r.frame}` }, `${r.room}`))),
      );
    },
  };
}

/** Objects' header slots come first; the name pointer is the last of them. */
const NAME_SLOT = 8;

function objectPanel(ex: Explorer, getSession: () => GameSession | undefined, address: number): LivePanel {
  const element = el("div", {}, el("p", { className: "meta" }, "Starting the game…"));
  const cells = new Map<number, HTMLTableCellElement>();
  const values = new Map<number, number>();
  let built: SciObject | undefined;

  const render = (vm: Vm, v: Value): Node | string => {
    const o = v && v < 0x10000 ? undefined : objectAt(vm, v);
    if (o) return liveLink(ex, o);
    return showValue(v & 0xffff);
  };

  return {
    element,
    refresh() {
      const session = getSession();
      if (!session) return;
      const vm = session.vm;
      const o = objectAt(vm, address);
      if (!o) {
        element.replaceChildren(el("h2", {}, "Gone"), el("p", { className: "meta" }, `Object ${address.toString(16)} no longer exists (disposed, or the room changed).`));
        built = undefined;
        return;
      }
      if (built !== o) {
        built = o;
        cells.clear();
        values.clear();
        // By slot: some properties have no selector name in the vocabulary.
        const props = [...o.propIndex].sort((a, b) => a[1] - b[1]).map(([sel, slot]) => ({ name: vm.selectors[sel] ?? `sel_${sel}`, slot }));
        const table = el("table");
        for (const { name, slot } of props) {
          // Header slots (-objID-, -size-, dictionaries...) aren't interesting; `name` is shown as text.
          if (slot < NAME_SLOT || name.startsWith("-")) continue;
          const cell = el("td");
          cells.set(slot, cell);
          table.append(el("tr", {}, el("td", { className: "num" }, name), cell));
        }
        const cls = vm.classObject(o.isClass ? o.species : o.superclass);
        element.replaceChildren(
          el("h2", {}, o.name),
          el("p", { className: "meta" },
            o.isClone ? "clone" : o.isClass ? "class" : "instance",
            " of ", cls ? el("a", { href: ex.href(`class/${cls.species}`) }, cls.name) : "?",
            " · ", el("a", { href: ex.href(staticRoute(o)) }, "definition"),
            ` · address ${o.address.toString(16)}`),
          el("p", { className: "meta" }, "Values update live; changes flash."),
          table,
        );
      }
      for (const [slot, cell] of cells) {
        const v = o.vars[slot] ?? 0;
        if (values.get(slot) === v) continue;
        const first = !values.has(slot);
        values.set(slot, v);
        cell.replaceChildren(slot === NAME_SLOT ? o.name : render(vm, v));
        if (!first) {
          cell.classList.remove("flash");
          void cell.offsetWidth; // restart the animation
          cell.classList.add("flash");
        }
      }
    },
  };
}
