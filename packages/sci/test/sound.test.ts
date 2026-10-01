import { describe, expect, it } from "vitest";
import { readMidiFile, readWav } from "../../../tools/game/audio.ts";
import {
  AudioIndex, ResourceManager, ResourceType, SoundDevice, decodeSol, parseSound, writeEffects, writeResourceArchive, writeSol, writeSound,
  type FileSource, type MidiEvent,
} from "../src/index.ts";

// Sound written and read back, with made-up data.

const memoryFiles = (files: Record<string, Uint8Array>): FileSource => ({
  read: async (path) => files[path],
  readRange: async (path, offset, length) => files[path]!.slice(offset, offset + length),
  list: async (dir) => (dir === "" ? Object.keys(files) : []),
});

const notes = (channel: number, from: number, pitches: number[], step: number): MidiEvent[] =>
  pitches.flatMap((p, i) => [{ tick: from + i * step, bytes: [0x90 | channel, p, 100] }, { tick: from + i * step + step - 1, bytes: [0x80 | channel, p, 0] }]);

describe("sound resources", () => {
  it("write and read back: every channel's events, with long gaps and running status", () => {
    const melody = [{ tick: 0, bytes: [0xc0, 10] }, ...notes(0, 0, [60, 62, 64, 65], 30), { tick: 1000, bytes: [0xb0, 7, 90] }];
    const bass = notes(1, 500, [36, 43], 400);
    const data = writeSound({ priority: 3, tracks: [{ device: SoundDevice.GeneralMidi, channels: [{ midiChannel: 0, voices: 1, events: melody }, { midiChannel: 1, voices: 2, events: bass }] }] });
    const song = parseSound(data)!;
    expect(song.priority).toBe(3);
    expect(song.channels).toEqual([{ midiChannel: 0, voices: 1 }, { midiChannel: 1, voices: 2 }]);
    const key = (e: MidiEvent) => `${e.tick}:${e.bytes.join(",")}`;
    expect(song.events.map(key).sort()).toEqual([...melody, ...bass].map(key).sort());
    expect(song.length).toBe(1299);
  });

  it("keep a track per device", () => {
    const one = { midiChannel: 2, voices: 1, events: notes(2, 0, [70], 10) };
    const data = writeSound({ tracks: [{ device: SoundDevice.AdLib, channels: [one] }, { device: SoundDevice.GeneralMidi, channels: [{ ...one, events: notes(2, 0, [50], 10) }] }] });
    expect(parseSound(data, SoundDevice.AdLib)!.events[0]!.bytes).toEqual([0x92, 70, 100]);
    expect(parseSound(data, SoundDevice.GeneralMidi)!.events[0]!.bytes).toEqual([0x92, 50, 100]);
  });

  it("refuse what doesn't fit", () => {
    expect(() => writeSound({ tracks: [{ device: 7, channels: [{ midiChannel: 16, voices: 1, events: [] }] }] })).toThrow(/channel 16/);
    expect(() => writeSound({ tracks: [{ device: 7, channels: [{ midiChannel: 0, voices: 1, events: [{ tick: 0, bytes: [0xf0, 1] }] }] }] })).toThrow(/not a channel message/);
  });
});

describe("digital effects", () => {
  const samples = Int16Array.from({ length: 2205 }, (_, i) => Math.round(Math.sin(i / 5) * 20000));

  it("SOL clips decode to their samples", () => {
    const clip = decodeSol(writeSol(samples, 22050))!;
    expect(clip.rate).toBe(22050);
    expect(clip.channels).toBe(1);
    expect(Array.from(clip.samples, (s) => Math.round(s * 32768))).toEqual([...samples]);
  });

  it("RESOURCE.SFX and map 65535 are found by the engine's audio index, with their lengths", async () => {
    const short = samples.subarray(0, 1102);
    const { sfx, map } = writeEffects([{ number: 50, sol: writeSol(samples, 22050) }, { number: 7, sol: writeSol(short, 11025) }]);
    const { map: rmap, volume } = writeResourceArchive([{ type: ResourceType.Map, number: 65535, data: map }]);
    const rm = await ResourceManager.open(memoryFiles({ "RESOURCE.MAP": rmap, "RESOURCE.000": volume, "RESOURCE.SFX": sfx }));
    await rm.preload();
    const index = AudioIndex.build(rm);
    expect([...index.effects.keys()].sort((a, b) => a - b)).toEqual([7, 50]);
    expect(AudioIndex.ticks(index.effects.get(50)!)).toBe(6); // 0.1 s
    expect(AudioIndex.ticks(index.effects.get(7)!)).toBe(6);
    const clip = index.effects.get(50)!;
    expect(decodeSol(sfx.subarray(clip.offset, clip.offset + clip.length))!.samples.length).toBe(samples.length);
  });
});

