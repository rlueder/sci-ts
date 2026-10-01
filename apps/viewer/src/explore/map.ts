import cytoscape from "cytoscape";
import type { ExitKind } from "@sci-ts/sci";
import { el, thumbnail, type Explorer } from "./context.ts";

/** Rooms linked to this many others are hubs (combat): their links are hidden by default. */
const HUB_DEGREE = 20;

export interface RoomMap {
  element: HTMLElement;
  select(room: number | undefined): void;
}

/**
 * The room graph: one node per room (thumbnail of its pic), grouped by hundreds, which is
 * how Sierra numbered areas. One edge per connected pair; arrows show direction, and a
 * dashed edge means the only evidence is the target checking where the hero came from.
 */
export function createRoomMap(ex: Explorer, onSelect: (room: number) => void): RoomMap {
  const { rooms, exits } = ex.index;
  const container = el("div", { id: "map" });

  type Pair = { a: number; b: number; ab: Set<ExitKind>; ba: Set<ExitKind> };
  const pairs = new Map<string, Pair>();
  for (const e of exits) {
    const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
    const key = `${a}-${b}`;
    const p = pairs.get(key) ?? { a, b, ab: new Set(), ba: new Set() };
    (e.from === a ? p.ab : p.ba).add(e.kind);
    pairs.set(key, p);
  }
  const degree = new Map<number, number>();
  for (const p of pairs.values()) for (const r of [p.a, p.b]) degree.set(r, (degree.get(r) ?? 0) + 1);
  const hubs = new Set([...degree].filter(([, d]) => d >= HUB_DEGREE).map(([r]) => r));

  const areas = new Set(rooms.map((r) => Math.floor(r.number / 100)));
  const elements: cytoscape.ElementDefinition[] = [
    // Area boxes are plain nodes drawn behind the rooms; they get sized after layout.
    ...[...areas].map((a) => ({ data: { id: `area${a}`, label: `${a}00s`, w: 1, h: 1 }, classes: "area", selectable: false, grabbable: false })),
    ...rooms.map((r) => ({
      data: { id: `r${r.number}`, label: `${r.number} ${r.name.replace(/^rm\d+$/, "")}`.trim(), area: Math.floor(r.number / 100), room: r.number },
      classes: hubs.has(r.number) ? "hub" : "",
    })),
    ...[...pairs.values()].map((p) => {
      const kinds = new Set([...p.ab, ...p.ba]);
      const entryOnly = [...kinds].every((k) => k === "entry");
      const direction = kinds.has("direction") && ![...kinds].some((k) => k !== "direction" && k !== "entry");
      // Edge runs a → b; arrows at whichever ends are entered.
      const classes = [entryOnly ? "entry" : direction ? "direction" : "code", p.ab.size ? "to-b" : "", p.ba.size ? "to-a" : ""];
      if (hubs.has(p.a) || hubs.has(p.b)) classes.push("hub-link");
      return { data: { id: `e${p.a}-${p.b}`, source: `r${p.a}`, target: `r${p.b}`, kinds: [...kinds].join(", ") }, classes: classes.join(" ") };
    }),
  ];

  const cy = cytoscape({
    container,
    elements,
    minZoom: 0.15,
    maxZoom: 3,
    style: [
      { selector: "node", style: {
        "z-index-compare": "manual", "z-index": 2,
        shape: "round-rectangle", width: 64, height: 46, "background-color": "#262626",
        "border-width": 1, "border-color": "#3a3a3a",
        label: "data(label)", color: "#ccc", "font-size": 10, "font-family": "ui-monospace, Menlo, monospace",
        "text-valign": "bottom", "text-margin-y": 3, "text-background-color": "#111", "text-background-opacity": 0.7, "text-background-padding": "1px",
      } },
      { selector: "node[thumb]", style: { "background-image": "data(thumb)", "background-fit": "cover" } },
      { selector: ".area", style: {
        shape: "round-rectangle", width: "data(w)", height: "data(h)", "z-index": 0, events: "no",
        "background-color": "#181818", "border-color": "#2e2e2e", "border-width": 1,
        label: "data(label)", "text-valign": "top", "text-halign": "center", "text-margin-y": -4, color: "#777", "font-size": 16,
        "text-background-opacity": 0,
      } },
      { selector: "node.hub", style: { "border-color": "#a05050", "border-width": 2 } },
      { selector: "node:selected", style: { "border-color": "#e8b04a", "border-width": 3 } },
      { selector: "edge", style: {
        "z-index-compare": "manual", "z-index": 1,
        width: 1.6, "curve-style": "bezier", "line-color": "#7fb3e8", opacity: 0.8,
        "target-arrow-color": "#7fb3e8", "source-arrow-color": "#7fb3e8", "arrow-scale": 0.8,
      } },
      { selector: "edge.to-b", style: { "target-arrow-shape": "triangle" } },
      { selector: "edge.to-a", style: { "source-arrow-shape": "triangle" } },
      { selector: "edge.direction", style: { "line-color": "#6fb07a", "target-arrow-color": "#6fb07a", "source-arrow-color": "#6fb07a" } },
      { selector: "edge.entry", style: { "line-style": "dashed", "line-color": "#666", "target-arrow-color": "#666", "source-arrow-color": "#666" } },
      { selector: "edge.hub-link", style: { display: "none" } },
      { selector: ".faded", style: { opacity: 0.18 } },
      { selector: "edge.lit", style: { width: 3, opacity: 1, "z-index": 10 } },
    ],
    layout: { name: "preset" },
  });

  // Lay out once the map is in the page: cytoscape measures its container.
  let laidOut = false;
  const layout = () => {
    if (laidOut || !container.isConnected) return;
    laidOut = true;
    cy.resize();
    layoutAreas(cy);
    cy.fit(undefined, 20);
    if (pending !== undefined) select(pending);
  };
  let pending: number | undefined;
  // Cytoscape caches its container's size; keep it current as the window changes.
  new ResizeObserver(() => cy.resize()).observe(container);

  cy.on("tap", "node", (evt) => {
    const room = evt.target.data("room");
    if (room !== undefined) onSelect(room);
  });

  // Thumbnails load in the background, a few at a time.
  void (async () => {
    for (const r of rooms) {
      if (r.picture < 0) continue;
      const canvas = await ex.pic(r.picture).catch(() => undefined);
      if (canvas) cy.getElementById(`r${r.number}`).data("thumb", thumbnail(canvas));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  })();

  const swatch = (css: string) => {
    const i = el("i");
    i.style.cssText = css;
    return i;
  };
  const hubToggle = el("input", { type: "checkbox" });
  hubToggle.addEventListener("change", () => cy.edges(".hub-link").style("display", hubToggle.checked ? "element" : "none"));
  const legend = el("div", { className: "legend" },
    el("span", {}, swatch("border-color: #7fb3e8"), "script exit"),
    el("span", {}, swatch("border-color: #6fb07a"), "north/south/east/west"),
    el("span", {}, swatch("border-color: #666; border-top-style: dashed"), "entry check only"),
    el("label", {}, hubToggle, ` combat links (${[...hubs].join(", ")})`),
  );
  const element = el("div", {}, container, legend);
  element.style.cssText = "position: absolute; inset: 0;";

  function select(room: number | undefined) {
    pending = room;
    if (!laidOut) return;
    cy.elements().removeClass("faded lit").unselect();
    if (room === undefined) return;
    const node = cy.getElementById(`r${room}`);
    if (node.empty()) return;
    node.select();
    const hood = node.closedNeighborhood();
    cy.elements().not(hood).not(".area").addClass("faded");
    node.connectedEdges().addClass("lit");
    if (!node.visible()) return;
    const bb = cy.extent();
    const p = node.position();
    if (p.x < bb.x1 || p.x > bb.x2 || p.y < bb.y1 || p.y > bb.y2) cy.animate({ center: { eles: node } }, { duration: 300 });
  }

  return {
    element,
    select(room) {
      select(room);
      layout();
    },
  };
}

/**
 * Each area (a hundreds series of room numbers) gets its own force layout, over its rooms
 * and the links inside it, in a box sized for its room count; boxes are packed into rows.
 * One global force layout of compound nodes blows apart, and cross-area links (and combat)
 * would pull everything into a knot anyway.
 */
function layoutAreas(cy: cytoscape.Core) {
  const GAP = 110;
  const MAX_ROW = 2800;
  let x = 0, y = 0, rowHeight = 0;
  for (const area of cy.nodes(".area").sort((a, b) => Number(a.id().slice(4)) - Number(b.id().slice(4)))) {
    const rooms = cy.nodes(`[area = ${area.id().slice(4)}]`);
    const inner = rooms.connectedEdges().filter((e) => rooms.contains(e.source()) && rooms.contains(e.target()) && !e.hasClass("hub-link"));
    rooms.union(inner).layout({
      name: "cose", animate: false, randomize: true, fit: false, nodeDimensionsIncludeLabels: true,
      idealEdgeLength: () => 60, nodeRepulsion: () => 6000, gravity: 1.2, numIter: 1500, componentSpacing: 40,
    } as cytoscape.LayoutOptions).run();
    // Move the area, at its natural size, to the next slot in the current row.
    const bb = rooms.boundingBox({ includeLabels: true });
    if (x > 0 && x + bb.w > MAX_ROW) {
      x = 0;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    const dx = x - bb.x1, dy = y - bb.y1;
    rooms.positions((n) => ({ x: n.position().x + dx, y: n.position().y + dy }));
    area.data({ w: bb.w + 30, h: bb.h + 30 }).position({ x: x + bb.w / 2, y: y + bb.h / 2 });
    x += bb.w + GAP;
    rowHeight = Math.max(rowHeight, bb.h);
  }
}
