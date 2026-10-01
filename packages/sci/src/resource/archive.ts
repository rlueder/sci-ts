import { resourceKey, type ResourceId } from "./types.ts";

export interface ResourceData extends ResourceId {
  data: Uint8Array;
}

/**
 * RESOURCE.MAP and RESOURCE.000 for a set of resources: the files an interpreter opens a game
 * by. Resources are stored uncompressed (method 0), in type then number order.
 *
 *   volume entry: u8 type, u16 number, u32 packed size, u32 unpacked size, u16 method, data
 *   map: { u8 type, u16 table offset } per type, then 0xFF with the end offset;
 *        per type, { u16 number, u32 volume offset } per resource (see parseResourceMap)
 */
export function writeResourceArchive(resources: readonly ResourceData[]): { map: Uint8Array; volume: Uint8Array } {
  const sorted = [...resources].sort((a, b) => a.type - b.type || a.number - b.number);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.type === sorted[i - 1]!.type && sorted[i]!.number === sorted[i - 1]!.number) {
      throw new Error(`resource ${resourceKey(sorted[i]!)} is there twice`);
    }
  }

  const volume = new Uint8Array(sorted.reduce((n, r) => n + 13 + r.data.length, 0));
  const vv = new DataView(volume.buffer);
  const offsets: number[] = [];
  let at = 0;
  for (const r of sorted) {
    offsets.push(at);
    volume[at] = r.type;
    vv.setUint16(at + 1, r.number, true);
    vv.setUint32(at + 3, r.data.length, true);
    vv.setUint32(at + 7, r.data.length, true);
    vv.setUint16(at + 11, 0, true);
    volume.set(r.data, at + 13);
    at += 13 + r.data.length;
  }

  const types = [...new Set(sorted.map((r) => r.type))];
  const map = new Uint8Array((types.length + 1) * 3 + sorted.length * 6);
  if (map.length > 0xffff) throw new Error(`too many resources for one map (${sorted.length})`);
  const mv = new DataView(map.buffer);
  let table = (types.length + 1) * 3;
  types.forEach((type, i) => {
    map[i * 3] = type;
    mv.setUint16(i * 3 + 1, table, true);
    sorted.forEach((r, k) => {
      if (r.type !== type) return;
      mv.setUint16(table, r.number, true);
      mv.setUint32(table + 2, offsets[k]!, true);
      table += 6;
    });
  });
  map[types.length * 3] = 0xff;
  mv.setUint16(types.length * 3 + 1, table, true);
  return { map, volume };
}
