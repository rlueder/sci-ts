import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildArt, type ArtManifest } from "../../../tools/art/build.ts";
import { buildGame } from "../../../tools/game/build.ts";
import { rgbaPng } from "../../../tools/png.ts";
import { parseFont, parsePicFile, parseViewFile, ResourceType, writePic, writeView } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sci-art-"));
  dirs.push(dir);
  const art = join(dir, "art");
  mkdirSync(art);
  const png = (name: string, width: number, height: number, pixel: number[]) => {
    const data = Uint8Array.from({ length: width * height * 4 }, (_, i) => pixel[i % 4]!);
    writeFileSync(join(art, name), rgbaPng({ width, height, data }));
  };
  png("room.png", 320, 200, [214, 168, 117, 255]);
  png("foreground.png", 320, 200, [123, 12, 34, 0]); // invisible RGB is irrelevant
  png("actor.png", 2, 2, [255, 255, 255, 255]);
  const manifest: ArtManifest = {
    version: 1, palette: "palette.json",
    pictures: [{ number: 301, layers: [{ png: "room.png", priority: -1000 }, { png: "foreground.png", priority: 150 }] }],
    views: [{ number: 310, loops: [{ cels: [{ png: "actor.png", anchor: [0, 0] }] }, { link: 0, mirror: true }] }],
  };
  writeFileSync(join(art, "palette.json"), JSON.stringify(["#000000", "#d6a875", "#ffffff"]));
  const file = join(art, "art.json");
  const save = () => writeFileSync(file, JSON.stringify(manifest));
  save();
  return { dir, art, file, manifest, save, png };
}

