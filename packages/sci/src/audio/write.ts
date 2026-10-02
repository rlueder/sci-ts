import type { MidiEvent } from "./midi.ts";
import { DPCM16, SolFlag } from "./sol.ts";

/**
 * Writers for sound: sound resources (music, in the layout parseSound reads), SOL clips, and
 * the effects file RESOURCE.SFX with its index, map 65535 (the layout AudioIndex reads).
 */

export interface SoundChannel {
  /** 0-15; 15 is the control channel (signals and cues to the scripts), not music. */
  midiChannel: number;
  /** Voices it wants from a voice-limited device (AdLib); others ignore it. */
  voices: number;
  /** Absolute ticks (1/60 s); bytes are MIDI messages (their channel nibble is replaced). */
  events: MidiEvent[];
}

export interface SoundSpec {
  priority?: number;
  /** One per sound device (SoundDevice): each device plays its own arrangement. */
  tracks: { device: number; channels: SoundChannel[] }[];
}

const dataBytes = (status: number) => ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2);

/** A channel stream: channel, voices, then delta-timed events with running status, then 0xFC. */
function channelStream(c: SoundChannel): number[] {
  if (c.midiChannel < 0 || c.midiChannel > 15) throw new Error(`MIDI channel ${c.midiChannel} isn't 0-15`);
  const out = [c.midiChannel, c.voices & 0x0f];
  const events = [...c.events].sort((a, b) => a.tick - b.tick);
  let tick = 0, running = -1;
  for (const e of events) {
    if (e.tick < tick) throw new Error(`event at tick ${e.tick} before ${tick}`);
    let delta = Math.round(e.tick - tick);
    tick += delta;
    // A delta of 240 or more is 0xF8 bytes of 240 each, then the rest.
    for (; delta >= 240; delta -= 240) out.push(0xf8);
    out.push(delta);
    const status = (e.bytes[0]! & 0xf0) | c.midiChannel;
    if (status < 0x80 || status >= 0xf0) throw new Error(`not a channel message: ${e.bytes.map((b) => b.toString(16)).join(" ")}`);
    if (status !== running) out.push(status);
    running = status;
    const n = dataBytes(status);
    for (let i = 1; i <= n; i++) out.push((e.bytes[i] ?? 0) & 0x7f);
  }
  out.push(0, 0xfc);
  return out;
}

export function writeSound(spec: SoundSpec): Uint8Array {
  const header = [0xf0, spec.priority ?? 0, 0, 0, 0, 0, 0, 0];
  const streams = spec.tracks.map((t) => t.channels.map(channelStream));
  // Track table: device, 6-byte entries (u16 0, u16 offset, u16 size), 0xFF; then 0xFF.
  const tableSize = spec.tracks.reduce((n, t) => n + 1 + t.channels.length * 6 + 1, 0) + 1;
  let at = header.length + tableSize;
  const table: number[] = [];
  const body: number[] = [];
  spec.tracks.forEach((t, i) => {
    table.push(t.device);
    for (const s of streams[i]!) {
      if (at + s.length > 0xffff) throw new Error("sound too large: offsets are 16-bit (64 KB)");
      table.push(0, 0, at & 0xff, at >> 8, s.length & 0xff, s.length >> 8);
      body.push(...s);
      at += s.length;
    }
    table.push(0xff);
  });
  table.push(0xff);
  return Uint8Array.from([...header, ...table, ...body]);
}

/**
 * A SOL clip of 16-bit samples at `rate`: uncompressed, or compressed with SOL's 16-bit DPCM
 * (one byte a sample, half the size; what speech uses).
 */
export function writeSol(samples: Int16Array, rate: number, compressed = false): Uint8Array {
  const data = compressed ? encodeDpcm16(samples) : new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const out = new Uint8Array(13 + data.length);
  const v = new DataView(out.buffer);
  out[0] = 0x8d; // audio
  out[1] = 11; // header bytes after these two
  out.set([0x53, 0x4f, 0x4c, 0], 2); // "SOL\0"
  v.setUint16(6, rate, true);
  out[8] = compressed ? SolFlag.Compressed | SolFlag.Bits16 : SolFlag.Bits16 | SolFlag.Signed;
  v.setUint32(9, data.length, true);
  if (compressed) out.set(data, 13);
  else samples.forEach((s, i) => v.setInt16(13 + i * 2, s, true));
  return out;
}

/**
 * SOL's 16-bit DPCM: each byte steps from the last sample by DPCM16[byte & 0x7f], down if
 * bit 7 is set. Each step is the one that lands nearest the sample, never past the 16-bit
 * range (the decoder would wrap around).
 */
