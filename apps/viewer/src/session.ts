import {
  EventType, GLOBAL_NAMES_VOCAB, ResourceManager, ResourceType, SciKey, SoundDevice, Vm, allKernels, audio, graphics, hostFiles, input, parseAdLibBank, readingTime, restoreGame, saves, snapshot,
  type Frame, type VmSnapshot,
} from "@sci-ts/sci";
import { AdLibOutput } from "./adlib.ts";
import { WebAudioOutput } from "./audio.ts";
import { BASE, httpFiles } from "./files.ts";
import { SoundFontMidi } from "./music.ts";
import { APP_ID } from "./app.ts";
import { browserSaveStore } from "./saves.ts";

export type MusicMode = "gm" | "adlib";

export interface SessionOptions {
  canvas: HTMLCanvasElement;
  /** Reuse an open resource manager (it gets preloaded). */
  rm?: ResourceManager;
  /** Active mods: saves are kept apart per set of mods. */
  mods?: string[];
  /** Keep saves under this name instead (the editor's, apart from playing). */
  saveNamespace?: string;
  /**
   * Sierra's debug room, which the game loads when a file "18.scr" exists (their machines had one).
   * Alt-T teleports, Alt-G sets flags, Alt-I gives items, Alt-H sets the hour... (Alt-? lists).
   */
  debug?: boolean;
  /** Start with audio suspended; `setMuted(false)` turns it on. */
  muted?: boolean;
  /**
   * Keep running when the page isn't painted (a hidden tab or pane), where
   * requestAnimationFrame stops: a timer takes over. For automated testing.
   */
  runHidden?: boolean;
  /**
   * Called for canvas mouse-downs before the game sees them; return true to swallow the
   * click (the explorer's inspect mode). Coordinates are game screen pixels.
   */
  interceptClick?: (x: number, y: number, e: MouseEvent) => boolean;
}

/**
 * One running game in a canvas: VM, audio, input and the frame loop. The player page and
 * the explorer's live view both run the game through this.
 */
export class GameSession {
  paused = false;
  /** Game frames run so far. */
  frames = 0;
  fps = 0;
  error: { message: string; backtrace: string[] } | undefined;
  /** After each drawn browser frame. */
  readonly onDraw: (() => void)[] = [];
  private latest: Frame | undefined;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private musicModeValue: MusicMode = "gm";
  private stepsOwed = 0;

  private constructor(
    readonly rm: ResourceManager,
    readonly vm: Vm,
    readonly canvas: HTMLCanvasElement,
    readonly sound: WebAudioOutput,
    readonly music: SoundFontMidi,
    /** Only for games with an AdLib instrument bank (patch 3). */
    private readonly adlib: AdLibOutput | undefined,
    private readonly options: SessionOptions,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.image = this.ctx.createImageData(320, 200);
  }

