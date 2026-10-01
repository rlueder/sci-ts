/**
 * Yamaha YM3812 (OPL2) FM synthesizer: the chip on AdLib and Sound Blaster cards.
 *
 * 9 channels, each with two operators: a *modulator* and a *carrier*. Each operator is a
 * sine-ish oscillator with its own envelope. In FM mode the modulator's output bends the
 * carrier's phase (that's where the metallic/brassy timbres come from); in additive mode
 * both are simply mixed. Sound is shaped entirely through register writes, exactly as the
 * game's AdLib driver did it in 1994.
 *
 * This is a behavioural model, not a gate-level one: it follows the documented register
 * layout and datasheet timings (log-domain attenuation in 0.1875 dB steps, a 10-bit sine
 * table, exponential attack, linear-in-dB decay) closely enough to sound like the chip.
 */
export const OPL_RATE = 49716; // 3.579545 MHz / 72

const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [8, 1, 2, 0];
/** Attenuation units are 0.1875 dB; 511 units ≈ 96 dB = silence. */
const ATT_MAX = 511;
const ATT_DB = 0.1875;

const SINE = new Float32Array(1024).map((_, i) => Math.sin(((i + 0.5) / 1024) * 2 * Math.PI));
const AMPLITUDE = new Float32Array(2048).map((_, u) => Math.pow(10, (-u * ATT_DB) / 20));

/** OPL2 waveforms: sine, half-sine, abs-sine, and "quarter" pulses of abs-sine. */
function wave(form: number, phase: number): number {
  const i = Math.floor(phase * 1024) & 1023;
  const s = SINE[i]!;
  switch (form) {
    case 1: return s > 0 ? s : 0;
    case 2: return Math.abs(s);
    case 3: return (i & 256) === 0 ? Math.abs(s) : 0;
    default: return s;
  }
}

enum Env { Attack, Decay, Sustain, Release, Off }

/** Datasheet timings (ms) for the slowest rate (effective rate 4); each +4 halves them. */
const ATTACK_MS = 2826.24;
const DECAY_MS = 39280.64;

function rateTime(baseMs: number, rate: number): number {
  if (rate < 4) return Infinity;
  const r = Math.min(rate, 60);
  return (baseMs * 4) / ((4 + (r & 3)) * Math.pow(2, (r >> 2) - 1));
}

class Operator {
  // Registers
  am = false;
  vib = false;
  sustained = false; // EG type: hold at sustain level until key-off
  ksr = false;
  mult = 1;
  ksl = 0;
  tl = 0;
  ar = 0;
  dr = 0;
  sl = 0;
  rr = 0;
  wave = 0;

  // State
  phase = 0; // in cycles, 0..1
  inc = 0; // cycles per sample
  att = ATT_MAX; // envelope attenuation, units of 0.1875 dB
  state = Env.Off;
  kslAtt = 0;
  keyCode = 0; // (block << 1) | fnum bit 9, for rate key scaling
  // Per-sample envelope steps, recomputed when rates or pitch change.
  attackK = 0;
  decayStep = 0;
  releaseStep = 0;

  private effectiveRate(r: number): number {
    return r === 0 ? 0 : Math.min(63, r * 4 + (this.ksr ? this.keyCode : this.keyCode >> 2));
  }

  updateRates(): void {
    const at = rateTime(ATTACK_MS, this.effectiveRate(this.ar));
    // Exponential attack: reach ~0 attenuation from full in `at`.
    this.attackK = this.effectiveRate(this.ar) >= 60 ? 1 : at === Infinity ? 0 : 1 - Math.pow(1 / 512, 1000 / (at * OPL_RATE));
    const step = (rate: number) => {
      const t = rateTime(DECAY_MS, this.effectiveRate(rate));
      return t === Infinity ? 0 : (ATT_MAX * 1000) / (t * OPL_RATE);
    };
    this.decayStep = step(this.dr);
    this.releaseStep = step(this.rr);
  }

  get sustainLevel(): number {
    return (this.sl === 15 ? 31 : this.sl) * 16; // 3 dB steps; 15 means 93 dB
  }

  keyOn(): void {
    this.phase = 0;
    this.state = Env.Attack;
  }

  keyOff(): void {
    if (this.state !== Env.Off) this.state = Env.Release;
  }

  stepEnvelope(): void {
    switch (this.state) {
      case Env.Attack:
        this.att -= (this.att + 1) * this.attackK;
        if (this.att <= 0) {
          this.att = 0;
          this.state = Env.Decay;
        }
        break;
      case Env.Decay:
        this.att += this.decayStep;
        if (this.att >= this.sustainLevel) {
          this.att = this.sustainLevel;
          this.state = Env.Sustain;
        }
        break;
      case Env.Sustain:
        // Percussive envelopes (EG type 0) keep falling at the release rate.
        if (!this.sustained) this.att += this.releaseStep;
        break;
      case Env.Release:
        this.att += this.releaseStep;
        break;
    }
    if (this.att >= ATT_MAX && this.state !== Env.Attack) {
      this.att = ATT_MAX;
      if (this.state === Env.Release || this.state === Env.Sustain) this.state = Env.Off;
    }
  }

  /** Output in -1..1 for a phase offset (modulation) in cycles. */
  output(mod: number, tremolo: number, waveEnabled: boolean): number {
    if (this.state === Env.Off) return 0;
    const att = this.att + this.tl * 4 + this.kslAtt + (this.am ? tremolo : 0);
    if (att >= ATT_MAX) return 0;
    return wave(waveEnabled ? this.wave : 0, this.phase + mod) * AMPLITUDE[att | 0]!;
  }
}

