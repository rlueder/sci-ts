import type { MidiOutput } from "./midi.ts";
import { OPL_RATE } from "./opl2.ts";

/** Anything that accepts OPL register writes: the emulator, or a queue to a worklet. */
export interface OplChip {
  write(reg: number, value: number): void;
}

interface OperatorPatch {
  ksl: number;
  mult: number;
  attack: number;
  sustainLevel: number;
  sustained: number;
  decay: number;
  release: number;
  level: number; // total level: 0 = loudest, 63 = silent
  am: number;
  vibrato: number;
  ksr: number;
  wave: number;
}

export interface AdLibInstrument {
  mod: OperatorPatch;
  car: OperatorPatch;
  feedback: number;
  fm: boolean;
}

export interface AdLibBank {
  instruments: AdLibInstrument[];
  /** Channel 9 note → pitch to play its percussion instrument at (notes 27..88). */
  rhythmKeyMap: Uint8Array | undefined;
}

/**
 * Parses the AdLib instrument bank (patch resource 3). SCI1.1/SCI2 banks are 190 × 28-byte
 * instruments followed by a 62-byte rhythm key map (5,382 bytes); older ones have 48 or 96.
 *
 * Instrument: modulator (13 bytes) + carrier (13 bytes) + 2 waveform bytes. Operator bytes:
 * KSL, MULT, FB, AR, SL, EGT, DR, RR, TL, AM, VIB, KSR, CON. FB and CON are only meaningful
 * on the modulator; CON = 1 means FM (the chip's register bit is the inverse).
 */
export function parseAdLibBank(data: Uint8Array): AdLibBank {
  const count = Math.floor(Math.min(data.length, 190 * 28) / 28);
  const op = (b: Uint8Array, wave: number): OperatorPatch => ({
    ksl: b[0]! & 3,
    mult: b[1]! & 0x0f,
    attack: b[3]! & 0x0f,
    sustainLevel: b[4]! & 0x0f,
    sustained: b[5]! ? 1 : 0,
    decay: b[6]! & 0x0f,
    release: b[7]! & 0x0f,
    level: b[8]! & 0x3f,
    am: b[9]! ? 1 : 0,
    vibrato: b[10]! ? 1 : 0,
    ksr: b[11]! ? 1 : 0,
    wave: wave & 3,
  });
  const instruments = Array.from({ length: count }, (_, i) => {
    const b = data.subarray(i * 28, i * 28 + 28);
    return { mod: op(b.subarray(0, 13), b[26]!), car: op(b.subarray(13, 26), b[27]!), feedback: b[2]! & 7, fm: b[12] === 1 };
  });
  return { instruments, rhythmKeyMap: data.length >= 190 * 28 + 62 ? data.slice(190 * 28, 190 * 28 + 62) : undefined };
}

/** Maps MIDI note velocity (0..63) onto the driver's level curve (from Sierra's SCI1.1 driver). */
const VELOCITY_MAP = [
  0x00, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x12, 0x13, 0x14, 0x16, 0x17, 0x18, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x2f, 0x30, 0x31, 0x32,
  0x32, 0x33, 0x34, 0x34, 0x35, 0x36, 0x36, 0x37, 0x38, 0x38, 0x39, 0x3a, 0x3a, 0x3b, 0x3b, 0x3c, 0x3c, 0x3c, 0x3d,
  0x3d, 0x3d, 0x3e, 0x3e, 0x3e, 0x3e, 0x3f,
];

/** Operator register offsets of each of the 9 voices' modulators (carrier = +3). */
const VOICE_OFFSET = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];
const VOICES = 9;
const RHYTHM_CHANNEL = 9;
const BEND_RANGE = 2; // semitones

interface Voice {
  channel: number; // -1 = unassigned
  note: number; // -1 = free
  patch: number;
  velocity: number;
  age: number;
  sustained: boolean;
  keyOn: boolean;
}

interface ChannelState {
  patch: number;
  volume: number;
  pan: number;
  hold: boolean;
  pitchWheel: number;
  lastVoice: number;
  velocityEnabled: boolean;
  /** Voices claimed by songs but not yet available. */
  wanted: number;
}

/**
 * Sierra's AdLib driver, reimplemented: turns MIDI into OPL2 register writes.
 * The chip has 9 voices; Sierra's AdLib arrangements ask for a fixed number per channel
 * (1 each in the scores we tested), and a channel steals its own oldest voice when it runs out.
 */
