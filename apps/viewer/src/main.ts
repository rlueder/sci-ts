import {
  ResourceType,
  ScriptWorld,
  disassemble,
  formatDisassembly,
  celToRgba,
  emptyPalette,
  hasRef,
  mergePalette,
  parseFont,
  parseMessages,
  renderText,
  wrapText,
  parseHunkPalette,
  parsePic,
  parseView,
  resourceTypeName,
  type Cel,
  type Font,
  type Palette,
  type ResourceInfo,
} from "@sci-ts/sci";
import { assetKey, buildAssetIndex, matches, type AssetIndex } from "./asset-index.ts";
import { openGame } from "./files.ts";
import { renderSound, soundSummary, stopSoundPreview, toggleSoundPreview } from "./sound-preview.ts";


const hexDump = (data: Uint8Array, max = 2048): string => {
  const lines: string[] = [];
  for (let i = 0; i < Math.min(data.length, max); i += 16) {
    const row = data.subarray(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (data.length > max) lines.push(`… ${data.length - max} more bytes`);
  return lines.join("\n");
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), props);

// Mods show up as patch resources (?mods=, or the player's last choice).
const { rm } = await openGame();
const all = rm.list();
const basePalette =
  parseHunkPalette((await rm.load({ type: ResourceType.Palette, number: 999 })).data) ?? emptyPalette();

/** Palette a room pic installs, used to colour views the way they'd appear in that room. */
const roomPalette = async (picNo: number | undefined): Promise<Palette> =>
  picNo === undefined ? basePalette : mergePalette(basePalette, parsePic((await rm.load({ type: ResourceType.Pic, number: picNo })).data).palette);

// SCI's 320x200 was shown on 4:3 monitors, so pixels were 1.2x taller than wide.
let aspect = true;
const SCALE = 3;
// Remap colours (shadows): approximate as translucent black until scripts drive them.
const REMAP = new Map([[253, 64], [254, 110]]);

const celCanvas = (cel: Cel, palette: Palette, mirror = false): HTMLCanvasElement => {
  const canvas = el("canvas", { width: Math.max(cel.width, 1), height: Math.max(cel.height, 1) });
  if (cel.width && cel.height) {
    canvas.getContext("2d")!.putImageData(new ImageData(celToRgba(cel, palette, { mirror, remap: REMAP }), cel.width, cel.height), 0, 0);
  }
  return sized(canvas);
};

const sized = (canvas: HTMLCanvasElement, scale = SCALE) => {
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale * (aspect ? 1.2 : 1)}px`;
  return canvas;
};

// --- Renderers ---------------------------------------------------------------

const renderPalette = (pal: Palette): HTMLElement => {
  const grid = el("div", { className: "swatches" });
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = pal.rgb.subarray(i * 3, i * 3 + 3);
    grid.append(
      el("div", {
        className: pal.used[i] ? "sw" : "sw unused",
        title: `${i}: rgb(${r}, ${g}, ${b})${pal.used[i] ? "" : " (not set here)"}`,
        style: `background: rgb(${r} ${g} ${b})`,
      }),
    );
  }
  return grid;
};

const renderPic = (data: Uint8Array): HTMLElement => {
  const pic = parsePic(data);
  const canvas = composePic(data);
  const wrap = el("div");
  wrap.append(
    sized(canvas),
    el("p", {
      className: "meta",
      textContent: `${pic.width}×${pic.height} · ${pic.cels.length} layer(s): ${pic.cels.map((c) => `${c.width}×${c.height} @${c.x},${c.y} pri ${c.priority}`).join("; ")}`,
    }),
  );
  return wrap;
};

let animTimer: number | undefined;

const renderView = async (data: Uint8Array): Promise<HTMLElement> => {
  const view = parseView(data);
  const wrap = el("div");

  const picSelect = el("select");
  picSelect.append(el("option", { value: "", textContent: "base palette only" }));
  for (const p of rm.list(ResourceType.Pic)) picSelect.append(el("option", { value: String(p.number), textContent: `room palette: pic ${p.number}` }));
  const body = el("div");

  const draw = async () => {
    clearInterval(animTimer);
    const room = await roomPalette(picSelect.value ? Number(picSelect.value) : undefined);
    const palette = mergePalette(room, view.palette);
    body.replaceChildren();

    view.loops.forEach((loop, i) => {
      const row = el("div", { className: "loop" });
      row.append(el("span", { className: "meta", textContent: `loop ${i}${loop.mirror ? " (mirror)" : ""}` }));
      for (const cel of loop.cels) row.append(celCanvas(cel, palette, loop.mirror));
      body.append(row);
    });

    // Animate loop 0 like the game would, anchored at the cel's origin point.
    const loop = view.loops[0];
    if (loop && loop.cels.length > 1) {
      const stage = el("div", { className: "stage" });
      body.prepend(stage);
      let frame = 0;
      const tick = () => stage.replaceChildren(celCanvas(loop.cels[frame++ % loop.cels.length]!, palette, loop.mirror));
      tick();
      animTimer = window.setInterval(tick, 120);
    }
  };

  picSelect.onchange = draw;
  wrap.append(
    el("p", { className: "meta", textContent: `${view.loops.length} loops · ${view.palette ? "embedded palette" : "no embedded palette"}` }),
    picSelect,
    body,
  );
  await draw();
  return wrap;
};

/** Draws a 1-bit text mask onto a canvas in the given colour. */
const textCanvas = (font: Font, lines: string[], color: [number, number, number], align: "left" | "center" = "left") => {
  const bmp = renderText(font, lines, align);
  const canvas = el("canvas", { width: bmp.width, height: bmp.height });
  const rgba = new Uint8ClampedArray(bmp.width * bmp.height * 4);
  bmp.pixels.forEach((ink, i) => {
    if (ink) rgba.set([...color, 255], i * 4);
  });
  canvas.getContext("2d")!.putImageData(new ImageData(rgba, bmp.width, bmp.height), 0, 0);
  return sized(canvas);
};

const loadFont = async (n: number) => parseFont((await rm.load({ type: ResourceType.Font, number: n })).data);

const renderFont = (data: Uint8Array): HTMLElement => {
  const font = parseFont(data);
  const wrap = el("div");
  const chars = font.glyphs.map((_, i) => (i >= 32 ? String.fromCharCode(i) : "")).join("");
  const rows = chars.match(/.{1,32}/g) ?? [];
  wrap.append(
    el("p", { className: "meta", textContent: `${font.glyphs.length} glyphs · line height ${font.height}px` }),
    textCanvas(font, rows, [232, 176, 74]),
    el("p", { className: "meta", textContent: "Sample" }),
    textCanvas(font, wrapText(font, "The quick brown fox jumps over the lazy dog. 0123456789, punctuation: ?!;:", 200), [221, 221, 221]),
  );
  return wrap;
};

// Talker ids come from scripts; these two are clear from usage counts across all messages.
const TALKERS: Record<number, string> = { 97: "Hero", 99: "Narrator" };

const renderMessages = async (data: Uint8Array, room: number): Promise<HTMLElement> => {
  const file = parseMessages(data);
  const fontSelect = el("select");
  for (const f of rm.list(ResourceType.Font)) fontSelect.append(el("option", { value: String(f.number), textContent: `font ${f.number}` }));
  const box = el("div", { className: "dialog" });
  const table = el("table", { className: "messages" });
  table.innerHTML = "<thead><tr><th>noun</th><th>verb</th><th>cond</th><th>seq</th><th>talker</th><th>text</th></tr></thead>";
  const tbody = el("tbody");
  table.append(tbody);

  let selected = file.records[0];
  const preview = async () => {
    if (!selected) return;
    const font = await loadFont(Number(fontSelect.value));
    const target = hasRef(selected) ? file.records.find((r) => r.noun === selected!.ref.noun && r.verb === selected!.ref.verb && r.cond === selected!.ref.cond && r.seq === selected!.ref.seq) : selected;
    const text = target?.text ?? "(missing reference)";
    box.replaceChildren(textCanvas(font, wrapText(font, text, 200), [255, 255, 255]));
  };

  for (const r of file.records) {
    const tr = el("tr");
    const text = hasRef(r) ? `→ ${r.ref.noun}/${r.ref.verb}/${r.ref.cond}/${r.ref.seq}` : r.text;
    for (const cell of [r.noun, r.verb, r.cond, r.seq, TALKERS[r.talker] ?? r.talker, text]) tr.append(el("td", { textContent: String(cell) }));
    tr.onclick = () => {
      tbody.querySelector(".active")?.classList.remove("active");
      tr.classList.add("active");
      selected = r;
      preview();
    };
    tbody.append(tr);
  }
  fontSelect.onchange = preview;
  await preview();

  const wrap = el("div");
  wrap.append(
    el("p", { className: "meta", textContent: `room/module ${room} · format v${file.version} · ${file.records.length} messages · click a row to preview in a game font` }),
    fontSelect,
    box,
    table,
  );
  return wrap;
};

let worldPromise: Promise<ScriptWorld> | undefined;
const getWorld = () =>
  (worldPromise ??= ScriptWorld.open(rm).then(async (w) => {
    await w.loadAllClasses();
    return w;
  }));

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

const renderScript = async (number: number): Promise<HTMLElement> => {
  const world = await getWorld();
  const script = await world.script(number);
  const functions = disassemble(script, world.context());
  const listing = el("pre", { className: "asm" });
  listing.innerHTML = formatDisassembly(script, functions)
    .split("\n")
    .map((line) => {
      const html = escapeHtml(line);
      if (line.startsWith("(")) return `<span class="fn" id="fn-${line.slice(1, -1).replace(/\W/g, "_")}">${html}</span>`;
      if (line.startsWith(";")) return `<span class="c">${html}</span>`;
      return html.replace(/(;.*)$/, '<span class="c">$1</span>');
    })
    .join("\n");

  const jump = el("select");
  jump.append(el("option", { textContent: `${functions.length} functions…` }));
  for (const fn of functions) jump.append(el("option", { value: fn.label.replace(/\W/g, "_"), textContent: fn.label }));
  jump.onchange = () => document.getElementById(`fn-${jump.value}`)?.scrollIntoView({ block: "start" });

  const wrap = el("div");
  wrap.append(
    el("p", {
      className: "meta",
      textContent: `${script.objects.length} objects · ${script.locals.length} locals · ${functions.reduce((n, f) => n + f.instructions.length, 0)} instructions`,
    }),
    jump,
    listing,
  );
  return wrap;
};

// --- Thumbnails ----------------------------------------------------------------

/** A picture's layers composed at full size (the list scales it down with CSS). */
const composePic = (data: Uint8Array): HTMLCanvasElement => {
  const pic = parsePic(data);
  const palette = mergePalette(basePalette, pic.palette);
  const canvas = el("canvas", { width: pic.width, height: pic.height });
  const ctx = canvas.getContext("2d")!;
  for (const cel of [...pic.cels].sort((a, b) => a.priority - b.priority)) {
    if (!cel.width || !cel.height) continue;
    const layer = el("canvas", { width: cel.width, height: cel.height });
    layer.getContext("2d")!.putImageData(new ImageData(celToRgba(cel, palette, { remap: REMAP }), cel.width, cel.height), 0, 0);
    ctx.drawImage(layer, cel.x, cel.y);
  }
  return canvas;
};

/** What a list row shows next to the number: a picture, a sprite, a font sample, a line. */
const thumbnail = async (info: ResourceInfo): Promise<HTMLElement | undefined> => {
  const { data } = await rm.load(info);
  switch (info.type) {
    case ResourceType.Pic:
      return composePic(data);
    case ResourceType.View: {
      const view = parseView(data);
      const cel = view.loops.flatMap((l) => l.cels).find((c) => c.width && c.height);
      if (!cel) return undefined;
      const palette = mergePalette(basePalette, view.palette);
      const canvas = el("canvas", { width: cel.width, height: cel.height });
      canvas.getContext("2d")!.putImageData(new ImageData(celToRgba(cel, palette, { remap: REMAP }), cel.width, cel.height), 0, 0);
      return canvas;
    }
    case ResourceType.Font: {
      const font = parseFont(data);
      const bmp = renderText(font, ["Aa Bb 123"], "left");
      const canvas = el("canvas", { width: Math.max(bmp.width, 1), height: Math.max(bmp.height, 1) });
      const rgba = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      bmp.pixels.forEach((ink, i) => ink && rgba.set([221, 221, 221, 255], i * 4));
      canvas.getContext("2d")!.putImageData(new ImageData(rgba, canvas.width, canvas.height), 0, 0);
      return canvas;
    }
    case ResourceType.Message: {
      const first = parseMessages(data).records.find((r) => r.text);
      return first ? el("span", { className: "snippet", textContent: first.text }) : undefined;
    }
    case ResourceType.Sound:
      return el("span", { className: "snippet", textContent: soundSummary(data) });
    default:
      return undefined;
  }
};

/** Rows render their thumbnail when they scroll into view. */
const thumbs = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const li = entry.target as HTMLLIElement & { info?: ResourceInfo };
      thumbs.unobserve(li);
      const slot = li.querySelector(".thumb");
      if (!slot || !li.info) continue;
      thumbnail(li.info)
        .then((t) => t && slot.replaceChildren(t))
        .catch(() => slot.replaceChildren());
    }
  },
  { root: $("list"), rootMargin: "200px 0px" },
);

// --- Shell -------------------------------------------------------------------

const types = [...new Set(all.map((r) => r.type))];
const typeSelect = $<HTMLSelectElement>("type");
typeSelect.innerHTML = types
  .map((t) => `<option value="${t}">${resourceTypeName[t]} (${all.filter((r) => r.type === t).length})</option>`)
  .join("");

let current: { info: ResourceInfo; li: HTMLLIElement } | undefined;
/** Only the latest selection may fill the view (arrowing quickly starts many loads). */
let showing = 0;

const show = async (info: ResourceInfo, li: HTMLLIElement) => {
  const token = ++showing;
  current = { info, li };
  clearInterval(animTimer);
  stopSoundPreview();
  document.querySelector("li.active")?.classList.remove("active");
  li.classList.add("active");
  li.scrollIntoView({ block: "nearest" });
  history.replaceState(null, "", `#${resourceTypeName[info.type]}/${info.number}`);
  const res = await rm.load(info);
  if (token !== showing) return;
  $("title").textContent = `${resourceTypeName[info.type]} ${info.number} · ${res.data.length} bytes · ${info.source}`;
  showUses(info);

  const view = $("view");
  let content: HTMLElement | undefined;
  try {
    switch (info.type) {
      case ResourceType.Pic: content = renderPic(res.data); break;
      case ResourceType.View: content = await renderView(res.data); break;
      case ResourceType.Script: case ResourceType.Heap: content = await renderScript(info.number); break;
      case ResourceType.Font: content = renderFont(res.data); break;
      case ResourceType.Message: content = await renderMessages(res.data, info.number); break;
      case ResourceType.Palette: content = renderPalette(parseHunkPalette(res.data) ?? emptyPalette()); break;
      case ResourceType.Sound: content = await renderSound(rm, info.number, res.data, () => token === showing); break;
    }
  } catch (e) {
    content = el("p", { className: "error", textContent: String(e) });
  }
  if (token !== showing) {
    // A view's animation started for a resource that's no longer selected.
    if (info.type === ResourceType.View) clearInterval(animTimer);
    return;
  }
  view.replaceChildren(...(content ? [content] : []));
  $("hex").textContent = hexDump(res.data);
};

