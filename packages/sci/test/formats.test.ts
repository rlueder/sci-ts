import { describe, expect, it } from "vitest";
import {
  ResourceType, encodeCelRle, findMessage, hasRef, hunkToPalette, messagesFromText, messagesToText, parseFont,
  parseMessages, parsePicFile, parseResourceMap, parseViewFile, textWidth, wrapText, writeMessages, writePic, writeView,
  type HunkPaletteFile, type MessageFile, type PicFile, type ViewFile,
} from "../src/index.ts";

// File formats, written and read back with made-up data: no game needed.

const tuple = (noun: number, verb: number, cond = 0, seq = 1) => ({ noun, verb, cond, seq });
const none = tuple(0, 0, 0, 0);

const messages: MessageFile = {
  version: 4321,
  records: [
    { ...tuple(1, 1), talker: 99, text: "A brass clock, stopped at a quarter past three.", ref: none },
    { ...tuple(1, 1, 0, 2), talker: 99, text: 'Someone wrote "17" on the dial.\nIn pencil.', ref: none },
    { ...tuple(2, 1), talker: 99, text: "", ref: tuple(1, 1) },
    // Noun 0 is the room itself: a reference to it is still a reference.
    { ...tuple(3, 4), talker: 99, text: "", ref: tuple(0, 1) },
    { ...tuple(0, 1), talker: 99, text: "The workshop smells of oil and \xe9tain.", ref: none },
  ],
};

describe("message files", () => {
  it("write and read back", () => {
    const back = parseMessages(writeMessages(messages));
    expect(back.version).toBe(4321);
    expect(back.records).toEqual(messages.records);
  });

  it("are byte-stable", () => {
    const bytes = writeMessages(messages);
    expect(writeMessages(parseMessages(bytes))).toEqual(bytes);
  });

  it("survive the text form", () => {
    const { number, file } = messagesFromText(messagesToText(42, messages));
    expect(number).toBe(42);
    expect(file.records).toEqual(messages.records);
  });

  it("follow references, including to noun 0", () => {
    expect(findMessage(messages, tuple(2, 1))?.text).toMatch(/^A brass clock/);
    expect(findMessage(messages, tuple(3, 4))?.text).toMatch(/^The workshop/);
    expect(hasRef(messages.records[3]!)).toBe(true);
    expect(hasRef(messages.records[0]!)).toBe(false);
  });

  it("reject what doesn't fit", () => {
    expect(() => messagesFromText('messages 1 version 4321\n1 1 0 300 99 "x"')).toThrow(/doesn't fit in a byte/);
    expect(() => messagesFromText('1 1 0 1 99 "x"')).toThrow(/missing `messages N version V`/);
  });
});

const palette = (first: number, colours: [number, number, number][], shared = false): HunkPaletteFile => ({
  header: Uint8Array.from([14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]),
  entryPrefix: new Uint8Array(10),
  first,
  used: colours.map(() => 1),
  rgb: colours,
  shared,
  defaultUsed: 1,
});

/** A w×h cel with a pattern RLE has to work for: runs, single pixels and transparency. */
function cel(width: number, height: number, seed: number) {
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const x = i % width, y = Math.floor(i / width);
    pixels[i] = x < 3 ? 255 : (x + y) % 5 === 0 ? 10 + ((i * seed) % 7) : 20 + y;
  }
  return { width, height, displaceX: -2, displaceY: 3, skipColor: 255, pixels };
}

describe("views", () => {
  const view: ViewFile = {
    flags: 1,
    loops: [
      { link: -1, mirror: false, cels: [cel(12, 9, 3), cel(7, 4, 5)] },
      { link: 0, mirror: true, cels: [] },
      { link: -1, mirror: false, cels: [cel(1, 1, 1)] },
    ],
    palette: palette(10, [[255, 0, 0], [0, 255, 0], [0, 0, 255]]),
  };

  it("write and read back", () => {
    const back = parseViewFile(writeView(view));
    expect(back.loops).toHaveLength(3);
    expect(back.loops[1]).toMatchObject({ link: 0, mirror: true });
    view.loops.forEach((loop, l) => loop.cels.forEach((c, i) => {
      const got = back.loops[l]!.cels[i]!;
      expect([got.width, got.height, got.displaceX, got.displaceY, got.skipColor]).toEqual([c.width, c.height, c.displaceX, c.displaceY, c.skipColor]);
      expect(got.pixels).toEqual(c.pixels);
    }));
    expect(back.palette?.rgb).toEqual(view.palette!.rgb);
  });

  it("are byte-stable once written", () => {
    const bytes = writeView(view);
    expect(writeView(parseViewFile(bytes))).toEqual(bytes);
  });

  it("compress runs", () => {
    const flat = { width: 64, height: 4, displaceX: 0, displaceY: 0, skipColor: 255, pixels: new Uint8Array(256).fill(7) };
    const rle = encodeCelRle(flat);
    expect(rle.control.length + rle.literal.length).toBeLessThan(flat.pixels.length / 4);
  });

  it("work without a palette", () => {
    const back = parseViewFile(writeView({ flags: 1, loops: [{ link: -1, mirror: false, cels: [cel(4, 4, 2)] }], palette: undefined }));
    expect(back.palette).toBeUndefined();
    expect(back.loops[0]!.cels[0]!.pixels).toEqual(cel(4, 4, 2).pixels);
  });
});

