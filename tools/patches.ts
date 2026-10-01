import { mkdirSync, writeFileSync } from "node:fs";
import { ResourceType, patchExtensions } from "@sci-ts/sci";

/** Writes an SCI patch file: [type | 0x80, 0 extra header bytes] + data, e.g. 770.MSG. */
export function writePatch(dir: string, type: ResourceType, number: number, data: Uint8Array): string {
  const ext = Object.entries(patchExtensions).find(([, t]) => t === type)?.[0];
  if (!ext) throw new Error(`No patch extension for resource type ${type}`);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${number}.${ext.toUpperCase()}`;
  writeFileSync(path, Buffer.concat([Buffer.from([type | 0x80, 0]), data]));
  console.log(`${path}: ${data.length} bytes`);
  return path;
}
