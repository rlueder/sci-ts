import { isSeq, parseDocument, type Node } from "yaml";

/**
 * Direct manipulation for the room editor: handles drawn from the room's YAML over the
 * game, which turn drags and brush strokes into edits of the YAML text. Edits replace only
 * the value they change (a `[x, y]`, a `[l, t, r, b]`, a list of points), so comments and
 * layout stay as written.
 */

type Point = [number, number];
type Path = (string | number)[];

// --- Editing YAML text in place ----------------------------------------------------------

const flow = (v: unknown): string => (Array.isArray(v) ? `[${v.map(flow).join(", ")}]` : String(v));

/** `text` with the value at `path` replaced by `value`, keeping the rest as written. */
export function setYamlValue(text: string, path: Path, value: number[] | Point[]): string {
  const doc = parseDocument(text);
  const node = doc.getIn(path, true) as Node | undefined;
  if (node?.range) {
    const start = node.range[0];
    let end = node.range[1];
    while (end > start && text[end - 1] === "\n") end--;
    let replacement: string;
    if (isSeq(node) && !node.flow && Array.isArray(value[0])) {
      // A block list of points stays one "- [x, y]" per line, at its indentation.
      const indent = " ".repeat(start - (text.lastIndexOf("\n", start - 1) + 1));
      replacement = (value as Point[]).map((p) => `- ${flow(p)}`).join(`\n${indent}`);
    } else replacement = flow(value);
    return text.slice(0, start) + replacement + text.slice(end);
  }
  // Not there yet: let the YAML library add it (it may tidy the layout).
  doc.setIn(path, flowNode(doc, value));
  return doc.toString();
}

/** `text` with `value` added at the end of the list at `path` (made if missing). */
export function appendYamlItem(text: string, path: Path, value: Point[]): string {
  const doc = parseDocument(text);
  const node = doc.getIn(path, true) as Node | undefined;
  if (node?.range && isSeq(node) && !node.flow) {
    const start = node.range[0];
    let end = node.range[1];
    while (end > start && text[end - 1] === "\n") end--;
    const indent = " ".repeat(start - (text.lastIndexOf("\n", start - 1) + 1));
    return `${text.slice(0, end)}\n${indent}- ${flow(value)}${text.slice(end)}`;
  }
  if (!node) return `${text.replace(/\n*$/, "\n")}\n${path.join(".")}:\n  - ${flow(value)}\n`;
  doc.addIn(path, flowNode(doc, value));
  return doc.toString();
}

function flowNode(doc: ReturnType<typeof parseDocument>, value: unknown): Node {
  const node = doc.createNode(value) as Node & { flow?: boolean; items?: Node[] };
  if (isSeq(node)) {
    node.flow = true;
    for (const item of node.items) if (isSeq(item)) item.flow = true;
  }
  return node;
}

// --- The room as handles -----------------------------------------------------------------

interface Spec {
  hero?: { at?: Point; enterTo?: Point };
  walkable?: Point[];
  obstacles?: Point[][];
  features?: Record<string, { rect?: number[]; at?: Point; approach?: Point }>;
  exits?: Record<string, { rect?: number[]; at?: Point; approach?: Point }>;
  props?: Record<string, { at?: Point }>;
}

export type EditMode = "play" | "move" | "floor" | "obstacle";

export interface EditHost {
  /** The room's YAML as it is in the editor now. */
  yaml(): string;
  /** Replaces the YAML in the editor (an undoable edit). */
  setYaml(text: string): void;
  /** Where the room plane is on screen (game pixels). */
  roomOffset(): Point;
  /** A prop's drawn box right now (room coordinates), to grab it by. */
  spriteBox(name: string): { x: number; y: number; w: number; h: number } | undefined;
  /** Moves a prop in the running game while it's dragged (the rebuild makes it stick). */
  previewProp(name: string, at: Point): void;
  /** Hold rebuilding while a drag or stroke is in progress. */
  holdBuild(hold: boolean): void;
}

