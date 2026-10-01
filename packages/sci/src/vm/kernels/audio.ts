import { AudioIndex, speechKey, type AudioClip, type AudioOutput } from "../../audio/index.ts";
import { SongPlayer, SoundDevice, parseSound, type MidiOutput, type Song } from "../../audio/midi.ts";
import { ResourceType } from "../../resource/types.ts";
import { findMessage, parseMessages, type MessageFile } from "../../text/message.ts";
import type { KernelFn, Vm } from "../vm.ts";
import { toSigned, type Value } from "../value.ts";

const NOT_PLAYING = 0xffff;
const MAX_VOLUME = 127;

interface Channel {
  clip: AudioClip;
  /** VM clock (ms) when playback started; undefined while waiting to start. */
  start: number | undefined;
  pausedAt: number | undefined;
  ticks: number;
  loop: boolean;
  volume: number;
}

/**
 * Digital audio state. Durations are known synchronously from the index, so the scripts'
 * position polling works off the VM clock; the host's AudioOutput does the actual playback
 * (fetching and decoding clips asynchronously).
 */
export class AudioState {
  readonly index: AudioIndex;
  readonly channels = new Map<string, Channel>();
  output: AudioOutput | undefined;
  /** MIDI music goes here (a SoundFont synth or the AdLib driver). */
  midi: MidiOutput | undefined;
  /** Which track of each sound resource to play: General MIDI or AdLib. */
  device: number = SoundDevice.GeneralMidi;
  readonly songs = new Map<Value, SongPlayer>();
  private readonly songNumbers = new Map<Value, number>();
  private readonly songCache = new Map<string, Song | null>();
  masterVolume = 15;
  /**
   * Ticks to report when a speech clip doesn't exist (new dialogue in a mod). The game times
   * a spoken line by its clip, so a missing clip would flash the text for a second; hosts
   * that load mods set this (see `readingTime`). Unset, missing clips report 0 like SSCI.
   */
  missingSpeechTicks?: (module: number, noun: number, verb: number, cond: number, seq: number) => number;

  constructor(private readonly vm: Vm) {
    this.index = AudioIndex.build(vm.resources);
    vm.frameHooks.push(() => {
      const now = this.ticks();
      for (const player of this.songs.values()) player.update(now);
    });
  }

  ticks(): number {
    return Math.floor((this.vm.clock() * 60) / 1000);
  }

  song(number: number, device = this.device): Song | undefined {
    const key = `${number}:${device}`;
    if (!this.songCache.has(key)) {
      const id = { type: ResourceType.Sound, number };
      this.songCache.set(key, this.vm.resources.has(id) ? (parseSound(this.vm.resources.loadSync(id).data, device) ?? null) : null);
    }
    return this.songCache.get(key) ?? undefined;
  }

  startSong(obj: Value, number: number, loop: boolean, volume: number, position = 0): void {
    const song = this.song(number);
    if (!song) return;
    const player = new SongPlayer(song, this.midi, loop, volume, this.ticks());
    if (position) player.seek(position % Math.max(song.length, 1), this.ticks());
    this.songs.set(obj, player);
    this.songNumbers.set(obj, number);
  }

  playingSongs(): { object: Value; number: number; player: SongPlayer }[] {
    return [...this.songs].map(([object, player]) => ({ object, number: this.songNumbers.get(object)!, player }));
  }

  /** Silences all music, effects and speech (restart / restore). */
  stopEverything(): void {
    for (const obj of [...this.songs.keys()]) this.stopSong(obj);
    for (const key of [...this.channels.keys()]) this.stop(key);
  }

  stopSong(obj: Value): void {
    this.songs.get(obj)?.stop();
    this.songs.delete(obj);
    this.songNumbers.delete(obj);
  }

  /**
   * Switches music to another device (track) and output, carrying every playing song over
   * at its current position.
   */
  setMusicDevice(device: number, output: MidiOutput | undefined): void {
    const now = this.ticks();
    const playing = [...this.songs].map(([obj, player]) => ({ obj, player, pos: player.position(now) }));
    for (const { player } of playing) player.stop();
    this.device = device;
    this.midi = output;
    output?.setMasterVolume?.(this.masterVolume);
    for (const { obj, player, pos } of playing) {
      const song = this.song(this.songNumbers.get(obj)!);
      if (!song) {
        this.songs.delete(obj);
        continue;
      }
      const next = new SongPlayer(song, output, player.loop, player.volume, now);
      next.seek(song.length ? pos % Math.max(song.length, 1) : 0, now);
      this.songs.set(obj, next);
    }
  }

  play(key: string, clip: AudioClip, loop: boolean, volume: number, autoStart = true): number {
    this.stop(key);
    const ticks = AudioIndex.ticks(clip);
    this.channels.set(key, { clip, start: undefined, pausedAt: undefined, ticks, loop, volume });
    if (autoStart) this.start(key);
    return ticks;
  }

