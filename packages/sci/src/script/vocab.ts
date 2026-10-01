const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

/**
 * Vocab 997: selector names, indexed by selector id. Selectors name every property and
 * method across all classes (e.g. 0x93 = init, 0x45 = doit).
 *   u16 count, u16 offset per selector → { u16 length, chars }
 */
export function parseSelectorNames(data: Uint8Array): string[] {
  const v = view(data);
  const count = v.getUint16(0, true);
  const decoder = new TextDecoder("latin1");
  return Array.from({ length: count }, (_, i) => {
    const o = v.getUint16(2 + i * 2, true);
    return decoder.decode(data.subarray(o + 2, o + 2 + v.getUint16(o, true)));
  });
}

/**
 * Vocab 996: which script defines each class, indexed by class (species) number.
 *   4 bytes per class: u16 (unused), u16 script number
 */
export function parseClassTable(data: Uint8Array): number[] {
  const v = view(data);
  return Array.from({ length: data.length / 4 }, (_, i) => v.getUint16(i * 4 + 2, true));
}

/** Vocab 997 from selector names, in id order (the inverse of parseSelectorNames). */
export function writeSelectorNames(names: readonly string[]): Uint8Array {
  const bytes = names.map((n) => Uint8Array.from(n, (ch) => ch.charCodeAt(0) & 0xff));
  const out = new Uint8Array(2 + names.length * 2 + bytes.reduce((n, b) => n + 2 + b.length, 0));
  const v = view(out);
  v.setUint16(0, names.length, true);
  let at = 2 + names.length * 2;
  bytes.forEach((b, i) => {
    v.setUint16(2 + i * 2, at, true);
    v.setUint16(at, b.length, true);
    out.set(b, at + 2);
    at += 2 + b.length;
  });
  return out;
}

/** Vocab 996 from the script defining each class, by species (the inverse of parseClassTable). */
export function writeClassTable(scripts: readonly number[]): Uint8Array {
  const out = new Uint8Array(scripts.length * 4);
  scripts.forEach((s, i) => view(out).setUint16(i * 4 + 2, s, true));
  return out;
}
