import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  AsmError, CompileError, GLOBAL_NAMES_VOCAB, OBJECT_HEADER, ResourceType, assemble, compileScripts, kernelNames, messagesFromText, parseScript,
  resourceKey, writeClassTable, writeEffects, writeMessages, writeSelectorNames, writeSol, writeSound, writeSpeech, type AsmContext, type SpeechClip,
  type ResourceData, type ScriptObject,
} from "@sci-ts/sci";
import { ContentError, compileRoom, type SpokenLine } from "@sci-ts/content";
import { modFlags } from "../mod-build.ts";
import { AudioFileError, SPEECH_RATE, prepareSpeech, readMidiFile, readWav } from "./audio.ts";
import { lineScript, writeLineScript, type ScriptLine } from "./voices.ts";
import { defaultResources } from "./defaults.ts";
import { ITEMS_SCRIPT, libraryTarget } from "./target.ts";

/**
 * Builds a game from its sources, needing nothing from any other game:
 *
 *   games/<name>/scripts/<n>.sc    scripts (see packages/sci/src/script/compiler.ts), compiled
 *                                  together; they may include files from the game folder
 *   games/<name>/scripts/<n>.sca   scripts in assembly (packages/sci/src/script/assembly.ts)
 *   games/<name>/messages/<n>.msg  message files, as text (`pnpm msg` writes the same form)
 *   games/<name>/rooms/<n>.room.yaml (+ <n>.yarn)  rooms as data (packages/content), compiled
 *                                  for the class library; their Yarn variables are flags
 *                                  numbered in flags.yaml
 *   games/<name>/items.yaml        optional: the things the hero can carry: their verbs, so
 *                                  rooms' Yarn can answer them (filings.lens), and with a view
 *                                  the item itself, made in script ITEMS_SCRIPT (<<get lens>>)
 *   games/<name>/music/<n>.mid     music: sound n, from a Standard MIDI File (General MIDI)
 *   games/<name>/sounds/<n>.wav    digital effects: sound n plays this instead of music
 *   games/<name>/voices/<id>.wav   speech: the line tagged #line:<id> in a room's Yarn
 *                                  (RESOURCE.AUD, and a map per room); the build keeps
 *                                  voices/lines.json, the script, up to date
 *   games/<name>/resources.ts      optional: `export default () => ResourceData[]` for art,
 *                                  music and anything else made by code
 *   games/<name>/game.json         optional: { "library": false } to build without lib/;
 *                                  "fonts": { "bold": 3, "italic": 4, "boldItalic": 5 }
 *                                  for the rooms' [b] and [i] markup
 *
 * plus the class library (lib/: its scripts and resources) and font 0, palette 999 and cursor
 * view 999 (tools/game/defaults.ts), unless the game makes its own. Selectors are numbered as the scripts use them, starting with the nine object
 * header slots; vocab 997 lists them and vocab 996 says which script defines each class.
 */
export interface BuiltGame {
  resources: ResourceData[];
  selectors: string[];
  classes: Map<number, { name: string; script: number }>;
  /** The assembly compiled from each .sc file, by script number. */
  generated: Map<number, string>;
  /** The globals' names, by number (when script 0 is compiled). */
  globals: string[];
  /** The message text compiled from each YAML room's Yarn, by room. */
  roomMessages: Map<number, string>;
  /** Each YAML room's spoken lines, by room: their #line: ids and message keys today. */
  lines: Map<number, SpokenLine[]>;
  /** Files that go next to RESOURCE.MAP and RESOURCE.000 (RESOURCE.SFX, the effects; RESOURCE.AUD, speech). */
  files: Record<string, Uint8Array>;
  /** Likely mistakes that still built, as file:line: message. */
  warnings: string[];
}

const HEADER = OBJECT_HEADER;

export class GameBuildError extends Error {}

/** game.json's fonts for the rooms' markup: bold, italic and boldItalic font numbers. */
function gameFonts(value: unknown): { bold: number; italic: number; boldItalic: number } | undefined {
  if (value === undefined) return undefined;
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 65535;
  const f = value as Record<string, unknown>;
  if (typeof value !== "object" || value === null || !ok(f.bold) || !ok(f.italic) || !ok(f.boldItalic)) {
    throw new GameBuildError(`game.json: "fonts" is { "bold": n, "italic": n, "boldItalic": n }, font numbers`);
  }
  return { bold: f.bold as number, italic: f.italic as number, boldItalic: f.boldItalic as number };
}

/** sci-ts's class library: scripts every game gets, and the resources they use. */
export const LIBRARY_DIR = resolve(import.meta.dirname, "../../lib");

