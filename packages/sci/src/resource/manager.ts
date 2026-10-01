import { decompressLzs } from "./lzs.ts";
import { parseResourceMap } from "./map.ts";
import { patchExtensions, resourceKey, type ResourceId, type ResourceType } from "./types.ts";

/** Where game files come from: Node fs in tools, fetch/File API in the browser. */
export interface FileSource {
  read(path: string): Promise<Uint8Array | undefined>;
  /** Byte range read, so large volumes needn't be loaded whole. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  list(dir: string): Promise<string[]>;
}

export interface ResourceInfo extends ResourceId {
  source: "volume" | "patch" | "memory";
  /** Volume: header offset. Patch: file path. */
  location: number | string;
}

export interface Resource extends ResourceId {
  data: Uint8Array;
}

const VOLUME = "RESOURCE.000";
const VOLUME_HEADER_SIZE = 13; // type u8, number u16, packed u32, unpacked u32, method u16

const Compression = { None: 0, Lzs: 32 } as const;

/** Extra-header sizes for patch size bytes with bit 7 set (per ScummVM). */
const patchHeaderCodes: Record<number, number> = { 0: 24, 1: 2, 4: 8 };

export class ResourceManager {
  private readonly index = new Map<string, ResourceInfo>();
  private volume: Uint8Array | undefined;
  private readonly patches = new Map<string, Uint8Array>();
  private readonly extras = new Map<string, Uint8Array>();
  /** Resources replaced at run time (an editor's latest build), by key. */
  private readonly memory = new Map<string, Uint8Array>();

  private constructor(private readonly files: FileSource) {}

  /** Indexes RESOURCE.MAP, then lets loose patch files (game dir, then PATCHES/) override it. */
  static async open(files: FileSource, patchDirs = ["", "PATCHES"]): Promise<ResourceManager> {
    const rm = new ResourceManager(files);
    const map = await files.read("RESOURCE.MAP");
    if (!map) throw new Error("RESOURCE.MAP not found");

    for (const e of parseResourceMap(map)) {
      rm.index.set(resourceKey(e), { type: e.type, number: e.number, source: "volume", location: e.offset });
    }

    for (const dir of patchDirs) {
      for (const name of await files.list(dir)) {
        const m = /^(\d+)\.([a-z0-9]+)$/i.exec(name);
        const type = m && patchExtensions[m[2]!.toLowerCase()];
        if (type === undefined || type === null) continue;
        const id = { type, number: Number(m![1]) };
        rm.index.set(resourceKey(id), { ...id, source: "patch", location: dir ? `${dir}/${name}` : name });
      }
    }
    return rm;
  }

  list(type?: ResourceType): ResourceInfo[] {
    const all = [...this.index.values()];
    return (type === undefined ? all : all.filter((r) => r.type === type)).sort(
      (a, b) => a.type - b.type || a.number - b.number,
    );
  }

  has(id: ResourceId): boolean {
    return this.index.has(resourceKey(id));
  }

  /**
   * Replaces (or adds) a resource with already decoded data, until the page goes away: a
   * live editor's rebuilt room. Whatever parsed the old one must forget it (replaceResources).
   */
  override(id: ResourceId, data: Uint8Array): void {
    const key = resourceKey(id);
    this.memory.set(key, data);
    this.index.set(key, { type: id.type, number: id.number, source: "memory", location: key });
  }