const NS = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text) node.textContent = text;
  return node;
};
const COLORS = { feature: "#e8b04a", exit: "#5fd08c", prop: "#7fb3e8", hero: "#f08fd0", floor: "#5fa0e8", obstacle: "#e05555" };
const clampX = (x: number) => Math.max(0, Math.min(319, Math.round(x)));
const clampY = (y: number) => Math.max(0, Math.min(189, Math.round(y)));

/** A drag in progress: what it changes, given how far the pointer has moved. */
interface Drag {
  start: Point;
  apply(dx: number, dy: number): string;
  /** Shows the change in the game right away, where it can (props). */
  preview?(dx: number, dy: number): void;
}

/**
 * An SVG layer over the game. In "move" mode, everything the YAML places has a handle;
 * "floor" and "obstacle" are brushes that draw a polygon. In "play" it's out of the way.
 */
export class EditLayer {
  readonly svg: SVGSVGElement;
  mode: EditMode = "play";
  private spec: Spec = {};
  private specText = "";
  private drag: Drag | undefined;
  private stroke: Point[] | undefined;
  private lastWrite = 0;

  constructor(private readonly host: EditHost) {
    this.svg = el("svg", { viewBox: "0 0 320 200", preserveAspectRatio: "none" });
    this.svg.style.touchAction = "none";
    this.svg.addEventListener("pointerdown", (e) => this.down(e));
    this.svg.addEventListener("pointermove", (e) => this.move(e));
    this.svg.addEventListener("pointerup", (e) => this.up(e));
    this.svg.addEventListener("pointercancel", (e) => this.up(e));
    this.setMode("play");
  }

  setMode(mode: EditMode): void {
    this.mode = mode;
    this.svg.style.pointerEvents = mode === "play" ? "none" : "auto";
    this.svg.style.cursor = mode === "move" ? "default" : mode === "play" ? "" : "crosshair";
    this.render();
  }

  /** Room coordinates under the pointer. */
  private point(e: PointerEvent): Point {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const [ox, oy] = this.host.roomOffset();
    return [p.x - ox, p.y - oy];
  }

  private readSpec(): Spec {
    const text = this.host.yaml();
    if (text !== this.specText) {
      this.specText = text;
      try {
        this.spec = (parseDocument(text).toJS() as Spec | null) ?? {};
      } catch {
        /* mid-edit: keep the last good one */
      }
    }
    return this.spec;
  }

  // --- Drawing ---

