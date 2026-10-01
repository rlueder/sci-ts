import { SoundDevice, type MidiEvent, type SoundSpec } from "@sci-ts/sci";

/**
 * Music and sound for games, from the files people make them with: Standard MIDI Files
 * (.mid, from any sequencer) become sound resources; WAV files (PCM) become digital effects.
 */

export class AudioFileError extends Error {}

const CONTROL_CHANNEL = 15;

/**
 * A Standard MIDI File (format 0 or 1) as a sound resource for General MIDI: its tempo
 * changes turned into SCI's 1/60 s ticks, a channel stream per MIDI channel it uses. SCI
 * keeps channel 16 (15 counting from 0) for signals to the scripts, so music there moves to
 * a free channel.
 */
export function readMidiFile(data: Uint8Array): SoundSpec {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (at: number) => String.fromCharCode(...data.subarray(at, at + 4));
  if (tag(0) !== "MThd") throw new AudioFileError("not a MIDI file (no MThd)");
  const format = v.getUint16(8), trackCount = v.getUint16(10), division = v.getUint16(12);
  if (format > 1) throw new AudioFileError(`MIDI format ${format} isn't supported (save as format 0 or 1)`);
  if (division & 0x8000) throw new AudioFileError("SMPTE-timed MIDI files aren't supported (use ticks per quarter note)");

  const events: { tick: number; bytes: number[]; order: number }[] = [];
  const tempos: { tick: number; usPerQuarter: number }[] = [];
  let pos = 8 + v.getUint32(4), order = 0;
  for (let t = 0; t < trackCount; t++) {
    if (tag(pos) !== "MTrk") throw new AudioFileError(`track ${t + 1}: expected MTrk`);
    const end = pos + 8 + v.getUint32(pos + 4);
    pos += 8;
    let tick = 0, running = 0;
    const varLen = () => {
      let n = 0, b: number;
      do {
        b = data[pos++]!;
        n = (n << 7) | (b & 0x7f);
      } while (b & 0x80 && pos < end);
      return n;
    };
    while (pos < end) {
      tick += varLen();
      let status = data[pos]!;
      if (status & 0x80) pos++;
      else if (running) status = running;
      else throw new AudioFileError(`track ${t + 1}: data before any status byte`);
      if (status === 0xff) {
        const type = data[pos++]!, len = varLen();
        if (type === 0x51 && len === 3) tempos.push({ tick, usPerQuarter: (data[pos]! << 16) | (data[pos + 1]! << 8) | data[pos + 2]! });
        pos += len;
        if (type === 0x2f) break;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        pos += varLen();
        continue;
      }
      running = status;
      const n = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
      events.push({ tick, bytes: [status, ...data.subarray(pos, pos + n)], order: order++ });
      pos += n;
    }
    pos = end;
  }

  // MIDI ticks to seconds, through the tempo changes (120 bpm until the first).
  tempos.sort((a, b) => a.tick - b.tick);
  const toSciTicks = (tick: number) => {
    let seconds = 0, last = 0, us = 500_000;
    for (const t of tempos) {
      if (t.tick >= tick) break;
      seconds += ((t.tick - last) * us) / division / 1e6;
      last = t.tick;
      us = t.usPerQuarter;
    }
    seconds += ((tick - last) * us) / division / 1e6;
    return Math.round(seconds * 60);
  };

  const byChannel = new Map<number, MidiEvent[]>();
  for (const e of events.sort((a, b) => a.tick - b.tick || a.order - b.order)) {
    const channel = e.bytes[0]! & 0x0f;
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel)!.push({ tick: toSciTicks(e.tick), bytes: e.bytes });
  }
  const music = byChannel.get(CONTROL_CHANNEL);
  if (music) {
    const free = [...Array(15).keys()].find((c) => !byChannel.has(c));
    if (free === undefined) throw new AudioFileError("all 16 MIDI channels are used; SCI needs channel 16 for itself");
    byChannel.delete(CONTROL_CHANNEL);
    byChannel.set(free, music);
  }
  const channels = [...byChannel].sort((a, b) => a[0] - b[0]).map(([midiChannel, evs]) => ({ midiChannel, voices: 1, events: evs }));
  if (!channels.length) throw new AudioFileError("no notes in this MIDI file");
  return { tracks: [{ device: SoundDevice.GeneralMidi, channels }] };
}

/** A PCM WAV file (8- or 16-bit, mono or stereo) as mono 16-bit samples. */
export function readWav(data: Uint8Array): { samples: Int16Array; rate: number } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (at: number) => String.fromCharCode(...data.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new AudioFileError("not a WAV file");
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  for (let pos = 12; pos + 8 <= data.length; ) {
    const id = tag(pos), size = v.getUint32(pos + 4, true), body = pos + 8;
    if (id === "fmt ") {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
      if (fmt.format !== 1) throw new AudioFileError(`WAV format ${fmt.format} isn't supported (save as PCM)`);
      if (fmt.bits !== 8 && fmt.bits !== 16) throw new AudioFileError(`${fmt.bits}-bit WAV isn't supported (8 or 16)`);
      if (fmt.channels < 1 || fmt.channels > 2) throw new AudioFileError(`${fmt.channels} channels: mono or stereo only`);
      if (fmt.rate > 65535) throw new AudioFileError(`${fmt.rate} Hz is too high (65,535 at most; 22,050 is plenty)`);
    } else if (id === "data") {
      if (!fmt) throw new AudioFileError("WAV data before its format");
      const bytes = fmt.bits / 8, frames = Math.floor(Math.min(size, data.length - body) / bytes / fmt.channels);
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const at = body + (i * fmt.channels + c) * bytes;
          sum += fmt.bits === 16 ? v.getInt16(at, true) : (data[at]! - 128) << 8;
        }
        samples[i] = Math.round(sum / fmt.channels);
      }
      return { samples, rate: fmt.rate };
    }
    pos = body + size + (size & 1);
  }
  throw new AudioFileError("WAV file without data");
}
