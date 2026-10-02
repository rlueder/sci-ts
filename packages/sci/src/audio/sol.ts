/**
 * Sierra SOL audio, used for speech (RESOURCE.AUD) and digital effects (RESOURCE.SFX).
 *
 *   +0 u8  resource type (0x8D = audio)     +1 u8 header size (data starts at 2 + this)
 *   +2 "SOL\0"   +6 u16 sample rate   +8 u8 flags   +9 u32 data size
 *
 * Flags: 1 = DPCM compressed, 4 = 16-bit, 8 = signed, 0x10 = stereo.
 * DPCM stores one delta per byte (16-bit) or per nibble (8-bit); tables and the x86-style
 * 16-bit wraparound follow the original interpreter (as documented by ScummVM).
 */
export interface SolAudio {
  rate: number;
  channels: number;
  /** Samples in -1..1, interleaved if stereo. */
  samples: Float32Array;
}

export const SolFlag = { Compressed: 1, Bits16: 4, Signed: 8, Stereo: 0x10 } as const;

export interface SolHeader {
  rate: number;
  flags: number;
  dataOffset: number;
  dataSize: number;
}

export function parseSolHeader(data: Uint8Array): SolHeader | undefined {
  if (data[2] !== 0x53 || data[3] !== 0x4f || data[4] !== 0x4c) return undefined; // "SOL"
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerSize = data[1]!;
  return {
    rate: v.getUint16(6, true),
    flags: data[8]!,
    dataOffset: 2 + headerSize,
    dataSize: headerSize >= 11 ? v.getUint32(9, true) : data.length - 2 - headerSize,
  };
}

/** Samples a SOL clip of `dataBytes` bytes decodes to, per channel. */
export function solSampleCount(flags: number, dataBytes: number): number {
  const channels = flags & SolFlag.Stereo ? 2 : 1;
  const bytesPerSample = flags & SolFlag.Compressed ? (flags & SolFlag.Bits16 ? 1 : 0.5) : flags & SolFlag.Bits16 ? 2 : 1;
  return Math.floor(dataBytes / bytesPerSample / channels);
}

/** The steps of 16-bit DPCM, by the low seven bits of a byte (bit 7 makes it a step down). */
export const DPCM16 = [
  0x0000, 0x0008, 0x0010, 0x0020, 0x0030, 0x0040, 0x0050, 0x0060, 0x0070, 0x0080, 0x0090, 0x00a0, 0x00b0, 0x00c0,
  0x00d0, 0x00e0, 0x00f0, 0x0100, 0x0110, 0x0120, 0x0130, 0x0140, 0x0150, 0x0160, 0x0170, 0x0180, 0x0190, 0x01a0,
  0x01b0, 0x01c0, 0x01d0, 0x01e0, 0x01f0, 0x0200, 0x0208, 0x0210, 0x0218, 0x0220, 0x0228, 0x0230, 0x0238, 0x0240,
  0x0248, 0x0250, 0x0258, 0x0260, 0x0268, 0x0270, 0x0278, 0x0280, 0x0288, 0x0290, 0x0298, 0x02a0, 0x02a8, 0x02b0,
  0x02b8, 0x02c0, 0x02c8, 0x02d0, 0x02d8, 0x02e0, 0x02e8, 0x02f0, 0x02f8, 0x0300, 0x0308, 0x0310, 0x0318, 0x0320,
  0x0328, 0x0330, 0x0338, 0x0340, 0x0348, 0x0350, 0x0358, 0x0360, 0x0368, 0x0370, 0x0378, 0x0380, 0x0388, 0x0390,
  0x0398, 0x03a0, 0x03a8, 0x03b0, 0x03b8, 0x03c0, 0x03c8, 0x03d0, 0x03d8, 0x03e0, 0x03e8, 0x03f0, 0x03f8, 0x0400,
  0x0440, 0x0480, 0x04c0, 0x0500, 0x0540, 0x0580, 0x05c0, 0x0600, 0x0640, 0x0680, 0x06c0, 0x0700, 0x0740, 0x0780,
  0x07c0, 0x0800, 0x0900, 0x0a00, 0x0b00, 0x0c00, 0x0d00, 0x0e00, 0x0f00, 0x1000, 0x1400, 0x1800, 0x1c00, 0x2000,
  0x3000, 0x4000,
];
const DPCM8 = [0, 1, 2, 3, 6, 10, 15, 21];

export function decodeSol(data: Uint8Array): SolAudio | undefined {
  const h = parseSolHeader(data);
  if (!h) return undefined;
  const channels = h.flags & SolFlag.Stereo ? 2 : 1;
  const body = data.subarray(h.dataOffset, Math.min(data.length, h.dataOffset + h.dataSize));
  const out = new Float32Array(solSampleCount(h.flags, body.length) * channels);

  if (h.flags & SolFlag.Compressed) {
    if (h.flags & SolFlag.Bits16) {
      const last = [0, 0];
      for (let i = 0; i < out.length; i++) {
        const ch = i % channels;
        const delta = body[i]!;
        let s = last[ch]! + (delta & 0x80 ? -DPCM16[delta & 0x7f]! : DPCM16[delta]!);
        if (s > 32767) s -= 65536; // x86 16-bit register wraparound
        else if (s < -32768) s += 65536;
        last[ch] = s;
        out[i] = s / 32768;
      }
    } else {
      let sample = 0x80;
      let o = 0;
      const nibble = (d: number) => {
        const prev = sample;
        sample = Math.max(0, Math.min(255, sample + (d & 8 ? -DPCM8[d & 7]! : DPCM8[d & 7]!)));
        out[o++] = ((prev + sample) / 2 - 128) / 128;
      };
      for (let i = 0; i < body.length && o < out.length; i++) {
        nibble(body[i]! >> 4);
        if (o < out.length) nibble(body[i]! & 0xf);
      }
    }
  } else if (h.flags & SolFlag.Bits16) {
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 2, true) / 32768;
  } else {
    const signed = (h.flags & SolFlag.Signed) !== 0;
    for (let i = 0; i < out.length; i++) out[i] = signed ? ((body[i]! << 24) >> 24) / 128 : (body[i]! - 128) / 128;
  }
  return { rate: h.rate, channels, samples: out };
}
