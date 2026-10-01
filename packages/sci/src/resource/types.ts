/** Resource type ids as stored in RESOURCE.MAP and volume headers (SCI1.1 / SCI2 numbering). */
export const ResourceType = {
  View: 0x00,
  Pic: 0x01,
  Script: 0x02,
  Text: 0x03,
  Sound: 0x04,
  Memory: 0x05,
  Vocab: 0x06,
  Font: 0x07,
  Cursor: 0x08,
  Patch: 0x09,
  Bitmap: 0x0a,
  Palette: 0x0b,
  CdAudio: 0x0c,
  Audio: 0x0d,
  Sync: 0x0e,
  Message: 0x0f,
  Map: 0x10,
  Heap: 0x11,
  Audio36: 0x12,
  Sync36: 0x13,
  Translation: 0x14,
  Robot: 0x15,
  Vmd: 0x16,
  Chunk: 0x17,
  Animation: 0x18,
} as const;

export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

export const resourceTypeName: Record<number, string> = Object.fromEntries(
  Object.entries(ResourceType).map(([name, id]) => [id, name.toLowerCase()]),
);

/** Loose files in the game dir or PATCHES/ override volume resources: `<number>.<ext>`. */
export const patchExtensions: Record<string, ResourceType> = {
  v56: ResourceType.View,
  p56: ResourceType.Pic,
  scr: ResourceType.Script,
  hep: ResourceType.Heap,
  snd: ResourceType.Sound,
  voc: ResourceType.Vocab,
  fon: ResourceType.Font,
  cur: ResourceType.Cursor,
  pat: ResourceType.Patch,
  pal: ResourceType.Palette,
  msg: ResourceType.Message,
  map: ResourceType.Map,
};

export interface ResourceId {
  type: ResourceType;
  number: number;
}

export const resourceKey = ({ type, number }: ResourceId): string => `${type}:${number}`;
