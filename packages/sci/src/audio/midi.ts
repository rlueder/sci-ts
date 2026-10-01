/**
 * SCI1.1/SCI2 sound resources and a sequencer for them.
 *
 * Resource layout:
 *   [0xF0 priority, 6 unused]         optional 8-byte header
 *   tracks until 0xFF:  u8 device, then 6-byte channel entries until 0xFF:
 *                       u16 unused, u16 offset, u16 size
 * Devices: 0x00 AdLib, 0x07 General MIDI, 0x0C MT-32 (plus a few others).
 * Each channel stream: u8 channel (low nibble = MIDI channel), u8 priority/voices,
 * then [delta][event]... where delta bytes of 0xF8 each add 240 ticks (1/60 s), and
 * events are MIDI messages with running status. 0xFC ends the stream.
 *
 * Channel 15 is Sierra's control channel: program change N sets the sound object's
 * signal to N (127 marks the loop point instead), controller 0x60 is a "cue".
 */
export const SoundDevice = { AdLib: 0x00, GeneralMidi: 0x07, Mt32: 0x0c } as const;

const CONTROL_CHANNEL = 15;
const LOOP_MARKER = 127;
const CUE_CONTROLLER = 0x60;

export interface MidiEvent {
  tick: number;
  /** Raw MIDI bytes, e.g. [0x91, 60, 100]. */
  bytes: number[];
}

export interface SongChannel {
  midiChannel: number;
  /** Voices this channel wants from a voice-limited device (AdLib: 9 in total). */
  voices: number;
}

export interface Song {
  priority: number;
  channels: SongChannel[];
  /** All channels merged, sorted by tick. */
  events: MidiEvent[];
  /** Tick where the last event ends. */
  length: number;
}

const dataBytes = (status: number) => ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2);

function readChannel(data: Uint8Array, start: number, end: number, midiChannel: number, out: MidiEvent[]): number {
  let pos = start;
  let tick = 0;
  let running = 0;
  while (pos < end) {
    // Delta time.
    let b = data[pos++]!;
    while (b === 0xf8 && pos < end) {
      tick += 240;
      b = data[pos++]!;
    }
    tick += b;
    if (pos >= end) break;

    let status = data[pos]!;
    if (status === 0xfc) break; // end of stream
    if (status & 0x80) pos++;
    else status = running; // running status: this byte is data
    if (status === 0xf0) {
      while (pos < end && data[pos] !== 0xf7) pos++; // skip sysex
      pos++;
      continue;
    }
    if (status === 0xff) {
      pos += 1; // meta type
      const len = data[pos++]!;
      pos += len;
      continue;
    }
    if (status < 0x80) break; // corrupt stream
    running = status;
    const n = dataBytes(status);
    const bytes = [(status & 0xf0) | midiChannel];
    for (let i = 0; i < n; i++) bytes.push(data[pos++]! & 0x7f);
    out.push({ tick, bytes });
  }
  return tick;
}

/** Parses the track for `device` (falling back to MT-32, then any), merging its channels. */
export function parseSound(data: Uint8Array, device: number = SoundDevice.GeneralMidi): Song | undefined {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  let priority = 0;
  if (data[0] === 0xf0) {
    priority = data[1]!;
    pos = 8;
  }
  const tracks = new Map<number, { offset: number; size: number }[]>();
  while (pos < data.length && data[pos] !== 0xff) {
    const type = data[pos++]!;
    const channels: { offset: number; size: number }[] = [];
    while (pos + 6 <= data.length && data[pos] !== 0xff) {
      channels.push({ offset: v.getUint16(pos + 2, true), size: v.getUint16(pos + 4, true) });
      pos += 6;
    }
    pos++;
    tracks.set(type, channels);
  }
  const channels = tracks.get(device) ?? tracks.get(SoundDevice.Mt32);
  if (!channels?.length) return undefined;

  const events: MidiEvent[] = [];
  const songChannels: SongChannel[] = [];
  let length = 0;
  for (const { offset, size } of channels) {
    if (!size || offset + 2 > data.length) continue;
    const midiChannel = data[offset]! & 0x0f;
    if (midiChannel !== CONTROL_CHANNEL) songChannels.push({ midiChannel, voices: data[offset + 1]! & 0x0f });
    length = Math.max(length, readChannel(data, offset + 2, Math.min(data.length, offset + size), midiChannel, events));
  }
  // Stable sort keeps each channel's order for events on the same tick.
  events.sort((a, b) => a.tick - b.tick);
  return { priority, channels: songChannels, events, length };
}

