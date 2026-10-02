import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { SpokenLine } from "@sci-ts/content";

/**
 * voices/lines.json: the script, for a recording session or a TTS run. One entry per line
 * with an id, with what's needed to say it (who, what, the line before) and whether
 * voices/<id>.wav exists and was recorded for the line as it is now. The build keeps it
 * up to date, as it does flags.yaml.
 */
export interface ScriptLine {
  id: string;
  room: number;
  speaker: string;
  text: string;
  node: string;
  before?: { speaker: string; text: string };
  /** file:line in the game's folder (rooms/1.yarn:4). */
  where: string;
  /** missing: no voices/<id>.wav. recorded: there is, for this text. changed: the text has changed since. */
  recording: "missing" | "recorded" | "changed";
  /** What the recording was made for: hashes of the line's text then, and of the WAV file. */
  recorded?: { text: string; wav: string };
}

const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 12);

/** The script as it was last written, by id; empty if there's none. */
export function readLineScript(dir: string): Map<string, ScriptLine> {
  const file = join(dir, "voices/lines.json");
  if (!existsSync(file)) return new Map();
  const { lines } = JSON.parse(readFileSync(file, "utf8")) as { lines: ScriptLine[] };
  return new Map(lines.map((l) => [l.id, l]));
}

/**
 * The script for the game's lines now. A recording keeps the text it was made for from the
 * last script; one not seen before, or a WAV that has changed (recorded again), is taken to
 * be for the text as it is now.
 */
export function lineScript(dir: string, rooms: Map<number, SpokenLine[]>): ScriptLine[] {
  const previous = readLineScript(dir);
  // Lines know where they are from the working directory; the script, from the game's.
  const inGame = (where: string) => where.replace(/^(.*)(:\d+)$/, (_, file: string, line: string) => `${relative(dir, resolve(file))}${line}`);
  return [...rooms].sort(([a], [b]) => a - b).flatMap(([room, lines]) => lines.flatMap((l): ScriptLine[] => {
    if (l.id === undefined) return [];
    const entry: ScriptLine = {
      id: l.id, room, speaker: l.speaker, text: l.text, node: l.node, ...(l.before ? { before: l.before } : {}), where: inGame(l.where), recording: "missing",
    };
    const wavFile = join(dir, "voices", `${l.id}.wav`);
    if (existsSync(wavFile)) {
      const wav = hash(readFileSync(wavFile));
      const old = previous.get(l.id)?.recorded;
      entry.recorded = old?.wav === wav ? old : { text: hash(l.text), wav };
      entry.recording = entry.recorded.text === hash(l.text) ? "recorded" : "changed";
    }
    return [entry];
  }));
}

/** Writes voices/lines.json if it has changed. */
export function writeLineScript(dir: string, script: ScriptLine[]): void {
  const file = join(dir, "voices/lines.json");
  const text = `${JSON.stringify({ lines: script }, null, 2)}\n`;
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
}
