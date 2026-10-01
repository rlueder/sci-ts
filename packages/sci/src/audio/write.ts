import type { MidiEvent } from "./midi.ts";
import { SolFlag } from "./sol.ts";

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

/** A SOL clip: 16-bit samples at `rate`, uncompressed. */
export function writeSol(samples: Int16Array, rate: number): Uint8Array {
  const out = new Uint8Array(13 + samples.length * 2);
  const v = new DataView(out.buffer);
  out[0] = 0x8d; // audio
  out[1] = 11; // header bytes after these two
  out.set([0x53, 0x4f, 0x4c, 0], 2); // "SOL\0"
  v.setUint16(6, rate, true);
  out[8] = SolFlag.Bits16 | SolFlag.Signed;
  v.setUint32(9, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(13 + i * 2, s, true));
  return out;
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
