import { findPath, contains, type Polygon } from "../../motion/pathfinding.ts";
import type { KernelFn, SendRequest, Vm } from "../vm.ts";
import { bool, fromInt, offsetOf, toSigned, type Value } from "../value.ts";
import { stringHelpers } from "./arrays.ts";
import { graphics } from "./graphics.ts";

const SIGNAL_HIT_OBSTACLE = 0x0400;
const SIGNAL_FIXED_LOOP = 0x0800;
const POLY_END = 0x7777;

const get = (vm: Vm, obj: Value, name: string) => toSigned(vm.getProp(obj, name) ?? 0);

/** Signals that exclude an actor from actor-vs-actor collisions (don't-restore, hidden, ignore-actors). */
const COLLISION_EXEMPT = 0x0004 | 0x0008 | 0x4000;

/** Reads `count` int16 values from an array, an IntArray-style object, or static heap data. */
function readInts(vm: Vm, ref: Value, count: number): number[] {
  const array = stringHelpers.resolve(vm, ref);
  if (array) return array.data.slice(0, count).map(toSigned);
  const seg = vm.memory.segment(ref);
  if (seg?.kind === "script") {
    const heap = seg.script.script.heap;
    const v = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
    return Array.from({ length: count }, (_, i) => v.getInt16(offsetOf(ref) + i * 2, true));
  }
  return Array.from({ length: count }, (_, i) => toSigned(vm.memory.read(ref + i * 2)));
}

function readPolygon(vm: Vm, obj: Value): Polygon | undefined {
  if (!vm.memory.object(obj)) return undefined;
  const size = get(vm, obj, "size");
  const ints = readInts(vm, vm.getProp(obj, "points") ?? 0, size * 2);
  const points = Array.from({ length: size }, (_, i) => ({ x: ints[i * 2] ?? 0, y: ints[i * 2 + 1] ?? 0 }));
  return size >= 3 ? { type: get(vm, obj, "type"), points } : undefined;
}

function readPolygons(vm: Vm, list: Value): Polygon[] {
  const out: Polygon[] = [];
  for (let n = vm.memory.list(list)?.first; n; n = n.next) {
    const poly = readPolygon(vm, n.value);
    if (poly) out.push(poly);
  }
  return out;
}
const set = (vm: Vm, obj: Value, name: string, v: number) => vm.setProp(obj, name, fromInt(v));

/**
 * Actor movement. A Motion object ("mover") walks its client toward (x, y) using an
 * integer Bresenham line, one step of (xStep, yStep) per update: the original
 * interpreter's algorithm, as ScummVM's documentation describes it, written afresh here.
 */
