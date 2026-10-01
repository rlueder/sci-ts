/**
 * STACpack / LZS decompression (compression method 32 in SCI2 volumes).
 *
 * Bitstream is read MSB-first. Tokens:
 *   0 bbbbbbbb              literal byte
 *   1 1 ooooooo  len        back-reference, 7-bit offset (offset 0 = end marker)
 *   1 0 ooooooooooo len     back-reference, 11-bit offset
 *
 * Length codes: 00=2 01=3 10=4 | 1100=5 1101=6 1110=7 | 1111 then nibbles
 * added to 8 until a nibble other than 0xF.
 */
export function decompressLzs(src: Uint8Array, unpackedSize: number): Uint8Array {
  const out = new Uint8Array(unpackedSize);
  let written = 0;
  let bytePos = 0;
  let bitBuf = 0;
  let bitCount = 0;

  const bits = (n: number): number => {
    while (bitCount < n) {
      bitBuf = (bitBuf << 8) | (src[bytePos++] ?? 0);
      bitCount += 8;
    }
    bitCount -= n;
    return (bitBuf >>> bitCount) & ((1 << n) - 1);
  };

  const length = (): number => {
    switch (bits(2)) {
      case 0: return 2;
      case 1: return 3;
      case 2: return 4;
    }
    switch (bits(2)) {
      case 0: return 5;
      case 1: return 6;
      case 2: return 7;
    }
    let len = 8;
    let nibble: number;
    do {
      nibble = bits(4);
      len += nibble;
    } while (nibble === 0xf);
    return len;
  };

  while (written < unpackedSize) {
    if (bits(1) === 0) {
      out[written++] = bits(8);
      continue;
    }
    const offset = bits(1) ? bits(7) : bits(11);
    if (offset === 0) break;
    let from = written - offset;
    if (from < 0) throw new Error(`LZS: back-reference before start (offset ${offset} at ${written})`);
    for (let n = length(); n > 0 && written < unpackedSize; n--) {
      out[written++] = out[from++]!;
    }
  }

  if (written !== unpackedSize) {
    throw new Error(`LZS: produced ${written} bytes, expected ${unpackedSize}`);
  }
  return out;
}