class Channel {
  readonly ops = [new Operator(), new Operator()] as const;
  fnum = 0;
  block = 0;
  keyOn = false;
  feedback = 0;
  additive = false;
  fb1 = 0;
  fb2 = 0;

  updatePitch(): void {
    const keyCode = (this.block << 1) | ((this.fnum >> 9) & 1);
    const kslBase = Math.max(0, KSL_ROM[this.fnum >> 6]! * 4 - (8 - this.block) * 32);
    for (const op of this.ops) {
      op.inc = (this.fnum * Math.pow(2, this.block) * MULT[op.mult]!) / (1 << 20);
      op.keyCode = keyCode;
      op.kslAtt = kslBase >> KSL_SHIFT[op.ksl]!;
      op.updateRates();
    }
  }
}

/** Operator register offsets 0x00-0x15 → (channel, operator), with gaps at 6-7 and 0x0e-0x0f. */
function slotFor(offset: number): [channel: number, op: 0 | 1] | undefined {
  const group = offset >> 3;
  const within = offset & 7;
  if (group > 2 || within > 5) return undefined;
  return [group * 3 + (within % 3), within >= 3 ? 1 : 0];
}

export class Opl2 {
  readonly channels = Array.from({ length: 9 }, () => new Channel());
  private waveSelect = false;
  private deepTremolo = false;
  private deepVibrato = false;
  private lfoTime = 0;

  write(reg: number, value: number): void {
    reg &= 0xff;
    value &= 0xff;
    if (reg === 0x01) {
      this.waveSelect = (value & 0x20) !== 0;
      return;
    }
    if (reg === 0xbd) {
      this.deepTremolo = (value & 0x80) !== 0;
      this.deepVibrato = (value & 0x40) !== 0;
      return;
    }
    const hi = reg & 0xe0;
    if (hi >= 0x20 && hi <= 0x80 || hi === 0xe0) {
      const slot = slotFor(reg & 0x1f);
      if (!slot) return;
      const ch = this.channels[slot[0]]!;
      const op = ch.ops[slot[1]];
      switch (hi) {
        case 0x20:
          op.am = (value & 0x80) !== 0;
          op.vib = (value & 0x40) !== 0;
          op.sustained = (value & 0x20) !== 0;
          op.ksr = (value & 0x10) !== 0;
          op.mult = value & 0x0f;
          ch.updatePitch();
          break;
        case 0x40:
          op.ksl = value >> 6;
          op.tl = value & 0x3f;
          ch.updatePitch();
          break;
        case 0x60:
          op.ar = value >> 4;
          op.dr = value & 0x0f;
          op.updateRates();
          break;
        case 0x80:
          op.sl = value >> 4;
          op.rr = value & 0x0f;
          op.updateRates();
          break;
        case 0xe0:
          op.wave = value & 3;
          break;
      }
      return;
    }
    const c = reg & 0x0f;
    if (c > 8) return;
    const ch = this.channels[c]!;
    switch (reg & 0xf0) {
      case 0xa0:
        ch.fnum = (ch.fnum & 0x300) | value;
        ch.updatePitch();
        break;
      case 0xb0: {
        ch.fnum = (ch.fnum & 0xff) | ((value & 3) << 8);
        ch.block = (value >> 2) & 7;
        ch.updatePitch();
        const on = (value & 0x20) !== 0;
        if (on && !ch.keyOn) for (const op of ch.ops) op.keyOn();
        if (!on && ch.keyOn) for (const op of ch.ops) op.keyOff();
        ch.keyOn = on;
        break;
      }
      case 0xc0:
        ch.feedback = (value >> 1) & 7;
        ch.additive = (value & 1) !== 0;
        break;
    }
  }

  /** Renders `count` mono samples at OPL_RATE into `out` starting at `offset`. */
  generate(out: Float32Array, offset = 0, count = out.length - offset): void {
    const tremoloDepth = this.deepTremolo ? 4.8 / ATT_DB : 1 / ATT_DB;
    const vibratoCents = this.deepVibrato ? 14 : 7;
    for (let n = 0; n < count; n++) {
      this.lfoTime += 1 / OPL_RATE;
      const tremolo = tremoloDepth * (0.5 - 0.5 * Math.cos(2 * Math.PI * 3.7 * this.lfoTime));
      const vibrato = Math.pow(2, (vibratoCents * Math.sin(2 * Math.PI * 6.07 * this.lfoTime)) / 1200);
      let mix = 0;
      for (const ch of this.channels) {
        const [mod, car] = ch.ops;
        if (mod.state === Env.Off && car.state === Env.Off) continue;
        const fb = ch.feedback ? (ch.fb1 + ch.fb2) * Math.pow(2, ch.feedback - 7) : 0;
        const m = mod.output(fb, tremolo, this.waveSelect);
        ch.fb2 = ch.fb1;
        ch.fb1 = m;
        // Full-scale modulator output shifts the carrier's phase by ±4 cycles, as on the chip.
        const c = car.output(ch.additive ? 0 : m * 4, tremolo, this.waveSelect);
        mix += ch.additive ? m + c : c;
        for (const op of ch.ops) {
          op.phase = (op.phase + op.inc * (op.vib ? vibrato : 1)) % 1;
          op.stepEnvelope();
        }
      }
      // Each channel peaks at ~1/8 of the DAC's range; the sum can clip, as on real cards.
      out[offset + n] = Math.max(-1, Math.min(1, mix * 0.125 * 2));
    }
  }
}
