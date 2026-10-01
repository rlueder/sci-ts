import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRoom } from "@sci-ts/content";
import { picFromPngs } from "./pic-build.ts";
import { loadTarget, type ModTarget } from "./mod-target.ts";
import { viewFromManifest } from "./view-build.ts";
import {
  ResourceType, analyzeGame, assemble, messagesFromText, messagesToText, parseMessages, toAssembly, writeMessages, writePic, writeView,
  type AsmContext, type ResourceManager, type ScriptWorld,
} from "@sci-ts/sci";

export interface BuiltResource {
  type: ResourceType;
  number: number;
  data: Uint8Array;
}

/** Message file text with each record annotated: verb name, and the room objects using the noun. */
export async function dumpMessages(rm: ResourceManager, world: ScriptWorld, n: number): Promise<string> {
  const file = parseMessages((await rm.load({ type: ResourceType.Message, number: n })).data);
  const index = await analyzeGame(rm, { world });
  const nounOwners = new Map<number, string[]>();
  for (const o of index.scripts.find((s) => s.number === n)?.objects ?? []) {
    const noun = o.props.find((p) => p.name === "noun")?.value;
    if (noun) nounOwners.set(noun, [...(nounOwners.get(noun) ?? []), o.name]);
  }
  return messagesToText(n, file, (r) => [index.verbs[r.verb], nounOwners.get(r.noun)?.join("/")].filter(Boolean).join(" · ") || undefined);
}

/**
 * Builds a mod directory: <n>.sca / <n>.msg are whole new files (a new room);
 * <n>.sca.diff / <n>.msg.diff change the game's own, applied to fresh dumps with `patch`;
 * <n>.png (+ <n>.layer-<priority>.png) is a room picture; *.view.json is a view;
 * <n>.room.yaml (+ <n>.yarn) is a room described as data, compiled to <n>.sca and <n>.msg
 * (@sci-ts/content). `generated` receives that compiled text, for reading. Their Yarn
 * variables are flags numbered in the mod's flags.yaml (see modFlags). Rooms are compiled for
 * the game named in the mod's mod.yaml (see tools/mod-target.ts).
 */
export async function buildMod(
  modDir: string, rm: ResourceManager, world: ScriptWorld, ctx: AsmContext,
  generated?: (file: string, text: string) => void,
): Promise<BuiltResource[]> {
  const work = mkdtempSync(join(tmpdir(), "sci-mod-"));
  const all = readdirSync(modDir);
  const files = all.filter((f) => /^\d+\.(sca|msg)(\.diff)?$/.test(f));
  const pictures = all.filter((f) => /^\d+\.png$/.test(f));
  const views = all.filter((f) => /\.view\.json$/.test(f));
  const rooms = all.filter((f) => /^\d+\.room\.yaml$/.test(f));
  if (!files.length && !pictures.length && !views.length && !rooms.length) {
    throw new Error(`No <n>.room.yaml, <n>.sca, <n>.msg, .diff, <n>.png or .view.json files in ${modDir}`);
  }
  // <n>.room.yaml + <n>.yarn: compiled to the same text a hand-written room would be.
  const target: ModTarget | undefined = rooms.length ? await loadTarget(modDir) : undefined;
  const flags = target && modFlags(modDir, target);
  const sources = new Map<string, string>();
  // Diffs to apply per generated file: the mod's own, plus the target's support patches.
  const diffs = new Map<string, string[]>();
  for (const f of files.filter((x) => x.endsWith(".diff"))) diffs.set(f.slice(0, -5), [join(modDir, f)]);
  for (const file of rooms) {
    const n = file.split(".")[0]!;
    for (const kind of ["sca", "msg"]) {
      if (files.includes(`${n}.${kind}`)) throw new Error(`${modDir}: both ${file} and ${n}.${kind} define room ${n}`);
    }
    const yarnFile = `${n}.yarn`;
    const room = compileRoom(
      readFileSync(join(modDir, file), "utf8"),
      all.includes(yarnFile) ? readFileSync(join(modDir, yarnFile), "utf8") : undefined,
      target!.content,
      { yaml: join(modDir, file), yarn: join(modDir, yarnFile) },
      { flag: flags!.number },
    );
    sources.set(`${n}.sca`, room.sca).set(`${n}.msg`, room.msg);
    if (room.roomTalkers) {
      // Characters: the target's patches that let the game ask the current room for talkers.
      for (const [patched, diff] of Object.entries(target!.roomTalkerPatches ?? {})) {
        const list = diffs.get(patched) ?? [];
        if (!list.includes(diff)) diffs.set(patched, [diff, ...list]);
      }
    }
    generated?.(`${n}.sca`, room.sca);
    generated?.(`${n}.msg`, room.msg);
    files.push(`${n}.sca`, `${n}.msg`);
  }
  flags?.save();
  const out: BuiltResource[] = [];
  // <n>.png (+ <n>.layer-<priority>.png): a room picture.
  for (const file of pictures) {
    const n = Number(file.split(".")[0]);
    out.push({ type: ResourceType.Pic, number: n, data: writePic(await picFromPngs(modDir, n, rm)) });
  }
  // *.view.json: a view (sprite/animation) from PNGs. Built after pictures, which it may use.
  for (const file of views) {
    const { number, view } = await viewFromManifest(join(modDir, file), rmWith(rm, out));
    out.push({ type: ResourceType.View, number, data: writeView(view) });
  }
  const targets = [...files.filter((f) => !f.endsWith(".diff")), ...[...diffs.keys()].map((f) => `${f}.diff`)];
  for (const file of new Set(targets)) {
    const [n, kind] = file.split(".") as [string, "sca" | "msg"];
    let text: string;
    if (file.endsWith(".diff")) {
      const source = join(work, `${n}.${kind}`);
      writeFileSync(source, kind === "sca" ? toAssembly(await world.script(Number(n)), ctx) : await dumpMessages(rm, world, Number(n)));
      for (const diff of diffs.get(`${n}.${kind}`)!) execFileSync("patch", ["--quiet", "--forward", source, diff], { stdio: "inherit" });
      text = readFileSync(source, "utf8");
    } else text = sources.get(file) ?? readFileSync(join(modDir, file), "utf8");
    if (kind === "sca") {
      const built = assemble(text, ctx);
      out.push({ type: ResourceType.Script, number: built.number, data: built.code }, { type: ResourceType.Heap, number: built.number, data: built.heap });
    } else {
      const { number, file: messages } = messagesFromText(text);
      out.push({ type: ResourceType.Message, number, data: writeMessages(messages) });
    }
  }
  return out;
}

