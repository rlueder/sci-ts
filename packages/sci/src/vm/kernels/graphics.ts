import { ResourceType } from "../../resource/types.ts";
import type { Cel } from "../../gfx/cel.ts";
import { emptyPalette, mergePalette, parseHunkPalette, type Palette } from "../../gfx/palette.ts";
import { parsePic, type Pic } from "../../gfx/pic.ts";
import { parseView, type View } from "../../gfx/view.ts";
import { INFO_VIEW_CHANGED, type KernelFn, type Vm } from "../vm.ts";
import { ObjectSlot } from "../../script/script.ts";
import { paletteEffects } from "./palette.ts";
import { input } from "./system.ts";
import { NULL, bool, fromInt, toSigned, type Value } from "../value.ts";

export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 200;

/**
 * SCI32 graphics model: the scripts create Plane objects (layers with a rect, a background
 * pic or colour, and a priority) and register View-like objects as screen items in a plane.
 * Each FrameOut composes planes by priority, then items within a plane by priority.
 * The kernel only remembers *which* objects are registered; their current state (x, y,
 * view, loop, cel...) is read from the objects' properties at compose time.
 */
export class Graphics {
  readonly planes = new Set<Value>();
  readonly items = new Set<Value>();
  frames = 0;
  private readonly views = new Map<number, View | null>();
  private readonly pics = new Map<number, Pic | null>();
  readonly basePalette: Palette;
  /** Called on every FrameOut with the composed frame. */
  onFrame?: (frame: Frame) => void;

  /** Drops parsed views and pictures (their resources were replaced). */
  forgetResources(): void {
    this.views.clear();
    this.pics.clear();
  }

  constructor(private readonly vm: Vm) {
    const res = { type: ResourceType.Palette, number: 999 };
    const base = vm.resources.has(res) ? (parseHunkPalette(vm.resources.loadSync(res).data) ?? emptyPalette()) : emptyPalette();
    // SCI reserves colour 255 as white; palette 999 doesn't define it but UI text uses it.
    base.rgb.set([255, 255, 255], 255 * 3);
    base.used[255] = 1;
    this.basePalette = base;
  }

  /**
   * View numbers are unsigned (SCI32's system views live at 64xxx), but scripts store them
   * in signed properties; only 0xFFFF (-1) means "no view".
   */
  view(n: number): View | undefined {
    n &= 0xffff;
    if (n === 0xffff) return undefined;
    if (!this.views.has(n)) {
      const id = { type: ResourceType.View, number: n };
      this.views.set(n, this.vm.resources.has(id) ? parseView(this.vm.resources.loadSync(id).data) : null);
    }
    return this.views.get(n) ?? undefined;
  }

  pic(n: number): Pic | undefined {
    if (!this.pics.has(n)) {
      const id = { type: ResourceType.Pic, number: n };
      this.pics.set(n, this.vm.resources.has(id) ? parsePic(this.vm.resources.loadSync(id).data) : null);
    }
    return this.pics.get(n) ?? undefined;
  }

  cel(viewNo: number, loopNo: number, celNo: number): { cel: Cel; mirror: boolean } | undefined {
    const view = this.view(viewNo);
    if (!view || !view.loops.length) return undefined;
    const loop = view.loops[Math.min(Math.max(loopNo, 0), view.loops.length - 1)]!;
    if (!loop.cels.length) return undefined;
    return { cel: loop.cels[Math.min(Math.max(celNo, 0), loop.cels.length - 1)]!, mirror: loop.mirror };
  }

  /** Reads a numeric property (signed), 0 if absent. */
  prop(obj: Value, name: string): number {
    return toSigned(this.vm.getProp(obj, name) ?? 0);
  }

