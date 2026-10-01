import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const GAME_DIR = resolve(import.meta.dirname, "../../original");
const SOUNDFONT_DIR = resolve(import.meta.dirname, "../../assets/soundfonts");
/** Built mods (`pnpm mod build mods/<name>` → out/mods/<name>), served as /game/MODS/<name>. */
const MODS_DIR = resolve(import.meta.dirname, "../../out/mods");
/** The live editor's build service (editor.html). */
const EDITOR_SERVER = resolve(import.meta.dirname, "../../tools/editor-server.ts");

/**
 * Dev only: serve the local game files under /game/ (Range requests supported), built mods
 * under /game/MODS/, a dir listing, the list of built mods, and downloaded SoundFonts; and
 * the live editor's routes (/__editor: mods, their room files, save + build).
 */
export default defineConfig({
  publicDir: false,
  // Allow access through ngrok tunnels (Vite blocks unknown hostnames by default).
  server: { allowedHosts: [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.io"] },
  plugins: [
    {
      name: "game-files",
      async configureServer(server) {
        const sirv = (await import("sirv")).default;
        // Before /game: mods look like a MODS folder inside the game, as patch directories.
        server.middlewares.use("/game/MODS", sirv(MODS_DIR, { dev: true }));
        server.middlewares.use("/game", sirv(GAME_DIR, { dev: true }));
        server.middlewares.use("/__mods", async (_req, res) => {
          const entries = await readdir(MODS_DIR, { withFileTypes: true }).catch(() => []);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()));
        });
        server.middlewares.use("/soundfonts", sirv(SOUNDFONT_DIR, { dev: true }));
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
        server.middlewares.use("/__list", async (req, res) => {
          const dir = new URL(req.url ?? "", "http://x").searchParams.get("dir") ?? "";
          const base = dir === "MODS" || dir.startsWith("MODS/") ? resolve(MODS_DIR, dir.slice(5)) : resolve(GAME_DIR, dir);
          const names = await readdir(base).catch(() => []);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(names));
        });
      },
    },
  ],
});
