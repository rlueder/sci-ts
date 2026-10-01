import { disassemble, formatDisassembly, type ClassInfo, type ObjectInfo, type PropValue } from "@sci-ts/sci";
import { editorLink, el, showValue, type Explorer } from "./context.ts";

const link = (ex: Explorer, route: string, text: string) => el("a", { href: ex.href(route) }, text);
const roomLink = (ex: Explorer, n: number) => {
  const room = ex.index.rooms.find((r) => r.number === n);
  return link(ex, `room/${n}`, room ? `${n} ${room.name}` : `${n}`);
};
const scriptLink = (ex: Explorer, n: number) =>
  ex.index.rooms.some((r) => r.number === n) ? roomLink(ex, n) : link(ex, `script/${n}`, `script ${n}`);
const classBySpecies = (ex: Explorer, species: number) => ex.index.classes.find((c) => c.species === species);
const classLink = (ex: Explorer, species: number) => {
  const c = classBySpecies(ex, species);
  return c ? link(ex, `class/${c.species}`, c.name) : el("span", {}, `class ${species}`);
};
const objectLink = (ex: Explorer, o: ObjectInfo) => link(ex, `object/${o.script}/${o.offset}`, o.name);
const prop = (o: { props: PropValue[] }, name: string) => o.props.find((p) => p.name === name)?.value;

/** Root first. */
function ancestry(ex: Explorer, species: number): ClassInfo[] {
  const chain: ClassInfo[] = [];
  for (let c = classBySpecies(ex, species); c && chain.length < 64; c = c.superclass < 0 ? undefined : classBySpecies(ex, c.superclass)) chain.unshift(c);
  return chain;
}

const breadcrumb = (ex: Explorer, species: number) => {
  const chain = ancestry(ex, species);
  const out = el("p", { className: "meta" });
  chain.forEach((c, i) => out.append(...(i ? [" → "] : []), link(ex, `class/${c.species}`, c.name)));
  return out;
};

/** Lazily disassembled listing of a script, optionally only one object's methods. */
function disassembly(ex: Explorer, script: number, title: string, owner?: number): HTMLElement {
  const pre = el("pre", { className: "asm" }, "…");
  const details = el("details", {}, el("summary", {}, title), pre);
  details.addEventListener("toggle", async () => {
    if (!details.open || pre.dataset.done) return;
    pre.dataset.done = "1";
    const s = await ex.world.script(script);
    let fns = disassemble(s, ex.world.context());
    if (owner !== undefined) fns = fns.filter((f) => f.owner?.offset === owner);
    pre.textContent = formatDisassembly(s, fns);
  }, { once: false });
  return details;
}

/** Messages for one module, optionally only for some nouns; grouped by noun. */
async function messageTable(ex: Explorer, module: number, nouns?: Set<number>, objects: ObjectInfo[] = []): Promise<HTMLElement | undefined> {
  const file = await ex.messages(module);
  if (!file) return undefined;
  const records = file.records.filter((r) => !nouns || nouns.has(r.noun));
  if (!records.length) return undefined;
  const namesByNoun = new Map<number, string[]>();
  for (const o of objects) {
    const noun = prop(o, "noun");
    if (noun) namesByNoun.set(noun, [...(namesByNoun.get(noun) ?? []), o.name]);
  }
  const verb = (v: number) => (v ? ex.index.verbs[v] ?? `verb ${v}` : "—");
  const table = el("table", {}, el("tr", {}, el("th", {}, "noun"), el("th", {}, "verb"), el("th", {}, "cond"), el("th", {}, "seq"), el("th", {}, "text")));
  for (const r of [...records].sort((a, b) => a.noun - b.noun || a.verb - b.verb || a.cond - b.cond || a.seq - b.seq)) {
    const who = namesByNoun.get(r.noun)?.join(", ");
    table.append(el("tr", {},
      el("td", { className: "num", title: who ?? "" }, `${r.noun}${who ? ` ${who}` : ""}`),
      el("td", { className: "num" }, verb(r.verb)),
      el("td", { className: "num" }, `${r.cond}`),
      el("td", { className: "num" }, `${r.seq}`),
      el("td", {}, r.text || el("span", { className: "meta" }, "(empty)")),
    ));
  }
  return el("details", { open: records.length <= 40 }, el("summary", {}, `Messages (${records.length})`), table);
}