  /** Palette built from every palette submitted so far (base, scripts, pics, views). */
  private source: Palette | undefined;
  /** Picture each plane last submitted, and view each item last submitted. */
  private readonly planePictures = new Map<Value, number>();
  private readonly itemViews = new Map<Value, number>();
  /** The palette after PalVary/PalCycle (before fades), as of the last frame. */
  currentPalette: Palette = emptyPalette();
  /** Active show-style transitions, by plane. */
  readonly transitions = new Map<Value, Transition>();
  /** The mouse cursor: a view cel drawn on top at the mouse position (its origin = hotspot). */
  cursor = { view: -1, loop: 0, cel: 0, visible: true, x: 160, y: 100 };
  /**
   * The cursor as a magnifying glass (AddMagnify): where this cel is opaque, placed like the
   * cursor, the screen under the cursor's hotspot shows `zoom` times larger.
   */
  magnify: { view: number; loop: number; cel: number; zoom: number } | undefined;
  /** Palette range affected by fade show styles (SetPalStyleRange). */
  styleRange = { from: 0, to: 255 };
  lastFrame: Frame | undefined;

  get sourcePalette(): Palette | undefined {
    return this.source;
  }

  set sourcePalette(pal: Palette | undefined) {
    this.source = pal;
  }

  submitPalette(pal: Palette | undefined): void {
    this.source = mergePalette(this.source ?? this.basePalette, pal);
  }

  /** Forgets submitted palettes (restart/restore); they're resubmitted as things are drawn. */
  resetPalette(): void {
    this.source = undefined;
    this.planePictures.clear();
    this.itemViews.clear();
  }

  /**
   * Where a view item's cel lands, in its plane's coordinates. Scripts scale cels for
   * perspective (the hero shrinks with distance) and to stretch UI backgrounds (dialog boxes)
   * to fit their contents.
   */
  viewRect(item: Value) {
    const p = (n: string) => this.prop(item, n);
    const found = this.cel(p("view"), p("loop"), p("cel"));
    if (!found || found.cel.width === 0) return undefined;
    const { cel, mirror } = found;
    const scaled = (p("scaleSignal") & SCALE_SIGNAL_DO_SCALING) !== 0;
    const sx = scaled ? Math.max(p("scaleX"), 1) / 128 : 1;
    const sy = scaled ? Math.max(p("scaleY"), 1) / 128 : 1;
    const origin = celOrigin(cel, mirror);
    return {
      cel, mirror, sx, sy,
      x: p("x") - Math.floor(origin.x * sx),
      y: p("y") - p("z") - Math.floor(origin.y * sy),
      width: Math.max(1, Math.floor(cel.width * sx)),
      height: Math.max(1, Math.floor(cel.height * sy)),
    };
  }

