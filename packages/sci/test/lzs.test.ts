import { describe, expect, it } from "vitest";
import { decompressLzs } from "../src/index.ts";

/** Packs MSB-first bit fields into bytes. */
const pack = (fields: [value: number, bits: number][]): Uint8Array => {
  const out: number[] = [];
  let acc = 0;
  let n = 0;
  for (const [v, bits] of fields) {
    for (let i = bits - 1; i >= 0; i--) {
      acc = (acc << 1) | ((v >> i) & 1);
      if (++n === 8) (out.push(acc), (acc = 0), (n = 0));
    }
  }
  if (n) out.push(acc << (8 - n));
  return new Uint8Array(out);
};

describe("decompressLzs", () => {
  it("decodes literals and an overlapping back-reference", () => {
    // "ab" then copy offset 2 length 4 -> "ababab"
    const src = pack([[0, 1], [0x61, 8], [0, 1], [0x62, 8], [0b11, 2], [2, 7], [0b10, 2], [0b11, 2], [0, 7]]);
    expect(new TextDecoder().decode(decompressLzs(src, 6))).toBe("ababab");
  });

  it("decodes extended lengths", () => {
    // "x" then offset 1, length 8 + 15 + 2 = 25 -> 26 x's
    const src = pack([[0, 1], [0x78, 8], [0b11, 2], [1, 7], [0b11, 2], [0b11, 2], [0xf, 4], [2, 4]]);
    expect(decompressLzs(src, 26)).toEqual(new Uint8Array(26).fill(0x78));
  });
});
