import { decodeSol, type AudioClip, type AudioOutput, type FileSource } from "@sci-ts/sci";

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
  buffer: AudioBuffer;
  startedAt: number;
  offset: number;
  loop: boolean;
}

/**
 * Plays digital clips through Web Audio. Clips are fetched (HTTP range requests into the
 * 515 MB RESOURCE.AUD), decoded from SOL and cached. Browsers only allow audio after a
 * user gesture, so `unlock()` must be called from a click/keypress handler.
 */
export class WebAudioOutput implements AudioOutput {
  readonly ctx = new AudioContext();
  private readonly buffers = new Map<string, Promise<AudioBuffer | undefined>>();
  private readonly playing = new Map<string, Playing>();
  private readonly paused = new Map<string, Playing>();
  /** Incremented per play/stop so late-arriving decodes don't start stale clips. */
  private readonly tokens = new Map<string, number>();

  constructor(
    private readonly files: FileSource,
    private readonly preloaded: (file: string) => Uint8Array | undefined,
  ) {}

  unlock(): void {
    if (this.ctx.state !== "running") void this.ctx.resume();
  }

  private load(clip: AudioClip): Promise<AudioBuffer | undefined> {
    const key = `${clip.file}:${clip.offset}`;
    let p = this.buffers.get(key);
    if (!p) {
      p = (async () => {
        const whole = this.preloaded(clip.file);
        const bytes = whole ? whole.subarray(clip.offset, clip.offset + clip.length) : await this.files.readRange(clip.file, clip.offset, clip.length);
        const sol = decodeSol(bytes);
        if (!sol || !sol.samples.length) return undefined;
        const frames = sol.samples.length / sol.channels;
        const buffer = this.ctx.createBuffer(sol.channels, frames, sol.rate);
        for (let c = 0; c < sol.channels; c++) {
          const data = buffer.getChannelData(c);
          for (let i = 0; i < frames; i++) data[i] = sol.samples[i * sol.channels + c]!;
        }
        return buffer;
      })();
      this.buffers.set(key, p);
    }
    return p;
  }

  private startNode(channel: string, buffer: AudioBuffer, offset: number, loop: boolean, volume: number): void {
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    gain.connect(this.ctx.destination);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(gain);
    source.onended = () => {
      if (this.playing.get(channel)?.source === source) this.playing.delete(channel);
    };
    source.start(0, offset);
    this.playing.set(channel, { source, gain, buffer, startedAt: this.ctx.currentTime - offset, offset, loop });
  }

  play(channel: string, clip: AudioClip, { loop, volume }: { loop: boolean; volume: number }): void {
    this.stop(channel);
    const token = (this.tokens.get(channel) ?? 0) + 1;
    this.tokens.set(channel, token);
    void this.load(clip).then((buffer) => {
      if (!buffer || this.tokens.get(channel) !== token) return;
      this.startNode(channel, buffer, 0, loop, volume);
    });
  }

  stop(channel: string): void {
    this.tokens.set(channel, (this.tokens.get(channel) ?? 0) + 1);
    this.paused.delete(channel);
    const p = this.playing.get(channel);
    if (!p) return;
    this.playing.delete(channel);
    p.source.onended = null;
    p.source.stop();
    p.gain.disconnect();
  }

  pause(channel: string): void {
    const p = this.playing.get(channel);
    if (!p) return;
    this.stop(channel);
    this.paused.set(channel, { ...p, offset: (this.ctx.currentTime - p.startedAt) % p.buffer.duration });
  }

  resume(channel: string): void {
    const p = this.paused.get(channel);
    if (!p) return;
    this.paused.delete(channel);
    this.startNode(channel, p.buffer, p.offset, p.loop, p.gain.gain.value);
  }

  setVolume(channel: string, volume: number): void {
    const p = this.playing.get(channel);
    if (p) p.gain.gain.value = volume;
  }
}