  /**
   * Composes the current frame in three phases, because remap colours (shadows) depend on
   * the final palette: collect what each plane draws (submitting palettes as pictures and
   * views change, like the original), apply palette effects, then blit.
   */
  compose(): Frame {
    const pixels = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    const p = (o: Value, n: string) => this.prop(o, n);
    this.source ??= this.basePalette;

    // Phase 1: what to draw. Priority -1 marks a hidden plane; an empty rect is off-screen.
    const layers: { clip: Clip; fill: number | undefined; draws: Drawable[] }[] = [];
    const planes = [...this.planes]
      .filter((pl) => this.vm.memory.object(pl) && p(pl, "priority") !== -1)
      .sort((a, b) => p(a, "priority") - p(b, "priority"));
    for (const plane of planes) {
      const left = p(plane, "inLeft"), top = p(plane, "inTop");
      const clip = { left, top, right: p(plane, "inRight"), bottom: p(plane, "inBottom") };
      if (clip.right <= clip.left || clip.bottom <= clip.top) continue;
      const draws: Drawable[] = [];
      let fill: number | undefined;

      const picture = p(plane, "picture");
      const pic = picture >= 0 ? this.pic(picture) : undefined;
      if (pic) {
        if (this.planePictures.get(plane) !== picture) {
          this.planePictures.set(plane, picture);
          this.submitPalette(pic.palette);
        }
        for (const cel of pic.cels) draws.push({ cel, mirror: false, x: left + cel.x, y: top + cel.y, priority: cel.priority, order: -1 });
      } else if (picture !== -2) fill = p(plane, "back") & 0xff;

      let order = 0;
      for (const item of this.items) {
        if (!this.vm.memory.object(item) || this.vm.getProp(item, "plane") !== plane) continue;
        const priority = p(item, "fixPriority") ? p(item, "priority") : p(item, "y");

        // Script-drawn bitmaps (text boxes) replace the view cel when `bitmap` is set.
        const bitmap = this.vm.memory.bitmap(this.vm.getProp(item, "bitmap") ?? 0);
        if (bitmap) {
          const cel: Cel = { width: bitmap.width, height: bitmap.height, displaceX: 0, displaceY: 0, skipColor: bitmap.skipColor, pixels: bitmap.pixels };
          draws.push({ cel, mirror: false, x: left + p(item, "x") - bitmap.originX, y: top + p(item, "y") - bitmap.originY, priority, order: order++ });
          continue;
        }

        const viewNo = p(item, "view");
        const rect = this.viewRect(item);
        if (!rect) continue;
        const { cel, mirror, sx, sy } = rect;
        const x = left + rect.x, y = top + rect.y, w = rect.width, h = rect.height;
        if (x > clip.right || y > clip.bottom || x + w <= clip.left || y + h <= clip.top) continue;
        // A view's palette is submitted when it's first drawn (or the item's view changes).
        if (this.itemViews.get(item) !== viewNo) {
          this.itemViews.set(item, viewNo);
          this.submitPalette(this.view(viewNo)?.palette);
        }
        draws.push({ cel, mirror, x, y, priority, order: order++, sx, sy });
      }
      draws.sort((a, b) => a.priority - b.priority || a.order - b.order);
      layers.push({ clip, fill, draws });
    }

    // Phase 2: palette effects and remap tables.
    const fx = paletteEffects(this.vm);
    fx.update(Math.floor((this.vm.clock() * 60) / 1000));
    const { current, output, remap } = fx.apply(this.source);
    this.currentPalette = current;

    // Fade show styles dim the style range of the palette (held at black after a fade-out).
    const now = this.vm.clock();
    const progress = (t: Transition) => (t.duration <= 0 ? 1 : Math.min(1, (now - t.start) / t.duration));
    let fadedOutput = output;
    for (const t of this.transitions.values()) {
      if (t.style !== ShowStyle.FadeOut && t.style !== ShowStyle.FadeIn) continue;
      const level = t.style === ShowStyle.FadeOut ? 1 - progress(t) : progress(t);
      if (fadedOutput === output) fadedOutput = { rgb: output.rgb.slice(), used: output.used };
      for (let i = this.styleRange.from; i <= this.styleRange.to; i++) for (let k = 0; k < 3; k++) fadedOutput.rgb[i * 3 + k] = Math.round(fadedOutput.rgb[i * 3 + k]! * level);
    }

    // Phase 3: blit.
    for (const { clip, fill, draws } of layers) {
      if (fill !== undefined) {
        for (let y = Math.max(clip.top, 0); y <= Math.min(clip.bottom, SCREEN_HEIGHT - 1); y++) {
          pixels.fill(fill, y * SCREEN_WIDTH + Math.max(clip.left, 0), y * SCREEN_WIDTH + Math.min(clip.right, SCREEN_WIDTH - 1) + 1);
        }
      }
      for (const d of draws) blit(pixels, d, clip, remap);
    }
    // The cursor goes on top of everything: first what a magnifier shows through its glass.
    const cur = this.cursor;
    const mag = this.magnify;
    const glass = cur.visible && mag ? this.cel(mag.view, mag.loop, mag.cel) : undefined;
    if (glass && mag) {
      const scene = pixels.slice();
      const o = celOrigin(glass.cel, glass.mirror);
      const { width: w, height: h, skipColor } = glass.cel;
      for (let gy = 0; gy < h; gy++) {
        for (let gx = 0; gx < w; gx++) {
          if (glass.cel.pixels[gy * w + (glass.mirror ? w - 1 - gx : gx)] === skipColor) continue;
          const x = cur.x - o.x + gx, y = cur.y - o.y + gy;
          if (x < 0 || y < 0 || x >= SCREEN_WIDTH || y >= SCREEN_HEIGHT) continue;
          const sx = cur.x + Math.floor((x - cur.x) / mag.zoom), sy = cur.y + Math.floor((y - cur.y) / mag.zoom);
          if (sx < 0 || sy < 0 || sx >= SCREEN_WIDTH || sy >= SCREEN_HEIGHT) continue;
          pixels[y * SCREEN_WIDTH + x] = scene[sy * SCREEN_WIDTH + sx]!;
        }
      }
    }
    if (cur.visible && cur.view >= 0) {
      const found = this.cel(cur.view, cur.loop, cur.cel);
      if (found) {
        const o = celOrigin(found.cel, found.mirror);
        blit(pixels, { cel: found.cel, mirror: found.mirror, x: cur.x - o.x, y: cur.y - o.y, priority: 0, order: 0 }, { left: 0, top: 0, right: SCREEN_WIDTH - 1, bottom: SCREEN_HEIGHT - 1 }, remap);
      }
    }
    const frame: Frame = { pixels, palette: fadedOutput, width: SCREEN_WIDTH, height: SCREEN_HEIGHT };

    // Wipes, shutters, irises and dissolves reveal the new image over the old one.
    for (const [plane, t] of this.transitions) {
      const p = progress(t);
      if (t.style === ShowStyle.FadeOut || t.style === ShowStyle.FadeIn) {
        if (p >= 1 && t.style === ShowStyle.FadeIn) this.transitions.delete(plane);
        continue;
      }
      if (t.from && p < 1) {
        const rgb = (frame.rgb ??= frameRgb(frame).slice());
        for (let y = Math.max(t.rect.top, 0); y <= Math.min(t.rect.bottom, SCREEN_HEIGHT - 1); y++) {
          for (let x = Math.max(t.rect.left, 0); x <= Math.min(t.rect.right, SCREEN_WIDTH - 1); x++) {
            if (!revealed(t.style, x, y, t.rect, p)) {
              const i = (y * SCREEN_WIDTH + x) * 3;
              rgb.set(t.from.subarray(i, i + 3), i);
            }
          }
        }
      }
      if (p >= 1) this.transitions.delete(plane);
    }
    this.lastFrame = frame;
    return frame;
  }
}

