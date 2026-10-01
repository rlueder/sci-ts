import { Colour, ResourceType, basePalette, cube, writePic, writeView, type ResourceData } from "../../tools/game/kit.ts";

/** hello's art, drawn here: a night sky over a hill (picture 100) and a lantern (view 100). */
export default function resources(): ResourceData[] {
  return [
    { type: ResourceType.Pic, number: 100, data: writePic(sky()) },
    { type: ResourceType.View, number: 100, data: writeView(lantern()) },
  ];
}

const W = 320, H = 200;

/** A small deterministic random generator, so the stars land in the same places every build. */
function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function sky() {
  const pixels = new Uint8Array(W * H);
  const rnd = random(221);
  // Darkest blue at the top, lighter toward the horizon, dithered between the palette's blues.
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < H; y++) {
    const level = 0.6 + (y / 150) * 2.2;
    for (let x = 0; x < W; x++) {
      const step = Math.floor(level) + (level % 1 > (bayer[(y & 3) * 4 + (x & 3)]! + 0.5) / 16 ? 1 : 0);
      pixels[y * W + x] = cube(0, 0, Math.min(5, step) * 51);
    }
  }
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * 130);
    pixels[y * W + x] = rnd() < 0.2 ? Colour.White : 245;
  }
  // The moon.
  for (let y = -9; y <= 9; y++) for (let x = -9; x <= 9; x++) if (x * x + y * y <= 81) pixels[(30 + y) * W + 260 + x] = cube(255, 255, 204);
  // A hill.
  for (let x = 0; x < W; x++) {
    const top = Math.round(150 - 18 * Math.sin((x / W) * Math.PI) + 3 * Math.sin(x / 9));
    for (let y = top; y < H; y++) pixels[y * W + x] = y === top ? cube(51, 102, 51) : cube(0, 51, 0);
  }
  return {
    resolution: [W, H] as [number, number],
    cels: [{ width: W, height: H, displaceX: 0, displaceY: 0, skipColor: Colour.Transparent, pixels, priority: 0, x: 0, y: 0, unknown16: 0 }],
    palette: basePalette(),
  };
}

function lantern() {
  const art = [
    "...KKK...",
    "..K...K..",
    "...KKK...",
    "..KKKKK..",
    ".K.YYY.K.",
    ".KYYWYYK.",
    ".KYWWWYK.",
    ".KYYWYYK.",
    ".KYYYYYK.",
    ".K.YYY.K.",
    "..KKKKK..",
    "...KKK...",
  ];
  const colours: Record<string, number> = { K: cube(51, 51, 51), Y: cube(255, 204, 0), W: cube(255, 255, 153) };
  const width = art[0]!.length, height = art.length;
  const pixels = Uint8Array.from(art.join(""), (c) => colours[c] ?? Colour.Transparent);
  // The origin is the bottom middle (displacements of 0), where the lantern stands.
  const cel = { width, height, displaceX: 0, displaceY: 0, skipColor: Colour.Transparent, pixels };
  return { flags: 1, loops: [{ link: -1, mirror: false, cels: [cel] }], palette: undefined };
}