  static async create(options: SessionOptions): Promise<GameSession> {
    const rm = options.rm ?? (await ResourceManager.open(httpFiles));
    await rm.preload();
    const vm = new Vm(rm);
    vm.registerKernels(allKernels);
    // Saved games persist in this browser (IndexedDB) and appear in the game's Restore screen.
    saves(vm).store = await browserSaveStore(options.saveNamespace ?? defaultSaveNamespace(vm, rm, options.mods ?? []));
    if (options.debug) hostFiles(vm).add("18.scr");

    const sound = new WebAudioOutput(httpFiles, (name) => rm.file(name));
    audio(vm).output = sound;
    // Mods add dialogue without recordings: give those lines time to be read.
    if (options.mods?.length) audio(vm).missingSpeechTicks = readingTime(vm);
    // Music: General MIDI through a SoundFont (loads in the background), or the AdLib track
    // through Sierra's driver and an OPL2 emulator: what most players heard in 1994.
    const music = new SoundFontMidi(sound.ctx);
    music.load(`${BASE}soundfonts/GeneralUser-GS.sf2`).catch((e) => console.warn("SoundFont unavailable:", e));
    const bank = { type: ResourceType.Patch, number: 3 };
    const adlib = rm.has(bank) ? await AdLibOutput.create(sound.ctx, parseAdLibBank(rm.loadSync(bank).data)) : undefined;

    const session = new GameSession(rm, vm, options.canvas, sound, music, adlib, options);
    graphics(vm).onFrame = (f) => (session.latest = f);
    session.setMusicMode(readMusicMode());
    session.setMuted(!!options.muted);
    session.attachInput();
    for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => session.muted || sound.unlock());
    return session;
  }

  get musicMode(): MusicMode {
    return this.musicModeValue;
  }

  /** Whether the game can play its AdLib tracks (it has an instrument bank). */
  get hasAdLib(): boolean {
    return !!this.adlib;
  }

  setMusicMode(mode: MusicMode): void {
    if (!this.adlib) mode = "gm";
    this.musicModeValue = mode;
    this.adlib?.reset();
    if (mode === "adlib" && this.adlib) audio(this.vm).setMusicDevice(SoundDevice.AdLib, this.adlib);
    else audio(this.vm).setMusicDevice(SoundDevice.GeneralMidi, this.music);
    try {
      localStorage.setItem(`${APP_ID}.music`, mode);
    } catch {
      /* private mode: just don't remember */
    }
  }

  muted = false;
  /** Browsers keep audio suspended until a user gesture: unmuted, the next gesture unlocks it. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) void this.sound.ctx.suspend();
    else this.sound.unlock();
  }

  /** True while `start({ fastForward })` is still running ahead. */
  fastForwarding = false;

  /**
   * Starts the game and the frame loop. With `fastForward`, the game first runs as fast as
   * it can on a frame clock (60 frames = 1 second of game time), from the very first frame,
   * with `script[n]` called before frame n (scripted input) until frame `until`; audio is
   * silent meanwhile. Then real time takes over, continuing the clock where it was.
   */
  start(options: { fastForward?: { script: Record<number, () => void>; until: number; done?: () => void } } = {}): void {
    this.vm.start(this.vm.exportAddress(0, 0), "play");
    const ff = options.fastForward;
    const g = graphics(this.vm);
    if (ff) {
      this.fastForwarding = true;
      this.vm.clock = () => (g.frames * 1000) / 60;
      void this.sound.ctx.suspend();
    }
    const finishFastForward = () => {
      this.fastForwarding = false;
      const base = (g.frames * 1000) / 60, t0 = performance.now();
      this.vm.clock = () => base + (performance.now() - t0);
      if (!this.muted) this.sound.unlock();
      ff?.done?.();
    };
    let prev = performance.now();
    let lastFps = prev;
    let counted = 0;
    // SCI32 games expect ~60 FrameOuts per second. If the browser ticks slower (a hidden tab,
    // a slow machine), run several game frames per tick to catch up, up to a cap.
    const FRAME_MS = 1000 / 60;
    let owed = 0;
    const tick = (now: number) => {
      try {
        if (this.fastForwarding && ff) {
          // As many frames as fit in ~30 ms, then draw so the page stays responsive.
          const stop = performance.now() + 30;
          while (g.frames < ff.until && this.vm.running && performance.now() < stop) {
            ff.script[g.frames]?.();
            this.vm.run();
            this.frames++;
          }
          if (g.frames >= ff.until) finishFastForward();
          prev = now;
        }
        owed = this.paused || this.fastForwarding ? 0 : Math.min(owed + (now - prev) / FRAME_MS, 30);
        prev = now;
        let steps = this.paused ? this.stepsOwed : 0;
        this.stepsOwed = 0;
        while ((owed >= 1 || steps > 0) && this.vm.running) {
          this.vm.run();
          this.frames++;
          counted++;
          if (steps > 0) steps--;
          else owed--;
        }
        if (this.latest) this.draw(this.latest);
        for (const hook of this.onDraw) hook();
        if (now - lastFps > 1000) {
          this.fps = counted;
          counted = 0;
          lastFps = now;
        }
        if (this.vm.running) schedule();
      } catch (e) {
        this.error = { message: (e as Error).message, backtrace: this.vm.backtrace() };
        console.error(e);
        for (const hook of this.onDraw) hook();
      }
    };
    // One tick per animation frame; with runHidden, a timer fires it if frames stop coming.
    let pending = false;
    const fire = (now: number) => {
      if (!pending) return;
      pending = false;
      tick(now);
    };
    const schedule = () => {
      pending = true;
      requestAnimationFrame(fire);
      if (this.options.runHidden) setTimeout(() => fire(performance.now()), 50);
    };
    schedule();
  }

  /** While paused: run `n` game frames on the next tick. */
  step(n = 1): void {
    this.stepsOwed += n;
  }

  snapshot(): VmSnapshot {
    return snapshot(this.vm);
  }

  /** Like the game's own restore: replace memory, then restart execution with `replay`. */
  /** Loads a snapshot as the game's own Restore does (see `restoreGame`). */
  restore(snap: VmSnapshot): void {
    restoreGame(this.vm, snap);
  }

  private draw(f: Frame): void {
    const { pixels, palette, rgb } = f;
    const data = this.image.data;
    for (let i = 0; i < pixels.length; i++) {
      // Mid-transition frames carry RGB directly; otherwise look colours up in the palette.
      const src = rgb ?? palette.rgb;
      const c = rgb ? i * 3 : pixels[i]! * 3;
      data[i * 4] = src[c]!;
      data[i * 4 + 1] = src[c + 1]!;
      data[i * 4 + 2] = src[c + 2]!;
      data[i * 4 + 3] = 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  // --- Input: map page coordinates to the 320×200 game screen ---------------------
  private attachInput(): void {
    const { canvas } = this;
    const inp = input(this.vm);
    const toGame = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(319, Math.floor(((e.clientX - r.left) / r.width) * 320))),
        y: Math.max(0, Math.min(199, Math.floor(((e.clientY - r.top) / r.height) * 200))),
      };
    };
    // While a fast-forward plays its script, the player's mouse and keys stay out of it: a
    // queued click reads the mouse position when the game gets to it, so a real mouse move in
    // between would send the scripted click wherever the pointer is.
    const track = (e: MouseEvent) => {
      if (!this.fastForwarding) ({ x: inp.x, y: inp.y } = toGame(e));
    };
    let swallowed = false;
    canvas.addEventListener("mousemove", track);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("mousedown", (e) => {
      if (this.fastForwarding) return;
      const { x, y } = toGame(e);
      swallowed = !!this.options.interceptClick?.(x, y, e);
      if (swallowed) return;
      track(e);
      // SCI reports the right button as a click with shift held.
      inp.push({ type: EventType.MouseDown, message: 0, modifiers: e.button === 2 ? 3 : 0 });
    });
    canvas.addEventListener("mouseup", (e) => {
      if (swallowed || this.fastForwarding) return;
      track(e);
      inp.push({ type: EventType.MouseUp, message: 0 });
    });
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || !canvas.isConnected || this.fastForwarding) return; // leave browser shortcuts alone
      // Typing into the page's own inputs (search boxes, the room editor) isn't for the game.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      // DOS reports Alt+letter as the key's scan code in the high byte (Alt-T = 0x1400); use
      // the physical key, since on a Mac Alt changes the character (Alt-T types "†").
      const scan = e.altKey ? ALT_SCAN_CODES[e.code] : undefined;
      const code = scan ? scan << 8 : e.key === "Tab" && e.shiftKey ? SciKey.ShiftTab : KEY_CODES[e.key] ?? (e.key.length === 1 ? e.key.charCodeAt(0) : 0);
      if (!code) return;
      e.preventDefault();
      inp.push({ type: EventType.KeyDown, message: code, modifiers: modifiers(e) });
    });
  }
}

