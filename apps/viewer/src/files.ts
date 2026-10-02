import { APP_ID } from "./app.ts";
import { ResourceManager, type FileSource } from "@sci-ts/sci";

/** Where the page is served from: / in development, wherever a built site is put. */
export const BASE = import.meta.env.BASE_URL;

/**
 * FileSource over game/: the dev server's mount (see vite.config.ts), or the game copied
 * next to a built site, with its file names in game/files.json (`pnpm game site`).
 *
 * A built site's files.json also has the build's `version`. It's always fetched fresh, and
 * every game file is fetched with the version on its URL, so after a new build a browser
 * can't mix its cached files with the new ones (an old RESOURCE.000 under a new RESOURCE.MAP
 * doesn't start).
 */
export const httpFiles: FileSource = {
  async read(path) {
    const res = await fetch(await gameUrl(path));
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
  },
  async readRange(path, offset, length) {
    const res = await fetch(await gameUrl(path), { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A server that ignores Range (Python's http.server) sends the whole file.
    return res.status === 206 ? bytes : bytes.subarray(offset, offset + length);
  },
  async list(dir) {
    if (import.meta.env.DEV) return (await fetch(`/__list?dir=${encodeURIComponent(dir)}`)).json();
    const files = (await staticListing())[dir];
    return Array.isArray(files) ? files : [];
  },
};

let listing: Promise<Record<string, unknown>> | undefined;
const staticListing = () => (listing ??= fetch(`${BASE}game/files.json`, { cache: "no-store" }).then((r): Promise<Record<string, unknown>> => (r.ok ? r.json() : Promise.resolve({}))));

/** A game file's URL: on a built site, with the build's version (see httpFiles). */
async function gameUrl(path: string): Promise<string> {
  const url = `${BASE}game/${path}`;
  if (import.meta.env.DEV) return url;
  const version = (await staticListing()).version;
  return typeof version === "string" ? `${url}?v=${encodeURIComponent(version)}` : url;
}

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

/** Mods built into out/mods (see `pnpm mod build`); a built site has none. */
export async function availableMods(): Promise<string[]> {
  if (!import.meta.env.DEV) return [];
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
