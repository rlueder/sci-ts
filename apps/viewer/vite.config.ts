import { resolve } from "node:path";
import { defineConfig } from "vite";
import { sciGame } from "./plugin.ts";

/** The game to serve: original/ unless SCI_GAME names another (e.g. out/games/hello). */
const GAME_DIR = resolve(import.meta.dirname, "../..", process.env.SCI_GAME ?? "original");

/**
 * The resource viewer, player, explorer and room editor, for the game in SCI_GAME: its
 * files, built mods (`pnpm mod build mods/<name>` → out/mods/<name>), SoundFonts
 * (assets/soundfonts) and the editor's routes come from the sciGame plugin.
 */
export default defineConfig({
  publicDir: false,
  // Allow access through ngrok tunnels (Vite blocks unknown hostnames by default).
  server: { allowedHosts: [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.io"] },
  plugins: [
    sciGame({
      game: GAME_DIR,
      mods: resolve(import.meta.dirname, "../../out/mods"),
      soundfonts: resolve(import.meta.dirname, "../../assets/soundfonts"),
      editor: true,
    }),
  ],
});