type Clip = { left: number; top: number; right: number; bottom: number };

export interface Frame {
  width: number;
  height: number;
  pixels: Uint8Array;
  palette: Palette;
  /** Set during wipes/dissolves, which mix two differently-coloured images: RGB per pixel. */
  rgb?: Uint8Array;
}

/** SCI32 show styles (SetShowStyle): how a plane's new content appears. */
export const ShowStyle = {
  None: 0, HShutterOut: 1, HShutterIn: 2, VShutterOut: 3, VShutterIn: 4, WipeLeft: 5, WipeRight: 6,
  WipeUp: 7, WipeDown: 8, IrisOut: 9, IrisIn: 10, DissolveNoMorph: 11, Dissolve: 12, FadeOut: 13, FadeIn: 14,
} as const;

interface Transition {
  style: number;
  start: number; // ms (vm clock)
  duration: number; // ms
  rect: Clip;
  /** The screen as it was when the transition started (RGB), for wipes and dissolves. */
  from: Uint8Array | undefined;
}

/** Converts an indexed frame to RGB. */
export function frameRgb(f: Frame): Uint8Array {
  if (f.rgb) return f.rgb;
  const rgb = new Uint8Array(f.width * f.height * 3);
  for (let i = 0; i < f.pixels.length; i++) rgb.set(f.palette.rgb.subarray(f.pixels[i]! * 3, f.pixels[i]! * 3 + 3), i * 3);
  return rgb;
}

