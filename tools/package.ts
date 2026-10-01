/**
 * The npm package: one `sci-ts` package from this workspace, in out/package.
 *
 *   pnpm tsx tools/package.ts [out dir]     then: cd out/package && npm publish
 *
 * The repository's layout is kept (packages/sci/src, packages/content/src, tools, lib,
 * apps/viewer), so paths the code works out at run time still hold. Workspace imports
 * (@scope/sci, @scope/content) become relative paths, and tsc writes JavaScript and type
 * declarations next to the TypeScript, which ships too: Vite serves the player from its
 * sources, and the editor and the art tool load TypeScript through tsx.
 *
 * Before anything is written, the files are checked: no resources or dumps of a game.
 * (What reaches this repository has already been checked for any game's text and names.)
 * The package's own package.json is made from the root one.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(ROOT, "out/package"));

/** What goes in, as repository paths. */
const INCLUDE = ["packages/sci/src", "packages/content/src", "packages/content/room.schema.json", "tools", "lib", "apps/viewer", "README.md", "LICENSE", "CHANGELOG.md"];
const EXCLUDE = [
  /(^|\/)node_modules(\/|$)/, /(^|\/)\.DS_Store$/, /^apps\/viewer\/(out|dist)\//,
  /^tools\/(_|oss-export|package)/, /^tools\/targets\//, /^tools\/art\/(grotto|wisp-portrait)\.ts$/,
];
/** Files that mustn't be in a package: a game's resources, and dumps or diffs of them. */
const FORBIDDEN = /\.(scr|hep|v56|p56|map|aud|sfx|sca|diff|bin|msg)$/i;

function walk(path: string): string[] {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [path];
  return readdirSync(abs).flatMap((name) => walk(`${path}/${name}`));
}

const files = INCLUDE.flatMap(walk).filter((f) => !EXCLUDE.some((re) => re.test(f)));

// --- Checks ---
const problems: string[] = [];
for (const f of files) {
  if (FORBIDDEN.test(f)) problems.push(`${f}: looks like a game resource or a dump of one`);
}
if (problems.length) {
  console.error(`Not packaged:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

// --- Stage ---
rmSync(out, { recursive: true, force: true });
const scope = (name: string) => new RegExp(`(["'])@[\\w-]+/${name}\\1`, "g");
for (const f of files) {
  const to = join(out, f);
  mkdirSync(dirname(to), { recursive: true });
  if (!f.endsWith(".ts")) {
    cpSync(join(ROOT, f), to);
    continue;
  }
  // Workspace packages become relative imports of their sources.
  const rel = (target: string) => {
    const r = relative(dirname(f), target).replaceAll("\\", "/");
    return r.startsWith(".") ? r : `./${r}`;
  };
  const text = readFileSync(join(ROOT, f), "utf8")
    .replace(scope("sci"), (_, q: string) => `${q}${rel("packages/sci/src/index.ts")}${q}`)
    .replace(scope("content"), (_, q: string) => `${q}${rel("packages/content/src/index.ts")}${q}`);
  writeFileSync(to, text);
}

// --- Compile: JavaScript and declarations beside the TypeScript ---
writeFileSync(join(out, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
    lib: ["ES2022", "DOM", "DOM.Iterable"], types: ["node", "vite/client"],
    strict: true, skipLibCheck: true, isolatedModules: true, verbatimModuleSyntax: true,
    allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true,
    declaration: true,
  },
  include: ["packages/*/src", "tools", "lib", "apps/viewer/plugin.ts", "apps/viewer/src"],
}, null, 2));
// Dependencies (and their types) come from this workspace: while compiling, each staged
// package folder links to its original's node_modules.
const links = ["", "packages/content", "tools", "apps/viewer"].filter((d) => existsSync(join(ROOT, d, "node_modules")));
for (const d of links) symlinkSync(join(ROOT, d, "node_modules"), join(out, d, "node_modules"), "dir");
try {
  execFileSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(out, "tsconfig.json")], { stdio: "inherit" });
} finally {
  for (const d of links) rmSync(join(out, d, "node_modules"));
  rmSync(join(out, "tsconfig.json"));
}

// --- package.json ---
const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const viewer = JSON.parse(readFileSync(join(ROOT, "apps/viewer/package.json"), "utf8"));
const content = JSON.parse(readFileSync(join(ROOT, "packages/content/package.json"), "utf8"));
const entry = (path: string) => ({ types: `./${path}.d.ts`, default: `./${path}.js` });
const pkg = {
  name: "sci-ts",
  version: root.version ?? "0.0.0",
  description: root.description,
  license: "MIT",
  type: "module",
  repository: { type: "git", url: "git+https://github.com/rlueder/sci-ts.git" },
  homepage: "https://github.com/rlueder/sci-ts#readme",
  keywords: ["sci", "sierra", "adventure", "game-engine", "point-and-click", "interpreter"],
  engines: { node: ">=22.18" },
  bin: { "sci-ts": "bin/sci-ts.mjs" },
  exports: {
    ".": entry("packages/sci/src/index"),
    "./content": entry("packages/content/src/index"),
    "./kit": entry("tools/game/kit"),
    "./build": entry("tools/game/build"),
    "./art": entry("tools/art/build"),
    "./png": entry("tools/png"),
    // The player is TypeScript for Vite to serve; its types are generated.
    "./viewer": { types: "./apps/viewer/src/session.d.ts", default: "./apps/viewer/src/session.ts" },
    "./vite": entry("apps/viewer/plugin"),
    "./package.json": "./package.json",
  },
  dependencies: {
    tsx: root.devDependencies.tsx,
    vite: root.devDependencies.vite,
    ...content.dependencies,
    ...viewer.dependencies,
    sirv: viewer.devDependencies.sirv,
  },
};
delete (pkg.dependencies as Record<string, string>)["@sci-ts/sci"];
delete (pkg.dependencies as Record<string, string>)["@sci-ts/sci"];
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
mkdirSync(join(out, "bin"), { recursive: true });
writeFileSync(join(out, "bin/sci-ts.mjs"), `#!/usr/bin/env node
// The sci-ts command, run with tsx so that a game's own TypeScript (resources.ts) loads.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../tools/cli.js", import.meta.url));
const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
`, { mode: 0o755 });

console.log(`${relative(process.cwd(), out)}: sci-ts ${pkg.version}, ${files.length} source files`);