/** The objects and rooms that use the resource, and what the game says about them. */
const showUses = (info: ResourceInfo) => {
  const meta = assetIndex?.get(assetKey(info.type, info.number));
  $("uses").replaceChildren(
    ...(meta?.uses ?? []).slice(0, 12).map((u) => {
      const p = el("p", { className: "use" });
      p.append(el("b", { textContent: u.label }));
      if (u.text) p.append(" · ", el("q", { textContent: u.text }));
      return p;
    }),
  );
};

const THUMBNAILS = new Set<number>([ResourceType.Pic, ResourceType.View, ResourceType.Font, ResourceType.Message, ResourceType.Sound]);

const rows = (): HTMLLIElement[] => [...$("list").querySelectorAll<HTMLLIElement>("li")].filter((li) => "info" in li);

const search = $<HTMLInputElement>("search");
let assetIndex: AssetIndex | undefined;

const renderList = () => {
  const type = Number(typeSelect.value);
  const withThumbs = THUMBNAILS.has(type);
  $("list").className = withThumbs ? `thumbs type-${resourceTypeName[type as ResourceType]}` : "";
  thumbs.disconnect();
  const items = all
    .filter((r) => r.type === type)
    .filter((r) => matches(search.value, r.number, assetIndex?.get(assetKey(r.type, r.number))))
    .map((r) => {
      const li = Object.assign(el("li"), { info: r });
      if (withThumbs) li.append(el("span", { className: "thumb" }));
      const label = el("span", { className: "num", innerHTML: `<span>${r.number}${r.source === "patch" ? " <small>patch</small>" : ""}</span>` });
      const tags = assetIndex?.get(assetKey(r.type, r.number))?.tags;
      if (tags?.length) label.append(el("span", { className: "tags", textContent: tags.slice(0, 3).join(" · "), title: tags.join(" · ") }));
      li.append(label);
      li.onclick = () => show(r, li);
      if (withThumbs) thumbs.observe(li);
      // Keep the selection across filtering.
      if (current && current.info === r) (li.classList.add("active"), (current.li = li));
      return li;
    });
  $("list").replaceChildren(...(items.length ? items : [el("li", { className: "empty", textContent: search.value ? "Nothing matches" : "None" })]));
};

