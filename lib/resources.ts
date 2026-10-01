import { Colour, ResourceType, writeView, type ResourceData } from "../tools/game/kit.ts";

/**
 * The class library's own resources: a cursor for each verb, view CURSOR_BASE + verb
 * (system.sh). X is black, W white, . transparent.
 */
const CURSOR_BASE = 990;

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
};

function cursor(art: string[], hotspot: "tip" | "centre") {
  const width = art[0]!.length, height = art.length;
  const pixels = Uint8Array.from(art.join(""), (c) => (c === "X" ? Colour.Black : c === "W" ? Colour.White : Colour.Transparent));
  // The cel's origin is the hotspot: (width/2 - displaceX, height - 1 - displaceY).
  const [hx, hy] = hotspot === "tip" ? [0, 0] : [width >> 1, height >> 1];
  const cel = { width, height, displaceX: (width >> 1) - hx, displaceY: height - 1 - hy, skipColor: Colour.Transparent, pixels };
  return writeView({ flags: 1, loops: [{ link: -1, mirror: false, cels: [cel] }], palette: undefined });
}

export default function resources(): ResourceData[] {
  return Object.entries(CURSORS).map(([verb, c]) => ({ type: ResourceType.View, number: CURSOR_BASE + Number(verb), data: cursor(c.art, c.hotspot) }));
}
