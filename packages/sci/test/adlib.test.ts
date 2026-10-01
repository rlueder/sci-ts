import { describe, expect, it } from "vitest";
import { OPL_RATE, Opl2 } from "../src/index.ts";

/** Channel 0 as a plain sine: modulator silent, carrier at full level, fast envelope. */
function sineChip(fm = false): Opl2 {
  const chip = new Opl2();
  chip.write(0x20, 0x21); // modulator: sustain, mult 1
  chip.write(0x23, 0x21); // carrier: sustain, mult 1
  chip.write(0x40, fm ? 0x10 : 0x3f); // modulator level (63 = silent)
  chip.write(0x43, 0x00); // carrier loudest
  chip.write(0x60, 0xf0); chip.write(0x63, 0xf0); // instant attack, no decay
  chip.write(0x80, 0x0f); chip.write(0x83, 0x0f); // sustain level 0, fast release
  chip.write(0xc0, 0x00); // FM connection, no feedback
  return chip;
}

const keyOnA4 = (chip: Opl2) => {
  // 440 Hz: fnum = 440 * 2^20 / (49716 * 2^4) ≈ 580, block 4
  chip.write(0xa0, 580 & 0xff);
  chip.write(0xb0, 0x20 | (4 << 2) | (580 >> 8));
};

const render = (chip: Opl2, seconds: number) => {
  const out = new Float32Array(Math.round(OPL_RATE * seconds));
  chip.generate(out);
  return out;
};

describe("OPL2 emulator", () => {
  it("plays a sine at the programmed frequency", () => {
    const chip = sineChip();
    keyOnA4(chip);
    const out = render(chip, 1);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if (out[i - 1]! < 0 && out[i]! >= 0) crossings++;
    expect(crossings).toBeGreaterThan(435);
    expect(crossings).toBeLessThan(445);
  });

  it("fades out after key-off", () => {
    const chip = sineChip();
    keyOnA4(chip);
    render(chip, 0.2);
    chip.write(0xb0, (4 << 2) | (580 >> 8)); // key off
    const tail = render(chip, 0.5).subarray(-1000);
    expect(Math.max(...tail.map(Math.abs))).toBeLessThan(0.001);
  });

  it("adds harmonics in FM mode", () => {
    // Compare how "busy" the waveform is: FM output crosses zero far more often.
    const count = (chip: Opl2) => {
      keyOnA4(chip);
      const out = render(chip, 0.5);
      let c = 0;
      for (let i = 1; i < out.length; i++) if (Math.sign(out[i]!) !== Math.sign(out[i - 1]!)) c++;
      return c;
    };
    expect(count(sineChip(true))).toBeGreaterThan(count(sineChip(false)) * 1.5);
  });
});