/** The room picture with static object positions drawn on top. */
async function roomPicture(ex: Explorer, picture: number, objects: ObjectInfo[]): Promise<{ element: HTMLElement; highlight(o?: ObjectInfo): void } | undefined> {
  const canvas = await ex.pic(picture);
  if (!canvas) return undefined;
  const copy = el("canvas", { width: canvas.width, height: canvas.height });
  copy.getContext("2d")!.drawImage(canvas, 0, 0);
  const box = el("div", { className: "pic" }, copy);
  box.style.aspectRatio = `${canvas.width} / ${canvas.height * 1.2}`;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${canvas.width} ${canvas.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const marks = new Map<ObjectInfo, SVGGElement>();
  for (const o of objects) {
    const [l = 0, t = 0, r = 0, b = 0] = ["nsLeft", "nsTop", "nsRight", "nsBottom"].map((n) => prop(o, n) ?? 0);
    const x = prop(o, "x") ?? 0, y = prop(o, "y") ?? 0;
    const g = document.createElementNS(NS, "g");
    const title = document.createElementNS(NS, "title");
    title.textContent = `${o.name} (${o.className})`;
    g.append(title);
    if (r > l && b > t && r < 0x8000) {
      const rect = document.createElementNS(NS, "rect");
      Object.entries({ x: l, y: t, width: r - l, height: b - t }).forEach(([k, v]) => rect.setAttribute(k, String(v)));
      g.append(rect);
    } else if ((x || y) && x < 0x8000 && y < 0x8000) {
      const dot = document.createElementNS(NS, "circle");
      Object.entries({ cx: x, cy: y, r: 2.5 }).forEach(([k, v]) => dot.setAttribute(k, String(v)));
      g.append(dot);
    } else continue;
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(r > l ? l + 2 : x + 4));
    label.setAttribute("y", String(r > l ? t + 7 : y + 2));
    label.textContent = o.name;
    g.append(label);
    svg.append(g);
    marks.set(o, g);
  }
  box.append(svg);
  return {
    element: box,
    highlight(o) {
      for (const [obj, g] of marks) g.classList.toggle("hl", obj === o);
    },
  };
}

function exitList(ex: Explorer, room: number): HTMLElement {
  const out = ex.index.exits.filter((e) => e.from === room);
  const into = ex.index.exits.filter((e) => e.to === room);
  const rows = (list: typeof out, other: (e: (typeof out)[number]) => number) => {
    const table = el("table");
    for (const e of [...list].sort((a, b) => other(a) - other(b))) {
      table.append(el("tr", {},
        el("td", {}, roomLink(ex, other(e))),
        el("td", {}, el("span", { className: `kind ${e.kind}` }, e.kind)),
        el("td", { className: "num" }, e.script === room ? e.where : el("span", {}, scriptLink(ex, e.script), ` ${e.where}`)),
      ));
    }
    return list.length ? table : el("p", { className: "meta" }, "none found");
  };
  const unresolved = ex.index.unresolved.filter((e) => e.from === room);
  return el("div", {},
    el("h3", {}, `Leads to (${new Set(out.map((e) => e.to)).size})`), rows(out, (e) => e.to),
    el("h3", {}, `Entered from (${new Set(into.map((e) => e.from)).size})`), rows(into, (e) => e.from),
    unresolved.length ? el("p", { className: "meta" }, `Also ${unresolved.map((e) => `${e.where} = ${e.to}`).join(", ")}: not room numbers (maze codes or cut rooms).`) : null,
  );
}

