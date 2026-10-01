#!/usr/bin/env node
// The sci-ts command (tools/cli.ts), run with this package's own TypeScript loader, so a
// game's repository needs nothing but sci-ts installed.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../tools/cli.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");
const child = spawn(process.execPath, ["--import", tsx, cli, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
