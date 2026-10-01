import {
  ResourceType, celToRgba, mergePalette, parseMessages, parsePic,
  type GameIndex, type MessageFile, type ObjectInfo, type Palette, type ResourceManager, type ScriptWorld,
} from "@sci-ts/sci";

/** Everything the explorer's views share. */
export interface Explorer {
  rm: ResourceManager;
  /** Mods loaded over the game (their saves are kept apart). */
  mods: string[];
  world: ScriptWorld;
  index: GameIndex;
  basePalette: Palette;
  /** Navigates to a hash route, e.g. "room/710" (the current tab is kept). */
  href(route: string): string;
  messages(n: number): Promise<MessageFile | undefined>;
  pic(n: number): Promise<HTMLCanvasElement | undefined>;
  object(script: number, offset: number): ObjectInfo | undefined;
  objectsNamed(name: string): ObjectInfo[];
}

type Child = Node | string | null | undefined | false;

/** `el("a", { href }, "text", child)`: a tiny DOM builder. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

export const hex = (n: number) => `$${n.toString(16).padStart(4, "0")}`;
/** Property values: small numbers as decimal, the rest (addresses, flags) as hex too. */
export const showValue = (v: number) => (v >= 0x8000 ? `${v - 0x10000}` : v > 255 ? `${v} (${hex(v)})` : `${v}`);

export function createExplorer(rm: ResourceManager, mods: string[], world: ScriptWorld, index: GameIndex, basePalette: Palette, currentTab: () => string): Explorer {
  const messageCache = new Map<number, Promise<MessageFile | undefined>>();
  const picCache = new Map<number, Promise<HTMLCanvasElement | undefined>>();
  const objects = new Map<string, ObjectInfo>();
  const byName = new Map<string, ObjectInfo[]>();
  for (const s of index.scripts) {
    for (const o of s.objects) {
      objects.set(`${o.script}:${o.offset}`, o);
      byName.set(o.name, [...(byName.get(o.name) ?? []), o]);
    }
  }

  return {
    rm, mods, world, index, basePalette,
    href: (route) => `#/${currentTab()}/${route}`,
    object: (script, offset) => objects.get(`${script}:${offset}`),
    objectsNamed: (name) => byName.get(name) ?? [],
    messages(n) {
      let p = messageCache.get(n);
      if (!p) {
        p = rm.has({ type: ResourceType.Message, number: n })
          ? rm.load({ type: ResourceType.Message, number: n }).then((r) => parseMessages(r.data))
          : Promise.resolve(undefined);
        messageCache.set(n, p);
      }
      return p;
    },
    pic(n) {
      let p = picCache.get(n);
      if (!p) {
        p = rm.has({ type: ResourceType.Pic, number: n }) ? rm.load({ type: ResourceType.Pic, number: n }).then((r) => renderPic(r.data, basePalette)) : Promise.resolve(undefined);
        picCache.set(n, p);
      }
      return p;
    },
  };
}

// Remap colours (shadows, torch light) only mean something at run time: approximate.
const REMAP = new Map([[253, 64], [254, 110]]);

function renderPic(data: Uint8Array, base: Palette): HTMLCanvasElement {
  const pic = parsePic(data);
  const palette = mergePalette(base, pic.palette);
  const canvas = el("canvas", { width: pic.width, height: pic.height });
  const ctx = canvas.getContext("2d")!;
  for (const cel of [...pic.cels].sort((a, b) => a.priority - b.priority)) {
    if (!cel.width || !cel.height) continue;
    const layer = el("canvas", { width: cel.width, height: cel.height });
    layer.getContext("2d")!.putImageData(new ImageData(celToRgba(cel, palette, { remap: REMAP }), cel.width, cel.height), 0, 0);
    ctx.drawImage(layer, cel.x, cel.y);
  }
  return canvas;
}

/** A small copy of a canvas as a data URL, for map thumbnails. */
export function thumbnail(canvas: HTMLCanvasElement, width = 96): string {
  const height = Math.round((canvas.height / canvas.width) * width * 1.2);
  const small = el("canvas", { width, height });
  const ctx = small.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, width, height);
  return small.toDataURL();
}

// --- Rooms the editor can open ------------------------------------------------------------

let editable: Promise<{ name: string; rooms: number[] }[]> | undefined;

/**
 * The room editor's address for room `n`, if a mod describes it in a .room.yaml (preferring
 * the mods loaded here). The dev server's /__editor/mods lists them; elsewhere, none.
 */
export async function editorUrl(n: number, preferred: string[] = []): Promise<string | undefined> {
  editable ??= fetch("/__editor/mods")
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const mods = (await editable).filter((m) => m.rooms.includes(n));
  const mod = mods.find((m) => preferred.includes(m.name)) ?? mods[0];
  return mod && `/editor.html?mod=${encodeURIComponent(mod.name)}&room=${n}`;
}

/** An "Edit room n" link to the editor, filled in once we know the room is editable. */
export function editorLink(n: number, preferred: string[] = []): HTMLAnchorElement {
  const a = el("a", { className: "edit-link", target: "_blank", hidden: true, title: "Open this room in the room editor" }, `Edit room ${n}`);
  void editorUrl(n, preferred).then((url) => {
    if (url) (a.href = url), (a.hidden = false);
  });
  return a;
}