  render(): void {
    this.svg.replaceChildren();
    if (this.mode === "play") return;
    const spec = this.readSpec();
    const [ox, oy] = this.host.roomOffset();
    const g = el("g", { transform: `translate(${ox} ${oy})` });
    this.svg.append(g);
    const handle = (x: number, y: number, color: string, start: () => Drag, shape: "square" | "circle" | "diamond" = "square") => {
      const attrs = { fill: color, stroke: "#000", "stroke-width": 0.4, cursor: "grab" };
      const h = shape === "circle"
        ? el("circle", { cx: x, cy: y, r: 2.4, ...attrs })
        : shape === "diamond"
          ? el("path", { d: `M${x} ${y - 2.8}L${x + 2.8} ${y}L${x} ${y + 2.8}L${x - 2.8} ${y}Z`, ...attrs })
          : el("rect", { x: x - 2, y: y - 2, width: 4, height: 4, ...attrs });
      h.addEventListener("pointerdown", (e) => this.begin(e, start));
      g.append(h);
      return h;
    };
    const label = (x: number, y: number, text: string, color: string) =>
      g.append(el("text", { x, y, fill: color, stroke: "#000", "stroke-width": 1.2, "paint-order": "stroke", "font-size": 5, "font-family": "ui-monospace, Menlo, monospace", "pointer-events": "none" }, text));

    if (this.mode === "move") {
      // Walk areas: every vertex can be dragged; Alt-click removes one.
      const polygon = (points: Point[], path: Path, color: string) => {
        g.append(el("polygon", { points: points.map((p) => p.join(",")).join(" "), fill: `${color}22`, stroke: color, "stroke-width": 0.6, "pointer-events": "none" }));
        points.forEach((p, i) => {
          const h = handle(p[0], p[1], color, () => ({
            start: p,
            apply: (dx, dy) => setYamlValue(this.host.yaml(), path, points.map((q, j) => (j === i ? [clampX(p[0] + dx), clampY(p[1] + dy)] : q)) as Point[]),
          }), "circle");
          h.addEventListener("click", (e) => {
            if (!e.altKey || points.length <= 3) return;
            this.host.setYaml(setYamlValue(this.host.yaml(), path, points.filter((_, j) => j !== i)));
          });
        });
      };
      if (spec.walkable) polygon(spec.walkable, ["walkable"], COLORS.floor);
      spec.obstacles?.forEach((o, i) => polygon(o, ["obstacles", i], COLORS.obstacle));

      // Features and exits: drag the box to move it (and its look-at point), corners to resize.
      for (const group of ["features", "exits"] as const) {
        for (const [name, f] of Object.entries(spec[group] ?? {})) {
          const color = group === "exits" ? COLORS.exit : COLORS.feature;
          const r = f.rect;
          if (r?.length === 4) {
            const [l, t, rt, b] = r as [number, number, number, number];
            const box = el("rect", { x: l, y: t, width: rt - l, height: b - t, fill: `${color}22`, stroke: color, "stroke-width": 0.6, cursor: "move" });
            box.addEventListener("pointerdown", (e) => this.begin(e, () => ({
              start: [l, t],
              apply: (dx, dy) => {
                let text = setYamlValue(this.host.yaml(), [group, name, "rect"], [clampX(l + dx), clampY(t + dy), clampX(rt + dx), clampY(b + dy)]);
                if (f.at) text = setYamlValue(text, [group, name, "at"], [clampX(f.at[0] + dx), clampY(f.at[1] + dy)]);
                return text;
              },
            })));
            g.append(box);
            label(l + 2, t + 6, name, color);
            ([[l, t, 0, 1], [rt, t, 2, 1], [l, b, 0, 3], [rt, b, 2, 3]] as const).forEach(([x, y, xi, yi]) => {
              handle(x, y, color, () => ({
                start: [x, y],
                apply: (dx, dy) => {
                  const next = [l, t, rt, b];
                  next[xi] = clampX(x + dx);
                  next[yi] = clampY(y + dy);
                  const [nl, nt, nr, nb] = next as [number, number, number, number];
                  return setYamlValue(this.host.yaml(), [group, name, "rect"], [Math.min(nl, nr), Math.min(nt, nb), Math.max(nl, nr), Math.max(nt, nb)]);
                },
              }));
            });
          }
          if (f.approach) {
            const [ax, ay] = f.approach;
            label(ax + 3, ay + 2, "approach", color);
            handle(ax, ay, color, () => ({ start: [ax, ay], apply: (dx, dy) => setYamlValue(this.host.yaml(), [group, name, "approach"], [clampX(ax + dx), clampY(ay + dy)]) }), "diamond");
          }
        }
      }

      // Props: grab the sprite (or its anchor) to move its `at`.
      for (const [name, p] of Object.entries(spec.props ?? {})) {
        if (!p.at) continue;
        const [x, y] = p.at;
        const box = this.host.spriteBox(name);
        const start = (): Drag => ({
          start: [x, y],
          apply: (dx, dy) => setYamlValue(this.host.yaml(), ["props", name, "at"], [clampX(x + dx), clampY(y + dy)]),
          preview: (dx, dy) => this.host.previewProp(name, [clampX(x + dx), clampY(y + dy)]),
        });
        if (box) {
          const r = el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, fill: `${COLORS.prop}22`, stroke: COLORS.prop, "stroke-width": 0.6, "stroke-dasharray": "2 1", cursor: "move" });
          r.addEventListener("pointerdown", (e) => this.begin(e, start));
          g.append(r);
        }
        label(x + 3, y + 2, name, COLORS.prop);
        handle(x, y, COLORS.prop, start, "circle");
      }

