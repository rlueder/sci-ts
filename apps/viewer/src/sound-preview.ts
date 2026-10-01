import { AudioIndex, ResourceType, SongPlayer, SoundDevice, parseAdLibBank, parseSound, type MidiOutput, type ResourceManager, type Song } from "@sci-ts/sci";
import { AdLibOutput } from "./adlib.ts";
import { WebAudioOutput } from "./audio.ts";
import { httpFiles } from "./files.ts";
import { SoundFontMidi } from "./music.ts";

/**
 * A mini player for sound resources in the resource viewer: the General MIDI track through
 * the SoundFont, the AdLib track through the OPL2 emulator, or the digital version from
 * RESOURCE.SFX when there is one. Music plays on a 60 Hz tick clock, as in the game.
 */

interface Audio {
  out: WebAudioOutput;
  gm: SoundFontMidi;
  gmReady: Promise<void>;
  adlib: AdLibOutput;
  index: AudioIndex;
}

let audio: Promise<Audio> | undefined;
const openAudio = (rm: ResourceManager) =>
  (audio ??= (async () => {
    await rm.preload(); // the audio maps and the AdLib bank are read synchronously
    const out = new WebAudioOutput(httpFiles, (name) => rm.file(name));
    const gm = new SoundFontMidi(out.ctx);
    const gmReady = gm.load("/soundfonts/GeneralUser-GS.sf2");
    const adlib = await AdLibOutput.create(out.ctx, parseAdLibBank(rm.loadSync({ type: ResourceType.Patch, number: 3 }).data));
    return { out, gm, gmReady, adlib, index: AudioIndex.build(rm) };
  })());

type Source = "gm" | "adlib" | "digital";
const SOURCE_NAMES: Record<Source, string> = { gm: "General MIDI", adlib: "AdLib", digital: "Digital (SFX)" };