export const motionKernels: Record<string, KernelFn> = {
  InitBresen: (vm, [mover = 0, stepFactor = 1]) => {
    const client = vm.getProp(mover, "client")!;
    let xStep = get(vm, client, "xStep") * stepFactor;
    const yStep = get(vm, client, "yStep") * stepFactor;
    let step = xStep < yStep ? yStep * 2 : xStep * 2;
    const deltaX = get(vm, mover, "x") - get(vm, client, "x");
    const deltaY = get(vm, mover, "y") - get(vm, client, "y");
    let dx = 0, dy = 0, i1 = 0, i2 = 0, di = 0, incr = 0, xAxis = 0;

    for (;;) {
      dx = xStep;
      dy = yStep;
      incr = 1;
      if (Math.abs(deltaX) >= Math.abs(deltaY)) {
        xAxis = 1;
        if (deltaX < 0) dx = -dx;
        dy = deltaX ? Math.trunc((dx * deltaY) / deltaX) : 0;
        i1 = (dx * deltaY - dy * deltaX) * 2;
        if (deltaY < 0) (incr = -1), (i1 = -i1);
        i2 = i1 - deltaX * 2;
        di = i1 - deltaX;
        if (deltaX < 0) (i1 = -i1), (i2 = -i2), (di = -di);
      } else {
        xAxis = 0;
        if (deltaY < 0) dy = -dy;
        dx = deltaY ? Math.trunc((dy * deltaX) / deltaY) : 0;
        i1 = (dy * deltaX - dx * deltaY) * 2;
        if (deltaX < 0) (incr = -1), (i1 = -i1);
        i2 = i1 - deltaY * 2;
        di = i1 - deltaY;
        if (deltaY < 0) (i1 = -i1), (i2 = -i2), (di = -di);
        break;
      }
      // Along x, shrink xStep until the y step fits.
      if (xStep <= yStep || !xStep || yStep >= Math.abs(dy + incr)) break;
      if (!--step) break;
      xStep--;
    }
    set(vm, mover, "dx", dx);
    set(vm, mover, "dy", dy);
    set(vm, mover, "b-i1", i1);
    set(vm, mover, "b-i2", i2);
    set(vm, mover, "b-di", di);
    set(vm, mover, "b-incr", incr);
    set(vm, mover, "b-xAxis", xAxis);
  },

  /**
   * One Bresenham step of the mover's client. SCI2 differs from SCI0–1.1 in two ways the
   * scripts depend on: `Motion::doit` already throttles by comparing `b-moveCnt` (a game-time
   * stamp) to `moveSpeed`, so the kernel must not touch it; and `doit` ignores our return
   * value, so on arrival the kernel itself sends `moveDone` to the mover.
   */
  *DoBresen(vm: Vm, [mover = 0]: Value[]): Generator<SendRequest, Value, Value> {
    const client = vm.getProp(mover, "client")!;
    set(vm, client, "signal", get(vm, client, "signal") & ~SIGNAL_HIT_OBSTACLE);

    const toX = get(vm, mover, "x"), toY = get(vm, mover, "y");
    const xAxis = get(vm, mover, "b-xAxis"), dx = get(vm, mover, "dx"), dy = get(vm, mover, "dy");
    const incr = get(vm, mover, "b-incr"), i1 = get(vm, mover, "b-i1"), i2 = get(vm, mover, "b-i2");
    let di = get(vm, mover, "b-di");
    const origX = get(vm, client, "x"), origY = get(vm, client, "y"), origDi = di;
    let x = origX, y = origY;

    if ((xAxis && Math.abs(toX - x) < Math.abs(dx)) || (!xAxis && Math.abs(toY - y) < Math.abs(dy))) {
      x = toX;
      y = toY;
    } else {
      x += dx;
      y += dy;
      if (di < 0) di += i1;
      else {
        di += i2;
        if (xAxis) y += incr;
        else x += incr;
      }
    }
    set(vm, client, "x", x);
    set(vm, client, "y", y);

    const cantBeHere = yield { object: client, selector: vm.selector("cantBeHere"), args: [] };
    if (cantBeHere) {
      set(vm, client, "x", origX);
      set(vm, client, "y", origY);
      di = origDi;
      set(vm, client, "signal", get(vm, client, "signal") | SIGNAL_HIT_OBSTACLE);
    }
    set(vm, mover, "b-di", di);

    const completed = get(vm, client, "x") === toX && get(vm, client, "y") === toY;
    if (completed) yield { object: mover, selector: vm.selector("moveDone"), args: [] };
    return completed ? 1 : 0;
  },

  DirLoop: (vm, [obj = 0, angle = 0]) => {
    if (get(vm, obj, "signal") & SIGNAL_FIXED_LOOP) return;
    const loops = graphics(vm).view(get(vm, obj, "view"))?.loops.length ?? 0;
    let loop: number;
    if (loops >= 4) {
      if (angle > 315 || angle < 45) loop = 3; // north
      else if (angle < 136) loop = 0; // east
      else if (angle < 226) loop = 2; // south
      else loop = 1; // west
    } else loop = angle > 180 ? 1 : 0;
    set(vm, obj, "loop", loop);
  },

  /**
   * Actor-vs-actor collision: can `obj` stand where it is, given the other actors' base
   * rects in `list`? (Walls are handled by pathfinding, not here.) Returns 1 if blocked.
   */
  CantBeHere: (vm, [obj = 0, list = 0]) => {
    if (get(vm, obj, "signal") & COLLISION_EXEMPT) return 0;
    const r = (o: Value) => ({ l: get(vm, o, "brLeft"), t: get(vm, o, "brTop"), r: get(vm, o, "brRight"), b: get(vm, o, "brBottom") });
    const me = r(obj);
    for (let n = vm.memory.list(list)?.first; n; n = n.next) {
      const other = n.value;
      if (other === obj || !vm.memory.object(other) || get(vm, other, "signal") & COLLISION_EXEMPT) continue;
      const o = r(other);
      // Strict overlap: touching isn't a collision (as in the original).
      if (o.r > me.l && o.l < me.r && o.b > me.t && o.t < me.b) return 1;
    }
    return 0;
  },

  /** AvoidPath(x1, y1, x2, y2, polygonList, opt) → int16 array of points ending in 0x7777. */
  AvoidPath: (vm, [x1 = 0, y1 = 0, x2 = 0, y2 = 0, list = 0]) => {
    const start = { x: toSigned(x1), y: toSigned(y1) };
    const end = { x: toSigned(x2), y: toSigned(y2) };
    const path = list ? findPath(start, end, readPolygons(vm, list)) : [start, end];
    const ref = vm.memory.newArray("int16", 0);
    vm.memory.array(ref)!.data = [...path.flatMap((p) => [fromInt(Math.round(p.x)), fromInt(Math.round(p.y))]), POLY_END, POLY_END];
    return ref;
  },
  InPolygon: (vm, [x = 0, y = 0, polygon = 0]) => {
    const poly = readPolygon(vm, polygon);
    return bool(!!poly && contains(poly, { x: toSigned(x), y: toSigned(y) }) !== "outside");
  },
  // TODO: merge a dynamic obstacle with overlapping barred polygons.
  MergePoly: (_vm, [polygon = 0]) => polygon,
  SetJump: () => 0,
};
