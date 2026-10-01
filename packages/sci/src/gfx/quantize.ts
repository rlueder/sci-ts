import type { Palette } from "./palette.ts";
import type { HunkPaletteFile, PicFile } from "./pic-file.ts";

/**
 * Turning RGBA art into a room picture, within an SCI2 game's palette layout (measured on all 59
 * of its pics, the base palette 999 and the hero's views):
 *
 *   0-111    shared character colours: identical in every room and in the hero's views
 *   112-235  124 colours each room chooses for itself
 *   236-255  fixed interface/system colours (253, 254 are the shadow/light remaps, 255 is
 *            white and the pic cels' transparent colour)
 *
 * A new picture keeps 0-111 and 236-252 exactly as the base palette has them (it may use
 * them in its art), picks its 124 own colours by k-means around those fixed ones, and never
 * uses 253-255.
 */
export interface PicLayer {
  width: number;
  height: number;
  /** RGBA; alpha < 128 is transparent (only meaningful for foreground layers). */
  rgba: Uint8Array;
  /** Draw order against actors: -1000 for the background; else actors with y below it are behind. */
  priority: number;
  x?: number;
  y?: number;
}

export interface QuantizeOptions {
  /** Floyd–Steinberg error diffusion: smoother gradients for painted art. Default true. */
  dither?: boolean;
  /** Lloyd iterations for the room's own colours. Default 8. */
  iterations?: number;
}

const FREE_FIRST = 112, FREE_LAST = 235;
const FIXED = [...Array.from({ length: 112 }, (_, i) => i), ...Array.from({ length: 17 }, (_, i) => 236 + i)]; // 0-111, 236-252
const SKIP = 255;

type Rgb = [number, number, number];

/** "Redmean": a cheap perceptual RGB distance. */
function distance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

/** Deterministic pseudo-random numbers, so the same art always builds the same picture. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

export function buildRoomPic(layers: PicLayer[], base: Palette, options: QuantizeOptions = {}): PicFile {
  const { dither = true, iterations = 8 } = options;
  if (!layers.length) throw new Error("A picture needs at least a background layer");

  // Training pixels: every opaque pixel of every layer (sampled if there are many).
  const all: Rgb[] = [];
  for (const l of layers) for (let i = 0; i < l.width * l.height; i++) if (l.rgba[i * 4 + 3]! >= 128) all.push([l.rgba[i * 4]!, l.rgba[i * 4 + 1]!, l.rgba[i * 4 + 2]!]);
  const rand = random(all.length);
  const sample = all.length > 30_000 ? Array.from({ length: 30_000 }, () => all[Math.floor(rand() * all.length)]!) : all;

  const fixed: Rgb[] = FIXED.map((i) => [base.rgb[i * 3]!, base.rgb[i * 3 + 1]!, base.rgb[i * 3 + 2]!]);
  const nearest = (centers: Rgb[], r: number, g: number, b: number) => {
    let best = 0, bestD = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const k = centers[c]!;
      const d = distance(r, g, b, k[0], k[1], k[2]);
      if (d < bestD) (bestD = d), (best = c);
    }
    return { index: best, d: bestD };
  };

  // k-means++ seeding of the free colours, around the fixed ones.
  const free: Rgb[] = [];
  const dist = sample.map((p) => nearest(fixed, ...p).d);
  const count = FREE_LAST - FREE_FIRST + 1;
  while (free.length < count) {
    const total = dist.reduce((a, b) => a + b, 0);
    if (total === 0) {
      free.push([0, 0, 0]); // the fixed colours already cover the art exactly
      continue;
    }
    let t = rand() * total, pick = 0;
    for (; pick < dist.length - 1 && (t -= dist[pick]!) > 0; pick++);
    const c = sample[pick]!;
    free.push([...c]);
    for (let i = 0; i < sample.length; i++) dist[i] = Math.min(dist[i]!, distance(...sample[i]!, ...c));
  }

  // Lloyd iterations: only the free colours move.
  for (let it = 0; it < iterations; it++) {
    const sums = free.map(() => [0, 0, 0, 0]);
    const centers = [...fixed, ...free];
    for (const p of sample) {
      const { index } = nearest(centers, ...p);
      if (index < fixed.length) continue;
      const s = sums[index - fixed.length]!;
      s[0]! += p[0]; s[1]! += p[1]; s[2]! += p[2]; s[3]!++;
    }
    sums.forEach((s, i) => {
      if (s[3]) free[i] = [Math.round(s[0]! / s[3]), Math.round(s[1]! / s[3]), Math.round(s[2]! / s[3])];
    });
  }

  const centers = [...fixed, ...free];
  const indexOf = [...FIXED, ...Array.from({ length: count }, (_, i) => FREE_FIRST + i)];
  const map = (layer: PicLayer): Uint8Array => {
    const { width: w, height: h, rgba } = layer;
    const out = new Uint8Array(w * h).fill(SKIP);
    const err = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (rgba[i * 4 + 3]! < 128) continue;
        const r = clamp(rgba[i * 4]! + err[i * 3]!), g = clamp(rgba[i * 4 + 1]! + err[i * 3 + 1]!), b = clamp(rgba[i * 4 + 2]! + err[i * 3 + 2]!);
        const { index } = nearest(centers, r, g, b);
        out[i] = indexOf[index]!;
        if (!dither) continue;
        const c = centers[index]!;
        const e = [r - c[0], g - c[1], b - c[2]];
        const spread = (dx: number, dy: number, f: number) => {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) return;
          const j = yy * w + xx;
          if (rgba[j * 4 + 3]! < 128) return;
          for (let k = 0; k < 3; k++) err[j * 3 + k]! += e[k]! * f;
        };
        spread(1, 0, 7 / 16); spread(-1, 1, 3 / 16); spread(0, 1, 5 / 16); spread(1, 1, 1 / 16);
      }
    }
    return out;
  };

  const cels = layers.map((l) => {
    let pixels = map(l);
    let [x, y, w, h] = [l.x ?? 0, l.y ?? 0, l.width, l.height];
    if (l.priority > -1000) {
      // Foreground pieces: crop to what's opaque.
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (pixels[yy * w + xx] !== SKIP) (x0 = Math.min(x0, xx)), (x1 = Math.max(x1, xx)), (y0 = Math.min(y0, yy)), (y1 = Math.max(y1, yy));
      if (x1 < 0) throw new Error(`Layer at priority ${l.priority} is fully transparent`);
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      const cropped = new Uint8Array(cw * ch);
      for (let yy = 0; yy < ch; yy++) cropped.set(pixels.subarray((y0 + yy) * w + x0, (y0 + yy) * w + x0 + cw), yy * cw);
      [pixels, x, y, w, h] = [cropped, x + x0, y + y0, cw, ch];
    }
    return { width: w, height: h, displaceX: 0, displaceY: 0, skipColor: SKIP, pixels, unknown16: 2768, priority: l.priority, x, y };
  });

  const rgb: [number, number, number][] = [];
  for (let i = 0; i < 255; i++) {
    const k: Rgb = i >= FREE_FIRST && i <= FREE_LAST ? free[i - FREE_FIRST]! : [base.rgb[i * 3]!, base.rgb[i * 3 + 1]!, base.rgb[i * 3 + 2]!];
    rgb.push(k);
  }
  const palette: HunkPaletteFile = {
    header: Uint8Array.from([14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]),
    entryPrefix: Uint8Array.from([0, 255, 255, 255, 255, 255, 255, 255, 0, 0]),
    first: 0,
    used: rgb.map(() => 1),
    rgb,
    shared: false,
    defaultUsed: 1,
  };
  return { resolution: [320, 200], cels, palette };
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** The colours a view may use: shared character colours (+ fixed ones), or a room's too. */
export const SHARED_COLORS = FIXED;
export const ROOM_COLORS = [...FIXED, ...Array.from({ length: FREE_LAST - FREE_FIRST + 1 }, (_, i) => FREE_FIRST + i)];
export const SHADOW_COLOR = 254;

