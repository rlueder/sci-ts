/**
 * Renders a song through the AdLib path (sequencer → Sierra AdLib driver → OPL2 emulator)
 * to a WAV file, for listening and for checking the emulator headlessly.
 *   pnpm tsx tools/adlib-render.ts <sound number> [seconds] [--gm-track]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { AdLibDriver, OPL_RATE, Opl2, ResourceManager, ResourceType, SongPlayer, SoundDevice, parseAdLibBank, parseSound } from "@sci-ts/sci";
import { nodeFiles } from "./node-files.ts";

const [number = "130", seconds = "30"] = process.argv.slice(2);
const rm = await ResourceManager.open(nodeFiles(process.env.SCI_GAME ?? "original"));
const bank = parseAdLibBank((await rm.load({ type: ResourceType.Patch, number: 3 })).data);
const song = parseSound((await rm.load({ type: ResourceType.Sound, number: Number(number) })).data, SoundDevice.AdLib);
if (!song) throw new Error(`sound ${number} has no AdLib track`);

const chip = new Opl2();
const driver = new AdLibDriver(chip, bank);
const player = new SongPlayer(song, driver, false, 127, 0);

const ticks = Number(seconds) * 60;
const out = new Float32Array(Math.ceil((ticks * OPL_RATE) / 60));
let written = 0;
for (let t = 0; t < ticks && !player.finished; t++) {
  player.update(t);
  const end = Math.round(((t + 1) * OPL_RATE) / 60);
  chip.generate(out, written, end - written);
  written = end;
}

let peak = 0, sum = 0;
for (let i = 0; i < written; i++) (peak = Math.max(peak, Math.abs(out[i]!))), (sum += out[i]! * out[i]!);
console.log({ sound: Number(number), seconds: +(written / OPL_RATE).toFixed(1), peak: +peak.toFixed(3), rms: +Math.sqrt(sum / written).toFixed(4), finished: player.finished });

const wav = Buffer.alloc(44 + written * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + written * 2, 4); wav.write("WAVE", 8);
wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(OPL_RATE, 24); wav.writeUInt32LE(OPL_RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(written * 2, 40);
for (let i = 0; i < written; i++) wav.writeInt16LE(Math.round(out[i]! * 32767), 44 + i * 2);
mkdirSync("out/audio", { recursive: true });
writeFileSync(`out/audio/adlib-${number}.wav`, wav);
console.log(`wrote out/audio/adlib-${number}.wav`);
