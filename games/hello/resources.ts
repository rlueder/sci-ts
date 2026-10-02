import {
  ResourceType, SoundDevice, writeHunkPalette, writePic, writeSound, writeView,
  type MidiEvent, type ResourceData, type SoundSpec,
} from "../../tools/game/kit.ts";
import { cursors, dialogueFrame, hero, lantern, palette, picture, portrait, traveller } from "./art.ts";

/** The original two-room demo, with shared flat polygon art; music and scripts unchanged. */
export default function resources(): ResourceData[] {
  return [
    { type: ResourceType.Palette, number: 999, data: writeHunkPalette(palette()) },
    { type: ResourceType.Pic, number: 100, data: writePic(picture("hill")) },
    { type: ResourceType.Pic, number: 101, data: writePic(picture("road")) },
    { type: ResourceType.View, number: 100, data: writeView(lantern()) },
    { type: ResourceType.View, number: 200, data: writeView(hero()) },
    { type: ResourceType.View, number: 300, data: writeView(traveller()) },
    { type: ResourceType.View, number: 301, data: writeView(portrait()) },
    { type: ResourceType.View, number: 302, data: writeView(dialogueFrame()) },
    ...cursors().map(({ number, view }) => ({ type: ResourceType.View, number, data: writeView(view) })),
    { type: ResourceType.Sound, number: 100, data: writeSound(nightTune()) },
  ];
}

/**
 * A slow tune for the night: a music box over a soft pad, eight bars, looped by the game.
 * Lengths are in eighth notes; ticks are 1/60 s.
 */
function nightTune(): SoundSpec {
  const EIGHTH = 20;
  const melody: [note: number, eighths: number][] = [
    [69, 2], [72, 1], [76, 1], [74, 2], [72, 2],
    [69, 6], [67, 2],
    [64, 2], [67, 1], [69, 1], [72, 2], [74, 2],
    [76, 4], [74, 2], [72, 2],
    [69, 2], [72, 1], [76, 1], [79, 2], [76, 2],
    [74, 6], [72, 2],
    [69, 2], [67, 2], [64, 2], [67, 2],
    [69, 8],
  ];
  // A chord a bar: Am F C G Am F Em Am.
  const chords = [[45, 52, 57], [41, 48, 53], [48, 55, 60], [43, 50, 55], [45, 52, 57], [41, 48, 53], [40, 47, 52], [45, 52, 57]];
  const tune: MidiEvent[] = [{ tick: 0, bytes: [0xc0, 10] }]; // music box
  let t = 0;
  for (const [note, eighths] of melody) {
    tune.push({ tick: t, bytes: [0x90, note, 72] }, { tick: t + eighths * EIGHTH - 2, bytes: [0x80, note, 0] });
    t += eighths * EIGHTH;
  }
  const pad: MidiEvent[] = [{ tick: 0, bytes: [0xc1, 89] }]; // warm pad
  chords.forEach((chord, bar) => {
    const at = bar * 8 * EIGHTH;
    for (const n of chord) pad.push({ tick: at, bytes: [0x91, n, 40] }, { tick: at + 8 * EIGHTH - 1, bytes: [0x81, n, 0] });
  });
  return {
    tracks: [{
      device: SoundDevice.GeneralMidi,
      channels: [{ midiChannel: 0, voices: 1, events: tune }, { midiChannel: 1, voices: 3, events: pad }],
    }],
  };
}
