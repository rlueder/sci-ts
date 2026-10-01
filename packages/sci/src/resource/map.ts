import type { ResourceType } from "./types.ts";

export interface MapEntry {
  type: ResourceType;
  number: number;
  /** Byte offset of the resource header inside the volume (RESOURCE.000). */
  offset: number;
}

/**
 * Parses an SCI2 RESOURCE.MAP.
 *
 * Layout:
 *   header: repeated { type: u8, tableOffset: u16 } terminated by type 0xFF
 *           (the terminator's offset is the end of the last table)
 *   tables: per type, repeated { number: u16, volumeOffset: u32 } (6 bytes)
 *
 * SCI1.1 used 5-byte entries (u24 offset, shifted).
 */
export function parseResourceMap(data: Uint8Array): MapEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tables: { type: number; offset: number }[] = [];

  for (let pos = 0; ; pos += 3) {
    const type = view.getUint8(pos);
    const offset = view.getUint16(pos + 1, true);
    tables.push({ type, offset });
    if (type === 0xff) break;
  }

  const entries: MapEntry[] = [];
  for (let i = 0; i < tables.length - 1; i++) {
    const { type, offset: start } = tables[i]!;
    const end = tables[i + 1]!.offset;
    for (let pos = start; pos < end; pos += 6) {
      entries.push({
        type: type as ResourceType,
        number: view.getUint16(pos, true),
        offset: view.getUint32(pos + 2, true),
      });
    }
  }
  return entries;
}
