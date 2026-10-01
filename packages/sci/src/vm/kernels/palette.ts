import { ResourceType } from "../../resource/types.ts";
import { emptyPalette, mergePalette, parseHunkPalette, type Palette } from "../../gfx/palette.ts";
import type { KernelFn, Vm } from "../vm.ts";
import { fromInt, toSigned } from "../value.ts";
import { graphics } from "./graphics.ts";

/**
 * SCI32 palette effects, applied in the original's order:
 *
 *   source (submitted palettes) → PalVary blend → PalCycle rotation = current palette
 *   current → remap tables (shadows etc. are computed against these colours)
 *   current → fade table                                              = output palette
 */
export class PaletteEffects {
  /** Per-colour brightness in percent (Palette subop 2, fades). */
  readonly fade = new Uint8Array(256).fill(100);
  vary: Vary | undefined;
  readonly cycles = new Map<number, Cycle>(); // by first colour
  readonly remaps = new Map<number, Remap>(); // by remap colour index
  /** Colours excluded from remap matching (RemapColors subop 5). */
  blocked = { start: 0, count: 0 };

  constructor(private readonly vm: Vm) {}

  /** Serializable state, for save games. */
  save(): PaletteEffectsState {
    return {
      fade: Array.from(this.fade),
      vary: this.vary && { ...this.vary },
      cycles: [...this.cycles.values()].map((c) => ({ ...c })),
      remaps: [...this.remaps].map(([color, r]) => [color, { ...r }]),
      blocked: { ...this.blocked },
    };
  }

  load(state: PaletteEffectsState, now: number): void {
    this.fade.set(state.fade);
    this.vary = state.vary && { ...state.vary, lastTick: now };
    this.cycles.clear();
    for (const c of state.cycles) this.cycles.set(c.from, { ...c, lastTick: now });
    this.remaps.clear();
    for (const [color, r] of state.remaps) this.remaps.set(color, { ...r });
    this.blocked = { ...state.blocked };
  }

  reset(): void {
    this.load({ fade: new Array(256).fill(100), vary: undefined, cycles: [], remaps: [], blocked: { start: 0, count: 0 } }, 0);
  }

  paletteResource(id: number): Palette | undefined {
    const res = { type: ResourceType.Palette, number: id };
    return this.vm.resources.has(res) ? parseHunkPalette(this.vm.resources.loadSync(res).data) : undefined;
  }

  /** Advances PalVary and PalCycle to `now` (60 Hz ticks). */
  update(now: number): void {
    const v = this.vary;
    if (v && !v.paused && v.percent !== v.targetPercent) {
      const elapsed = now - v.lastTick;
      if (v.ticksPerStep <= 0) v.percent = v.targetPercent;
      else if (elapsed >= v.ticksPerStep) {
        const steps = Math.floor(elapsed / v.ticksPerStep);
        v.percent = v.percent < v.targetPercent ? Math.min(v.targetPercent, v.percent + steps) : Math.max(v.targetPercent, v.percent - steps);
        v.lastTick += steps * v.ticksPerStep;
      }
    }
    for (const c of this.cycles.values()) {
      if (c.paused || c.delay <= 0) continue;
      const steps = Math.floor((now - c.lastTick) / c.delay);
      if (steps > 0) {
        c.offset = (c.offset + steps * c.direction) % c.count;
        c.lastTick += steps * c.delay;
      }
    }
  }

  apply(source: Palette): { current: Palette; output: Palette; remap: Map<number, Uint8Array> } {
    let current = source;
    const v = this.vary;
    if (v && v.percent > 0 && v.target) {
      const start = v.start ?? source;
      current = { rgb: source.rgb.slice(), used: source.used.slice() };
      for (let i = v.from; i <= v.to; i++) {
        if (!v.target.used[i]) continue;
        for (let k = 0; k < 3; k++) {
          const a = start.rgb[i * 3 + k]!, b = v.target.rgb[i * 3 + k]!;
          current.rgb[i * 3 + k] = Math.round(a + ((b - a) * v.percent) / 100);
        }
      }
    }
    if (this.cycles.size) {
      const src = current.rgb.slice();
      if (current === source) current = { rgb: src.slice(), used: source.used };
      for (const c of this.cycles.values()) {
        for (let i = 0; i < c.count; i++) {
          const from = c.from + (((i - c.offset) % c.count) + c.count) % c.count;
          current.rgb.set(src.subarray(from * 3, from * 3 + 3), (c.from + i) * 3);
        }
      }
    }

    const remap = new Map<number, Uint8Array>();
    for (const [color, r] of this.remaps) remap.set(color, this.remapTable(current, r));

    let output = current;
    if (this.fade.some((f) => f !== 100)) {
      output = { rgb: current.rgb.slice(), used: current.used };
      for (let i = 0; i < 256; i++) for (let k = 0; k < 3; k++) output.rgb[i * 3 + k] = Math.min(255, Math.round((current.rgb[i * 3 + k]! * this.fade[i]!) / 100));
    }
    return { current, output, remap };
  }