      // The hero: where it appears, and where it walks to on arrival.
      const hero = spec.hero;
      if (hero?.at && hero.enterTo) {
        g.append(el("line", { x1: hero.at[0], y1: hero.at[1], x2: hero.enterTo[0], y2: hero.enterTo[1], stroke: COLORS.hero, "stroke-width": 0.6, "stroke-dasharray": "2 1.5", "pointer-events": "none" }));
      }
      for (const key of ["at", "enterTo"] as const) {
        const p = hero?.[key];
        if (!p) continue;
        label(p[0] + 3, p[1] + 2, key === "at" ? "hero" : "walks to", COLORS.hero);
        handle(p[0], p[1], COLORS.hero, () => ({ start: p, apply: (dx, dy) => setYamlValue(this.host.yaml(), ["hero", key], [clampX(p[0] + dx), clampY(p[1] + dy)]) }), key === "at" ? "circle" : "diamond");
      }
    } else if (this.stroke) {
      // A brush stroke in progress.
      const color = this.mode === "floor" ? COLORS.floor : COLORS.obstacle;
      g.append(el("polyline", { points: this.stroke.map((p) => p.join(",")).join(" "), fill: `${color}33`, stroke: color, "stroke-width": 1.2, "pointer-events": "none" }));
    }
  }

  // --- Pointer handling ---

  private begin(e: PointerEvent, start: () => Drag): void {
    if (this.mode !== "move" || e.button !== 0 || e.altKey) return;
    e.stopPropagation();
    e.preventDefault();
    this.drag = start();
    (this.drag as Drag & { from?: Point }).from = this.point(e);
    this.capture(e, true);
    this.host.holdBuild(true);
  }

  /** Keep getting the pointer's moves outside the layer (not for synthetic events). */
  private capture(e: PointerEvent, on: boolean): void {
    try {
      if (on) this.svg.setPointerCapture(e.pointerId);
      else if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    } catch {
      /* no such pointer */
    }
  }

  private down(e: PointerEvent): void {
    if (this.mode !== "floor" && this.mode !== "obstacle") return;
    e.preventDefault();
    this.capture(e, true);
    this.stroke = [this.point(e).map(Math.round) as Point];
    this.host.holdBuild(true);
    this.render();
  }

  private move(e: PointerEvent): void {
    const p = this.point(e);
    if (this.drag) {
      const from = (this.drag as Drag & { from: Point }).from;
      const [dx, dy] = [Math.round(p[0] - from[0]), Math.round(p[1] - from[1])];
      this.drag.preview?.(dx, dy);
      const text = this.drag.apply(dx, dy);
      // Show it as it moves: the YAML (and these handles) follow the pointer.
      if (text !== this.host.yaml()) this.host.setYaml(text);
      this.render();
    } else if (this.stroke) {
      const last = this.stroke.at(-1)!;
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 4) return;
      this.stroke.push([clampX(p[0]), clampY(p[1])]);
      this.render();
      // The list in the editor follows the brush, a few times a second.
      if (performance.now() - this.lastWrite > 120) this.writeStroke(false);
    }
  }

  private up(e: PointerEvent): void {
    this.capture(e, false);
    if (this.drag) {
      this.drag = undefined;
      this.host.holdBuild(false);
      this.render();
    } else if (this.stroke) {
      this.writeStroke(true);
      this.stroke = undefined;
      this.host.holdBuild(false);
      this.render();
    }
  }

  /** The stroke so far as a polygon in the YAML (simplified to its corners). */
  private writeStroke(final: boolean): void {
    this.lastWrite = performance.now();
    const points = simplify(this.stroke!, final ? 2.5 : 2);
    if (points.length < 3) return;
    const yaml = this.host.yaml();
    if (this.mode === "floor") this.host.setYaml(setYamlValue(yaml, ["walkable"], points));
    else if (final) this.host.setYaml(appendYamlItem(yaml, ["obstacles"], points));
  }
}

/** Ramer-Douglas-Peucker: drop points within `epsilon` of the line through their neighbours. */
export function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  const [a, b] = [points[0]!, points.at(-1)!];
  let index = 0, max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
    if (d > max) (max = d), (index = i);
  }
  if (max <= epsilon) return [a, b];
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)];
}
