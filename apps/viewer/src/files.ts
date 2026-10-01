import { APP_ID } from "./app.ts";
import { ResourceManager, type FileSource } from "@sci-ts/sci";

/** FileSource over the dev server's /game/ mount (see vite.config.ts). */
export const httpFiles: FileSource = {
  async read(path) {
    const res = await fetch(`/game/${path}`);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
  },
  async readRange(path, offset, length) {
    const res = await fetch(`/game/${path}`, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    return new Uint8Array(await res.arrayBuffer());
  },
  async list(dir) {
    return (await fetch(`/__list?dir=${encodeURIComponent(dir)}`)).json();
  },
};

// --- Mods -------------------------------------------------------------------------------

const MODS_KEY = `${APP_ID}.mods`;

/**
 * The mods to load: `?mods=a,b` in the URL, else the last choice (per browser). `?mods=`
 * (empty) turns them off.
 */
export function activeMods(): string[] {
  const param = new URLSearchParams(location.search).get("mods");
  let list = param;
  if (list === null) {
    try {
      list = localStorage.getItem(MODS_KEY);
    } catch {
      list = null;
    }
  }
  return (list ?? "").split(",").map((m) => m.trim()).filter((m) => /^[\w.-]+$/.test(m));
}

export function rememberMods(mods: string[]): void {
  try {
    localStorage.setItem(MODS_KEY, mods.join(","));
  } catch {
    /* private mode: only the URL carries it */
  }
}

/** Mods built into out/mods (see `pnpm mod build`). */
export async function availableMods(): Promise<string[]> {
  try {
    return await (await fetch("/__mods")).json();
  } catch {
    return [];
  }
}

/** The game's resources with the active mods layered on top, as patch directories. */
export async function openGame(): Promise<{ rm: ResourceManager; mods: string[] }> {
  const mods = activeMods();
  const rm = await ResourceManager.open(httpFiles, ["", "PATCHES", ...mods.map((m) => `MODS/${m}`)]);
  return { rm, mods };
}