function objectTable(ex: Explorer, objects: ObjectInfo[], onHover?: (o?: ObjectInfo) => void): HTMLElement {
  const table = el("table", {}, el("tr", {}, el("th", {}, "object"), el("th", {}, "class"), el("th", {}, "noun"), el("th", {}, "methods")));
  for (const o of objects) {
    const row = el("tr", {},
      el("td", {}, objectLink(ex, o)),
      el("td", {}, classLink(ex, o.superclass)),
      el("td", { className: "num" }, `${prop(o, "noun") || ""}`),
      el("td", { className: "num" }, o.methods.join(" ")),
    );
    if (onHover) {
      row.addEventListener("mouseenter", () => { row.classList.add("hl"); onHover(o); });
      row.addEventListener("mouseleave", () => { row.classList.remove("hl"); onHover(undefined); });
    }
    table.append(row);
  }
  return table;
}

export async function renderRoom(ex: Explorer, n: number): Promise<HTMLElement> {
  const room = ex.index.rooms.find((r) => r.number === n);
  const info = ex.index.scripts.find((s) => s.number === n);
  if (!room || !info) return el("p", { className: "error" }, `No room ${n}`);
  const helpers = room.uses.filter((u) => !ex.index.rooms.some((r) => r.number === u));
  const helperObjects = ex.index.scripts.filter((s) => helpers.includes(s.number) && s.number >= 100).flatMap((s) => s.objects);
  const pic = room.picture >= 0 ? await roomPicture(ex, room.picture, info.objects) : undefined;

  const roomObject = info.objects.find((o) => o.name === room.name)!;
  const messages = await messageTable(ex, n, undefined, [...info.objects, ...helperObjects]);
  return el("div", {},
    el("h2", {}, `Room ${n} · ${room.name} `, editorLink(n, ex.mods)),
    breadcrumb(ex, roomObject.superclass),
    el("p", { className: "meta" }, `picture ${room.picture} · noun ${room.noun} · ${info.objects.length} objects`),
    room.uses.length ? el("div", { className: "chips" }, el("span", { className: "meta" }, "uses"), ...room.uses.map((u) => scriptLink(ex, u))) : null,
    pic?.element,
    exitList(ex, n),
    el("h3", {}, `Objects (${info.objects.length})`),
    el("p", { className: "meta" }, "Boxes and dots are positions set in the object's declaration; objects placed by code at run time don't show."),
    objectTable(ex, info.objects, pic?.highlight),
    messages ?? el("p", { className: "meta" }, "No messages."),
    disassembly(ex, n, "Disassembly"),
  );
}

export async function renderScript(ex: Explorer, n: number): Promise<HTMLElement> {
  const info = ex.index.scripts.find((s) => s.number === n);
  if (!info) return el("p", { className: "error" }, `No script ${n}`);
  const users = ex.index.scripts.filter((s) => s.references.includes(n)).map((s) => s.number);
  const classes = ex.index.classes.filter((c) => c.script === n);
  const messages = await messageTable(ex, n, undefined, info.objects);
  return el("div", {},
    el("h2", {}, `Script ${n}`),
    users.length ? el("div", { className: "chips" }, el("span", { className: "meta" }, "used by"), ...users.map((u) => scriptLink(ex, u))) : null,
    info.references.length ? el("div", { className: "chips" }, el("span", { className: "meta" }, "uses"), ...info.references.map((u) => scriptLink(ex, u))) : null,
    classes.length ? el("div", {}, el("h3", {}, `Classes (${classes.length})`), el("div", { className: "chips" }, ...classes.map((c) => classLink(ex, c.species)))) : null,
    el("h3", {}, `Objects (${info.objects.length})`),
    objectTable(ex, info.objects),
    messages,
    disassembly(ex, n, "Disassembly"),
  );
}

/** Props with where each value comes from: the class's default or this object's own. */
function propTable(props: PropValue[], defaults: PropValue[] | undefined): HTMLElement {
  const table = el("table", {}, el("tr", {}, el("th", {}, "property"), el("th", {}, "value"), el("th", {}, defaults ? "class default" : "")));
  for (const p of props) {
    const d = defaults?.find((x) => x.name === p.name);
    const changed = !!d && d.value !== p.value;
    const isNew = defaults && !d;
    table.append(el("tr", {},
      el("td", { className: changed || isNew ? "prop-changed" : "prop-inherited" }, p.name),
      el("td", { className: changed || isNew ? "prop-changed" : "" }, showValue(p.value)),
      el("td", { className: "num" }, d ? showValue(d.value) : isNew ? "new" : ""),
    ));
  }
  return table;
}