  /** Maps every colour to the palette entry closest to its transformed RGB. */
  private remapTable(pal: Palette, r: Remap): Uint8Array {
    const table = new Uint8Array(256);
    const candidates: number[] = [];
    for (let i = 0; i < 256; i++) {
      const blocked = i >= this.blocked.start && i < this.blocked.start + this.blocked.count;
      if (!blocked && !this.remaps.has(i)) candidates.push(i);
    }
    for (let c = 0; c < 256; c++) {
      if (r.kind === "range") {
        table[c] = c >= r.from && c <= r.to ? (c + r.delta) & 0xff : c;
        continue;
      }
      let [red, green, blue] = [pal.rgb[c * 3]!, pal.rgb[c * 3 + 1]!, pal.rgb[c * 3 + 2]!];
      if (r.gray) {
        const lum = (red * 77 + green * 151 + blue * 28) >> 8;
        red += ((lum - red) * r.gray) / 100;
        green += ((lum - green) * r.gray) / 100;
        blue += ((lum - blue) * r.gray) / 100;
      }
      red = (red * r.percent) / 100;
      green = (green * r.percent) / 100;
      blue = (blue * r.percent) / 100;
      let best = c, bestDist = Infinity;
      for (const i of candidates) {
        const dr = pal.rgb[i * 3]! - red, dg = pal.rgb[i * 3 + 1]! - green, db = pal.rgb[i * 3 + 2]! - blue;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) (bestDist = d), (best = i);
      }
      table[c] = best;
    }
    return table;
  }
}

export interface PaletteEffectsState {
  fade: number[];
  vary: Vary | undefined;
  cycles: Cycle[];
  remaps: [number, Remap][];
  blocked: { start: number; count: number };
}

interface Vary {
  target: Palette | undefined;
  start: Palette | undefined;
  percent: number;
  targetPercent: number;
  ticksPerStep: number;
  lastTick: number;
  from: number;
  to: number;
  paused: boolean;
}

interface Cycle {
  from: number;
  count: number;
  direction: number;
  delay: number;
  offset: number;
  lastTick: number;
  paused: boolean;
}

type Remap =
  | { kind: "range"; from: number; to: number; delta: number; percent: 100; gray: 0 }
  | { kind: "color"; percent: number; gray: number };

const stateOf = new WeakMap<Vm, PaletteEffects>();
export const paletteEffects = (vm: Vm): PaletteEffects => {
  let p = stateOf.get(vm);
  if (!p) stateOf.set(vm, (p = new PaletteEffects(vm)));
  return p;
};

const ticks = (vm: Vm) => Math.floor((vm.clock() * 60) / 1000);