export async function buildGame(dir: string, options: { library?: boolean } = {}): Promise<BuiltGame> {
  const scriptsDir = join(dir, "scripts");
  if (!existsSync(scriptsDir)) throw new GameBuildError(`${dir}: no scripts/ folder`);
  const config = existsSync(join(dir, "game.json")) ? (JSON.parse(readFileSync(join(dir, "game.json"), "utf8")) as { library?: boolean; fonts?: unknown }) : {};
  const fonts = gameFonts(config.fonts);
  const library = options.library ?? config.library ?? true;
  const load = (from: string, re: RegExp) =>
    readdirSync(from).sort().filter((f) => re.test(f)).map((f) => ({ file: join(from, f), text: readFileSync(join(from, f), "utf8") }));
  const sources = load(scriptsDir, /^\d+\.sca$/);
  const compiled = load(scriptsDir, /^\d+\.sc$/);
  const numberOf = (file: string) => Number(basename(file).split(".")[0]);
  const numbers = [...sources, ...compiled].map((s) => numberOf(s.file));
  if (!numbers.includes(0)) throw new GameBuildError(`${dir}: no scripts/0.sc or 0.sca (script 0 exports the game object)`);
  const repeated = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (repeated !== undefined) throw new GameBuildError(`${dir}: script ${repeated} is there twice`);
  // Items described in items.yaml are made by a script of their own.
  const items = gameItems(dir);
  const madeItems = library ? itemsScript(items) : undefined;
  if (madeItems) {
    if (numbers.includes(ITEMS_SCRIPT)) throw new GameBuildError(`${dir}: script ${ITEMS_SCRIPT} is where the build makes the items in items.yaml`);
    compiled.push({ file: join(dir, `${ITEMS_SCRIPT}.items.sc`), text: madeItems });
  }
  if (library) {
    const lib = load(LIBRARY_DIR, /^\d+\.sc$/);
    const clash = lib.find((l) => numbers.includes(numberOf(l.file)));
    if (clash) throw new GameBuildError(`${dir}: script ${numberOf(clash.file)} is the library's (${relative(process.cwd(), clash.file)})`);
    compiled.push(...lib);
  }

  const selectors = [...HEADER];
  const classes = new Map<number, ScriptObject & { script: number }>();
  const byName = new Map<string, number>();
  const ctx: AsmContext = {
    selectorNames: selectors,
    kernelNames,
    className: (species) => classes.get(species)?.name,
    propSelectors: (obj) => (obj.isClass ? obj.propSelectors : classes.get(obj.superclass)?.propSelectors),
    classSpecies: (name) => byName.get(name),
    classPropSelectors: (species) => classes.get(species)?.propSelectors,
    classDefaults: (species) => classes.get(species)?.properties,
    newSelector: (name) => selectors.push(name) - 1,
  };

  // Compiled scripts may subclass classes from assembled ones (known once those are built),
  // so the compiler runs inside the same loop.
  const generated = new Map<number, string>();
  let globals: string[] = [];
  const takenSpecies = new Set(sources.flatMap((s) => [...s.text.matchAll(/^\s*class\s+\S+\s+of\s+\S+\s+species\s+(\d+)/gm)].map((m) => Number(m[1]))));
  let compileError: CompileError | undefined;
  const warnings: string[] = [];
  const tryCompile = (): { file: string; text: string }[] => {
    if (!compiled.length) return [];
    try {
      const out = compileScripts(
        compiled.map((s) => ({ file: relative(process.cwd(), s.file), text: s.text })),
        {
          kernelNames,
          takenSpecies,
          // Only when every class is compiled: hand-written scripts' methods can't be seen.
          onWarning: sources.length ? undefined : (w) => warnings.push(`${w.file}:${w.line}: ${w.message}`),
          externalClass: (name) => {
            const species = byName.get(name);
            const c = species === undefined ? undefined : classes.get(species);
            if (!c) return undefined;
            const props = c.propSelectors!.slice(HEADER.length);
            return { species: c.species, properties: props.map((sel, i) => ({ name: selectors[sel]!, value: c.properties[HEADER.length + i]! })) };
          },
          // Next to the including file, then in the game folder, then in the library.
          include: (name, from) => {
            const path = [join(dirname(from), name), join(dir, name), join(LIBRARY_DIR, name)].find((p) => existsSync(p));
            return path ? readFileSync(path, "utf8") : undefined;
          },
        },
      );
      compiled.length = 0;
      compileError = undefined;
      for (const c of out) generated.set(c.number, c.assembly);
      globals = out.find((c) => c.number === 0)?.variables ?? [];
      const rooms = library ? compileRooms() : [];
      return [...out.map((c) => ({ file: c.file, text: c.assembly })), ...rooms];
    } catch (e) {
      if (!(e instanceof CompileError)) throw e;
      compileError = e;
      return [];
    }
  };

  // Rooms as YAML and Yarn: compiled once script 0 is (the target needs its globals).
  const roomMessages: ResourceData[] = [];
  const roomMessageText = new Map<number, string>();
  const roomLines = new Map<number, SpokenLine[]>();
  const compileRooms = (): { file: string; text: string }[] => {
    const roomsDir = join(dir, "rooms");
    if (!existsSync(roomsDir)) return [];
    const target = { ...libraryTarget(globals, items), ...(fonts ? { fonts } : {}) };
    const flags = modFlags(dir, { content: target });
    const out: { file: string; text: string }[] = [];
    for (const { file, text } of load(roomsDir, /^\d+\.room\.yaml$/)) {
      const n = numberOf(file);
      if (numbers.includes(n)) throw new GameBuildError(`${relative(process.cwd(), file)}: there's also a scripts/${n} (a room is one or the other)`);
      const yarnFile = join(roomsDir, `${n}.yarn`);
      let room: ReturnType<typeof compileRoom>;
      try {
        room = compileRoom(text, existsSync(yarnFile) ? readFileSync(yarnFile, "utf8") : undefined, target,
          { yaml: relative(process.cwd(), file), yarn: relative(process.cwd(), yarnFile) }, { flag: flags.number });
      } catch (e) {
        if (e instanceof ContentError) throw new GameBuildError(e.message);
        throw e;
      }
      generated.set(n, room.sca);
      roomMessageText.set(n, room.msg);
      roomLines.set(n, room.lines);
      roomMessages.push({ type: ResourceType.Message, number: n, data: writeMessages(messagesFromText(room.msg).file) });
      out.push({ file: relative(process.cwd(), file), text: room.sca });
    }
    flags.save();
    return out;
  };

  // A script can only be assembled once the classes it uses are known, so keep going round
  // until everything is built or nothing more can be.
  const resources: ResourceData[] = [];
  let pending = [...sources, ...tryCompile()];
  while (pending.length || compiled.length) {
    const failed: { file: string; text: string; error: AsmError }[] = [];
    for (const src of pending) {
      try {
        const built = assemble(src.text, ctx);
        if (Number(basename(src.file).split(".")[0]) !== built.number) throw new GameBuildError(`${src.file} says it is script ${built.number}`);
        resources.push({ type: ResourceType.Script, number: built.number, data: built.code }, { type: ResourceType.Heap, number: built.number, data: built.heap });
        for (const o of parseScript(built.number, built.code, built.heap).objects) {
          if (!o.isClass) continue;
          const other = classes.get(o.species);
          if (other) throw new GameBuildError(`${src.file}: class ${o.name} has species ${o.species}, already taken by ${other.name} (script ${other.script})`);
          if (byName.has(o.name)) throw new GameBuildError(`${src.file}: class ${o.name} is defined twice`);
          classes.set(o.species, { ...o, script: built.number });
          byName.set(o.name, o.species);
        }
      } catch (e) {
        if (!(e instanceof AsmError)) throw e;
        failed.push({ ...src, error: e });
      }
    }
    const more = tryCompile();
    if (failed.length === pending.length && !more.length) {
      if (compileError) throw new GameBuildError(compileError.message);
      throw new GameBuildError(failed.map((f) => `${f.file}: ${f.error.message}`).join("\n"));
    }
    pending = [...failed, ...more];
  }

  const classTable = Array.from({ length: Math.max(-1, ...classes.keys()) + 1 }, (_, species) => classes.get(species)?.script ?? 0);
  resources.push(
    { type: ResourceType.Vocab, number: 997, data: writeSelectorNames(selectors) },
    { type: ResourceType.Vocab, number: 996, data: writeClassTable(classTable) },
  );
  // The globals' names, for tools reading the running game (the player's room links, the
  // editor, the explorer): sci-ts's own vocab, in the selector list format.
  if (globals.length) resources.push({ type: ResourceType.Vocab, number: GLOBAL_NAMES_VOCAB, data: writeSelectorNames(globals) });

  // Messages: the rooms', then those written as text.
  resources.push(...roomMessages);
  const messagesDir = join(dir, "messages");
  if (existsSync(messagesDir)) {
    for (const { file, text } of load(messagesDir, /^\d+\.msg$/)) {
      let parsed: ReturnType<typeof messagesFromText>;
      try {
        parsed = messagesFromText(text);
      } catch (e) {
        throw new GameBuildError(`${relative(process.cwd(), file)}: ${(e as Error).message}`);
      }
      if (parsed.number !== numberOf(file)) throw new GameBuildError(`${file} says it is message file ${parsed.number}`);
      resources.push({ type: ResourceType.Message, number: parsed.number, data: writeMessages(parsed.file) });
    }
  }

  // Music (MIDI files) and digital effects (WAV files).
  const audioFile = <T>(file: string, read: () => T): T => {
    try {
      return read();
    } catch (e) {
      if (e instanceof AudioFileError) throw new GameBuildError(`${relative(process.cwd(), file)}: ${e.message}`);
      throw e;
    }
  };
  const musicDir = join(dir, "music");
  if (existsSync(musicDir)) {
    for (const f of readdirSync(musicDir).filter((x) => /^\d+\.midi?$/i.test(x)).sort()) {
      const file = join(musicDir, f);
      const spec = audioFile(file, () => readMidiFile(new Uint8Array(readFileSync(file))));
      resources.push({ type: ResourceType.Sound, number: numberOf(file), data: writeSound(spec) });
    }
  }
  const files: Record<string, Uint8Array> = {};
  const soundsDir = join(dir, "sounds");
  if (existsSync(soundsDir)) {
    const clips = readdirSync(soundsDir).filter((x) => /^\d+\.wav$/i.test(x)).sort().map((f) => {
      const file = join(soundsDir, f);
      const { samples, rate } = audioFile(file, () => readWav(new Uint8Array(readFileSync(file))));
      return { number: numberOf(file), sol: writeSol(samples, rate) };
    });
    if (clips.length) {
      const { sfx, map } = writeEffects(clips);
      files["RESOURCE.SFX"] = sfx;
      resources.push({ type: ResourceType.Map, number: 65535, data: map });
    }
  }

  // Line ids are the game's, not just a room's: recordings are filed under them.
  const ids = new Map<string, string>();
  for (const line of [...roomLines.values()].flat()) {
    if (line.id === undefined) continue;
    const first = ids.get(line.id);
    if (first) throw new GameBuildError(`${line.where}: #line:${line.id} is already the id of ${first}`);
    ids.set(line.id, line.where);
  }
  if (existsSync(join(dir, "voices"))) {
    const untagged = [...roomLines.values()].flat().filter((l) => l.id === undefined);
    if (untagged.length) warnings.push(`${untagged[0]!.where}: ${untagged.length} spoken line${untagged.length > 1 ? "s have" : " has"} no #line: id, so no recording can be found for ${untagged.length > 1 ? "them" : "it"} (sci-ts lines tag adds them)`);
  }

  // Recorded lines, voices/<id>.wav: each filed under its line's message key today.
  const voicesDir = join(dir, "voices");
  if (existsSync(voicesDir)) {
    const byId = new Map([...roomLines].flatMap(([room, lines]) => lines.filter((l) => l.id !== undefined).map((l) => [l.id!, { room, line: l }] as const)));
    const clips: SpeechClip[] = [];
    for (const f of readdirSync(voicesDir).filter((x) => /\.wav$/i.test(x)).sort()) {
      const file = join(voicesDir, f);
      const found = byId.get(f.slice(0, -4));
      if (!found) {
        warnings.push(`${relative(process.cwd(), file)}: no line has the id #line:${f.slice(0, -4)}, so it isn't used`);
        continue;
      }
      const { samples, rate } = audioFile(file, () => readWav(new Uint8Array(readFileSync(file))));
      const { noun, verb, cond, seq } = found.line;
      clips.push({ module: found.room, noun, verb, cond, seq, sol: writeSol(prepareSpeech(samples, rate), SPEECH_RATE, true) });
    }
    if (clips.length) {
      const { aud, maps } = writeSpeech(clips);
      files["RESOURCE.AUD"] = aud;
      for (const m of maps) resources.push({ type: ResourceType.Map, number: m.module, data: m.data });
    }
    // The script, and what's still to record.
    let script: ScriptLine[];
    try {
      script = lineScript(dir, roomLines);
    } catch (e) {
      throw new GameBuildError(`${relative(process.cwd(), join(voicesDir, "lines.json"))}: ${(e as Error).message}`);
    }
    writeLineScript(dir, script);
    for (const l of script.filter((x) => x.recording === "changed")) {
      warnings.push(`${relative(process.cwd(), join(voicesDir, `${l.id}.wav`))}: recorded before its line changed (${l.where}: "${l.text}"); record it again`);
    }
    const missing = script.filter((x) => x.recording === "missing").length;
    if (missing) warnings.push(`${relative(process.cwd(), join(voicesDir, "lines.json"))}: ${missing} of ${script.length} lines have no recording yet`);
  }

  // Resources made in code: the game's, then the library's and the defaults for what's left.
  const made = async (path: string) => {
    if (!existsSync(path)) return [];
    const mod = (await import(pathToFileURL(resolve(path)).href)) as { default: () => ResourceData[] | Promise<ResourceData[]> };
    return mod.default();
  };
  resources.push(...(await made(join(dir, "resources.ts"))));
  const have = new Set(resources.map(resourceKey));
  // The library's resources are compiled in the npm package (resources.js), source here.
  const libraryResources = ["resources.js", "resources.ts"].map((f) => join(LIBRARY_DIR, f)).find((f) => existsSync(f))!;
  const fallback = [...(library ? await made(libraryResources) : []), ...defaultResources()];
  for (const r of fallback) if (!have.has(resourceKey(r))) (resources.push(r), have.add(resourceKey(r)));

  const keys = resources.map(resourceKey);
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) throw new GameBuildError(`${dir}: resource ${twice} is made twice`);

  return {
    resources,
    selectors,
    classes: new Map([...classes].map(([species, c]) => [species, { name: c.name, script: c.script }])),
    generated,
    globals,
    roomMessages: roomMessageText,
    lines: roomLines,
    files,
    warnings: [...new Set(warnings)],
  };
}