export function encodeDpcm16(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  let last = 0;
  for (let i = 0; i < samples.length; i++) {
    const want = samples[i]! - last, size = Math.abs(want);
    let lo = 0, hi = DPCM16.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (DPCM16[mid]! < size) lo = mid + 1;
      else hi = mid;
    }
    // lo is the first step at least as big; the one below may be nearer.
    if (lo > 0 && size - DPCM16[lo - 1]! < DPCM16[lo]! - size) lo--;
    const down = want < 0;
    const land = (k: number) => last + (down ? -DPCM16[k]! : DPCM16[k]!);
    while (lo > 0 && (land(lo) > 32767 || land(lo) < -32768)) lo--;
    out[i] = (down ? 0x80 : 0) | lo;
    last = land(lo);
  }
  return out;
}

export interface SpeechClip {
  /** The message file (room) the line is in, and its key there. */
  module: number;
  noun: number;
  verb: number;
  cond: number;
  seq: number;
  sol: Uint8Array;
}

/**
 * RESOURCE.AUD (SOL clips one after another, by module and key) and a map per module, in the
 * layout AudioIndex reads: u32 offset of the module's first clip, then per clip u32
 * big-endian noun<<24|verb<<16|cond<<8|seq and a u24 delta from the previous clip;
 * 0xFFFFFFFF ends it.
 *
 * The index takes a clip's length from where the next one starts, so the last map also has
 * an entry at the end of the file, under 0 0 0 0, which no message has (nouns and seqs
 * start at 1); without it the last clip's length would be a guess.
 */
export function writeSpeech(clips: readonly SpeechClip[]): { aud: Uint8Array; maps: { module: number; data: Uint8Array }[] } {
  const key = (c: SpeechClip) => ((c.noun << 24) | (c.verb << 16) | (c.cond << 8) | c.seq) >>> 0;
  const sorted = [...clips].sort((a, b) => a.module - b.module || key(a) - key(b));
  const aud = new Uint8Array(sorted.reduce((n, c) => n + c.sol.length, 0));
  const modules = [...new Set(sorted.map((c) => c.module))];
  let at = 0;
  const maps = modules.map((module, m) => {
    const mine = sorted.filter((c) => c.module === module);
    const last = m === modules.length - 1;
    const data = new Uint8Array(4 + (mine.length + (last ? 1 : 0)) * 7 + 4);
    const v = new DataView(data.buffer);
    v.setUint32(0, at, true);
    let prev = at, p = 4;
    const entry = (k: number) => {
      const delta = at - prev;
      if (delta > 0xffffff) throw new Error("speech clip too large (16 MB at most)");
      v.setUint32(p, k, false);
      data.set([delta & 0xff, (delta >> 8) & 0xff, delta >> 16], p + 4);
      p += 7;
      prev = at;
    };
    mine.forEach((c, i) => {
      const where = `${c.module} ${c.noun} ${c.verb} ${c.cond} ${c.seq}`;
      for (const [n, max] of [[c.noun, 255], [c.verb, 255], [c.cond, 255]] as const) if (n < 0 || n > max) throw new Error(`speech for ${where}: noun, verb and cond are 0-255`);
      if (c.seq < 1 || c.seq > 63) throw new Error(`speech for ${where}: seq is 1-63`);
      if (i && key(c) === key(mine[i - 1]!)) throw new Error(`speech for ${where} is there twice`);
      entry(key(c));
      aud.set(c.sol, at);
      at += c.sol.length;
    });
    if (last) entry(0);
    v.setUint32(p, 0xffffffff, false);
    return { module, data };
  });
  return { aud, maps };
}

/**
 * RESOURCE.SFX (the SOL clips, one after another) and its index, map 65535: per clip, u16
 * sound number and u24 offset from the previous clip; 0xFFFF ends it.
 */
export function writeEffects(clips: readonly { number: number; sol: Uint8Array }[]): { sfx: Uint8Array; map: Uint8Array } {
  const sorted = [...clips].sort((a, b) => a.number - b.number);
  const sfx = new Uint8Array(sorted.reduce((n, c) => n + c.sol.length, 0));
  const map = new Uint8Array(sorted.length * 5 + 5);
  const v = new DataView(map.buffer);
  let at = 0, prev = 0;
  sorted.forEach((c, i) => {
    if (i && c.number === sorted[i - 1]!.number) throw new Error(`sound effect ${c.number} is there twice`);
    if (at - prev > 0xffffff) throw new Error("sound effect too large");
    sfx.set(c.sol, at);
    v.setUint16(i * 5, c.number, true);
    const delta = at - prev;
    map.set([delta & 0xff, (delta >> 8) & 0xff, delta >> 16], i * 5 + 2);
    prev = at;
    at += c.sol.length;
  });
  v.setUint16(sorted.length * 5, 0xffff, true);
  return { sfx, map };
}
