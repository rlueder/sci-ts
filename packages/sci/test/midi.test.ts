import { describe, expect, it } from "vitest";
import { SongPlayer, SongSignal, parseSound } from "../src/index.ts";

/** Builds a one-track GM sound resource from raw channel streams. */
function soundResource(channels: number[][]): Uint8Array {
  const header = [0x07];
  let offset = 1 + channels.length * 6 + 2;
  for (const ch of channels) {
    header.push(0, 0, offset & 0xff, offset >> 8, ch.length & 0xff, ch.length >> 8);
    offset += ch.length;
  }
  header.push(0xff, 0xff);
  return new Uint8Array([...header, ...channels.flat()]);
}

describe("SCI sound resources", () => {
  // Channel 1: program 48, a note at tick 0, released after 240+10 ticks (F8 = 240), end.
  // Like every event, the FC end marker is preceded by a delta.
  const music = [0x01, 0x01, 0, 0xc1, 48, 0, 0x91, 60, 100, 0xf8, 10, 60, 0, 0, 0xfc];
  // Channel 15 (control): cue at tick 5, signal 3 at tick 20.
  const control = [0x0f, 0x01, 5, 0xbf, 0x60, 1, 15, 0xcf, 3, 0, 0xfc];

  it("parses channels with running status and F8 delays", () => {
    const song = parseSound(soundResource([music]))!;
    expect(song.events.map((e) => [e.tick, ...e.bytes])).toEqual([
      [0, 0xc1, 48],
      [0, 0x91, 60, 100],
      [250, 0x91, 60, 0], // running status
    ]);
  });

  it("reports cues and signals from the control channel, then finishes", () => {
    const sent: number[][] = [];
    const player = new SongPlayer(parseSound(soundResource([music, control]))!, { send: (b) => sent.push(b) }, false, 127, 0);
    player.update(5);
    expect(player.signal).toBe(128); // first cue: dataInc 1 + 127
    player.update(20);
    expect(player.signal).toBe(3);
    player.update(400);
    expect(player.finished).toBe(true);
    expect(player.signal).toBe(SongSignal.Finished);
    expect(sent.some((b) => (b[0]! & 0x0f) === 15)).toBe(false); // control channel never reaches the synth
  });

  it("loops instead of finishing when looping", () => {
    const player = new SongPlayer(parseSound(soundResource([music]))!, undefined, true, 127, 0);
    player.update(400);
    player.update(800);
    expect(player.finished).toBe(false);
  });
});
