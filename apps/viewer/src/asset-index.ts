import { ResourceType, analyzeGame, parseMessages, type MessageFile, type ResourceManager, type ScriptWorld } from "@sci-ts/sci";

/**
 * What the game says about its assets. SCI resources carry no names or descriptions, so
 * they come from the scripts: the room that draws a picture, the objects whose `view` is a
 * view, and what the game says when you Look at them (the room's or the object's noun, verb
 * 1, in the room's message file); sounds from Sound objects that declare their number.
 * Only what's declared on objects is found, not what a script picks at run time.
 */
export interface AssetMeta {
  /** Short labels: room and object names ("rm250", "igor", "room 250"). */
  tags: string[];
  /** Who uses it, for the preview: "igor in room 250: Igor is digging…". */
  uses: { label: string; text?: string }[];
}

export type AssetIndex = Map<string, AssetMeta>;

export const assetKey = (type: ResourceType, number: number) => `${type}:${number}`;

const LOOK = 1;

export async function buildAssetIndex(rm: ResourceManager, world: ScriptWorld, onProgress?: (done: number, total: number) => void): Promise<AssetIndex> {
  const index = await analyzeGame(rm, { world, onProgress });
  const out: AssetIndex = new Map();
  const add = (type: ResourceType, number: number, tags: string[], use?: { label: string; text?: string }) => {
    const key = assetKey(type, number);
    const meta = out.get(key) ?? { tags: [], uses: [] };
    for (const t of tags) if (t && !meta.tags.includes(t)) meta.tags.push(t);
    if (use && !meta.uses.some((u) => u.label === use.label)) meta.uses.push(use);
    out.set(key, meta);
  };

  // Message files, by module (a room's own file is its number).
  const files = new Map<number, MessageFile | undefined>();
  const messages = async (n: number) => {
    if (!files.has(n)) {
      const id = { type: ResourceType.Message, number: n };
      files.set(n, rm.has(id) ? parseMessages((await rm.load(id)).data) : undefined);
    }
    return files.get(n);
  };
  /** What Look says about a noun: the first line, preferring no condition. */
  const look = async (module: number, noun: number): Promise<string | undefined> => {
    if (!noun) return undefined;
    const records = (await messages(module))?.records.filter((r) => r.noun === noun && r.verb === LOOK && r.text) ?? [];
    return (records.find((r) => r.cond === 0) ?? records[0])?.text;
  };
  const roomName = new Map(index.rooms.map((r) => [r.number, r.name]));

  for (const room of index.rooms) {
    const text = await look(room.number, room.noun);
    if (room.picture >= 0) add(ResourceType.Pic, room.picture, [room.name, `room ${room.number}`], { label: `${room.name} (room ${room.number})`, text });
    add(ResourceType.Script, room.number, [room.name, "room"], { label: `room ${room.number}`, text });
    add(ResourceType.Message, room.number, [room.name, `room ${room.number}`], { label: `${room.name}'s text`, text });
  }

  for (const script of index.scripts) {
    const where = script.isRoom ? `room ${script.number}` : `script ${script.number}`;
    const owner = roomName.get(script.number);
    for (const obj of script.objects) {
      const prop = (name: string) => obj.props.find((p) => p.name === name)?.value;
      const view = prop("view");
      const picture = prop("picture");
      const noun = prop("noun") ?? 0;
      const text = await look(script.number, noun);
      if (view !== undefined && view > 0 && view < 0x8000 && rm.has({ type: ResourceType.View, number: view })) {
        add(ResourceType.View, view, [obj.name, where, ...(owner ? [owner] : [])], { label: `${obj.name} in ${where}`, text });
      }
      if (picture !== undefined && picture > 0 && picture < 0x8000 && !script.isRoom) {
        add(ResourceType.Pic, picture, [obj.name, where], { label: `${obj.name} in ${where}` });
      }
      // Sound objects that declare their number (room effects, mostly; music is set by code).
      const sound = prop("number");
      if (/sound|song|music/i.test(obj.className) && sound !== undefined && sound > 0 && rm.has({ type: ResourceType.Sound, number: sound })) {
        add(ResourceType.Sound, sound, [obj.name, where, ...(owner ? [owner] : [])], { label: `${obj.name} in ${where}` });
      }
      if (!script.isRoom && obj.name) add(ResourceType.Script, script.number, [obj.name]);
    }
  }
  return out;
}

/** Whether every word of `query` is in the asset's number, tags or descriptions. */
export function matches(query: string, number: number, meta: AssetMeta | undefined): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [String(number), ...(meta?.tags ?? []), ...(meta?.uses.flatMap((u) => [u.label, u.text ?? ""]) ?? [])].join(" ").toLowerCase();
  return words.every((w) => haystack.includes(w));
}