export class AdLibDriver implements MidiOutput {
  private readonly voices: Voice[] = Array.from({ length: VOICES }, () => ({ channel: -1, note: -1, patch: -1, velocity: 0, age: 0, sustained: false, keyOn: false }));
  private readonly channels: ChannelState[] = Array.from({ length: 16 }, () => ({
    patch: 0, volume: 63, pan: 64, hold: false, pitchWheel: 8192, lastVoice: 0, velocityEnabled: false, wanted: 0,
  }));
  private masterVolume = 15;

  constructor(
    private readonly chip: OplChip,
    private readonly bank: AdLibBank,
  ) {
    chip.write(0x01, 0x20); // enable waveform select
    chip.write(0xbd, 0x00); // melodic mode, shallow tremolo/vibrato
    for (let v = 0; v < VOICES; v++) chip.write(0xb0 + v, 0);
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = volume & 0x0f;
    for (let v = 0; v < VOICES; v++) if (this.voices[v]!.note !== -1) this.updateLevels(v);
  }

  /** Voice mapping: give `channel` `count` more voices (negative releases them). */
  claimVoices(channel: number, count: number): void {
    const ch = this.channels[channel]!;
    if (count < 0) {
      let release = -count;
      for (let v = VOICES - 1; v >= 0 && release > 0; v--) {
        if (this.voices[v]!.channel === channel) {
          this.voiceOff(v);
          this.voices[v]!.channel = -1;
          release--;
        }
      }
      ch.wanted = Math.max(0, ch.wanted - release);
      return;
    }
    ch.wanted += count;
    this.assignFreeVoices();
  }

  private assignFreeVoices(): void {
    for (let c = 0; c < 16; c++) {
      const ch = this.channels[c]!;
      for (let v = 0; v < VOICES && ch.wanted > 0; v++) {
        if (this.voices[v]!.channel === -1) {
          this.voices[v]!.channel = c;
          ch.wanted--;
        }
      }
    }
  }

  send(bytes: number[]): void {
    const [status = 0, a = 0, b = 0] = bytes;
    const channel = status & 0x0f;
    const ch = this.channels[channel]!;
    switch (status & 0xf0) {
      case 0x80: return this.noteOff(channel, a);
      case 0x90: return b === 0 ? this.noteOff(channel, a) : this.noteOn(channel, a, b);
      case 0xc0:
        ch.patch = a;
        return;
      case 0xe0:
        ch.pitchWheel = (b << 7) | a;
        for (let v = 0; v < VOICES; v++) {
          const voice = this.voices[v]!;
          if (voice.channel === channel && voice.note !== -1) this.setNote(v, voice.note, voice.keyOn);
        }
        return;
      case 0xb0:
        switch (a) {
          case 7: // volume
            ch.volume = b;
            for (let v = 0; v < VOICES; v++) if (this.voices[v]!.channel === channel && this.voices[v]!.note !== -1) this.updateLevels(v);
            return;
          case 10:
            ch.pan = b;
            return;
          case 64: // hold pedal
            ch.hold = b !== 0;
            if (!ch.hold) {
              for (let v = 0; v < VOICES; v++) {
                const voice = this.voices[v]!;
                if (voice.channel === channel && voice.sustained) (voice.sustained = false), this.voiceOff(v);
              }
            }
            return;
          case 0x4e: // velocity sensitivity on/off
            ch.velocityEnabled = b !== 0;
            return;
          case 123: // all notes off
            for (let v = 0; v < VOICES; v++) if (this.voices[v]!.channel === channel) this.voiceOff(v);
            return;
        }
    }
  }

  private noteOn(channel: number, note: number, velocity: number): void {
    const vel = VELOCITY_MAP[velocity >> 1]!;
    // Retrigger if this note is already sounding on the channel.
    for (let v = 0; v < VOICES; v++) {
      const voice = this.voices[v]!;
      if (voice.channel === channel && voice.note === note) {
        this.voiceOff(v);
        return this.voiceOn(v, note, vel);
      }
    }
    const v = this.findVoice(channel);
    if (v !== -1) this.voiceOn(v, note, vel);
  }

  private noteOff(channel: number, note: number): void {
    for (let v = 0; v < VOICES; v++) {
      const voice = this.voices[v]!;
      if (voice.channel !== channel || voice.note !== note) continue;
      if (this.channels[channel]!.hold) voice.sustained = true;
      else this.voiceOff(v);
    }
  }

