import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { writeResourceArchive } from "@sci-ts/sci";
import { buildGame } from "../game/build.ts";
import { markdown } from "./markdown.ts";

/**
 * A static site, to publish anywhere (GitHub Pages, any web server):
 *
 *   index.html, CONTRIBUTING.html, ...   the Markdown of this repository (or a game's), as pages
 *   docs/...                             docs/**.md as pages, and their screenshots
 *   play/play.html                       the player, with the game in play/game/
 *
 * The SoundFont for music (GeneralUser-GS.sf2) is copied from the game's assets/soundfonts/,
 * or else this repository's, if it's there (it isn't part of either repository: a game's
 * publishing workflow fetches it); without it, games play silently.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const VIEWER = join(ROOT, "apps/viewer");
const SOUNDFONT = "assets/soundfonts/GeneralUser-GS.sf2";

export async function buildSite(
  gameDir: string,
  outDir: string,
  options: { docs?: string; name?: string } = {},
): Promise<{ pages: number; game: string; soundFont: boolean }> {
  const out = resolve(outDir);
  // Whose Markdown becomes the pages: this repository's, or the game's own.
  const docs = resolve(options.docs ?? ROOT);
  const name = options.name ?? "sci-ts";
  rmSync(out, { recursive: true, force: true });
  const game = await buildGame(gameDir);

  // The player: built by Vite with relative paths, then the game beside it.
  const { build } = await import("vite");
  const play = join(out, "play");
  await build({
    root: VIEWER,
    configFile: join(VIEWER, "vite.config.ts"),
    base: "./",
    logLevel: "warn",
    build: { outDir: play, emptyOutDir: true, rollupOptions: { input: { play: join(VIEWER, "play.html") } } },
  });
  const { map, volume } = writeResourceArchive(game.resources);
  const files: Record<string, Uint8Array> = { "RESOURCE.MAP": map, "RESOURCE.000": volume, ...game.files };
  mkdirSync(join(play, "game"), { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(play, "game", name), data);
  // What the player lists in place of the dev server's directory listings.
  writeFileSync(join(play, "game/files.json"), JSON.stringify({ "": Object.keys(files) }));
  const sf2 = [join(resolve(gameDir), SOUNDFONT), join(ROOT, SOUNDFONT)].find((f) => existsSync(f));
  const soundFont = sf2 !== undefined;
  if (sf2) cpSync(sf2, join(play, "soundfonts", basename(sf2)));

  // The pages.
  const sources = [
    ...["README.md", "CONTRIBUTING.md", "CHANGELOG.md"].filter((f) => existsSync(join(docs, f))),
    ...walk(docs, "docs").filter((f) => f.endsWith(".md")),
  ];
  const nav = [
    ["index.html", name],
    ["play/play.html", "Play"],
    ...sources.filter((f) => f.startsWith("docs/") && dirname(f) === "docs").map((f) => [f.replace(/\.md$/, ".html"), titleOf(docs, f)]),
  ];
  for (const f of sources) {
    const page = f === "README.md" ? "index.html" : f.replace(/\.md$/, ".html").replace(/(^|\/)README\.html$/, "$1index.html");
    const { html, title } = markdown(readFileSync(join(docs, f), "utf8"));
    const up = "../".repeat(page.split("/").length - 1);
    const links = nav.map(([href, label]) => `<a href="${up}${href}"${href === page ? ' aria-current="page"' : ""}>${label}</a>`).join("");
    mkdirSync(dirname(join(out, page)), { recursive: true });
    writeFileSync(join(out, page), template(title || basename(f), name, links, html));
  }
  if (existsSync(join(docs, "docs/screenshots"))) cpSync(join(docs, "docs/screenshots"), join(out, "docs/screenshots"), { recursive: true });
  if (existsSync(join(docs, "LICENSE"))) cpSync(join(docs, "LICENSE"), join(out, "LICENSE"));
  return { pages: sources.length, game: relative(ROOT, resolve(gameDir)), soundFont };
}

function walk(root: string, dir: string): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).sort().flatMap((name) => (statSync(join(abs, name)).isDirectory() ? walk(root, `${dir}/${name}`) : [`${dir}/${name}`]));
}

const titleOf = (root: string, f: string) => markdown(readFileSync(join(root, f), "utf8")).title || basename(f, ".md");

function template(title: string, site: string, nav: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, "&lt;")} · ${site}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fbfbf8; --muted: #6b6b6b; --line: #ddd; --code: #f0efe9; --link: #2a5db0; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6e6e3; --bg: #18181a; --muted: #9a9a9a; --line: #333; --code: #242428; --link: #8ab4f8; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, sans-serif; }
  nav { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); font-size: 14px; }
  nav a { color: var(--muted); text-decoration: none; }
  nav a[aria-current] { color: var(--fg); font-weight: 600; }
  main { max-width: 760px; margin: 0 auto; padding: 16px 16px 64px; }
  a { color: var(--link); }
  img { max-width: 100%; image-rendering: pixelated; }
  pre { background: var(--code); padding: 12px; overflow-x: auto; border-radius: 4px; font-size: 13px; }
  code { background: var(--code); padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; display: block; overflow-x: auto; font-size: 14px; }
  th, td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; }
  blockquote { margin: 0; padding: 0 16px; border-left: 3px solid var(--line); color: var(--muted); }
</style>
</head>
<body>
<nav>${nav}</nav>
<main>
${body}
</main>
</body>
</html>
`;
}