/** A Standard MIDI File from tracks of [delta, ...bytes] (format 1, 96 ticks a quarter). */
function smf(tracks: number[][][]): Uint8Array {
  const varLen = (n: number) => {
    const out = [n & 0x7f];
    while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  const u32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const out = [..."MThd"].map((c) => c.charCodeAt(0)).concat(u32(6), [0, 1, 0, tracks.length, 0, 96]);
  for (const t of tracks) {
    const body = t.flatMap(([delta, ...bytes]) => [...varLen(delta!), ...bytes]).concat([0, 0xff, 0x2f, 0]);
    out.push(..."MTrk".split("").map((c) => c.charCodeAt(0)), ...u32(body.length), ...body);
  }
  return Uint8Array.from(out);
}

describe("MIDI files", () => {
  it("become a General MIDI track, timed through tempo changes", () => {
    const data = smf([
      // Tempo: 120 bpm, then 60 bpm after two quarters.
      [[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], [192, 0xff, 0x51, 3, 0x0f, 0x42, 0x40]],
      [[0, 0xc0, 5], [0, 0x90, 60, 100], [96, 0x80, 60, 0], [96, 0x90, 64, 100], [96, 64, 0]], // running status, velocity 0
      [[0, 0x99, 36, 90], [384, 0x89, 36, 0]],
    ]);
    const spec = readMidiFile(data);
    expect(spec.tracks[0]!.device).toBe(SoundDevice.GeneralMidi);
    const [piano, drums] = spec.tracks[0]!.channels;
    expect(piano!.midiChannel).toBe(0);
    // A quarter is 30 ticks at 120 bpm, 60 at 60 bpm.
    expect(piano!.events.map((e) => [e.tick, ...e.bytes])).toEqual([[0, 0xc0, 5], [0, 0x90, 60, 100], [30, 0x80, 60, 0], [60, 0x90, 64, 100], [120, 0x90, 64, 0]]);
    expect(drums!.midiChannel).toBe(9);
    expect(drums!.events.at(-1)!.tick).toBe(60 + 120);
    expect(parseSound(writeSound(spec))!.events).toHaveLength(7);
  });

  it("move music off channel 16, which SCI keeps for itself", () => {
    const spec = readMidiFile(smf([[[0, 0x9f, 60, 100], [10, 0x8f, 60, 0]], [[0, 0x90, 50, 100]]]));
    expect(spec.tracks[0]!.channels.map((c) => c.midiChannel)).toEqual([0, 1]);
    expect(spec.tracks[0]!.channels[1]!.events[0]!.bytes).toEqual([0x9f, 60, 100]);
  });

  it("say what's wrong with a file", () => {
    expect(() => readMidiFile(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a MIDI file/);
  });
});

describe("WAV files", () => {
  const wav = (bits: number, channels: number, frames: number[][]) => {
    const bytes = bits / 8, size = frames.length * channels * bytes;
    const v = new DataView(new ArrayBuffer(44 + size));
    const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF"); v.setUint32(4, 36 + size, true); text(8, "WAVE");
    text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000 * channels * bytes, true); v.setUint16(32, channels * bytes, true); v.setUint16(34, bits, true);
    text(36, "data"); v.setUint32(40, size, true);
    frames.flat().forEach((s, i) => (bits === 16 ? v.setInt16(44 + i * 2, s, true) : v.setUint8(44 + i, s)));
    return new Uint8Array(v.buffer);
  };

  it("become mono 16-bit samples", () => {
    expect(readWav(wav(16, 1, [[100], [-200]]))).toEqual({ samples: Int16Array.from([100, -200]), rate: 8000 });
    // 8-bit is unsigned around 128; stereo is averaged.
    expect([...readWav(wav(8, 2, [[128, 128], [255, 1]])).samples]).toEqual([0, 0]);
    expect([...readWav(wav(8, 1, [[192]])).samples]).toEqual([64 << 8]);
  });

  it("say what isn't supported", () => {
    const float = wav(16, 1, [[0]]);
    new DataView(float.buffer).setUint16(20, 3, true);
    expect(() => readWav(float)).toThrow(/format 3/);
  });
});