  start(key: string): void {
    const ch = this.channels.get(key);
    if (!ch || ch.start !== undefined) return;
    ch.start = this.vm.clock();
    this.output?.play(key, ch.clip, { loop: ch.loop, volume: ch.volume / MAX_VOLUME });
  }

  stop(key: string): void {
    if (!this.channels.delete(key)) return;
    this.output?.stop(key);
  }

  stopAll(prefix = ""): void {
    for (const key of [...this.channels.keys()]) if (key.startsWith(prefix)) this.stop(key);
  }

  /** Elapsed ticks, or undefined once the clip has finished (non-looping). */
  position(key: string): number | undefined {
    const ch = this.channels.get(key);
    if (!ch) return undefined;
    if (ch.start === undefined) return 0;
    const now = ch.pausedAt ?? this.vm.clock();
    const elapsed = Math.floor(((now - ch.start) * 60) / 1000);
    if (!ch.loop && elapsed >= ch.ticks) {
      this.stop(key);
      return undefined;
    }
    return ch.loop ? elapsed % ch.ticks : elapsed;
  }

  pause(key: string, paused: boolean): void {
    const ch = this.channels.get(key);
    if (!ch || ch.start === undefined) return;
    if (paused && ch.pausedAt === undefined) {
      ch.pausedAt = this.vm.clock();
      this.output?.pause(key);
    } else if (!paused && ch.pausedAt !== undefined) {
      ch.start += this.vm.clock() - ch.pausedAt;
      ch.pausedAt = undefined;
      this.output?.resume(key);
    }
  }
}

const stateOf = new WeakMap<Vm, AudioState>();
export const audio = (vm: Vm): AudioState => {
  let a = stateOf.get(vm);
  if (!a) {
    const created = (a = new AudioState(vm));
    stateOf.set(vm, created);
    vm.hostRoots.push(() => created.songs.keys());
  }
  return a;
};

/**
 * DoAudio arguments name a clip either as an audio36 (speech) tuple
 * `module, noun, verb, cond, seq, [loop], [volume]` or as a plain audio number
 * `number, [loop], [volume]`.
 */
function resolveArgs(a: AudioState, args: Value[]): { key: string; clip?: AudioClip; loop: boolean; volume: number } | undefined {
  if (args.length >= 5) {
    const [module = 0, noun = 0, verb = 0, cond = 0, seq = 0, loop, volume] = args;
    return {
      key: `aud:${speechKey(module, noun, verb, cond, seq)}`,
      clip: a.index.speech.get(speechKey(module, noun, verb, cond, seq)),
      loop: loop !== undefined && toSigned(loop) === -1,
      volume: volume !== undefined && toSigned(volume) >= 0 ? Math.min(toSigned(volume), MAX_VOLUME) : MAX_VOLUME,
    };
  }
  if (args.length >= 1) {
    const [number = 0, loop, volume] = args;
    return {
      key: `sfx:${number}`,
      clip: a.index.effects.get(number),
      loop: loop !== undefined && toSigned(loop) === -1,
      volume: volume !== undefined && toSigned(volume) >= 0 ? Math.min(toSigned(volume), MAX_VOLUME) : MAX_VOLUME,
    };
  }
  return undefined;
}

const soundKey = (obj: Value) => `snd:${obj.toString(16)}`;
const prop = (vm: Vm, obj: Value, name: string) => toSigned(vm.getProp(obj, name) ?? 0);

