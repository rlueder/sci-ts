import { Colour, ResourceType, writeView, type ResourceData } from "../tools/game/kit.ts";

/**
 * The class library's own resources: a cursor for each verb, view CURSOR_BASE + verb, and
 * one while the player waits, CURSOR_WAIT (system.sh). X is black, W white, . transparent.
 */
const CURSOR_BASE = 990;
const CURSOR_WAIT = 995;

const CURSORS: Record<number, { art: string[]; hotspot: "tip" | "centre" }> = {
  // V_LOOK: an eye.
  1: {
    hotspot: "centre",
    art: [
      "....XXXXX....",
      "..XXWWWWWXX..",
      ".XWWWXXXWWWX.",
      "XWWWXXWXXWWWX",
      "XWWWXXXXXWWWX",
      ".XWWWXXXWWWX.",
      "..XXWWWWWXX..",
      "....XXXXX....",
    ],
  },
  // V_TALK: a speech balloon.
  2: {
    hotspot: "centre",
    art: [
      ".XXXXXXXXXX.",
      "XWWWWWWWWWWX",
      "XWXXWXXWXXWX",
      "XWWWWWWWWWWX",
      "XWXXXXWXXXWX",
      "XWWWWWWWWWWX",
      ".XXXWWXXXXX.",
      "...XWX......",
      "...XX.......",
    ],
  },
  // V_WALK: an arrow, pointing with its tip.
  3: {
    hotspot: "tip",
    art: [
      "X.......",
      "XX......",
      "XWX.....",
      "XWWX....",
      "XWWWX...",
      "XWWWWX..",
      "XWWWWWX.",
      "XWWWWWWX",
      "XWWWXXXX",
      "XWXWWX..",
      "XX.XWWX.",
      "X...XWX.",
      ".....XX.",
    ],
  },
  // V_DO: a hand.
  4: {
    hotspot: "centre",
    art: [
      "...XX......",
      "..XWWX.....",
      "..XWWX.....",
      "..XWWXXX...",
      "..XWWXWWXX.",
      ".XXWWXWWXWX",
      "XWXWWWWWXWX",
      "XWWWWWWWWWX",
      ".XWWWWWWWWX",
      "..XWWWWWWX.",
      "...XXXXXX..",
    ],
  },
  // Waiting: an hourglass.
  [CURSOR_WAIT - CURSOR_BASE]: {
    hotspot: "centre",
    art: [
      "XXXXXXXXX",
      "XWWWWWWWX",
      ".XWWWWWX.",
      "..XWWWX..",
      "...XWX...",
      "...XWX...",
      "..XWWWX..",
      ".XWWWWWX.",
      "XWWWWWWWX",
      "XXXXXXXXX",
    ],
  },
};

function cursor(art: string[], hotspot: "tip" | "centre") {
  const width = art[0]!.length, height = art.length;
  const pixels = Uint8Array.from(art.join(""), (c) => (c === "X" ? Colour.Black : c === "W" ? Colour.White : Colour.Transparent));
  // The cel's origin is the hotspot: (width/2 - displaceX, height - 1 - displaceY).
  const [hx, hy] = hotspot === "tip" ? [0, 0] : [width >> 1, height >> 1];
  const cel = { width, height, displaceX: (width >> 1) - hx, displaceY: height - 1 - hy, skipColor: Colour.Transparent, pixels };
  return writeView({ flags: 1, loops: [{ link: -1, mirror: false, cels: [cel] }], palette: undefined });
}

/**
 * What a close-up dims the room with (CLOSE_UP_SHADE): the whole screen in colour 253, which
 * CloseUp makes a remap colour that darkens what's under it.
 */
const CLOSE_UP_SHADE = 996;
function shade() {
  const [width, height] = [320, 200];
  const cel = { width, height, displaceX: width >> 1, displaceY: height - 1, skipColor: Colour.Transparent, pixels: new Uint8Array(width * height).fill(253) };
  return writeView({ flags: 1, loops: [{ link: -1, mirror: false, cels: [cel] }], palette: undefined });
}

/**
 * The icon bar's icons (ICON_BAR_VIEW): walk, look, do, talk, the inventory and the game
 * menu, each 24 pixels square and anchored at the top-left corner; loop 0 as they are,
 * loop 1 picked (inverted). The verbs reuse their cursors' drawings.
 */
const ICON_BAR_VIEW = 990;
const ICON = 24;
const BAG = [
  "...XXXXX...",
  "..X.....X..",
  "..X.....X..",
  "XXXXXXXXXXX",
  "XWWWWWWWWWX",
  "XWWWWWWWWWX",
  "XWWWXXXWWWX",
  "XWWWWWWWWWX",
  "XWWWWWWWWWX",
  "XXXXXXXXXXX",
];
const MENU = ["XXXXXXXXXXX", "", "", "XXXXXXXXXXX", "", "", "XXXXXXXXXXX"].map((r) => r || "...........");
function iconBar() {
  const drawings = [CURSORS[3]!.art, CURSORS[1]!.art, CURSORS[4]!.art, CURSORS[2]!.art, BAG, MENU];
  const icon = (art: string[], picked: boolean) => {
    const [ink, paper] = picked ? [Colour.White, Colour.Black] : [Colour.Black, Colour.White];
    const pixels = new Uint8Array(ICON * ICON);
    for (let y = 0; y < ICON; y++) for (let x = 0; x < ICON; x++) pixels[y * ICON + x] = x === 0 || y === 0 || x === ICON - 1 || y === ICON - 1 ? Colour.Black : paper;
    const top = (ICON - art.length) >> 1, left = (ICON - art[0]!.length) >> 1;
    art.forEach((row, y) => [...row].forEach((c, x) => {
      if (c === "X") pixels[(top + y) * ICON + left + x] = ink;
      else if (c === "W") pixels[(top + y) * ICON + left + x] = paper;
    }));
    return { width: ICON, height: ICON, displaceX: ICON >> 1, displaceY: ICON - 1, skipColor: Colour.Transparent, pixels };
  };
  const loop = (picked: boolean) => ({ link: -1, mirror: false, cels: drawings.map((art) => icon(art, picked)) });
  return writeView({ flags: 1, loops: [loop(false), loop(true)], palette: undefined });
}

export default function resources(): ResourceData[] {
  return [
    ...Object.entries(CURSORS).map(([verb, c]) => ({ type: ResourceType.View, number: CURSOR_BASE + Number(verb), data: cursor(c.art, c.hotspot) })),
    { type: ResourceType.View, number: CLOSE_UP_SHADE, data: shade() },
    { type: ResourceType.View, number: ICON_BAR_VIEW, data: iconBar() },
  ];
}