/** Deterministic per-pixel order for dissolves. */
const DISSOLVE = (() => {
  const order = new Float32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  let seed = 0x9e3779b9;
  for (let i = 0; i < order.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    order[i] = seed / 0x100000000;
  }
  return order;
})();

/** True where the *new* image shows at progress p (0..1) for a wipe-like style. */
function revealed(style: number, x: number, y: number, r: Clip, p: number): boolean {
  const w = r.right - r.left + 1, h = r.bottom - r.top + 1;
  const fx = (x - r.left) / w, fy = (y - r.top) / h;
  const cx = Math.abs(fx - 0.5) * 2, cy = Math.abs(fy - 0.5) * 2; // 0 at centre, 1 at edges
  switch (style) {
    case ShowStyle.HShutterOut: return cx <= p;
    case ShowStyle.HShutterIn: return cx >= 1 - p;
    case ShowStyle.VShutterOut: return cy <= p;
    case ShowStyle.VShutterIn: return cy >= 1 - p;
    case ShowStyle.WipeLeft: return fx >= 1 - p;
    case ShowStyle.WipeRight: return fx <= p;
    case ShowStyle.WipeUp: return fy >= 1 - p;
    case ShowStyle.WipeDown: return fy <= p;
    case ShowStyle.IrisOut: return Math.max(cx, cy) <= p;
    case ShowStyle.IrisIn: return Math.max(cx, cy) >= 1 - p;
    default: return DISSOLVE[y * SCREEN_WIDTH + x]! <= p; // dissolves
  }
}

interface Drawable {
  cel: Cel;
  mirror: boolean;
  x: number;
  y: number;
  priority: number;
  order: number;
  /** Scale factors (1 = actual size). */
  sx?: number;
  sy?: number;
}

/** scaleSignal bit 0: scale the cel by scaleX/128, scaleY/128. */
const SCALE_SIGNAL_DO_SCALING = 1;

/** View cel anchor point, relative to the cel's top-left. */
export function celOrigin(cel: Cel, mirror = false): { x: number; y: number } {
  const x = (cel.width >> 1) - cel.displaceX;
  return { x: mirror ? cel.width - 1 - x : x, y: cel.height - cel.displaceY - 1 };
}

function blit(dst: Uint8Array, d: Drawable, clip: Clip, remap: Map<number, Uint8Array>) {
  const { cel } = d;
  const sx = d.sx ?? 1, sy = d.sy ?? 1;
  const w = Math.max(1, Math.floor(cel.width * sx)), h = Math.max(1, Math.floor(cel.height * sy));
  for (let dy = 0; dy < h; dy++) {
    const y = d.y + dy;
    if (y < Math.max(clip.top, 0) || y > Math.min(clip.bottom, SCREEN_HEIGHT - 1)) continue;
    const cy = Math.min(cel.height - 1, Math.floor(dy / sy));
    for (let dx = 0; dx < w; dx++) {
      const x = d.x + dx;
      if (x < Math.max(clip.left, 0) || x > Math.min(clip.right, SCREEN_WIDTH - 1)) continue;
      const cx = Math.min(cel.width - 1, Math.floor(dx / sx));
      const c = cel.pixels[cy * cel.width + (d.mirror ? cel.width - 1 - cx : cx)]!;
      if (c === cel.skipColor) continue;
      const table = remap.get(c);
      if (table) {
        // Remap colour: transform what's already there (e.g. darken it for a shadow).
        const i = y * SCREEN_WIDTH + x;
        dst[i] = table[dst[i]!]!;
        continue;
      }
      // Placeholder remap colours with no active remap would show as magenta/teal: skip.
      if (c === 253 || c === 254) continue;
      dst[y * SCREEN_WIDTH + x] = c;
    }
  }
}