export const audioKernels: Record<string, KernelFn> = {
  DoAudio: (vm, [subop = 0, ...args]) => {
    const a = audio(vm);
    const target = resolveArgs(a, args);
    switch (subop) {
      case 0: return 0; // init
      case 1: // wait-for-play: prepare without starting, return length
      case 2: { // play
        if (!target) return a.channels.size;
        if (!target.clip) {
          const [module = 0, noun = 0, verb = 0, cond = 0, seq = 0] = args;
          return args.length >= 5 && a.missingSpeechTicks ? a.missingSpeechTicks(module, noun, verb, cond, seq) & 0xffff : 0;
        }
        return a.play(target.key, target.clip, target.loop, target.volume, subop === 2);
      }
      case 3: // stop
        if (target) a.stop(target.key);
        else a.stopAll("aud:"), a.stopAll("sfx:");
        return 0;
      case 4: case 5: // pause / resume
        for (const key of target ? [target.key] : [...a.channels.keys()]) a.pause(key, subop === 4);
        return 0;
      case 6: { // position in ticks, -1 when not playing
        const key = target?.key ?? [...a.channels.keys()].find((k) => k.startsWith("aud:"));
        const pos = key === undefined ? undefined : a.position(key);
        return pos === undefined ? NOT_PLAYING : pos & 0xffff;
      }
      case 8: return 0; // volume
      case 9: return 1; // capability: audio present
      case 10: return 16; // bit depth
      case 12: return 1; // mixing
      case 13: return 2; // channels
      default: return 0;
    }
  },

  // Sound objects. Numbers with a digital effect in RESOURCE.SFX play as samples;
  // everything else is MIDI, sequenced here and sent to `midi` (a SoundFont synth).
  DoSound: (vm, [subop = 0, obj = 0, arg = 0, , , stopAfter = 0]) => {
    const a = audio(vm);
    switch (subop) {
      case 0: // master volume (get, or set to arg)
        if (obj !== 0 || arg) {
          a.masterVolume = obj & 0xf;
          a.midi?.setMasterVolume?.(a.masterVolume);
        }
        return a.masterVolume;
      case 3: return 32; // polyphony
      case 4: return 1; // digital audio available
      case 6: // init
        vm.setProp(obj, "nodePtr", obj);
        return 0;
      case 7: // dispose
        a.stop(soundKey(obj));
        a.stopSong(obj);
        vm.setProp(obj, "nodePtr", 0);
        return 0;
      case 8: { // play: a digital effect if RESOURCE.SFX has this number, else MIDI
        const number = prop(vm, obj, "number");
        const loop = prop(vm, obj, "loop") === -1;
        const volume = vm.getProp(obj, "vol") === undefined ? MAX_VOLUME : prop(vm, obj, "vol");
        a.stop(soundKey(obj));
        a.stopSong(obj);
        vm.setProp(obj, "signal", 0);
        // SCI2 Sounds ask for updates (Sound::check -> updateCues, which reports the end and
        // cues the client) only while `handle` is set; playing sets it, stopping clears it.
        vm.setProp(obj, "handle", obj);
        const clip = a.index.effects.get(number);
        if (clip) a.play(soundKey(obj), clip, loop, volume);
        else a.startSong(obj, number, loop, volume);
        return 0;
      }
      case 9: // stop
        a.stop(soundKey(obj));
        a.stopSong(obj);
        vm.setProp(obj, "signal", NOT_PLAYING);
        vm.setProp(obj, "handle", 0);
        return 0;
      case 10: { // pause (obj or 0 = all, arg = pause?)
        for (const key of obj ? [soundKey(obj)] : [...a.channels.keys()].filter((k) => k.startsWith("snd:"))) a.pause(key, arg !== 0);
        for (const player of obj ? [a.songs.get(obj)] : [...a.songs.values()]) {
          if (arg !== 0) player?.pause(a.ticks());
          else player?.resume(a.ticks());
        }
        return 0;
      }
      case 11: { // fade(obj, targetVolume, ticks, step, stopAfter): fading out → stop
        if (arg === 0 || stopAfter) {
          a.stop(soundKey(obj));
          a.stopSong(obj);
          vm.setProp(obj, "signal", NOT_PLAYING);
        } else a.songs.get(obj)?.setVolume(arg);
        return 0;
      }
      case 14: // set volume
        a.output?.setVolume(soundKey(obj), arg / MAX_VOLUME);
        a.songs.get(obj)?.setVolume(arg);
        vm.setProp(obj, "vol", arg);
        return 0;
      case 16: { // set loop
        vm.setProp(obj, "loop", arg);
        const player = a.songs.get(obj);
        if (player) player.loop = toSigned(arg) === -1;
        return 0;
      }
      case 17: { // update cues: report song signals/cues and finished sounds to the script
        if (a.channels.has(soundKey(obj)) && a.position(soundKey(obj)) === undefined) vm.setProp(obj, "signal", NOT_PLAYING);
        const player = a.songs.get(obj);
        if (player) {
          player.update(a.ticks());
          if (player.signal) {
            vm.setProp(obj, "signal", player.signal);
            vm.setProp(obj, "dataInc", player.dataInc);
            player.signal = 0;
          }
          if (player.finished) a.stopSong(obj);
        }
        return 0;
      }
      default:
        return 0;
    }
  },

  DoSync: () => 0,
};

/**
 * A `missingSpeechTicks` that gives a line without a recording as long as it takes to read:
 * ~15 characters a second, at least two seconds. Reads the text from the message resources.
 */
export function readingTime(vm: Vm): (module: number, noun: number, verb: number, cond: number, seq: number) => number {
  const files = new Map<number, MessageFile | undefined>();
  return (module, noun, verb, cond, seq) => {
    if (!files.has(module)) {
      const id = { type: ResourceType.Message, number: module };
      files.set(module, vm.resources.has(id) ? parseMessages(vm.resources.loadSync(id).data) : undefined);
    }
    const file = files.get(module);
    const text = file ? findMessage(file, { noun, verb, cond, seq })?.text ?? "" : "";
    return Math.max(120, text.length * 4);
  };
}
