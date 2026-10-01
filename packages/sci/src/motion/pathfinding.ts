/**
 * Pathfinding over SCI polygons.
 *
 * Rooms describe walkable space with polygons of four access types:
 *   Total     (0): can't enter; if you start inside you may walk out.
 *   Nearest   (1): can't enter; clicking inside walks to its nearest edge.
 *   Barred    (2): can't enter at all.
 *   Contained (3): the walkable area itself: you can't leave it.
 *
 * `findPath` snaps unreachable start/end points to the nearest reachable point, builds a
 * visibility graph over the polygon vertices (two points are connected if the straight
 * segment between them stays walkable) and runs Dijkstra. Boundaries count as walkable,
 * so paths can hug walls and corners, like the original.
 */
export const PolygonType = { Total: 0, Nearest: 1, Barred: 2, Contained: 3 } as const;

export interface Point {
  x: number;
  y: number;
}

export interface Polygon {
  type: number;
  points: Point[];
}

const EPS = 1e-9;

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function onSegment(p: Point, a: Point, b: Point): boolean {
  if (Math.abs(cross(a, b, p)) > EPS) return false;
  return p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
}

function edges(poly: Polygon): [Point, Point][] {
  return poly.points.map((p, i) => [p, poly.points[(i + 1) % poly.points.length]!]);
}

export type Containment = "inside" | "outside" | "edge";

export function contains(poly: Polygon, p: Point): Containment {
  let inside = false;
  for (const [a, b] of edges(poly)) {
    if (onSegment(p, a, b)) return "edge";
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside ? "inside" : "outside";
}

/** Walkable = inside (or on) every contained polygon and not strictly inside any obstacle. */
export function walkable(polys: Polygon[], p: Point): boolean {
  for (const poly of polys) {
    const c = contains(poly, p);
    if (poly.type === PolygonType.Contained ? c === "outside" : c === "inside") return false;
  }
  return true;
}

/** True if segments ab and cd cross at a point interior to both. */
function properlyIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** A segment is clear if it crosses no polygon edge and its interior stays walkable. */
function clear(polys: Polygon[], a: Point, b: Point): boolean {
  for (const poly of polys) for (const [c, d] of edges(poly)) if (properlyIntersect(a, b, c, d)) return false;
  // Crossing no edges can still mean running through a polygon's interior (e.g. a diagonal
  // between two of its vertices), so sample along the segment.
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!walkable(polys, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
  }
  return true;
}

function nearestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Nearest walkable point to `p`, found on polygon edges (rounded to whole pixels). */
export function nearestWalkable(polys: Polygon[], p: Point): Point {
  if (walkable(polys, p)) return p;
  let best: Point | undefined;
  let bestDist = Infinity;
  for (const poly of polys) {
    for (const [a, b] of edges(poly)) {
      const q = nearestOnSegment(p, a, b);
      // Try the point and its integer neighbours; SCI coordinates are whole pixels.
      for (const cand of [{ x: Math.round(q.x), y: Math.round(q.y) }, { x: Math.floor(q.x), y: Math.floor(q.y) }, { x: Math.ceil(q.x), y: Math.ceil(q.y) }, q]) {
        const d = Math.hypot(cand.x - p.x, cand.y - p.y);
        if (d < bestDist && walkable(polys, cand)) {
          best = cand;
          bestDist = d;
        }
      }
    }
  }
  return best ?? p;
}

/**
 * Shortest walkable path from `start` to `end`, including both endpoints. If the end is
 * unreachable it's moved to the nearest reachable point; if the start is inside an
 * obstacle (e.g. pushed into one), the path first steps out of it.
 */
export function findPath(start: Point, end: Point, polys: Polygon[]): Point[] {
  // Obstacles that contain the start are ignored, so an actor stuck in one can walk out.
  const active = polys.filter((p) => p.type === PolygonType.Contained || contains(p, start) !== "inside");
  const from = nearestWalkable(active, start);
  const to = nearestWalkable(active, end);
  const prefix = from.x !== start.x || from.y !== start.y ? [start] : [];

  if (clear(active, from, to)) return [...prefix, from, to];

  const nodes: Point[] = [from, to];
  for (const poly of active) for (const p of poly.points) if (walkable(active, p)) nodes.push(p);

  // Dijkstra over the visibility graph (edges evaluated lazily; rooms have few vertices).
  const dist = new Array<number>(nodes.length).fill(Infinity);
  const prev = new Array<number>(nodes.length).fill(-1);
  const done = new Array<boolean>(nodes.length).fill(false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i]! < Infinity && (u === -1 || dist[i]! < dist[u]!)) u = i;
    if (u === -1 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v]) continue;
      const w = Math.hypot(nodes[v]!.x - nodes[u]!.x, nodes[v]!.y - nodes[u]!.y);
      if (dist[u]! + w < dist[v]! && clear(active, nodes[u]!, nodes[v]!)) {
        dist[v] = dist[u]! + w;
        prev[v] = u;
      }
    }
  }
  if (prev[1] === -1) return [...prefix, from]; // unreachable: stay put
  const path: Point[] = [];
  for (let i = 1; i !== -1; i = prev[i]!) path.unshift(nodes[i]!);
  return [...prefix, ...path];
}