const gfxOf = new WeakMap<Vm, Graphics>();
export const graphics = (vm: Vm): Graphics => {
  let g = gfxOf.get(vm);
  if (!g) {
    const created = (g = new Graphics(vm));
    gfxOf.set(vm, created);
    vm.hostRoots.push(() => [...created.planes, ...created.items]);
  }
  return g;
};

function clearViewChanged(vm: Vm, obj: Value) {
  const o = vm.memory.object(obj);
  if (o) o.vars[ObjectSlot.Info] = o.vars[ObjectSlot.Info]! & ~INFO_VIEW_CHANGED & 0xffff;
}

/** Writes nsLeft/nsTop/nsRight/nsBottom from the object's current (scaled) cel and position. */
function setNowSeen(vm: Vm, obj: Value) {
  if (vm.getProp(obj, "nsLeft") === undefined) return;
  const r = graphics(vm).viewRect(obj);
  if (!r) return;
  vm.setProp(obj, "nsLeft", fromInt(r.x));
  vm.setProp(obj, "nsTop", fromInt(r.y));
  vm.setProp(obj, "nsRight", fromInt(r.x + r.width - 1));
  vm.setProp(obj, "nsBottom", fromInt(r.y + r.height - 1));
}

export const graphicsKernels: Record<string, KernelFn> = {
  AddPlane: (vm, [plane = 0]) => void graphics(vm).planes.add(plane),
  UpdatePlane: (vm, [plane = 0]) => void graphics(vm).planes.add(plane),
  DeletePlane: (vm, [plane = 0]) => void graphics(vm).planes.delete(plane),
  RepaintPlane: () => 0,
  GetHighPlanePri: (vm) => {
    const g = graphics(vm);
    return fromInt(Math.max(0, ...[...g.planes].filter((p) => vm.memory.object(p)).map((p) => g.prop(p, "priority"))));
  },
  // Taking the object's current state clears its "changed since drawn" flag (SSCI's
  // ScreenItem::setFromObject), which scripts set again by writing drawing properties.
  AddScreenItem: (vm, [obj = 0]) => void (graphics(vm).items.add(obj), clearViewChanged(vm, obj)),
  UpdateScreenItem: (vm, [obj = 0]) => void (graphics(vm).items.add(obj), clearViewChanged(vm, obj)),
  DeleteScreenItem: (vm, [obj = 0]) => void graphics(vm).items.delete(obj),

  FrameOut: (vm) => {
    const g = graphics(vm);
    g.frames++;
    const mouse = input(vm);
    g.cursor.x = mouse.x;
    g.cursor.y = mouse.y;
    for (const hook of vm.frameHooks) hook();
    g.onFrame?.(g.compose());
    vm.yieldRequested = true;
  },

  SetNowSeen: (vm, [obj = 0]) => setNowSeen(vm, obj),
  NumLoops: (vm, [obj = 0]) => graphics(vm).view(graphics(vm).prop(obj, "view"))?.loops.length ?? 0,
  NumCels: (vm, [obj = 0]) => {
    const g = graphics(vm);
    const view = g.view(g.prop(obj, "view"));
    const loop = view?.loops[g.prop(obj, "loop")];
    return loop?.cels.length ?? 0;
  },
  CelWide: (vm, [view = 0, loop = 0, cel = 0]) => graphics(vm).cel(view, toSigned(loop), toSigned(cel))?.cel.width ?? 0,
  CelHigh: (vm, [view = 0, loop = 0, cel = 0]) => graphics(vm).cel(view, toSigned(loop), toSigned(cel))?.cel.height ?? 0,
  BaseSetter: (vm, [obj = 0]) => {
    const g = graphics(vm);
    const found = g.cel(g.prop(obj, "view"), g.prop(obj, "loop"), g.prop(obj, "cel"));
    if (!found) return;
    const left = g.prop(obj, "x") - celOrigin(found.cel, found.mirror).x;
    const bottom = g.prop(obj, "y") + 1;
    vm.setProp(obj, "brLeft", fromInt(left));
    vm.setProp(obj, "brRight", fromInt(left + found.cel.width - 1));
    vm.setProp(obj, "brBottom", fromInt(bottom));
    vm.setProp(obj, "brTop", fromInt(bottom - g.prop(obj, "yStep")));
  },
  // IsOnMe(x, y, obj, checkPixels): with checkPixels, only where the cel isn't transparent.
  IsOnMe: (vm, [x = 0, y = 0, obj = 0, checkPixels = 0]) => {
    const g = graphics(vm);
    const px = toSigned(x), py = toSigned(y);
    // Like SSCI, a screen item is hit where its cel is actually drawn (scaled, current
    // position): its ns* props can be stale, since only SetNowSeen updates them.
    const r = g.items.has(obj) ? g.viewRect(obj) : undefined;
    if (r) {
      if (!(px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height)) return 0;
      if (!checkPixels) return 1;
      const cx = Math.min(r.cel.width - 1, Math.floor((px - r.x) / r.sx));
      const cy = Math.min(r.cel.height - 1, Math.floor((py - r.y) / r.sy));
      return bool(r.cel.pixels[cy * r.cel.width + (r.mirror ? r.cel.width - 1 - cx : cx)] !== r.cel.skipColor);
    }
    return bool(px >= g.prop(obj, "nsLeft") && px <= g.prop(obj, "nsRight") && py >= g.prop(obj, "nsTop") && py <= g.prop(obj, "nsBottom"));
  },
  IsHiRes: () => 0,
  SetVideoMode: () => 0,
  // SetShowStyle(style, plane, seconds, backColor, priority, animate, refFrame, ...)
  SetShowStyle: (vm, [style = 0, plane = 0, seconds = 0]) => {
    const g = graphics(vm);
    if (style === ShowStyle.None) {
      g.transitions.delete(plane);
      return;
    }
    const rect = vm.memory.object(plane)
      ? { left: g.prop(plane, "inLeft"), top: g.prop(plane, "inTop"), right: g.prop(plane, "inRight"), bottom: g.prop(plane, "inBottom") }
      : { left: 0, top: 0, right: SCREEN_WIDTH - 1, bottom: SCREEN_HEIGHT - 1 };
    g.transitions.set(plane, {
      style,
      start: vm.clock(),
      duration: Math.max(0, toSigned(seconds)) * 1000,
      rect,
      from: g.lastFrame && frameRgb(g.lastFrame).slice(),
    });
  },
  ShowStylePercent: () => 0,
  SetPalStyleRange: (vm, [from = 0, to = 255]) => void (graphics(vm).styleRange = { from, to }),
  // SetCursor: (show) 1 arg, (x, y) warp, (view, loop, cel) shape, (l, t, r, b) restrict.
  SetCursor: (vm, args) => {
    const c = graphics(vm).cursor;
    const [a = 0, b = 0, d = 0] = args.map(toSigned);
    if (args.length === 1) {
      if (a !== -2) c.visible = a !== 0;
    } else if (args.length === 2) {
      vm.moveMouse?.(a, b);
    } else if (args.length === 3) {
      Object.assign(c, { view: a, loop: b, cel: d });
    }
  },
  HaveMouse: () => 1,
  ShakeScreen: () => 0,
  SetScroll: () => 0,
  // AddMagnify(view, loop, cel, zoom): sci-ts makes the cursor a magnifying glass, the cel's
  // opaque pixels its glass (placed like the cursor), showing what's under the hotspot zoom
  // times larger. DeleteMagnify() stops it.
  AddMagnify: (vm, [view = 0, loop = 0, cel = 0, zoom = 2]) => {
    graphics(vm).magnify = { view: toSigned(view), loop, cel, zoom: Math.max(1, toSigned(zoom)) };
    return 0;
  },
  DeleteMagnify: (vm) => {
    graphics(vm).magnify = undefined;
    return 0;
  },
  GetHighItemPri: () => 0,
  SetFontRes: () => 0,
  NULL_: () => NULL,
};