/** Selects the row `delta` away from the current one (or the first/last). */
const step = (delta: number | "first" | "last") => {
  const list = rows();
  if (!list.length) return;
  const at = current ? list.indexOf(current.li) : -1;
  const next = delta === "first" ? 0 : delta === "last" ? list.length - 1 : Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + delta));
  const li = list[next]!;
  void show((li as HTMLLIElement & { info: ResourceInfo }).info, li);
};

const switchType = (delta: number) => {
  const i = Math.max(0, Math.min(types.length - 1, typeSelect.selectedIndex + delta));
  if (i === typeSelect.selectedIndex) return;
  typeSelect.selectedIndex = i;
  renderList();
  step("first");
};

// Keyboard: ↑/↓ (k/j) next and previous, PageUp/PageDown by ten, Home/End, ←/→ the type,
// "/" the search box (where ↑/↓ and Enter still move through the results).
window.addEventListener("keydown", (e) => {
  const target = e.target instanceof HTMLElement ? e.target : document.body;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (target === search) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") (e.preventDefault(), step(e.key === "ArrowDown" ? 1 : -1));
    else if (e.key === "Enter") (e.preventDefault(), current ? search.blur() : step("first"));
    else if (e.key === "Escape") (search.value = "", renderList(), search.blur());
    return;
  }
  if (e.key === "/" && !target.matches("input, textarea")) {
    e.preventDefault();
    search.focus();
    search.select();
    return;
  }
  if (target.matches("input, textarea, select:not(#type)")) return;
  if (e.key === " " && !target.matches("button") && toggleSoundPreview()) return void e.preventDefault();
  const keys: Record<string, () => void> = {
    ArrowDown: () => step(1), j: () => step(1),
    ArrowUp: () => step(-1), k: () => step(-1),
    PageDown: () => step(10), PageUp: () => step(-10),
    Home: () => step("first"), End: () => step("last"),
    ArrowLeft: () => switchType(-1), ArrowRight: () => switchType(1),
  };
  const action = keys[e.key];
  if (!action) return;
  e.preventDefault();
  action();
});

