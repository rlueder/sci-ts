import { describe, expect, it } from "vitest";
import { parseFont, parseStyled, placeLine, plainOf, renderText, styledWidth, textWidth, wrapStyled, writeFont, type Font, type Glyph } from "../src/index.ts";

/** A glyph w wide and 1 high, all ink, with its own bearing and advance if given. */
const glyph = (w: number, bearingX?: number, advance?: number): Glyph => ({
  width: w, height: 1, pixels: new Uint8Array(w).fill(1), ...(bearingX === undefined ? {} : { bearingX }), ...(advance === undefined ? {} : { advance }),
});
const font = (height: number, g: Record<string, Glyph>): Font => {
  const glyphs: Glyph[] = [];
  for (const [ch, x] of Object.entries(g)) glyphs[ch.charCodeAt(0)] = x;
  return { height, glyphs };
};

describe("fonts", () => {
  it("keep bearings and advances when written and read, and old fonts have none", () => {
    const f = font(9, { j: glyph(4, -2, 3), f: glyph(4, 0, 3), " ": glyph(1, 0, 3), a: glyph(5) });
    const back = parseFont(writeFont(f));
    expect([back.glyphs[106]!.bearingX, back.glyphs[106]!.advance, back.glyphs[102]!.advance, back.glyphs[97]!.advance]).toEqual([-2, 3, 3, undefined]);
    const plain = font(9, { a: glyph(5), b: glyph(2) });
    const bytes = writeFont(plain);
    expect(String.fromCharCode(...bytes.slice(-4))).not.toBe("XMT1"); // nothing added when nothing needs it
    expect(parseFont(bytes).glyphs[97]).toEqual({ width: 5, height: 1, pixels: new Uint8Array(5).fill(1) });
    expect(textWidth(f, "jaf")).toBe(3 + 5 + 3);
  });

  it("render ink left of the pen and past it without moving the pen", () => {
    const f = font(1, { j: glyph(4, -2, 3), f: glyph(4, 0, 3) });
    const bmp = renderText(f, ["jf"]);
    // j's ink from -2, f's at 3 (its advance), reaching 7: 9 wide, the pen starting at 2.
    expect([bmp.width, bmp.originX]).toEqual([9, 2]);
    expect([...bmp.pixels]).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1]);
  });
});

describe("styled text", () => {
  const regular = font(14, { a: glyph(5), b: glyph(6), " ": glyph(0, 0, 3), j: glyph(4, -2, 3) });
  const bold = font(14, { a: glyph(6), b: glyph(7), " ": glyph(0, 0, 4) });
  const fontOf = (n: number) => (n === 3 ? bold : regular);

  it("switches font and colour with SCI's codes, which take no room", () => {
    const chars = parseStyled("a|f3|b|f|a |c7|b|c|", 1);
    expect(chars.map((c) => [c.ch, c.font, c.color])).toEqual([["a", 1, undefined], ["b", 3, undefined], ["a", 1, undefined], [" ", 1, undefined], ["b", 1, 7]]);
    expect(plainOf("a|f3|b|f|a |c7|b|c|")).toBe("aba b");
    expect(styledWidth(fontOf, chars)).toBe(5 + 7 + 5 + 3 + 6);
    expect(parseStyled("a|x|b", 1).map((c) => c.ch).join("")).toBe("a|x|b"); // not a code
  });

  it("wraps words measured in their own fonts, and a style change doesn't split a word", () => {
    // "ab|f3|ab|f| ab": the first word is aba-b with bold in the middle (5+6+6+7 = 24).
    const lines = wrapStyled(fontOf, parseStyled("ab|f3|ab|f| ab", 1), 1, 30);
    expect(lines.map((l) => l.chars.map((c) => c.ch).join(""))).toEqual(["abab", "ab"]);
    expect(lines[0]!.width).toBe(24);
    expect(wrapStyled(fontOf, parseStyled("ab ab", 1), 1, 30).map((l) => l.chars.length)).toEqual([5]);
  });

  it("places each glyph at the pen plus its bearing", () => {
    const [line] = wrapStyled(fontOf, parseStyled("ja", 1), 1, 100);
    expect(placeLine(fontOf, line!, 10).map((p) => p.x)).toEqual([8, 13]);
  });
});