/**
 * Maps RGBA art onto existing palette entries (no new colours): for sprites that must live
 * with a room's or the shared palette. Alpha below 64 is transparent (`skip`), 64-191 is a
 * shadow (the remap colour 254, which darkens what's behind), 192+ is opaque.
 */
export function mapToPalette(rgba: Uint8Array, width: number, height: number, palette: Palette, indices: number[], skip: number, dither = false): Uint8Array {
  const centers = indices.map((i) => [palette.rgb[i * 3]!, palette.rgb[i * 3 + 1]!, palette.rgb[i * 3 + 2]!] as Rgb);
  const out = new Uint8Array(width * height).fill(skip);
  const err = new Float32Array(width * height * 3);
  const cache = new Map<number, number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = rgba[i * 4 + 3]!;
      if (a < 64) continue;
      if (a < 192) {
        out[i] = SHADOW_COLOR;
        continue;
      }
      const r = clamp(rgba[i * 4]! + err[i * 3]!), g = clamp(rgba[i * 4 + 1]! + err[i * 3 + 1]!), b = clamp(rgba[i * 4 + 2]! + err[i * 3 + 2]!);
      const key = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
      let best = cache.get(key);
      if (best === undefined) {
        let bestD = Infinity;
        best = 0;
        centers.forEach((c, k) => {
          const d = distance(r, g, b, c[0], c[1], c[2]);
          if (d < bestD) (bestD = d), (best = k);
        });
        cache.set(key, best);
      }
      out[i] = indices[best]!;
      if (!dither) continue;
      const c = centers[best]!;
      const e = [r - c[0], g - c[1], b - c[2]];
      for (const [dx, dy, f] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]] as const) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= width || yy >= height) continue;
        for (let k = 0; k < 3; k++) err[(yy * width + xx) * 3 + k]! += e[k]! * f;
      }
    }
  }
  return out;
}