  /** A free voice owned by the channel, else its oldest; else any unowned voice. */
  private findVoice(channel: number): number {
    const ch = this.channels[channel]!;
    let oldest = -1;
    for (let i = 0; i < VOICES; i++) {
      const v = (ch.lastVoice + i + 1) % VOICES;
      const voice = this.voices[v]!;
      if (voice.channel !== channel) continue;
      if (voice.note === -1) return (ch.lastVoice = v);
      if (oldest === -1 || voice.age > this.voices[oldest]!.age) oldest = v;
    }
    if (oldest !== -1) {
      this.voiceOff(oldest);
      return (ch.lastVoice = oldest);
    }
    // Channel has no voices of its own (e.g. never claimed): borrow an idle unowned one.
    const idle = this.voices.findIndex((voice) => voice.channel === -1 && voice.note === -1);
    if (idle !== -1) this.voices[idle]!.channel = channel;
    return idle;
  }

  private voiceOn(v: number, note: number, velocity: number): void {
    const voice = this.voices[v]!;
    const channel = voice.channel;
    for (const other of this.voices) other.age++;
    voice.age = 0;
    const rhythm = channel === RHYTHM_CHANNEL && this.bank.rhythmKeyMap;
    const patch = rhythm ? Math.min(Math.max(note, 27), 88) + 101 : this.channels[channel]!.patch;
    if (patch !== voice.patch) this.setPatch(v, patch);
    voice.velocity = velocity;
    voice.note = note;
    this.updateLevels(v);
    this.setNote(v, note, true);
  }

  private voiceOff(v: number): void {
    const voice = this.voices[v]!;
    voice.note = -1;
    voice.sustained = false;
    if (voice.keyOn) {
      voice.keyOn = false;
      this.chip.write(0xb0 + v, this.lastB0[v]! & ~0x20);
    }
  }

  private readonly lastB0 = new Array<number>(VOICES).fill(0);

  private setNote(v: number, note: number, keyOn: boolean): void {
    const voice = this.voices[v]!;
    const channel = voice.channel;
    let pitch = note;
    const map = this.bank.rhythmKeyMap;
    if (channel === RHYTHM_CHANNEL && map) pitch = map[Math.min(Math.max(note, 27), 88) - 27]!;
    const bend = ((this.channels[channel]!.pitchWheel - 8192) / 8192) * BEND_RANGE;
    const freq = 440 * Math.pow(2, (pitch + bend - 69) / 12);
    let block = Math.min(7, Math.max(0, Math.floor(pitch / 12) - 1));
    let fnum = Math.round((freq * (1 << 20)) / (OPL_RATE * (1 << block)));
    while (fnum > 1023 && block < 7) fnum = Math.round((freq * (1 << 20)) / (OPL_RATE * (1 << ++block)));
    fnum = Math.min(fnum, 1023);
    this.chip.write(0xa0 + v, fnum & 0xff);
    const b0 = (keyOn ? 0x20 : 0) | (block << 2) | (fnum >> 8);
    this.lastB0[v] = b0;
    this.chip.write(0xb0 + v, b0);
    voice.keyOn = keyOn;
  }

  private setPatch(v: number, patch: number): void {
    const ins = this.bank.instruments[patch] ?? this.bank.instruments[0];
    if (!ins) return;
    this.voices[v]!.patch = patch;
    const base = VOICE_OFFSET[v]!;
    for (const [offset, op] of [[base, ins.mod], [base + 3, ins.car]] as const) {
      this.chip.write(0x20 + offset, (op.am << 7) | (op.vibrato << 6) | (op.sustained << 5) | (op.ksr << 4) | op.mult);
      this.chip.write(0x40 + offset, (op.ksl << 6) | op.level);
      this.chip.write(0x60 + offset, (op.attack << 4) | op.decay);
      this.chip.write(0x80 + offset, (op.sustainLevel << 4) | op.release);
      this.chip.write(0xe0 + offset, op.wave);
    }
    this.chip.write(0xc0 + v, (ins.feedback << 1) | (ins.fm ? 0 : 1));
  }

  /**
   * Output level = master × note (or instrument) level × channel volume. In FM mode only the
   * carrier's level changes loudness (the modulator's sets the timbre); additive voices
   * scale both operators.
   */
  private updateLevels(v: number): void {
    const voice = this.voices[v]!;
    const ins = this.bank.instruments[voice.patch];
    if (!ins) return;
    const ch = this.channels[voice.channel]!;
    const master = this.masterVolume > 0 ? Math.min(this.masterVolume + 3, 15) : 0;
    const level = (op: OperatorPatch) => {
      const base = ch.velocityEnabled ? voice.velocity : 63 - op.level;
      return 63 - ((master * base * (ch.volume + 1)) >> 11);
    };
    const offset = VOICE_OFFSET[v]!;
    this.chip.write(0x40 + offset + 3, (ins.car.ksl << 6) | level(ins.car));
    if (!ins.fm) this.chip.write(0x40 + offset, (ins.mod.ksl << 6) | level(ins.mod));
  }
}
