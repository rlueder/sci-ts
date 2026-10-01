import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export interface SciGameOptions {
  /** The built game's folder (RESOURCE.MAP, RESOURCE.000...), served as /game/. */
  game: string;
  /** Built mods (one folder each), served as /game/MODS/<name> and listed at /__mods. */
  mods?: string;
  /** SoundFonts for music, served as /soundfonts/ (GeneralUser-GS.sf2 is the one used). */
  soundfonts?: string;
  /** The live editor's routes (/__editor): edits and rebuilds the game being served. */
  editor?: boolean;
}

const EDITOR_SERVER = resolve(import.meta.dirname, "../../tools/editor-server.ts");

/**
 * A Vite plugin that serves an SCI game to pages using the player (`sci-ts/viewer`): the
 * game's files under /game/ (Range requests too), directory listings at /__list, and
 * optionally mods, SoundFonts and the editor's routes. Development only; a built site
 * carries the game itself (see `sci-ts site`).
 */
export function sciGame(options: SciGameOptions): Plugin {
  const game = resolve(options.game);
  const mods = options.mods && resolve(options.mods);
  return {
    name: "sci-game",
    // Pages outside this repository import the player's sources from it.
    config: () => ({ server: { fs: { allow: [resolve(import.meta.dirname, "../.."), process.cwd()] } } }),
    async configureServer(server) {
      const sirv = (await import("sirv")).default;
      // Before /game: mods look like a MODS folder inside the game, as patch directories.
      if (mods) {
        server.middlewares.use("/game/MODS", sirv(mods, { dev: true }));
        server.middlewares.use("/__mods", async (_req, res) => {
          const entries = await readdir(mods, { withFileTypes: true }).catch(() => []);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()));
        });
      }
      // A file that isn't there is a 404, not the page (Vite's fallback for unknown paths):
      // the player asks for files a game may not have (RESOURCE.SFX, the SoundFont).
      const notFound = (_req: unknown, res: { statusCode: number; end: () => void }) => ((res.statusCode = 404), res.end());
      server.middlewares.use("/game", sirv(game, { dev: true }));
      server.middlewares.use("/game", notFound);
      if (options.soundfonts) server.middlewares.use("/soundfonts", sirv(resolve(options.soundfonts), { dev: true }));
      server.middlewares.use("/soundfonts", notFound);
      if (options.editor) {
        // Loaded through Vite so edits to the tools take effect; the game stays loaded in it.
        const editor = () => server.ssrLoadModule(EDITOR_SERVER) as Promise<typeof import("../../tools/editor-server.ts")>;
        server.middlewares.use("/__editor", async (req, res) => {
          const url = new URL(req.url ?? "", "http://x");
          const json = (status: number, body: unknown) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
          };
          try {
            const mod = url.searchParams.get("mod") ?? "";
            if (req.method === "GET" && url.pathname === "/mods") return json(200, (await editor()).listMods());
            if (req.method === "GET" && url.pathname === "/files") return json(200, (await editor()).readFiles(mod));
            if (req.method === "POST" && url.pathname === "/save") {
              let body = "";
              for await (const chunk of req) body += chunk;
              const { files } = JSON.parse(body) as { files: Record<string, string> };
              return json(200, await (await editor()).save(mod, files));
            }
            json(404, { error: "unknown editor route" });
          } catch (e) {
            json(500, { error: (e as Error).message });
          }
        });
      }
      server.middlewares.use("/__list", async (req, res) => {
        const dir = new URL(req.url ?? "", "http://x").searchParams.get("dir") ?? "";
        const base = mods && (dir === "MODS" || dir.startsWith("MODS/")) ? resolve(mods, dir.slice(5)) : resolve(game, dir);
        const names = await readdir(base).catch(() => []);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(names));
      });
    },
  };
}
