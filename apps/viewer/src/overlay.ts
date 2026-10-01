import {
  collectionElements, drawnItems, gameGlobal, isKindOf, namedObject, objectAt, polygonOf, readInts, roomPlane, signedProp,
  type Vm,
} from "@sci-ts/sci";

/**
 * What the interpreter knows about the room, drawn over the game screen as SVG in game
 * coordinates (320x200): clickable features, sprites, walk polygons and where actors are
 * going. Used by the explorer's live view and the room editor.
 */
export interface OverlayOptions {
  /** Drawn sprites (cast members) with their names. */
  sprites?: boolean;
  /** The room's features (clickable areas) with their names, and approach points. */
  features?: boolean;
  /** Walk polygons: green total access, yellow near point, red barred, blue contained. */
  polygons?: boolean;
  /** Where moving actors are headed (PolyPath routes). */
  paths?: boolean;
  /** An object to outline in white. */
  selected?: number;
  /** Tells exits from other features (the editor knows from the room's YAML). */
  isExit?: (name: string) => boolean;
}

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text) node.textContent = text;
  return node;
};

export const OVERLAY_COLORS = {
  polygons: ["#6fb07a", "#d8c050", "#e05555", "#5fa0e8"],
  feature: "#e8b04a",
  exit: "#5fd08c",
  sprite: "#7fb3e8",
  hero: "#f08fd0",
  selected: "#ffffff",
};

/** An SVG to lay over the game canvas (position it over the canvas, same size). */
export function createOverlay(): SVGSVGElement {
  const root = svg("svg", { viewBox: "0 0 320 200", preserveAspectRatio: "none" });
  root.style.pointerEvents = "none";
  return root;
}

const label = (x: number, y: number, text: string, color: string) =>
  svg("text", {
    x, y, fill: color, stroke: "#000", "stroke-width": 1.2, "paint-order": "stroke", "font-size": 5, "font-family": "ui-monospace, Menlo, monospace",
  }, text);

export function drawRoomOverlay(root: SVGSVGElement, vm: Vm, o: OverlayOptions): void {
  root.replaceChildren();
  const plane = roomPlane(vm);
  const room = objectAt(vm, gameGlobal(vm, "curRoom"));
  // Room objects use the room plane's coordinates (below the status bar).
  const local = svg("g", { transform: plane ? `translate(${plane.left} ${plane.top})` : "" });
  root.append(local);
  const colorOf = (address: number, normal: string) => (address === o.selected ? OVERLAY_COLORS.selected : normal);

  if (o.polygons && room) {
    for (const poly of collectionElements(vm, vm.getProp(room, "obstacles"))) {
      const { type, points } = polygonOf(vm, poly);
      if (points.length < 3) continue;
      const color = OVERLAY_COLORS.polygons[type] ?? "#aaa";
      local.append(svg("polygon", { points: points.map((p) => p.join(",")).join(" "), fill: `${color}22`, stroke: color, "stroke-width": 0.6 }));
    }
  }
  if (o.features) {
    for (const f of collectionElements(vm, namedObject(vm, "features"))) {
      const color = colorOf(f.address, o.isExit?.(f.name) ? OVERLAY_COLORS.exit : OVERLAY_COLORS.feature);
      const style = { fill: `${color}18`, stroke: color, "stroke-width": f.address === o.selected ? 1.2 : 0.5 };
      const check = objectAt(vm, vm.getProp(f, "onMeCheck"));
      let at: [number, number] | undefined;
      if (check && isKindOf(vm, check, "Polygon")) {
        const { points } = polygonOf(vm, check);
        if (points.length < 3) continue;
        local.append(svg("polygon", { points: points.map((p) => p.join(",")).join(" "), ...style }));
        at = [points[0]![0] + 2, points[0]![1] + 6];
      } else {
        const [l, t, r, b] = ["nsLeft", "nsTop", "nsRight", "nsBottom"].map((n) => signedProp(vm, f, n)) as [number, number, number, number];
        if (r <= l || b <= t) continue;
        local.append(svg("rect", { x: l, y: t, width: r - l, height: b - t, ...style }));
        at = [l + 2, t + 6];
      }
      local.append(label(at[0], at[1], f.name, color));
      // Where the hero walks to before using it.
      const ax = signedProp(vm, f, "approachX"), ay = signedProp(vm, f, "approachY");
      if (ax || ay) {
        local.append(svg("path", { d: `M${ax - 2} ${ay - 2}L${ax + 2} ${ay + 2}M${ax - 2} ${ay + 2}L${ax + 2} ${ay - 2}`, stroke: color, "stroke-width": 0.6 }));
      }
    }
  }
  if (o.paths) {
    for (const actor of collectionElements(vm, namedObject(vm, "cast"))) {
      const mover = objectAt(vm, vm.getProp(actor, "mover"));
      if (!mover) continue;
      const pts = [[signedProp(vm, actor, "x"), signedProp(vm, actor, "y")]];
      // PolyPath keeps the whole route: an array ending in 0x7777, `value` = next index.
      const route = vm.getProp(mover, "points");
      if (route) {
        const flat = readInts(vm, route, 200);
        for (let i = signedProp(vm, mover, "value"); i + 1 < flat.length && flat[i] !== 0x7777; i += 2) pts.push([flat[i]!, flat[i + 1]!]);
      }
      const target = [signedProp(vm, mover, "x"), signedProp(vm, mover, "y")];
      if (pts.length === 1) pts.push(target);
      local.append(svg("polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: "#fff", "stroke-width": 0.6, "stroke-dasharray": "2 1.5" }));
      local.append(svg("circle", { cx: target[0]!, cy: target[1]!, r: 1.8, fill: "#fff" }));
    }
  }
  if (o.sprites) {
    const ego = gameGlobal(vm, "ego");
    for (const d of drawnItems(vm)) {
      if (plane && d.plane !== plane.address) continue;
      const color = colorOf(d.item.address, d.item.address === ego ? OVERLAY_COLORS.hero : OVERLAY_COLORS.sprite);
      root.append(svg("rect", { x: d.x, y: d.y, width: d.w, height: d.h, fill: "none", stroke: color, "stroke-width": d.item.address === o.selected ? 1.2 : 0.5 }));
      root.append(label(d.x, d.y - 1, d.item.name, color));
    }
  }
}