/**
 * Whose saves these are. Games built by sci-ts (they carry their globals' names, vocab 990)
 * each get their own, by the game object's name, so games played from one site don't share
 * save slots; Sierra's games keep the namespace they always had (their mods, if any).
 */
function defaultSaveNamespace(vm: Vm, rm: ResourceManager, mods: string[]): string {
  if (rm.has({ type: ResourceType.Vocab, number: GLOBAL_NAMES_VOCAB })) return `game:${vm.object(vm.exportAddress(0, 0)).name}`;
  return [...mods].sort().join("+");
}

const KEY_CODES: Record<string, number> = {
  Enter: 13, Escape: 27, Backspace: 8, Tab: 9, " ": 32,
  ArrowUp: SciKey.Up, ArrowDown: SciKey.Down, ArrowLeft: SciKey.Left, ArrowRight: SciKey.Right,
  Home: SciKey.Home, End: SciKey.End, PageUp: SciKey.PageUp, PageDown: SciKey.PageDown,
  Insert: SciKey.Insert, Delete: SciKey.Delete, Clear: SciKey.Center,
  F1: SciKey.F1, F2: SciKey.F2, F3: SciKey.F3, F4: SciKey.F4, F5: SciKey.F5,
  F6: SciKey.F6, F7: SciKey.F7, F8: SciKey.F8, F9: SciKey.F9, F10: SciKey.F10,
};
/** PC scan codes for the letter keys (Alt+letter). */
const ALT_SCAN_CODES: Record<string, number> = Object.fromEntries(
  [..."QWERTYUIOP"].map((k, i) => [`Key${k}`, 0x10 + i]).concat(
    [..."ASDFGHJKL"].map((k, i) => [`Key${k}`, 0x1e + i]),
    [..."ZXCVBNM"].map((k, i) => [`Key${k}`, 0x2c + i]),
  ),
);
/** SCI modifier bits: 3 = shift (both), 4 = ctrl, 8 = alt. */
const modifiers = (e: KeyboardEvent | MouseEvent) => (e.shiftKey ? 3 : 0) | (e.ctrlKey ? 4 : 0) | (e.altKey ? 8 : 0);

function readMusicMode(): MusicMode {
  try {
    return localStorage.getItem(`${APP_ID}.music`) === "adlib" ? "adlib" : "gm";
  } catch {
    return "gm";
  }
}
