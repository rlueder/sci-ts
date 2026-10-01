import {
  Colour, ResourceType, SoundDevice, basePalette, cube, writePic, writeSound, writeView,
  type MidiEvent, type ResourceData, type SoundSpec, type ViewFile,
} from "../../tools/game/kit.ts";

/**
 * hello's art, drawn here: the hill (picture 100) and the road (picture 101) at night, a
 * lantern (view 100), the hero (view 200: four directions, four steps each), and the
 * traveller (view 300) with a portrait (view 301: bust, mouth, eyes); and the music for the
 * night (sound 100). The lantern's chime is a WAV file, sounds/50.wav.
 */
export default function resources(): ResourceData[] {
  return [
    { type: ResourceType.Pic, number: 100, data: writePic(picture(hill)) },
    { type: ResourceType.Pic, number: 101, data: writePic(picture(road)) },
    { type: ResourceType.View, number: 100, data: writeView(lantern()) },
    { type: ResourceType.View, number: 200, data: writeView(hero()) },
    { type: ResourceType.View, number: 300, data: writeView(traveller()) },
    { type: ResourceType.View, number: 301, data: writeView(portrait()) },
    { type: ResourceType.Sound, number: 100, data: writeSound(nightTune()) },
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

/** The traveller, sitting on his pack by the road. */
function traveller(): ViewFile {
  const colours = {
    H: cube(153, 153, 153), S: cube(255, 204, 153), E: cube(0, 0, 0), C: cube(51, 102, 51),
    P: cube(153, 102, 51), L: cube(102, 102, 51), B: cube(51, 51, 51),
  };
  const rows = [
    "...HHHH....", "..HHHHHH...", "...SSSS....", "...SESE....", "...SSSS....", "....SS.....",
    "..CCCCCPPP.", ".CCCCCCPPPP", ".CCCCCCPPPP", ".SCCCCSPPPP", "..LLLLLPPP.", ".LL...LL...", ".BB...BB...",
  ];
  return { flags: 1, loops: [{ link: -1, mirror: false, cels: [cel(rows, colours)] }], palette: undefined };
}

/**
 * The traveller's portrait: loop 0 the bust in a frame, loop 1 the mouth (closed, open),
 * loop 2 the eyes (open, shut). Every cel is the same size and anchored at its top-left
 * corner, so the mouth and eyes land on the face.
 */
function portrait(): ViewFile {
  const w = 34, h = 40;
  const colours = {
    F: cube(102, 51, 0), K: cube(0, 0, 51), H: cube(153, 153, 153), S: cube(255, 204, 153),
    C: cube(51, 102, 51), E: cube(0, 0, 0), W: Colour.White, M: cube(153, 51, 51), D: cube(204, 153, 102),
  };
  const blank = () => Array.from({ length: h }, () => Array.from({ length: w }, () => "."));
  const done = (g: string[][]) => ({ ...cel(g.map((r) => r.join("")), colours), displaceX: w >> 1, displaceY: h - 1 });
  // The bust: a framed dark panel, shoulders, a face, grey hair.
  const bust = blank();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bust[y]![x] = x < 2 || y < 2 || x >= w - 2 || y >= h - 2 ? "F" : "K";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = (x - 17) / 9, fy = (y - 17) / 11;
      if (y >= 31 && y < h - 2 && Math.abs(x - 17) < 14 - (y - 31) * -0.3 && x > 1 && x < w - 2) bust[y]![x] = "C";
      else if (fx * fx + fy * fy <= 1) bust[y]![x] = y < 10 ? "H" : "S";
      else if (y >= 6 && y < 14 && Math.abs(x - 17) <= 10 && (x - 17) ** 2 / 100 + (y - 12) ** 2 / 49 <= 1) bust[y]![x] = "H";
    }
  }
  const mouth = (open: boolean) => {
    const g = blank();
    for (let x = 14; x <= 20; x++) g[23]![x] = "M";
    if (open) for (let x = 15; x <= 19; x++) g[24]![x] = "E";
    if (open) for (let x = 15; x <= 19; x++) g[25]![x] = "M";
    return done(g);
  };
  const eyes = (open: boolean) => {
    const g = blank();
    for (const cx of [13, 21]) {
      if (open) {
        g[16]![cx - 1] = "W";
        g[16]![cx] = "E";
        g[16]![cx + 1] = "W";
      } else for (let x = cx - 1; x <= cx + 1; x++) g[16]![x] = "D";
    }
    return done(g);
  };
  return {
    flags: 1,
    loops: [
      { link: -1, mirror: false, cels: [done(bust)] },
      { link: -1, mirror: false, cels: [mouth(false), mouth(true)] },
      { link: -1, mirror: false, cels: [eyes(true), eyes(false)] },
    ],
    palette: undefined,
  };
}

/**
 * A slow tune for the night: a music box over a soft pad, eight bars, looped by the game.
 * Lengths are in eighth notes; ticks are 1/60 s.
 */
function nightTune(): SoundSpec {
  const EIGHTH = 20;
  const melody: [note: number, eighths: number][] = [
    [69, 2], [72, 1], [76, 1], [74, 2], [72, 2],
    [69, 6], [67, 2],
    [64, 2], [67, 1], [69, 1], [72, 2], [74, 2],
    [76, 4], [74, 2], [72, 2],
    [69, 2], [72, 1], [76, 1], [79, 2], [76, 2],
    [74, 6], [72, 2],
    [69, 2], [67, 2], [64, 2], [67, 2],
    [69, 8],
  ];
  // A chord a bar: Am F C G Am F Em Am.
  const chords = [[45, 52, 57], [41, 48, 53], [48, 55, 60], [43, 50, 55], [45, 52, 57], [41, 48, 53], [40, 47, 52], [45, 52, 57]];
  const tune: MidiEvent[] = [{ tick: 0, bytes: [0xc0, 10] }]; // music box
  let t = 0;
  for (const [note, eighths] of melody) {
    tune.push({ tick: t, bytes: [0x90, note, 72] }, { tick: t + eighths * EIGHTH - 2, bytes: [0x80, note, 0] });
    t += eighths * EIGHTH;
  }
  const pad: MidiEvent[] = [{ tick: 0, bytes: [0xc1, 89] }]; // warm pad
  chords.forEach((chord, bar) => {
    const at = bar * 8 * EIGHTH;
    for (const n of chord) pad.push({ tick: at, bytes: [0x91, n, 40] }, { tick: at + 8 * EIGHTH - 1, bytes: [0x81, n, 0] });
  });
  return {
    tracks: [{
      device: SoundDevice.GeneralMidi,
      channels: [{ midiChannel: 0, voices: 1, events: tune }, { midiChannel: 1, voices: 3, events: pad }],
    }],
  };
}
