import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AsmError, CompileError, GLOBAL_NAMES_VOCAB, OBJECT_HEADER, ResourceType, assemble, compileScripts, kernelNames, messagesFromText, parseScript,
  resourceKey, writeClassTable, writeEffects, writeMessages, writeSelectorNames, writeSol, writeSound, type AsmContext,
  type ResourceData, type ScriptObject,
} from "@sci-ts/sci";
import { ContentError, compileRoom } from "@sci-ts/content";
import { modFlags } from "../mod-build.ts";
import { AudioFileError, readMidiFile, readWav } from "./audio.ts";
import { defaultResources } from "./defaults.ts";
import { libraryTarget } from "./target.ts";

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
 *   games/<name>/music/<n>.mid     music: sound n, from a Standard MIDI File (General MIDI)
 *   games/<name>/sounds/<n>.wav    digital effects: sound n plays this instead of music
 *   games/<name>/resources.ts      optional: `export default () => ResourceData[]` for art,
 *                                  music and anything else made by code
 *   games/<name>/game.json         optional: { "library": false } to build without lib/
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
  /** Files that go next to RESOURCE.MAP and RESOURCE.000 (RESOURCE.SFX, the effects). */
  files: Record<string, Uint8Array>;
  /** Likely mistakes that still built, as file:line: message. */
  warnings: string[];
}

const HEADER = OBJECT_HEADER;

export class GameBuildError extends Error {}

/** sci-ts's class library: scripts every game gets, and the resources they use. */
export const LIBRARY_DIR = resolve(import.meta.dirname, "../../lib");

export async function buildGame(dir: string, options: { library?: boolean } = {}): Promise<BuiltGame> {
  const scriptsDir = join(dir, "scripts");
  if (!existsSync(scriptsDir)) throw new GameBuildError(`${dir}: no scripts/ folder`);
  const config = existsSync(join(dir, "game.json")) ? (JSON.parse(readFileSync(join(dir, "game.json"), "utf8")) as { library?: boolean }) : {};
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
  const compileRooms = (): { file: string; text: string }[] => {
    const roomsDir = join(dir, "rooms");
    if (!existsSync(roomsDir)) return [];
    const target = libraryTarget(globals);
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

  // Resources made in code: the game's, then the library's and the defaults for what's left.
  const made = async (path: string) => {
    if (!existsSync(path)) return [];
    const mod = (await import(pathToFileURL(resolve(path)).href)) as { default: () => ResourceData[] | Promise<ResourceData[]> };
    return mod.default();
  };
  resources.push(...(await made(join(dir, "resources.ts"))));
  const have = new Set(resources.map(resourceKey));
  const fallback = [...(library ? await made(join(LIBRARY_DIR, "resources.ts")) : []), ...defaultResources()];
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
    files,
    warnings: [...new Set(warnings)],
  };
}