export const paletteKernels: Record<string, KernelFn> = {
  Palette: (vm, [subop = 0, a = 0, b = 0, c = 0]) => {
    const fx = paletteEffects(vm);
    switch (subop) {
      case 1: { // set from resource (merged into the source palette)
        const pal = fx.paletteResource(a);
        if (pal) graphics(vm).submitPalette(pal);
        return 0;
      }
      case 2: // fade(fromColor, toColor, percent)
        fx.fade.fill(Math.max(0, Math.min(100, c)), a, b + 1);
        return 0;
      case 3: { // find colour closest to (r, g, b)
        const pal = graphics(vm).currentPalette;
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < 256; i++) {
          const d = (pal.rgb[i * 3]! - a) ** 2 + (pal.rgb[i * 3 + 1]! - b) ** 2 + (pal.rgb[i * 3 + 2]! - c) ** 2;
          if (d < bestDist) (bestDist = d), (best = i);
        }
        return best;
      }
    }
    return 0;
  },

  // Palette morphing toward a target palette over time (e.g. day to night).
  PalVary: (vm, [subop = 0, ...args]) => {
    const fx = paletteEffects(vm);
    const now = ticks(vm);
    const start = (target: Palette | undefined, time: number, percent: number, from = 0, to = 255) => {
      const current = fx.vary?.percent ?? 0;
      const distance = Math.abs(percent - current);
      fx.vary = { target, start: fx.vary?.start, percent: time > 0 ? current : percent, targetPercent: percent, ticksPerStep: distance ? time / distance : 0, lastTick: now, from, to, paused: false };
    };
    switch (subop) {
      case 0: { // set vary(paletteId, ticks, percent, from, to)
        const [id = 0, time = 0, percent = 100, from = 0, to = 255] = args;
        start(fx.paletteResource(id), toSigned(time), toSigned(percent), from, to);
        return 1;
      }
      case 1: { // set percent(ticks, percent)
        const [time = 0, percent = 0] = args;
        if (fx.vary) start(fx.vary.target, toSigned(time), toSigned(percent), fx.vary.from, fx.vary.to);
        return 0;
      }
      case 2: return fromInt(fx.vary?.percent ?? 0);
      case 3: fx.vary = undefined; return 0;
      case 4: // merge into target
        if (fx.vary) fx.vary.target = mergePalette(fx.vary.target ?? emptyPalette(), fx.paletteResource(args[0] ?? 0));
        return fromInt(fx.vary?.percent ?? 0);
      case 5: // set time for the remaining change
        if (fx.vary) start(fx.vary.target, toSigned(args[0] ?? 0), fx.vary.targetPercent, fx.vary.from, fx.vary.to);
        return 0;
      case 6:
        if (fx.vary) fx.vary.paused = (args[0] ?? 0) !== 0;
        return 0;
      case 7:
        if (fx.vary) fx.vary.target = fx.paletteResource(args[0] ?? 0);
        return 0;
      case 8:
      case 9: {
        const pal = fx.paletteResource(args[0] ?? 0);
        if (fx.vary) fx.vary.start = subop === 8 ? pal : mergePalette(fx.vary.start ?? emptyPalette(), pal);
        return 0;
      }
    }
    return 0;
  },

  // Colour cycling (fire, water): rotate a range of palette entries.
  PalCycle: (vm, [subop = 0, from = 0, to = 0, direction = 1, delay = 0]) => {
    const fx = paletteEffects(vm);
    const now = ticks(vm);
    switch (subop) {
      case 0: // set cycle(from, to, direction, delay)
        fx.cycles.set(from, { from, count: Math.max(1, to - from + 1), direction: toSigned(direction) < 0 ? -1 : 1, delay: toSigned(delay), offset: 0, lastTick: now, paused: false });
        return 0;
      case 1: { // do cycle(from, steps)
        const c = fx.cycles.get(from);
        if (c) c.offset = (c.offset + (toSigned(to) || 1) * c.direction) % c.count;
        return 0;
      }
      case 2: case 3: // pause / resume (one or all)
        for (const c of from && fx.cycles.has(from) ? [fx.cycles.get(from)!] : fx.cycles.values()) {
          c.paused = subop === 2;
          c.lastTick = now;
        }
        return 0;
      case 4: // off (one or all)
        if (from && fx.cycles.has(from)) fx.cycles.delete(from);
        else fx.cycles.clear();
        return 0;
    }
    return 0;
  },

  // Remap colours: palette indices that transform what's underneath (e.g. 254 = shadow).
  RemapColors: (vm, [subop = 0, a = 0, b = 0, c = 0, d = 0]) => {
    const fx = paletteEffects(vm);
    switch (subop) {
      case 0: // off (one colour, or all)
        if (a) fx.remaps.delete(a);
        else fx.remaps.clear();
        return 0;
      case 1: fx.remaps.set(a, { kind: "range", from: b, to: c, delta: toSigned(d), percent: 100, gray: 0 }); return 0;
      case 2: fx.remaps.set(a, { kind: "color", percent: b, gray: 0 }); return 0; // by percent
      case 3: fx.remaps.set(a, { kind: "color", percent: 100, gray: b }); return 0; // to gray
      case 4: fx.remaps.set(a, { kind: "color", percent: c, gray: b }); return 0; // to percent gray
      case 5: fx.blocked = { start: a, count: b }; return 0; // exclude a range from matching
    }
    return 0;
  },
};