/** Where MIDI bytes go: a SoundFont synth or the AdLib driver. */
export interface MidiOutput {
  send(bytes: number[]): void;
  /** Voice-limited devices: a song claims (or, with a negative count, releases) voices. */
  claimVoices?(channel: number, count: number): void;
  setMasterVolume?(volume: number): void;
}

/** Signal values scripts see on the sound object. */
export const SongSignal = { Finished: 0xffff } as const;

/**
 * Plays one song against a tick clock. Tracks the control channel so the kernel can
 * report cues/signals, loops at the loop marker, and silences its notes when stopped.
 */
export class SongPlayer {
  private index = 0;
  private startTick = 0;
  private loopIndex = 0;
  private loopTick = 0;
  private readonly held = new Set<number>(); // channel << 8 | note
  /** Last channel volume (CC 7) the song asked for, to rescale on volume changes. */
  private readonly channelVolume = new Map<number, number>();
  finished = false;
  /** Latest control-channel signal not yet reported (0 = none). */
  signal = 0;
  dataInc = 0;
  private paused: number | undefined;

  constructor(
    readonly song: Song,
    private readonly output: MidiOutput | undefined,
    public loop: boolean,
    public volume: number, // 0..127
    now: number,
  ) {
    this.startTick = now;
    for (const c of song.channels) output?.claimVoices?.(c.midiChannel, c.voices);
  }

  /** Sends every event due by tick `now`. */
  update(now: number): void {
    if (this.finished || this.paused !== undefined) return;
    const pos = now - this.startTick;
    const events = this.song.events;
    while (this.index < events.length && events[this.index]!.tick <= pos) {
      this.dispatch(events[this.index]!, this.index);
      this.index++;
    }
    if (this.index >= events.length && pos >= this.song.length) {
      if (this.loop) {
        this.silence();
        this.index = this.loopIndex;
        this.startTick = now - this.loopTick;
      } else {
        this.stop();
        this.finished = true;
        this.signal = SongSignal.Finished;
      }
    }
  }

  private dispatch(e: MidiEvent, index: number): void {
    const [status = 0, a = 0, b = 0] = e.bytes;
    const channel = status & 0x0f;
    const type = status & 0xf0;
    if (channel === CONTROL_CHANNEL) {
      if (type === 0xc0) {
        if (a === LOOP_MARKER) {
          this.loopIndex = index + 1;
          this.loopTick = e.tick;
        } else if (e.tick > 0) this.signal = a;
      } else if (type === 0xb0 && a === CUE_CONTROLLER) {
        this.dataInc++;
        this.signal = this.dataInc + 127;
      }
      return;
    }
    if (type === 0x90 && b > 0) this.held.add((channel << 8) | a);
    else if (type === 0x80 || type === 0x90) this.held.delete((channel << 8) | a);
    // Scale channel volume by the sound object's volume.
    if (type === 0xb0 && a === 7) {
      this.channelVolume.set(channel, b);
      return this.output?.send([status, a, Math.round((b * this.volume) / 127)]);
    }
    this.output?.send(e.bytes);
  }

  /** Releases every note this song is holding. */
  private silence(): void {
    for (const key of this.held) this.output?.send([0x80 | (key >> 8), key & 0xff, 0]);
    this.held.clear();
  }

  private released = false;

  stop(): void {
    this.silence();
    if (this.released) return;
    this.released = true;
    for (const c of this.song.channels) this.output?.claimVoices?.(c.midiChannel, -c.voices);
  }

  /** Position in ticks. */
  position(now: number): number {
    return (this.paused ?? now) - this.startTick;
  }

  /**
   * Jumps to `pos` ticks without sounding notes: replays program, controller and pitch
   * events so the (possibly new) output is in the right state. Used when switching devices.
   */
  seek(pos: number, now: number): void {
    const events = this.song.events;
    this.index = 0;
    while (this.index < events.length && events[this.index]!.tick <= pos) {
      const e = events[this.index]!;
      const type = e.bytes[0]! & 0xf0;
      if (type !== 0x90 && type !== 0x80) this.dispatch(e, this.index);
      this.index++;
    }
    this.signal = 0;
    this.startTick = now - pos;
  }

  pause(now: number): void {
    if (this.paused !== undefined) return;
    this.paused = now;
    this.silence();
  }

  resume(now: number): void {
    if (this.paused === undefined) return;
    this.startTick += now - this.paused;
    this.paused = undefined;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    for (const [channel, v] of this.channelVolume) this.output?.send([0xb0 | channel, 7, Math.round((v * volume) / 127)]);
  }
}