search.addEventListener("input", () => {
  renderList();
  if (!current || !rows().includes(current.li)) step("first");
});

typeSelect.onchange = () => {
  renderList();
  step("first");
  typeSelect.blur(); // so the arrow keys go back to the list
};
$<HTMLInputElement>("aspect").onchange = (e) => {
  aspect = (e.target as HTMLInputElement).checked;
  if (current) show(current.info, current.li);
};

/** Goes where the URL says (#pic/130), else to the first picture; also on edits and Back. */
const goToHash = () => {
  const [hashType, hashNumber] = decodeURIComponent(location.hash.slice(1)).split("/");
  const type = types.find((t) => resourceTypeName[t] === hashType) ?? ResourceType.Pic;
  if (Number(typeSelect.value) !== type || !rows().length) {
    typeSelect.value = String(type);
    renderList();
  }
  const find = () => rows().find((li) => (li as HTMLLIElement & { info: ResourceInfo }).info.number === Number(hashNumber));
  let row = find();
  if (!row && search.value && hashNumber) {
    // Asked for something the search hides: show everything again.
    search.value = "";
    renderList();
    row = find();
  }
  if (row) void show((row as HTMLLIElement & { info: ResourceInfo }).info, row);
  else step("first");
};
window.addEventListener("hashchange", goToHash);
goToHash();

// Names and descriptions from the scripts (a couple of seconds): then search finds them.
const indexStatus = $("index-status");
getWorld()
  .then((world) => buildAssetIndex(rm, world, (done, total) => (indexStatus.textContent = `Indexing the scripts… ${done}/${total}`)))
  .then((index) => {
    assetIndex = index;
    indexStatus.textContent = `${index.size} assets named by the game's scripts`;
    renderList();
    if (current) (showUses(current.info), current.li.scrollIntoView({ block: "nearest" }));
  })
  .catch((e) => (indexStatus.textContent = `No index: ${(e as Error).message}`));