  async load(id: ResourceId): Promise<Resource> {
    const info = this.info(id);
    let data: Uint8Array;
    if (info.source === "memory") {
      data = this.memory.get(info.location as string)!;
    } else if (info.source === "patch") {
      const file = await this.files.read(info.location as string);
      if (!file) throw new Error(`Patch file ${info.location} disappeared`);
      data = decodePatch(info, file);
    } else if (this.volume) {
      data = decodeVolumeEntry(info, this.volume, info.location as number);
    } else {
      const offset = info.location as number;
      const header = await this.files.readRange(VOLUME, offset, VOLUME_HEADER_SIZE);
      const packed = new DataView(header.buffer, header.byteOffset).getUint32(3, true);
      const entry = new Uint8Array(VOLUME_HEADER_SIZE + packed);
      entry.set(header);
      entry.set(await this.files.readRange(VOLUME, offset + VOLUME_HEADER_SIZE, packed), VOLUME_HEADER_SIZE);
      data = decodeVolumeEntry(info, entry, 0);
    }
    return { type: info.type, number: info.number, data };
  }

  /**
   * Reads the whole volume and every patch into memory so `loadSync` works. The VM needs
   * this: bytecode can load a script or look up a view in the middle of an instruction.
   */
  async preload(extraFiles: string[] = ["RESOURCE.SFX"]): Promise<void> {
    this.volume ??= await this.files.read(VOLUME);
    for (const name of extraFiles) {
      const data = this.extras.has(name) ? undefined : await this.files.read(name);
      if (data) this.extras.set(name, data);
    }
    for (const info of this.index.values()) {
      if (info.source === "patch" && !this.patches.has(info.location as string)) {
        const file = await this.files.read(info.location as string);
        if (file) this.patches.set(info.location as string, file);
      }
    }
  }

  loadSync(id: ResourceId): Resource {
    const info = this.info(id);
    if (!this.volume) throw new Error("loadSync before preload()");
    const data =
      info.source === "memory"
        ? this.memory.get(info.location as string)!
        : info.source === "patch"
          ? decodePatch(info, this.patches.get(info.location as string)!)
          : decodeVolumeEntry(info, this.volume, info.location as number);
    return { type: info.type, number: info.number, data };
  }

  /** A whole game file read by `preload` (e.g. RESOURCE.SFX), if present. */
  file(name: string): Uint8Array | undefined {
    return this.extras.get(name);
  }

  private info(id: ResourceId): ResourceInfo {
    const info = this.index.get(resourceKey(id));
    if (!info) throw new Error(`Resource ${resourceKey(id)} not found`);
    return info;
  }
}

/** Decodes the volume entry at `offset` in `bytes`. */
function decodeVolumeEntry(info: ResourceInfo, bytes: Uint8Array, offset: number): Uint8Array {
  const h = new DataView(bytes.buffer, bytes.byteOffset + offset, VOLUME_HEADER_SIZE);
  const type = h.getUint8(0) & 0x7f;
  const number = h.getUint16(1, true);
  const packed = h.getUint32(3, true);
  const unpacked = h.getUint32(7, true);
  const method = h.getUint16(11, true);

  if (type !== info.type || number !== info.number) {
    throw new Error(`Volume header mismatch at ${info.location}: got ${type}:${number}, expected ${resourceKey(info)}`);
  }

  const body = bytes.subarray(offset + VOLUME_HEADER_SIZE, offset + VOLUME_HEADER_SIZE + packed);
  switch (method) {
    case Compression.None: return body;
    case Compression.Lzs: return decompressLzs(body, unpacked);
    default: throw new Error(`Unsupported compression method ${method} for ${resourceKey(info)}`);
  }
}

/**
 * Patch files: u8 type, u8 extra-header size, [extra header], data.
 * SCI32 view/pic patches set bit 7 of the size byte and store a code instead.
 */
function decodePatch(info: ResourceInfo, file: Uint8Array): Uint8Array {
  const type = file[0]! & 0x7f;
  if (type !== info.type) throw new Error(`Patch ${info.location} has type ${type}, expected ${info.type}`);
  let extra = file[1]!;
  if (extra & 0x80) {
    const size = patchHeaderCodes[extra & 0x7f];
    if (size === undefined) throw new Error(`Patch ${info.location}: unknown header code ${extra & 0x7f}`);
    extra = size;
  }
  return file.subarray(2 + extra);
}
