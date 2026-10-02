import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ResourceType, writeFont, writeHunkPalette, writePic, writeView, type ResourceData, type ViewLoop } from "@sci-ts/sci";
import { basePalette } from "../game/defaults.ts";
import { decodePng } from "../png.ts";
import { FontSheetError, fontFromMetrics, fontFromSheet, type FontMetrics } from "./font.ts";

/** Editor-neutral, exact-colour art for standalone games. See docs/art-workflow.md. */
export interface ArtManifest {
  version: 1;
  palette: string;
  /** Optional project art budget, including black and white but excluding transparency. */
  maxColours?: number;
  pictures: { number: number; layers: { png: string; priority: number }[] }[];
  views: { number: number; loops: ({ cels: { png: string; anchor: [number, number] }[] } | { link: number; mirror: boolean })[] }[];
  /**
   * Fonts (tools/art/font.ts): drawn as sheets of glyphs, or a bitmap font with its own
   * metrics, a JSON file (bearings, advances, its atlas) exported from the font's source.
   */
  fonts?: ({ number: number; png: string; cell: [number, number]; first?: number; spacing?: number; space?: number; lineHeight?: number } | { number: number; metrics: string })[];
}

export class ArtError extends Error {}

export function buildArt(file: string): { resources: ResourceData[]; colours: string[]; images: number } {
  const fail = (where: string, message: string): never => { throw new ArtError(`${file}: ${where}: ${message}`); };
  const json = (path: string): unknown => {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { return fail(path, (e as Error).message); }
  };
  const object = (value: unknown, where: string, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(where, "expected an object");
    for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where}.${key}`, "unknown key");
    return value as Record<string, unknown>;
  };
  const list = (value: unknown, where: string, min: number, max: number): unknown[] => {
    if (!Array.isArray(value) || value.length < min || value.length > max) return fail(where, `expected ${min}..${max} entries`);
    return value;
  };
  const int = (value: unknown, where: string, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return fail(where, `expected an integer in ${min}..${max}`);
    return value;
  };
  const path = (value: unknown, where: string): string => {
    if (typeof value !== "string" || !value.length) return fail(where, "expected a file path");
    return resolve(dirname(file), value);
  };
  const m = object(json(file), "manifest", ["version", "palette", "maxColours", "pictures", "views", "fonts"]);
  if (m.version !== 1) fail("version", "expected 1");
  const maxColours = m.maxColours === undefined ? 254 : int(m.maxColours, "maxColours", 2, 254);
  const paletteInput = json(path(m.palette, "palette"));
  if (Array.isArray(paletteInput) && paletteInput.length > maxColours) fail("palette", `${paletteInput.length} colours exceeds the project budget of ${maxColours}`);
  const colours = list(paletteInput, "palette", 2, 254).map((c, i) => {
    if (typeof c !== "string" || !/^#[0-9a-f]{6}$/i.test(c)) return fail(`palette[${i}]`, "expected #RRGGBB");
    return c.toLowerCase();
  });
  if (colours[0] !== "#000000" || colours.at(-1) !== "#ffffff") fail("palette", "first colour must be black, last white (interface colours)");
  if (new Set(colours).size !== colours.length) fail("palette", "duplicate colours");
  // Preserve the library's black=0, white=255 and transparent=254 conventions.
  // Entries 1..252 are ours; 253 is reserved. No room quantization or alpha remaps.
  const palette = basePalette();
  const indices = new Map<string, number>();
  colours.forEach((c, i) => {
    const index = i === colours.length - 1 ? 255 : i;
    palette.rgb[index] = [1, 3, 5].map((at) => parseInt(c.slice(at, at + 2), 16)) as [number, number, number];
    indices.set(c, index);
  });
  let images = 0;
  const image = (value: unknown, where: string, opaque: boolean) => {
    const filename = path(value, where);
    let img: ReturnType<typeof decodePng>;
    try { img = decodePng(readFileSync(filename)); }
    catch (e) { return fail(where, `${filename}: ${(e as Error).message}`); }
    int(img.width, `${where}.width`, 1, 320);
    int(img.height, `${where}.height`, 1, 200);
    const pixels = new Uint8Array(img.width * img.height);
    for (let i = 0; i < pixels.length; i++) {
      const [r, g, b, a] = img.data.subarray(i * 4, i * 4 + 4);
      const at = `${where} (${i % img.width},${Math.floor(i / img.width)})`;
      if (a !== 0 && a !== 255) fail(at, `alpha ${a}; export without antialiasing or partial opacity`);
      if (a === 0) {
        if (opaque) fail(at, "background must be opaque");
        pixels[i] = 254;
      } else {
        const hex = `#${[r, g, b].map((c) => c!.toString(16).padStart(2, "0")).join("")}`;
        const index = indices.get(hex);
        if (index === undefined) fail(at, `${hex} is outside the project palette`);
        pixels[i] = index!;
      }
    }
    images++;
    return { width: img.width, height: img.height, pixels, skipColor: 254 };
  };
  const resources: ResourceData[] = [{ type: ResourceType.Palette, number: 999, data: writeHunkPalette(palette) }];
  const numbers = new Set<string>();
  const number = (value: unknown, type: string, where: string) => {
    const n = int(value, where, 0, 65535);
    if (numbers.has(`${type}:${n}`)) fail(where, `duplicate ${type} ${n}`);
    numbers.add(`${type}:${n}`);
    return n;
  };
  list(m.pictures, "pictures", 0, 65536).forEach((value, i) => {
    const where = `pictures[${i}]`;
    const pic = object(value, where, ["number", "layers"]);
    const n = number(pic.number, "picture", `${where}.number`);
    const priorities = new Set<number>();
    const cels = list(pic.layers, `${where}.layers`, 1, 255).map((value, j) => {
      const at = `${where}.layers[${j}]`;
      const layer = object(value, at, ["png", "priority"]);
      const priority = int(layer.priority, `${at}.priority`, -32768, 32767);
      if (j === 0 ? priority !== -1000 : priority < 0 || priority > 199) fail(at, "background priority is -1000; foreground priorities are 0..199");
      if (priorities.has(priority)) fail(at, "duplicate layer priority; combine these layers in the editor");
      priorities.add(priority);
      const img = image(layer.png, `${at}.png`, j === 0);
      if (img.width !== 320 || img.height !== 200) fail(at, "picture layers must be 320x200");
      return { ...img, displaceX: 0, displaceY: 0, priority, x: 0, y: 0, unknown16: 0 };
    });
    resources.push({ type: ResourceType.Pic, number: n, data: writePic({ resolution: [320, 200], cels, palette }) });
  });
  list(m.views, "views", 0, 65536).forEach((value, i) => {
    const where = `views[${i}]`;
    const view = object(value, where, ["number", "loops"]);
    const n = number(view.number, "view", `${where}.number`);
    const loops: ViewLoop[] = [];
    let total = 0;
    list(view.loops, `${where}.loops`, 1, 128).forEach((value, j) => {
      const at = `${where}.loops[${j}]`;
      const loop = object(value, at, ["cels", "link", "mirror"]);
      if ("link" in loop) {
        if ("cels" in loop) fail(at, "linked loops cannot also have cels");
        const link = int(loop.link, `${at}.link`, 0, j - 1);
        if (loops[link]!.link !== -1) fail(at, "link must refer to an earlier loop with its own cels");
        if (typeof loop.mirror !== "boolean") fail(at, "mirror must be a boolean");
        loops.push({ link, mirror: loop.mirror as boolean, cels: [] });
        return;
      }
      if ("mirror" in loop) fail(at, "mirror requires link");
      let size = "";
      const cels = list(loop.cels, `${at}.cels`, 1, 255).map((value, k) => {
        const pos = `${at}.cels[${k}]`;
        const cel = object(value, pos, ["png", "anchor"]);
        const img = image(cel.png, `${pos}.png`, false);
        const dimensions = `${img.width}x${img.height}`;
        if (size && size !== dimensions) fail(pos, "keep the same canvas size throughout a loop (disable trimming)");
        size = dimensions;
        const anchor = list(cel.anchor, `${pos}.anchor`, 2, 2);
        const x = int(anchor[0], `${pos}.anchor[0]`, 0, img.width - 1);
        const y = int(anchor[1], `${pos}.anchor[1]`, 0, img.height - 1);
        total++;
        return { ...img, displaceX: (img.width >> 1) - x, displaceY: img.height - 1 - y };
      });
      loops.push({ link: -1, mirror: false, cels });
    });
    if (total > 255) fail(where, "a view supports at most 255 stored cels");
    resources.push({ type: ResourceType.View, number: n, data: writeView({ flags: 1, loops, palette }) });
  });
  list(m.fonts ?? [], "fonts", 0, 65536).forEach((value, i) => {
    const where = `fonts[${i}]`;
    const f = object(value, where, ["number", "png", "cell", "first", "spacing", "space", "lineHeight", "metrics"]);
    const n = number(f.number, "font", `${where}.number`);
    // A bitmap font with its own metrics: a sidecar JSON naming its atlas.
    if (f.metrics !== undefined) {
      if (f.png !== undefined || f.cell !== undefined) return fail(where, "a font is a sheet (png, cell) or has metrics, not both");
      const metricsFile = path(f.metrics, `${where}.metrics`);
      let metrics: FontMetrics;
      try { metrics = JSON.parse(readFileSync(metricsFile, "utf8")) as FontMetrics; }
      catch (e) { return fail(`${where}.metrics`, `${metricsFile}: ${(e as Error).message}`); }
      const atlas = resolve(dirname(metricsFile), String(metrics.atlas));
      let img: ReturnType<typeof decodePng>;
      try { img = decodePng(readFileSync(atlas)); }
      catch (e) { return fail(`${where}.metrics`, `${atlas}: ${(e as Error).message}`); }
      try {
        resources.push({ type: ResourceType.Font, number: n, data: writeFont(fontFromMetrics(img, metrics)) });
        images++;
      } catch (e) {
        if (!(e instanceof FontSheetError)) throw e;
        fail(`${where}.metrics`, e.message);
      }
      return;
    }
    const filename = path(f.png, `${where}.png`);
    let img: ReturnType<typeof decodePng>;
    try { img = decodePng(readFileSync(filename)); }
    catch (e) { return fail(`${where}.png`, `${filename}: ${(e as Error).message}`); }
    const cell = list(f.cell, `${where}.cell`, 2, 2);
    const optional = (key: string, min: number, max: number) => (f[key] === undefined ? undefined : int(f[key], `${where}.${key}`, min, max));
    try {
      const font = fontFromSheet(img, {
        cell: [int(cell[0], `${where}.cell[0]`, 1, 128), int(cell[1], `${where}.cell[1]`, 1, 128)],
        first: optional("first", 0, 255), spacing: optional("spacing", 0, 16),
        space: optional("space", 1, 128), lineHeight: optional("lineHeight", 1, 255),
      });
      resources.push({ type: ResourceType.Font, number: n, data: writeFont(font) });
      images++;
    } catch (e) {
      if (!(e instanceof FontSheetError)) throw e;
      fail(`${where}.png`, e.message);
    }
  });
  resources.sort((a, b) => a.type - b.type || a.number - b.number);
  return { resources, colours, images };
}
