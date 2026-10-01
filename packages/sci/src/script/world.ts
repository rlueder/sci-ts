import type { ResourceManager } from "../resource/manager.ts";
import { ResourceType } from "../resource/types.ts";
import type { AsmContext } from "./assembly.ts";
import type { DisasmContext } from "./disasm.ts";
import { kernelNames } from "./kernel-names.ts";
import { parseScript, type Script, type ScriptObject } from "./script.ts";
import { parseClassTable, parseSelectorNames } from "./vocab.ts";

/**
 * Game-wide script knowledge: selector names, the class table, and lazily loaded scripts.
 * Resolves class names and property layouts across script boundaries.
 */
export class ScriptWorld {
  private readonly scripts = new Map<number, Script>();
  private readonly classes = new Map<number, ScriptObject>();

  private constructor(
    private readonly rm: ResourceManager,
    readonly selectorNames: string[],
    readonly classScripts: number[],
  ) {}

  static async open(rm: ResourceManager): Promise<ScriptWorld> {
    const vocab = async (n: number) => (await rm.load({ type: ResourceType.Vocab, number: n })).data;
    return new ScriptWorld(rm, parseSelectorNames(await vocab(997)), parseClassTable(await vocab(996)));
  }

  async script(number: number): Promise<Script> {
    let s = this.scripts.get(number);
    if (!s) {
      const code = (await this.rm.load({ type: ResourceType.Script, number })).data;
      const heap = (await this.rm.load({ type: ResourceType.Heap, number })).data;
      s = parseScript(number, code, heap);
      this.scripts.set(number, s);
      for (const obj of s.objects) if (obj.isClass) this.classes.set(obj.species, obj);
    }
    return s;
  }

  /** Loads every script that defines a class, so class lookups are synchronous afterwards. */
  async loadAllClasses(): Promise<void> {
    const numbers = new Set(this.classScripts.filter((n) => this.rm.has({ type: ResourceType.Script, number: n })));
    for (const n of numbers) await this.script(n);
  }

  classObject(species: number): ScriptObject | undefined {
    return this.classes.get(species);
  }

  /** For the assembler: names both ways and class layouts. Requires `loadAllClasses()`. */
  asmContext(): AsmContext {
    const byName = new Map([...this.classes.values()].map((c) => [c.name, c.species] as const));
    return {
      ...this.context(),
      classSpecies: (name) => byName.get(name),
      classPropSelectors: (species) => this.classes.get(species)?.propSelectors,
      classDefaults: (species) => this.classes.get(species)?.properties,
    };
  }

  /** Requires `loadAllClasses()` first. */
  context(): DisasmContext {
    return {
      selectorNames: this.selectorNames,
      kernelNames,
      className: (species) => this.classes.get(species)?.name,
      propSelectors: (obj) => (obj.isClass ? obj.propSelectors : this.classes.get(obj.superclass)?.propSelectors),
    };
  }
}
