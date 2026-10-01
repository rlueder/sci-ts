import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AsmError, ResourceType, assemble, kernelNames, parseScript, resourceKey, writeClassTable, writeSelectorNames,
  type AsmContext, type ResourceData, type ScriptObject,
} from "@sci-ts/sci";
import { defaultResources } from "./defaults.ts";

/**
 * Builds a game from its sources, needing nothing from any other game:
 *
 *   games/<name>/scripts/<n>.sca   scripts, in assembly (see packages/sci/src/script/assembly.ts)
 *   games/<name>/resources.ts      optional: `export default () => ResourceData[]` for art,
 *                                  sounds and anything else made by code
 *
 * plus font 0, palette 999 and cursor view 999 (tools/game/defaults.ts) unless the game makes
 * its own. Selectors are numbered as the scripts use them, starting with the nine object
 * header slots; vocab 997 lists them and vocab 996 says which script defines each class.
 */
export interface BuiltGame {
  resources: ResourceData[];
  selectors: string[];
  classes: Map<number, { name: string; script: number }>;
}

/** The object header, in slot order. */
const HEADER = ["-objID-", "-size-", "-propDict-", "-methDict-", "-classScript-", "-script-", "-super-", "-info-", "name"];

export class GameBuildError extends Error {}

export async function buildGame(dir: string): Promise<BuiltGame> {
  const scriptsDir = join(dir, "scripts");
  if (!existsSync(scriptsDir)) throw new GameBuildError(`${dir}: no scripts/ folder`);
  const sources = readdirSync(scriptsDir)
    .filter((f) => /^\d+\.sca$/.test(f))
    .map((f) => ({ file: join(scriptsDir, f), text: readFileSync(join(scriptsDir, f), "utf8") }));
  if (!sources.some((s) => s.file.endsWith("/0.sca"))) throw new GameBuildError(`${dir}: no scripts/0.sca (script 0 exports the game object)`);

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

  // A script can only be assembled once the classes it uses are known, so keep going round
  // until everything is built or nothing more can be.
  const resources: ResourceData[] = [];
  let pending = sources;
  while (pending.length) {
    const failed: { file: string; text: string; error: AsmError }[] = [];
    for (const src of pending) {
      try {
        const built = assemble(src.text, ctx);
        if (!src.file.endsWith(`/${built.number}.sca`)) throw new GameBuildError(`${src.file} says it is script ${built.number}`);
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
    if (failed.length === pending.length) {
      throw new GameBuildError(failed.map((f) => `${f.file}: ${f.error.message}`).join("\n"));
    }
    pending = failed;
  }

  const classTable = Array.from({ length: Math.max(-1, ...classes.keys()) + 1 }, (_, species) => classes.get(species)?.script ?? 0);
  resources.push(
    { type: ResourceType.Vocab, number: 997, data: writeSelectorNames(selectors) },
    { type: ResourceType.Vocab, number: 996, data: writeClassTable(classTable) },
  );

  const own = join(dir, "resources.ts");
  if (existsSync(own)) {
    const mod = (await import(pathToFileURL(resolve(own)).href)) as { default: () => ResourceData[] | Promise<ResourceData[]> };
    resources.push(...(await mod.default()));
  }
  const have = new Set(resources.map(resourceKey));
  for (const r of defaultResources()) if (!have.has(resourceKey(r))) resources.push(r);

  const keys = resources.map(resourceKey);
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) throw new GameBuildError(`${dir}: resource ${twice} is made twice`);

  return {
    resources,
    selectors,
    classes: new Map([...classes].map(([species, c]) => [species, { name: c.name, script: c.script }])),
  };
}
