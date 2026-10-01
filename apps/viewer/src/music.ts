import type { MidiOutput } from "@sci-ts/sci";
import { WorkletSynthesizer } from "spessasynth_lib";
import processorUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";

/**
 * General MIDI output through a SoundFont synthesizer (SpessaSynth, in an AudioWorklet).
 * Messages sent before the SoundFont has loaded are dropped, as a real MIDI device that
 * isn't powered on yet would; the game re-sends program/volume setup on each song start.
 */
export class SoundFontMidi implements MidiOutput {
  private synth: WorkletSynthesizer | undefined;

  constructor(private readonly ctx: AudioContext) {}

  async load(soundFontUrl: string): Promise<void> {
    const res = await fetch(soundFontUrl);
    if (!res.ok) throw new Error(`no SoundFont at ${soundFontUrl} (${res.status}): music is silent`);
    const bank = await res.arrayBuffer();
    await this.ctx.audioWorklet.addModule(processorUrl);
    const synth = new WorkletSynthesizer(this.ctx);
    synth.connect(this.ctx.destination);
    await synth.soundBankManager.addSoundBank(bank, "main");
    await synth.isReady;
    this.synth = synth;
  }

  get ready(): boolean {
    return this.synth !== undefined;
  }

  send(bytes: number[]): void {
    this.synth?.sendMessage(bytes);
  }
}