const nowTicks = () => (performance.now() * 60) / 1000;
const clock = (ticks: number) => {
  const s = Math.max(0, Math.round(ticks / 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** What's playing, so switching resources (or sources) can stop it. */
let stopCurrent: (() => void) | undefined;
let toggleCurrent: (() => void) | undefined;

export function stopSoundPreview(): void {
  stopCurrent?.();
  stopCurrent = undefined;
  toggleCurrent = undefined;
}

/** Space in the viewer: play or pause the sound on show, if any. */
export function toggleSoundPreview(): boolean {
  if (!toggleCurrent) return false;
  toggleCurrent();
  return true;
}

/** The sound's length and tracks, for its row in the list. */
export function soundSummary(data: Uint8Array): string {
  const gm = parseSound(data, SoundDevice.GeneralMidi);
  const adlib = parseSound(data, SoundDevice.AdLib);
  const tracks = [gm && "MIDI", adlib && "AdLib"].filter(Boolean).join(" · ");
  const length = gm?.length ?? adlib?.length;
  return [length !== undefined ? clock(length) : undefined, tracks].filter(Boolean).join(" · ");
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), props);

export async function renderSound(rm: ResourceManager, number: number, data: Uint8Array, stillWanted: () => boolean = () => true): Promise<HTMLElement> {
  stopSoundPreview();
  const songs: Partial<Record<Source, Song>> = {};
  const gmSong = parseSound(data, SoundDevice.GeneralMidi);
  const adlibSong = parseSound(data, SoundDevice.AdLib);
  if (gmSong) songs.gm = gmSong;
  if (adlibSong) songs.adlib = adlibSong;

  const wrap = make("div", { className: "sound" });
  const info = make("p", { className: "meta" });
  const controls = make("div", { className: "player" });
  const play = make("button", { type: "button", className: "play", textContent: "▶", title: "Play / pause (Space)" });
  const stop = make("button", { type: "button", textContent: "■", title: "Stop" });
  const source = make("select", { title: "Which version to play" });
  const loopBox = make("input", { type: "checkbox" });
  const loop = make("label", { className: "loop-opt" });
  loop.append(loopBox, " loop");
  const seek = make("input", { type: "range", min: "0", max: "1000", value: "0", className: "seek" });
  const time = make("span", { className: "time", textContent: "0:00 / 0:00" });
  controls.append(play, stop, source, loop, seek, time);
  wrap.append(info, controls);

  const a = await openAudio(rm);
  const clip = a.index.effects.get(number);
  const sources = ([...(clip ? ["digital"] : []), ...(songs.gm ? ["gm"] : []), ...(songs.adlib ? ["adlib"] : [])] as Source[]);
  for (const s of sources) source.append(make("option", { value: s, textContent: SOURCE_NAMES[s] }));
  if (!sources.length) {
    info.textContent = "No playable track for these devices.";
    play.disabled = stop.disabled = true;
    return wrap;
  }
  const describe = (s: Song) => `${s.channels.length} channels · ${s.events.length} events · ${clock(s.length)}`;
  info.textContent = [
    songs.gm && `General MIDI: ${describe(songs.gm)}`,
    songs.adlib && `AdLib: ${describe(songs.adlib)}`,
    clip && `digital effect: ${clock(clip.ticks ?? 0)}`,
  ].filter(Boolean).join(" · ");

  // --- Playback ---
  let player: SongPlayer | undefined;
  let midi: MidiOutput | undefined;
  let started = 0; // tick at position 0
  let pausedAt: number | undefined;
  let digitalPlaying = false;
  // A timer, not animation frames: music keeps playing in a background tab.
  let timer: ReturnType<typeof setInterval> | undefined;
  const length = () => (source.value === "digital" ? clip?.ticks ?? 0 : songs[source.value as Source]?.length ?? 0);
  const position = () => {
    const at = (pausedAt ?? nowTicks()) - started;
    const len = Math.max(length(), 1);
    return loopBox.checked ? at % len : Math.min(at, len);
  };
  const playing = () => !!player || digitalPlaying;

  const frame = () => {
    if (player && pausedAt === undefined) {
      player.update(nowTicks());
      if (player.finished) return halt();
    }
    if (digitalPlaying && pausedAt === undefined && !loopBox.checked && nowTicks() - started >= length()) return halt();
    seek.value = String(Math.round((position() / Math.max(length(), 1)) * 1000));
    time.textContent = `${clock(position())} / ${clock(length())}`;
  };

  const silence = () => {
    if (!midi) return;
    for (let c = 0; c < 16; c++) midi.send([0xb0 | c, 123, 0]); // all notes off
  };
  function halt(): void {
    clearInterval(timer);
    timer = undefined;
    player?.stop();
    silence();
    player = undefined;
    if (digitalPlaying) a.out.stop("preview");
    digitalPlaying = false;
    pausedAt = undefined;
    play.textContent = "▶";
    seek.value = "0";
    time.textContent = `0:00 / ${clock(length())}`;
  }

  const start = async (from = 0) => {
    halt();
    a.out.unlock();
    const s = source.value as Source;
    if (s === "digital") {
      a.out.play("preview", clip!, { loop: loopBox.checked, volume: 1 });
      digitalPlaying = true;
      started = nowTicks();
    } else {
      if (s === "gm") {
        time.textContent = "loading SoundFont…";
        await a.gmReady.catch(() => undefined); // the SoundFont is 32 MB: the first time takes a moment
        midi = a.gm;
      } else {
        a.adlib.reset();
        midi = a.adlib;
      }
      player = new SongPlayer(songs[s]!, midi, loopBox.checked, 127, nowTicks());
      if (from) player.seek(from, nowTicks());
      started = nowTicks() - from;
    }
    play.textContent = "❚❚";
    timer = setInterval(frame, 15);
  };

  const toggle = () => {
    if (!playing()) return void start();
    const now = nowTicks();
    if (pausedAt === undefined) {
      pausedAt = now;
      player?.pause(now);
      if (digitalPlaying) a.out.pause("preview");
      play.textContent = "▶";
    } else {
      started += now - pausedAt;
      player?.resume(now);
      if (digitalPlaying) a.out.resume("preview");
      pausedAt = undefined;
      play.textContent = "❚❚";
    }
  };

  play.onclick = toggle;
  stop.onclick = halt;
  source.onchange = () => {
    const was = playing();
    halt();
    seek.disabled = source.value === "digital";
    if (was) void start();
  };
  loopBox.onchange = () => {
    if (player) player.loop = loopBox.checked;
  };
  // Seeking: music only (digital clips play from the start).
  seek.oninput = () => {
    if (source.value === "digital") return;
    const to = (Number(seek.value) / 1000) * length();
    if (player) {
      player.seek(to, nowTicks());
      started = nowTicks() - to;
      if (pausedAt !== undefined) pausedAt = nowTicks();
    } else void start(to);
  };
  seek.disabled = source.value === "digital";
  time.textContent = `0:00 / ${clock(length())}`;

  // Only the sound on show owns the controls (a slow load may finish after moving on).
  if (stillWanted()) {
    stopCurrent = halt;
    toggleCurrent = toggle;
  }
  return wrap;
}
