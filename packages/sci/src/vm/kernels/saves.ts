import { restore, snapshot, type VmSnapshot } from "../savegame.ts";
import type { KernelFn, Vm } from "../vm.ts";
import { toSigned } from "../value.ts";
import { stringHelpers } from "./arrays.ts";
import { audio } from "./audio.ts";
import { graphics } from "./graphics.ts";
import { paletteEffects } from "./palette.ts";
import { input } from "./system.ts";

export interface SaveInfo {
  id: number;
  description: string;
  version: string;
  date: number;
}

/** Where saves live. Synchronous because kernels are; hosts preload and write through. */
export interface SaveStore {
  list(): SaveInfo[];
  get(id: number): { info: SaveInfo; snapshot: VmSnapshot } | undefined;
  put(info: SaveInfo, snapshot: VmSnapshot): void;
}

export class MemorySaveStore implements SaveStore {
  readonly saves = new Map<number, { info: SaveInfo; snapshot: VmSnapshot }>();
  /** Called after every write, e.g. to persist asynchronously. */
  onWrite?: (info: SaveInfo, snapshot: VmSnapshot) => void;

  list(): SaveInfo[] {
    return [...this.saves.values()].map((s) => s.info).sort((a, b) => b.date - a.date);
  }

  get(id: number) {
    return this.saves.get(id);
  }

  put(info: SaveInfo, snap: VmSnapshot): void {
    this.saves.set(info.id, { info, snapshot: snap });
    this.onWrite?.(info, snap);
  }
}

const Restarting = { None: 0, Restart: 1, Restore: 2 } as const;
/** SSCI's fixed description slot size in GetSaveFiles' output. */
const DESCRIPTION_SIZE = 36;

class SaveState {
  store: SaveStore = new MemorySaveStore();
  restarting: number = Restarting.None;
}

const stateOf = new WeakMap<Vm, SaveState>();
export const saves = (vm: Vm): SaveState => {
  let s = stateOf.get(vm);
  if (!s) stateOf.set(vm, (s = new SaveState()));
  return s;
};

/**
 * Loads a saved game the way SSCI's RestoreGame does: host state (planes, screen items,
 * palette, sound) is cleared, memory replaced, and the game restarts with `replay` knowing
 * it's a restore. Hosts that load a save themselves must use this too: stale planes and
 * items left from before would alias unrelated objects in the restored memory.
 */
export function restoreGame(vm: Vm, snap: VmSnapshot): void {
  const game = vm.exportAddress(0, 0);
  resetHostState(vm);
  restore(vm, snap);
  saves(vm).restarting = Restarting.Restore;
  vm.resetExecution();
  vm.start(game, "replay");
}

/** Clears everything that isn't part of the VM's memory before a restart or restore. */
function resetHostState(vm: Vm) {
  audio(vm).stopEverything();
  const g = graphics(vm);
  g.planes.clear();
  g.items.clear();
  g.resetPalette();
  paletteEffects(vm).reset();
  input(vm).queue.length = 0;
}

export const saveKernels: Record<string, KernelFn> = {
  // SaveGame(gameName, id, description, version)
  SaveGame: (vm, [, id = 0, description = 0, version = 0]) => {
    const info: SaveInfo = {
      id,
      description: stringHelpers.str(vm, description),
      version: stringHelpers.str(vm, version),
      date: Date.now(),
    };
    saves(vm).store.put(info, snapshot(vm));
    return 1;
  },

  // RestoreGame(gameName, id, version): on success nothing returns; the game restarts in
  // the saved state via `theGame replay`, as in the original interpreter.
  RestoreGame: (vm, [, id = 0]) => {
    const save = saves(vm).store.get(toSigned(id));
    if (!save) return 0;
    restoreGame(vm, save.snapshot);
    return 1;
  },

  RestartGame: (vm) => {
    resetHostState(vm);
    vm.resetMemory();
    saves(vm).restarting = Restarting.Restart;
    vm.start(vm.exportAddress(0, 0), "play");
    return 0;
  },

  // Returns the flag; any argument clears it.
  GameIsRestarting: (vm, args) => {
    const s = saves(vm);
    const flag = s.restarting;
    if (args.length) s.restarting = Restarting.None;
    return flag;
  },

  // GetSaveFiles(gameName, descriptions, ids): fixed 36-byte description slots and a
  // 0-terminated id list, newest first.
  GetSaveFiles: (vm, [, descriptions = 0, ids = 0]) => {
    const list = saves(vm).store.list();
    const desc = stringHelpers.resolve(vm, descriptions);
    const idArray = stringHelpers.resolve(vm, ids);
    if (desc) {
      desc.data = new Array(DESCRIPTION_SIZE * list.length + 1).fill(0);
      list.forEach((s, i) => {
        const text = s.description.slice(0, DESCRIPTION_SIZE - 1);
        for (let c = 0; c < text.length; c++) desc.data[i * DESCRIPTION_SIZE + c] = text.charCodeAt(c) & 0xff;
      });
    }
    if (idArray) idArray.data = [...list.map((s) => s.id & 0xffff), 0];
    return list.length;
  },

  // CheckSaveGame(gameName, id, version): exists and was made by this game version.
  CheckSaveGame: (vm, [, id = 0, version = 0]) => {
    const save = saves(vm).store.get(toSigned(id));
    return save && save.info.version === stringHelpers.str(vm, version) ? 1 : 0;
  },

  GetSaveDir: (vm) => stringHelpers.newString(vm, "SAVES"),
  MakeSaveCatName: (vm, [dst = 0]) => stringHelpers.writeString(vm, dst, "QG4CDSG.CAT"),
  MakeSaveFileName: (vm, [dst = 0, , id = 0]) => stringHelpers.writeString(vm, dst, `QG4CDSG.${String(toSigned(id)).padStart(3, "0")}`),
};
