import { Colour, ResourceType, basePalette, cube, writePic, writeView, type ResourceData, type ViewFile } from "../../tools/game/kit.ts";

/**
 * hello's art, drawn here: the hill (picture 100) and the road (picture 101) at night, a
 * lantern (view 100) and the hero (view 200: four directions, four steps each).
 */
export default function resources(): ResourceData[] {
  return [
    { type: ResourceType.Pic, number: 100, data: writePic(picture(hill)) },
    { type: ResourceType.Pic, number: 101, data: writePic(picture(road)) },
    { type: ResourceType.View, number: 100, data: writeView(lantern()) },
    { type: ResourceType.View, number: 200, data: writeView(hero()) },
  ];
}

const W = 320, H = 200;

/** A small deterministic random generator, so the stars land in the same places every build. */
function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function picture(ground: (pixels: Uint8Array) => void) {
  const pixels = new Uint8Array(W * H);
  // Darkest blue at the top, lighter toward the horizon, dithered between the palette's blues.
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < H; y++) {
    const level = 0.6 + (y / 150) * 2.2;
    for (let x = 0; x < W; x++) {
      const step = Math.floor(level) + (level % 1 > (bayer[(y & 3) * 4 + (x & 3)]! + 0.5) / 16 ? 1 : 0);
      pixels[y * W + x] = cube(0, 0, Math.min(5, step) * 51);
    }
  }
  const rnd = random(221);
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * 130);
    pixels[y * W + x] = rnd() < 0.2 ? Colour.White : 245;
  }
  // The moon.
  for (let y = -9; y <= 9; y++) for (let x = -9; x <= 9; x++) if (x * x + y * y <= 81) pixels[(30 + y) * W + 260 + x] = cube(255, 255, 204);
  ground(pixels);
  return {
    resolution: [W, H] as [number, number],
    cels: [{ width: W, height: H, displaceX: 0, displaceY: 0, skipColor: Colour.Transparent, pixels, priority: 0, x: 0, y: 0, unknown16: 0 }],
    palette: basePalette(),
  };
}

function hill(pixels: Uint8Array) {
  for (let x = 0; x < W; x++) {
    const top = Math.round(150 - 18 * Math.sin((x / W) * Math.PI) + 3 * Math.sin(x / 9));
    for (let y = top; y < H; y++) pixels[y * W + x] = y === top ? cube(51, 102, 51) : cube(0, 51, 0);
  }
}

function road(pixels: Uint8Array) {
  // Flat ground, a road across it, and a signpost.
  for (let y = 150; y < H; y++) pixels.fill(y === 150 ? cube(51, 102, 51) : cube(0, 51, 0), y * W, (y + 1) * W);
  for (let y = 166; y < 186; y++) for (let x = 0; x < W; x++) pixels[y * W + x] = (x + y) % 7 ? cube(102, 102, 51) : cube(102, 102, 102);
  for (let y = 130; y < 162; y++) pixels[y * W + 249] = pixels[y * W + 250] = cube(102, 51, 0);
  for (let y = 130; y < 140; y++) for (let x = 237; x < 263; x++) pixels[y * W + x] = y === 130 || y === 139 || x === 237 || x === 262 ? cube(102, 51, 0) : cube(204, 153, 102);
}

/** A cel from rows of letters, with a colour per letter; `.` is transparent. */
function cel(rows: string[], colours: Record<string, number>) {
  const width = rows[0]!.length, height = rows.length;
  if (rows.some((r) => r.length !== width)) throw new Error("rows of different widths");
  const pixels = Uint8Array.from(rows.join(""), (c) => colours[c] ?? Colour.Transparent);
  // The origin is the bottom middle (displacements of 0): where it stands.
  return { width, height, displaceX: 0, displaceY: 0, skipColor: Colour.Transparent, pixels };
}

function lantern(): ViewFile {
  const colours = { K: cube(51, 51, 51), Y: cube(255, 204, 0), W: cube(255, 255, 153), O: cube(255, 153, 0) };
  const frame = (flame: string[]) => cel(["...KKK...", "..K...K..", "...KKK...", "..KKKKK..", ...flame, "..KKKKK..", "...KKK..."], colours);
  return {
    flags: 1,
    loops: [{
      link: -1,
      mirror: false,
      cels: [
        frame([".K.YYY.K.", ".KYYWYYK.", ".KYWWWYK.", ".KYYWYYK.", ".KYYYYYK.", ".K.YYY.K."]),
        frame([".K.YOY.K.", ".KYYWYYK.", ".KYYWWYK.", ".KYWWYYK.", ".KYYYYYK.", ".K.YYY.K."]),
      ],
    }],
    palette: undefined,
  };
}

/** The hero: loop 0 walks east, 1 west (0 mirrored), 2 south, 3 north; cel 0 stands. */
function hero(): ViewFile {
  const colours = {
    H: cube(102, 51, 0), S: cube(255, 204, 153), E: cube(0, 0, 0), C: cube(153, 51, 51),
    L: cube(51, 51, 102), B: cube(51, 51, 51),
  };
  const front = ["..HHHHH..", ".HHHHHHH.", "..SSSSS..", "..SESES..", "..SSSSS..", "...SSS...", "..CCCCC..", ".CCCCCCC.", "CCCCCCCCC", "CCCCCCCCC", "S.CCCCC.S", "..CCCCC..", "..CCCCC.."];
  const back = ["..HHHHH..", ".HHHHHHH.", ".HHHHHHH.", "..HHHHH..", "..SSSSS..", "...SSS...", "..CCCCC..", ".CCCCCCC.", "CCCCCCCCC", "CCCCCCCCC", "S.CCCCC.S", "..CCCCC..", "..CCCCC.."];
  const side = ["...HHHH..", "..HHHHHH.", "..HSSSS..", "...SSSES.", "...SSSSS.", "....SS...", "...CCCC..", "..CCCCCC.", "..CCCCCC.", "..CCCCCC.", "..CSCCCC.", "..CCCCC..", "..CCCCC.."];
  const facingLegs = [
    ["..LL.LL..", "..LL.LL..", "..LL.LL..", "..LL.LL..", "..BB.BB.."],
    ["..LL.LL..", "..LL.LL..", "..LL.LL..", "..BB.LL..", ".....BB.."],
    ["..LL.LL..", "..LL.LL..", "..LL.LL..", "..LL.LL..", "..BB.BB.."],
    ["..LL.LL..", "..LL.LL..", "..LL.LL..", "..LL.BB..", "..BB....."],
  ];
  const sideLegs = [
    ["...LL....", "...LL....", "...LL....", "...LL....", "...BBB..."],
    ["...LLL...", "..LL.LL..", ".LL...LL.", ".LL...LL.", ".BB...BBB"],
    ["...LL....", "...LL....", "...LL....", "...LL....", "...BBB..."],
    ["...LL....", "..LLL....", "..L.LL...", ".LL..LL..", ".BB..BBB."],
  ];
  const walk = (body: string[], legs: string[][]) => legs.map((l) => cel([...body, ...l], colours));
  return {
    flags: 1,
    loops: [
      { link: -1, mirror: false, cels: walk(side, sideLegs) },
      { link: 0, mirror: true, cels: [] },
      { link: -1, mirror: false, cels: walk(front, facingLegs) },
      { link: -1, mirror: false, cels: walk(back, facingLegs) },
    ],
    palette: undefined,
  };
}