describe("pictures", () => {
  const pic: PicFile = {
    resolution: [320, 200],
    cels: [
      { ...cel(16, 8, 2), priority: 0, x: 0, y: 0, unknown16: 0 },
      { ...cel(5, 5, 4), priority: 120, x: 40, y: 60, unknown16: 6 },
    ],
    palette: palette(64, [[10, 20, 30], [40, 50, 60]]),
  };

  it("write and read back", () => {
    const back = parsePicFile(writePic(pic));
    expect(back.resolution).toEqual([320, 200]);
    expect(back.cels).toEqual(pic.cels);
  });

  it("are byte-stable", () => {
    const bytes = writePic(pic);
    expect(writePic(parsePicFile(bytes))).toEqual(bytes);
  });

  it("put their colours where the palette starts", () => {
    const p = hunkToPalette(pic.palette);
    expect([...p.rgb.slice(64 * 3, 66 * 3)]).toEqual([10, 20, 30, 40, 50, 60]);
    expect([p.used[63], p.used[64], p.used[65], p.used[66]]).toEqual([0, 1, 1, 0]);
  });

  it("refuse a cel whose pixels don't match its size", () => {
    expect(() => writePic({ ...pic, cels: [{ ...pic.cels[0]!, width: 99 }] })).toThrow(/pixels for 99x8/);
  });
});

/** A font where every character is `width(c)` pixels wide and 8 tall, ink on the first row. */
function makeFont(width: (code: number) => number): Uint8Array {
  const count = 128, glyphs: number[][] = [];
  for (let c = 0; c < count; c++) {
    const w = width(c), stride = Math.ceil(w / 8);
    const rows = Array.from({ length: 8 * stride }, (_, i) => (i < stride ? 0xff : 0));
    glyphs.push([w, 8, ...rows]);
  }
  const out: number[] = [0, 0, count, 0, 8, 0];
  let at = 6 + count * 2;
  for (const g of glyphs) (out.push(at & 0xff, at >> 8), (at += g.length));
  return Uint8Array.from([...out, ...glyphs.flat()]);
}

describe("fonts", () => {
  const font = parseFont(makeFont((c) => (c === 32 ? 3 : c === 105 ? 2 : 6)));

  it("read glyphs and the line height", () => {
    expect(font.height).toBe(8);
    expect(font.glyphs[65]).toMatchObject({ width: 6, height: 8 });
    expect([...font.glyphs[65]!.pixels.slice(0, 7)]).toEqual([1, 1, 1, 1, 1, 1, 0]);
  });

  it("measure text", () => {
    expect(textWidth(font, "ii i")).toBe(2 + 2 + 3 + 2);
  });

  it("wrap at spaces and keep line breaks", () => {
    // "Holmes" is 6 characters of 6 pixels: 36.
    expect(wrapText(font, "Holmes Holmes Holmes", 80)).toEqual(["Holmes Holmes", "Holmes"]);
    expect(wrapText(font, "a\nb\r\nc", 200)).toEqual(["a", "b", "c"]);
    // A word wider than the line stays whole.
    expect(wrapText(font, "Mycroft", 10)).toEqual(["Mycroft"]);
  });
});

describe("resource maps", () => {
  it("list every entry by type", () => {
    // Two tables (views at 9, scripts at 21) and the terminator.
    const bytes = new Uint8Array(33);
    const v = new DataView(bytes.buffer);
    [[ResourceType.View, 9], [ResourceType.Script, 21], [0xff, 33]].forEach(([type, offset], i) => {
      bytes[i * 3] = type!;
      v.setUint16(i * 3 + 1, offset!, true);
    });
    const put = (at: number, number: number, offset: number) => (v.setUint16(at, number, true), v.setUint32(at + 2, offset, true));
    put(9, 0, 0);
    put(15, 900, 1234);
    put(21, 221, 99999);
    put(27, 0, 70000);
    expect(parseResourceMap(bytes)).toEqual([
      { type: ResourceType.View, number: 0, offset: 0 },
      { type: ResourceType.View, number: 900, offset: 1234 },
      { type: ResourceType.Script, number: 221, offset: 99999 },
      { type: ResourceType.Script, number: 0, offset: 70000 },
    ]);
  });
});
