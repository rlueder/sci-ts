/**
 * AudioWorklet running the OPL2 emulator. The main thread's AdLib driver posts register
 * writes as flat [reg, value, reg, value, ...] arrays; this renders the chip at its native
 * 49,716 Hz and linearly resamples to the AudioContext's rate.
 */
import { OPL_RATE, Opl2 } from "../../../packages/sci/src/audio/opl2.ts";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessorBase): void;
declare class AudioWorkletProcessorBase {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
const Base = (globalThis as unknown as { AudioWorkletProcessor: typeof AudioWorkletProcessorBase }).AudioWorkletProcessor;

class OplProcessor extends Base {
  private chip = new Opl2();
  private readonly one = new Float32Array(1);
  private prev = 0;
  private next = 0;
  private frac = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<number[] | "reset">) => {
      if (e.data === "reset") {
        this.chip = new Opl2();
        return;
      }
      const w = e.data;
      for (let i = 0; i + 1 < w.length; i += 2) this.chip.write(w[i]!, w[i + 1]!);
    };
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out?.[0]) return true;
    const step = OPL_RATE / sampleRate;
    const left = out[0];
    for (let i = 0; i < left.length; i++) {
      this.frac += step;
      while (this.frac >= 1) {
        this.prev = this.next;
        this.chip.generate(this.one, 0, 1);
        this.next = this.one[0]!;
        this.frac -= 1;
      }
      left[i] = this.prev + (this.next - this.prev) * this.frac;
    }
    for (let c = 1; c < out.length; c++) out[c]!.set(left);
    return true;
  }
}

registerProcessor("opl2", OplProcessor);