describe("standalone pixel art", () => {
  it("enforces a shared palette budget even when excess entries are unused", () => {
    const f = fixture();
    f.manifest.maxColours = 3;
    f.save();
    expect(buildArt(f.file).colours).toHaveLength(3);
    writeFileSync(join(f.art, "palette.json"), JSON.stringify(["#000000", "#d6a875", "#123456", "#ffffff"]));
    expect(() => buildArt(f.file)).toThrow(/4 colours exceeds the project budget of 3/);
    f.manifest.maxColours = 2.5;
    f.save();
    expect(() => buildArt(f.file)).toThrow(/maxColours: expected an integer/);
  });

  it("preserves colours, transparency, priorities, anchors and mirror links through SCI round trips", () => {
    const { file } = fixture();
    const built = buildArt(file);
    expect(buildArt(file).resources).toEqual(built.resources);
    const picData = built.resources.find((r) => r.type === ResourceType.Pic)!.data;
    const viewData = built.resources.find((r) => r.type === ResourceType.View)!.data;
    const pic = parsePicFile(picData), view = parseViewFile(viewData);
    expect(pic.cels[0]!.pixels.every((p) => p === 1)).toBe(true);
    expect(pic.cels[1]!.pixels.every((p) => p === 254)).toBe(true);
    expect(pic.cels.map((c) => c.priority)).toEqual([-1000, 150]);
    expect(view.loops[0]!.cels[0]).toMatchObject({ displaceX: 1, displaceY: 1, skipColor: 254 });
    expect([...view.loops[0]!.cels[0]!.pixels]).toEqual([255, 255, 255, 255]);
    expect(view.loops[1]).toMatchObject({ link: 0, mirror: true });
    expect(pic.palette.rgb[1]).toEqual([214, 168, 117]);
    expect(view.palette).toEqual(pic.palette);
    expect(writePic(pic)).toEqual(picData);
    expect(writeView(view)).toEqual(viewData);
  });

  it.each([
    ["partial alpha", [214, 168, 117, 128], /alpha 128/],
    ["unapproved colour", [1, 2, 3, 255], /#010203 is outside/],
    ["transparent background", [0, 0, 0, 0], /background must be opaque/],
  ] as const)("rejects %s with pixel coordinates", (_, pixel, error) => {
    const f = fixture();
    f.png("room.png", 320, 200, [...pixel]);
    expect(() => buildArt(f.file)).toThrow(error);
    expect(() => buildArt(f.file)).toThrow(/\(0,0\)/);
  });

  it("catches export dimensions, duplicate IDs and invalid loop links", () => {
    const f = fixture();
    f.png("room.png", 320, 190, [0, 0, 0, 255]);
    expect(() => buildArt(f.file)).toThrow(/320x200/);
    f.png("room.png", 320, 200, [0, 0, 0, 255]);
    f.manifest.pictures.push(f.manifest.pictures[0]!);
    f.save();
    expect(() => buildArt(f.file)).toThrow(/duplicate picture/);
    f.manifest.pictures.pop();
    f.manifest.views[0]!.loops[1] = { link: 1, mirror: true };
    f.save();
    expect(() => buildArt(f.file)).toThrow(/loops\[1\].link/);
  });

  it("rejects invalid anchors, trimmed animation canvases and misspelled keys", () => {
    const f = fixture();
    const loop = f.manifest.views[0]!.loops[0] as { cels: { png: string; anchor: [number, number] }[] };
    loop.cels[0]!.anchor = [2, 0];
    f.save();
    expect(() => buildArt(f.file)).toThrow(/anchor\[0\]/);
    loop.cels[0]!.anchor = [0, 0];
    f.png("trimmed.png", 1, 1, [0, 0, 0, 255]);
    loop.cels.push({ png: "trimmed.png", anchor: [0, 0] });
    f.save();
    expect(() => buildArt(f.file)).toThrow(/disable trimming/);
    writeFileSync(f.file, JSON.stringify({ ...f.manifest, dithering: true }));
    expect(() => buildArt(f.file)).toThrow(/dithering: unknown key/);
  });

  it("loads editor exports during game builds and rejects conflicting generated resources", async () => {
    const f = fixture();
    mkdirSync(join(f.dir, "scripts"));
    writeFileSync(join(f.dir, "scripts/0.sc"), '(script 0)\n(include "system.sh")\n(public artGame 0)\n(instance artGame of Game)\n');
    const importer = new URL("../../../tools/art/build.ts", import.meta.url).href;
    writeFileSync(join(f.dir, "resources.ts"), `import { buildArt } from ${JSON.stringify(importer)};
export default () => [...buildArt(${JSON.stringify(f.file)}).resources, { type: ${ResourceType.Pic}, number: 100, data: new Uint8Array([0]) }];`);
    const game = await buildGame(f.dir);
    for (const r of buildArt(f.file).resources) expect(game.resources.find((g) => g.type === r.type && g.number === r.number)).toEqual(r);
    f.manifest.pictures[0]!.number = 100; // resources.ts already makes this
    f.save();
    await expect(buildGame(f.dir)).rejects.toThrow(/made twice/);
  });

  it("turns a sheet of glyphs into a font: widths from the ink, the space from the manifest", () => {
    const f = fixture();
    // Three 4x5 cells: the space, "!" (ink in column 1) and '"' (columns 0 and 2).
    const width = 12, height = 5, data = new Uint8Array(width * height * 4);
    const ink = (x: number, y: number) => data.set([20, 30, 40, 255], (y * width + x) * 4);
    for (const y of [0, 1, 2, 4]) ink(4 + 1, y);
    for (const y of [0, 1]) (ink(8, y), ink(10, y));
    writeFileSync(join(f.art, "font.png"), rgbaPng({ width, height, data }));
    f.manifest.fonts = [{ number: 1, png: "font.png", cell: [4, 5], space: 3, lineHeight: 7 }];
    f.save();
    const data1 = buildArt(f.file).resources.find((r) => r.type === ResourceType.Font && r.number === 1)!.data;
    const font = parseFont(data1);
    expect(font.height).toBe(7);
    expect(font.glyphs.map((g) => g?.width ?? 0).slice(32, 35)).toEqual([3, 3, 4]);
    expect([...font.glyphs[33]!.pixels]).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
    expect(font.glyphs[65]!.width).toBe(0); // not on the sheet

    f.manifest.fonts[0]!.cell = [5, 5];
    f.save();
    expect(() => buildArt(f.file)).toThrow(/fonts\[0\]\.png: 12x5 is not a whole number of 5x5 cells/);
  });
});
