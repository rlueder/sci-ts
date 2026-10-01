import { describe, expect, it } from "vitest";
import { decodeInstruction } from "../src/index.ts";

describe("decodeInstruction", () => {
  it("honours the size bit and SCI2's fixed 16-bit call frames", () => {
    // callk (byte form): kernel 0x12, frame always u16
    const callk = decodeInstruction(new Uint8Array([0x43, 0x12, 0x04, 0x00]), 0);
    expect(callk).toMatchObject({ name: "callk", operands: [0x12, 4], length: 4 });
    // send (byte form): frame follows the size bit
    expect(decodeInstruction(new Uint8Array([0x4b, 0x06]), 0)).toMatchObject({ name: "send", operands: [6], length: 2 });
    // bnt (word form): relative target
    expect(decodeInstruction(new Uint8Array([0x30, 0x10, 0x00]), 0)).toMatchObject({ name: "bnt", target: 0x13 });
    // variable op pattern: 0x44 = lsg
    expect(decodeInstruction(new Uint8Array([0x89, 0x0c]), 0)).toMatchObject({ name: "lsg", operands: [12] });
  });
});
