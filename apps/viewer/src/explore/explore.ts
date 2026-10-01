import { ResourceType, ScriptWorld, analyzeGame, emptyPalette, parseHunkPalette } from "@sci-ts/sci";
import { openGame } from "../files.ts";
import { createClassTree, type ClassTree } from "./classes.ts";
import { createExplorer, el } from "./context.ts";
import { renderClass, renderObject, renderRoom, renderScript } from "./inspect.ts";
import { createLiveView, type LiveView } from "./live.ts";
import { createRoomMap, type RoomMap } from "./map.ts";

/**
 * The game structure explorer: a static map of rooms, classes and objects built by
 * `analyzeGame` from the scripts, with inspectors for each.
 *
 * Routes: #/<tab>/<kind>/<id...> where tab is map|classes|live and kind is room, script,
 * class, object (static) or live (a running object by address). The tab and the inspected
 * thing are independent.
 */
const stage = document.getElementById("stage")!;
const inspector = document.getElementById("inspector")!;
const status = document.getElementById("status")!;
const search = document.getElementById("search") as HTMLInputElement;

const loading = el("div", { id: "loading" }, "Loading resources…");
stage.append(loading);

// The explorer shows the game with the same mods as the player (?mods=, or the last choice).
const { rm, mods } = await openGame();
const world = await ScriptWorld.open(rm);
const started = performance.now();
const index = await analyzeGame(rm, { world, onProgress: (done, total) => (loading.textContent = `Analyzing scripts… ${done}/${total}`) });
const basePalette = parseHunkPalette((await rm.load({ type: ResourceType.Palette, number: 999 })).data) ?? emptyPalette();
loading.remove();

let tab = "map";
const ex = createExplorer(rm, mods, world, index, basePalette, () => tab);
const pairs = new Set(index.exits.map((e) => [e.from, e.to].sort((a, b) => a - b).join("-")));
const objectCount = index.scripts.reduce((n, s) => n + s.objects.length, 0);
status.textContent = `${mods.length ? `mods: ${mods.join(", ")} · ` : ""}${index.rooms.length} rooms · ${pairs.size} connections · ${index.classes.length} classes · ${objectCount} objects · analyzed in ${Math.round(performance.now() - started)} ms`;

let map: RoomMap | undefined;
let tree: ClassTree | undefined;
let live: LiveView | undefined;
let shown: { tab?: string; key?: string } = {};

async function route() {
  const [t = "map", kind, a, b] = location.hash.replace(/^#\/?/, "").split("/");
  tab = t === "classes" || t === "live" ? t : "map";
  for (const link of document.querySelectorAll<HTMLAnchorElement>("nav a[data-tab]")) {
    link.classList.toggle("active", link.dataset.tab === tab);
    link.href = `#/${link.dataset.tab}${kind ? `/${kind}/${[a, b].filter(Boolean).join("/")}` : ""}`;
  }

  if (shown.tab !== tab) {
    if (shown.tab === "live") live?.deactivate();
    shown.tab = tab;
    shown.key = undefined; // the live tab's default panel differs
    if (tab === "map") stage.replaceChildren((map ??= createRoomMap(ex, (room) => (location.hash = ex.href(`room/${room}`)))).element);
    else if (tab === "classes") stage.replaceChildren((tree ??= createClassTree(ex)).element);
    else {
      live ??= createLiveView(ex, (address) => (location.hash = ex.href(`live/${address.toString(16)}`)));
      stage.replaceChildren(live.element);
      await live.activate();
    }
  }

  const key = `${kind}/${a}/${b}`;
  map?.select(kind === "room" ? Number(a) : undefined);
  tree?.select(kind === "class" ? Number(a) : undefined);
  if (shown.key === key) return;
  shown.key = key;
  const view =
    kind === "room" ? await renderRoom(ex, Number(a))
    : kind === "script" ? await renderScript(ex, Number(a))
    : kind === "class" ? renderClass(ex, Number(a))
    : kind === "object" ? await renderObject(ex, Number(a), Number(b))
    : kind === "live" && live ? live.objectPanel(parseInt(a ?? "0", 16)).element
    : tab === "live" && live ? live.roomPanel().element
    : el("p", { className: "meta" }, "Select a room or class.");
  if (shown.key !== key) return; // a newer route won the race
  inspector.replaceChildren(view);
  inspector.scrollTop = 0;
}

// Search: every room, class and object by name, through a datalist.
const targets = new Map<string, string>();
for (const r of index.rooms) targets.set(`room ${r.number} ${r.name}`, `room/${r.number}`);
for (const c of index.classes) targets.set(`class ${c.name}`, `class/${c.species}`);
for (const s of index.scripts) for (const o of s.objects) targets.set(`${o.name} (${o.className}, script ${s.number})`, `object/${s.number}/${o.offset}`);
document.getElementById("search-options")!.append(...[...targets.keys()].map((value) => el("option", { value })));
search.addEventListener("input", () => {
  const target = targets.get(search.value);
  if (!target) return;
  location.hash = ex.href(target);
  search.value = "";
  search.blur();
});

/** A failed route shows its error in the inspector instead of failing silently. */
const navigate = () =>
  route().catch((e: Error) => {
    console.error(e);
    inspector.replaceChildren(el("pre", { className: "error" }, e.stack ?? e.message));
  });
addEventListener("hashchange", () => void navigate());
await navigate();
