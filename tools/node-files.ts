import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileSource } from "@sci-ts/sci";

/** FileSource over a local game directory. */
export function nodeFiles(root: string): FileSource {
  return {
    async read(path) {
      try {
        return new Uint8Array(await readFile(join(root, path)));
      } catch {
        return undefined;
      }
    },
    async readRange(path, offset, length) {
      const fh = await open(join(root, path));
      try {
        const buf = new Uint8Array(length);
        await fh.read(buf, 0, length, offset);
        return buf;
      } finally {
        await fh.close();
      }
    },
    async list(dir) {
      try {
        return await readdir(join(root, dir));
      } catch {
        return [];
      }
    },
  };
}
