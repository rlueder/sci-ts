import type { ResourceManager } from "../resource/manager.ts";
import { ResourceType } from "../resource/types.ts";
import { parseSolHeader, solSampleCount } from "./sol.ts";

export type AudioFile = "RESOURCE.AUD" | "RESOURCE.SFX";

/** Where a clip's bytes live, without having read them. */
export interface AudioClip {
  file: AudioFile;
  /** Offset of the SOL resource (type byte) in the file. */
  offset: number;
  /** Byte length up to the next clip in the file (an upper bound for the last one). */
  length: number;
  /** Exact duration in 60 Hz ticks, when the header was available at index time. */
  ticks?: number;
}

const SFX_MAP = 65535;
const SOL_HEADER = 14;
/** Speech and effects are usually 11,025 Hz, 16-bit DPCM (1 byte per sample). */
const DEFAULT_RATE = 11025;

export const speechKey = (module: number, noun: number, verb: number, cond: number, seq: number) =>
  `${module}:${noun}:${verb}:${cond}:${seq}`;

/**
 * Index of every digital clip, built from the audio map resources:
 *
 * Speech maps (one per module): u32 base offset into RESOURCE.AUD, then entries of
 *   u32 BIG-endian noun<<24|verb<<16|cond<<8|seq   (seq bit 7: u16 lip-sync size follows,
 *   u24 delta added to the running offset           seq bit 6: u16 extra size follows)
 *   terminated by 0xFFFFFFFF. Lip-sync data sits before the SOL audio.
 * Map 65535 (sound effects): u16 number, u24 delta (running offset) into RESOURCE.SFX;
 *   0xFFFF ends it.
 *
 * Lengths come from sorting all offsets per file: each clip runs to the next one.
 */
export class AudioIndex {
  readonly speech = new Map<string, AudioClip>();
  readonly effects = new Map<number, AudioClip>();

  static build(rm: ResourceManager): AudioIndex {
    const index = new AudioIndex();
    const starts: Record<AudioFile, number[]> = { "RESOURCE.AUD": [], "RESOURCE.SFX": [] };
    const pending: { clip: AudioClip; skip: number }[] = [];

    for (const info of rm.list(ResourceType.Map)) {
      const data = rm.loadSync(info).data;
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (info.number === SFX_MAP) {
        let offset = 0;
        for (let p = 0; p + 5 <= data.length; p += 5) {
          const n = v.getUint16(p, true);
          if (n === 0xffff) break;
          offset += data[p + 2]! | (data[p + 3]! << 8) | (data[p + 4]! << 16);
          const clip: AudioClip = { file: "RESOURCE.SFX", offset, length: 0 };
          index.effects.set(n, clip);
          starts["RESOURCE.SFX"].push(offset);
          pending.push({ clip, skip: 0 });
        }
        continue;
      }
      let offset = v.getUint32(0, true);
      for (let p = 4; p + 7 <= data.length; ) {
        const n = v.getUint32(p, false);
        if (n === 0xffffffff) break;
        offset += data[p + 4]! | (data[p + 5]! << 8) | (data[p + 6]! << 16);
        p += 7;
        let skip = 0;
        const seqFlags = n & 0xff;
        starts["RESOURCE.AUD"].push(offset);
        if (seqFlags & 0x80) (skip += v.getUint16(p, true)), (p += 2);
        if (seqFlags & 0x40) (skip += v.getUint16(p, true)), (p += 2);
        const key = speechKey(info.number, n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, seqFlags & 0x3f);
        const clip: AudioClip = { file: "RESOURCE.AUD", offset: offset + skip, length: 0 };
        index.speech.set(key, clip);
        pending.push({ clip, skip });
      }
    }

    // Effects are small and preloaded: take exact durations from their headers.
    const sfx = rm.file("RESOURCE.SFX");
    if (sfx) {
      for (const clip of index.effects.values()) {
        const h = parseSolHeader(sfx.subarray(clip.offset, clip.offset + 16));
        if (h) clip.ticks = Math.max(1, Math.round((solSampleCount(h.flags, h.dataSize) / h.rate) * 60));
      }
    }

    for (const file of Object.keys(starts) as AudioFile[]) starts[file] = [...new Set(starts[file])].sort((a, b) => a - b);
    for (const { clip, skip } of pending) {
      const list = starts[clip.file];
      const start = clip.offset - skip;
      // Binary search for the next start after this clip.
      let lo = 0, hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]! <= start) lo = mid + 1;
        else hi = mid;
      }
      const next = list[lo] ?? clip.offset + 2_000_000;
      clip.length = Math.max(0, next - clip.offset);
    }
    return index;
  }

  /** Estimated duration in 60 Hz ticks, from the clip's byte length. */
  static ticks(clip: AudioClip): number {
    if (clip.ticks) return clip.ticks;
    const samples = Math.max(0, clip.length - SOL_HEADER);
    return Math.max(1, Math.round((samples / DEFAULT_RATE) * 60));
  }
}

/** What a host (browser, test) provides to actually make noise. */
export interface AudioOutput {
  play(channel: string, clip: AudioClip, options: { loop: boolean; volume: number }): void;
  stop(channel: string): void;
  pause(channel: string): void;
  resume(channel: string): void;
  setVolume(channel: string, volume: number): void;
}