/** Each method name with the nearest ancestor that also defines it (so this overrides it). */
function methodList(ex: Explorer, methods: string[], superclass: number): HTMLElement {
  const chain = superclass < 0 ? [] : ancestry(ex, superclass).reverse();
  const list = el("div", { className: "chips" });
  for (const m of methods) {
    const from = chain.find((c) => c.methods.includes(m));
    list.append(el("span", { title: from ? `overrides ${from.name}::${m}` : "new" }, from ? `${m}` : el("strong", {}, m)));
  }
  return methods.length ? list : el("p", { className: "meta" }, "none");
}

export async function renderObject(ex: Explorer, script: number, offset: number): Promise<HTMLElement> {
  const o = ex.object(script, offset);
  if (!o) return el("p", { className: "error" }, "No such object");
  const cls = classBySpecies(ex, o.superclass);
  const noun = prop(o, "noun");
  const siblings = ex.index.scripts.find((s) => s.number === script)?.objects ?? [];
  const messages = noun ? await messageTable(ex, script, new Set([noun]), siblings) : undefined;
  return el("div", {},
    el("h2", {}, o.name),
    el("p", { className: "meta" }, "instance in ", scriptLink(ex, script)),
    breadcrumb(ex, o.superclass),
    el("h3", {}, "Methods (bold = new, others override the class)"),
    methodList(ex, o.methods, o.superclass),
    messages ?? null,
    el("h3", {}, "Properties"),
    propTable(o.props, cls?.props),
    disassembly(ex, script, "Disassembly of its methods", offset),
  );
}

export function renderClass(ex: Explorer, species: number): HTMLElement {
  const c = classBySpecies(ex, species);
  if (!c) return el("p", { className: "error" }, `No class ${species}`);
  const sup = c.superclass < 0 ? undefined : classBySpecies(ex, c.superclass);
  const subclasses = ex.index.classes.filter((x) => x.superclass === species);
  const instances = ex.index.scripts.flatMap((s) => s.objects.filter((o) => o.superclass === species));
  const inherited = ancestry(ex, species).slice(0, -1).reverse();
  const shown = instances.slice(0, 300);
  return el("div", {},
    el("h2", {}, c.name),
    el("p", { className: "meta" }, `class #${c.species} in `, scriptLink(ex, c.script)),
    breadcrumb(ex, species),
    subclasses.length ? el("div", {}, el("h3", {}, `Subclasses (${subclasses.length})`), el("div", { className: "chips" }, ...subclasses.map((s) => classLink(ex, s.species)))) : null,
    el("h3", {}, "Methods (bold = new, others override an ancestor)"),
    methodList(ex, c.methods, c.superclass),
    inherited.length ? el("details", {}, el("summary", { className: "meta" }, "Inherited methods"),
      ...inherited.map((a) => el("p", {}, link(ex, `class/${a.species}`, a.name), el("span", { className: "meta" }, `: ${a.methods.filter((m) => !c.methods.includes(m)).join(" ")}`)))) : null,
    el("h3", {}, "Properties"),
    propTable(c.props, sup?.props),
    el("h3", {}, `Direct instances (${instances.length})`),
    instances.length ? el("div", { className: "chips" }, ...shown.map((o) => el("a", { href: ex.href(`object/${o.script}/${o.offset}`), title: `script ${o.script}` }, `${o.name}`))) : el("p", { className: "meta" }, "none"),
    instances.length > shown.length ? el("p", { className: "meta" }, `…and ${instances.length - shown.length} more`) : null,
    disassembly(ex, c.script, "Disassembly of its methods", ex.index.scripts.length ? classOffset(ex, c) : undefined),
  );
}

/** Classes aren't in `scripts[].objects` (instances only): find the heap offset from the world. */
function classOffset(ex: Explorer, c: ClassInfo): number | undefined {
  return ex.world.classObject(c.species)?.offset;
}