/**
 * A mod's flags.yaml: Yarn variable -> flag number. Saved games store flags by number, so
 * a name keeps its number once given: new names get the next free one (the build adds them
 * to the file; commit it with the mod). `$game<n>` is the game's own flag n.
 */
export function modFlags(modDir: string, target: ModTarget): { number: (name: string) => number; save: () => void } {
  const file = join(modDir, "flags.yaml");
  const { first, last } = target.content.flags;
  const numbers = new Map<string, number>();
  if (existsSync(file)) {
    readFileSync(file, "utf8").split("\n").forEach((raw, i) => {
      const line = raw.replace(/#.*/, "").trim();
      if (!line) return;
      const m = /^([A-Za-z_]\w*)\s*:\s*(\d+)$/.exec(line);
      if (!m) throw new Error(`${file}:${i + 1}: expected name: number`);
      const n = Number(m[2]);
      if (n < first || n > last) throw new Error(`${file}:${i + 1}: ${n} is outside the flags mods may use (${first}-${last})`);
      if ([...numbers.values()].includes(n)) throw new Error(`${file}:${i + 1}: flag ${n} is used twice`);
      numbers.set(m[1]!, n);
    });
  }
  let added = false;
  return {
    number(name) {
      const game = /^game(\d+)$/.exec(name);
      if (game) {
        const n = Number(game[1]);
        if (n > last) throw new Error(`the game's flags go up to ${last}`);
        return n;
      }
      let n = numbers.get(name);
      if (n === undefined) {
        const used = new Set(numbers.values());
        for (n = first; used.has(n); n++);
        if (n > last) throw new Error(`no free flags left (${first}-${last})`);
        numbers.set(name, n);
        added = true;
      }
      return n;
    },
    save() {
      if (!added) return;
      const lines = [...numbers].sort((a, b) => a[1] - b[1]).map(([name, n]) => `${name}: ${n}`);
      writeFileSync(file, [
        "# Flags for the Yarn variables ($name) in these rooms, kept by the build: new names get the",
        "# next free number. Saved games store flags by number, so don't renumber once people play.",
        ...lines, "",
      ].join("\n"));
    },
  };
}

/** The game's resources plus what the mod has built so far (a view may use the mod's picture). */
function rmWith(rm: ResourceManager, built: BuiltResource[]): ResourceManager {
  return {
    async load(id: { type: ResourceType; number: number }) {
      const b = built.find((r) => r.type === id.type && r.number === id.number);
      return b ? { ...id, data: b.data } : rm.load(id);
    },
  } as unknown as ResourceManager;
}
