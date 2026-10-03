import { AdLibDriver, type AdLibBank, type MidiOutput } from "@sci-ts/sci";
import workletUrl from "./opl-worklet.ts?worker&url";

/**
 * AdLib music: Sierra's driver runs here and batches OPL register writes to the chip
 * emulator in an AudioWorklet (flushed once per microtask, i.e. per burst of MIDI events).
 */
export class AdLibOutput implements MidiOutput {
  private driver: AdLibDriver;
  private queue: number[] = [];
  private flushScheduled = false;

  private constructor(
    private readonly node: AudioWorkletNode,
    private readonly bank: AdLibBank,
  ) {
    this.driver = this.newDriver();
  }

  static async create(ctx: AudioContext, bank: AdLibBank, out: AudioNode = ctx.destination): Promise<AdLibOutput> {
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "opl2", { outputChannelCount: [2] });
    node.connect(out);
    return new AdLibOutput(node, bank);
  }

  private newDriver(): AdLibDriver {
    const chip = {
      write: (reg: number, value: number) => {
        this.queue.push(reg, value);
        if (!this.flushScheduled) {
          this.flushScheduled = true;
          queueMicrotask(() => {
            this.flushScheduled = false;
            this.node.port.postMessage(this.queue);
            this.queue = [];
          });
        }
      },
    };
    return new AdLibDriver(chip, this.bank);
  }

  /** Silences the chip and starts from a clean driver (used when switching devices). */
  reset(): void {
    this.queue = [];
    this.node.port.postMessage("reset");
    this.driver = this.newDriver();
  }

  send(bytes: number[]): void {
    this.driver.send(bytes);
  }

  claimVoices(channel: number, count: number): void {
    this.driver.claimVoices(channel, count);
  }

  setMasterVolume(volume: number): void {
    this.driver.setMasterVolume(volume);
  }
}