/** An item from items.yaml: its verb, and if it has a view, everything the build needs to make it. */
export interface GameItem {
  verb: number;
  view?: number;
  description?: string;
}

/**
 * items.yaml: each thing the hero can carry, by name. `lens: 10` names just its verb (10 to
 * 255; 1 to 4 are the player's), for a game whose scripts make the item; with a view, the
 * build makes it too, in script ITEMS_SCRIPT, and rooms can give it (`<<get lens>>`):
 *
 *   lens: { verb: 10, view: 250, description: "Holmes's lens." }
 */
export function gameItems(dir: string): Record<string, GameItem> {
  const file = join(dir, "items.yaml");
  if (!existsSync(file)) return {};
  const where = relative(process.cwd(), file);
  const fail = (message: string): never => { throw new GameBuildError(`${where}: ${message}`); };
  let data: unknown;
  try { data = parseYaml(readFileSync(file, "utf8")); }
  catch (e) { return fail((e as Error).message.split("\n")[0]!); }
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) return fail("expected item: verb, or item: { verb, view, description }");
  const items: Record<string, GameItem> = {};
  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || ["look", "talk", "walk", "do", "enter"].includes(name)) fail(`"${name}" can't name an item (lower camelCase, and not a verb)`);
    const spec = typeof value === "number" ? { verb: value } : value;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return fail(`${name}: expected a verb, or { verb, view, description }`);
    const { verb, view, description, ...rest } = spec as Record<string, unknown>;
    const unknown = Object.keys(rest)[0];
    if (unknown) fail(`${name}: unknown key ${unknown}`);
    if (typeof verb !== "number" || !Number.isInteger(verb) || verb < 10 || verb > 255) fail(`${name}: the verb is a number from 10 to 255`);
    if (Object.values(items).some((i) => i.verb === verb)) fail(`${name}: verb ${verb} is used twice`);
    if (view !== undefined && (typeof view !== "number" || !Number.isInteger(view) || view < 0 || view > 65535)) fail(`${name}: view is a view number`);
    if (description !== undefined && (typeof description !== "string" || /["\\]/.test(description))) fail(`${name}: description is text without quotes or backslashes`);
    if (description !== undefined && view === undefined) fail(`${name}: an item the build makes needs a view`);
    items[name] = { verb: verb as number, view: view as number | undefined, description: description as string | undefined };
  }
  return items;
}

/** The script making the items that have views, exported in items.yaml's order. */
function itemsScript(items: Record<string, GameItem>): string | undefined {
  const made = Object.entries(items).filter(([, i]) => i.view !== undefined);
  if (!made.length) return undefined;
  return [
    ";;; The items in items.yaml, made by the build.",
    `(script ${ITEMS_SCRIPT})`,
    '(include "system.sh")',
    `(public ${made.map(([name], i) => `${name} ${i}`).join(" ")})`,
    ...made.map(([name, i]) => `(instance ${name} of InvItem (properties view ${i.view} verb ${i.verb}${i.description ? ` description "${i.description}"` : ""}))`),
    "",
  ].join("\n");
}
