/**
 * An SCI value ("reg_t"): a (segment, offset) pair packed into one JS number as
 * `segment * 0x10000 + offset`. Segment 0 holds plain 16-bit integers; every other
 * segment is something addressable: a script's heap, a clone, an array, a list...
 *
 * Numbers are stored unsigned (0..0xFFFF) and read signed where the bytecode wants it.
 */
export type Value = number;

export const NULL: Value = 0;

export const makeRef = (segment: number, offset: number): Value => segment * 0x10000 + (offset & 0xffff);
export const segmentOf = (v: Value): number => Math.floor(v / 0x10000);
export const offsetOf = (v: Value): number => v & 0xffff;
export const isNumber = (v: Value): boolean => v < 0x10000;

export const toSigned = (v: Value): number => {
  const n = v & 0xffff;
  return n >= 0x8000 ? n - 0x10000 : n;
};
export const fromInt = (n: number): Value => n & 0xffff;
export const bool = (b: boolean): Value => (b ? 1 : 0);

export const formatValue = (v: Value): string =>
  isNumber(v) ? String(toSigned(v)) : `${segmentOf(v).toString(16)}:${offsetOf(v).toString(16).padStart(4, "0")}`;
