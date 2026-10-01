import type { ClassInfo } from "@sci-ts/sci";
import { el, type Explorer } from "./context.ts";

export interface ClassTree {
  element: HTMLElement;
  select(species: number | undefined): void;
}

/** The class hierarchy as an indented tree, with a filter that keeps matches' ancestors. */
export function createClassTree(ex: Explorer): ClassTree {
  const { classes } = ex.index;
  const children = new Map<number, ClassInfo[]>();
  for (const c of classes) children.set(c.superclass, [...(children.get(c.superclass) ?? []), c]);
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const instanceCount = new Map<number, number>();
  for (const s of ex.index.scripts) for (const o of s.objects) instanceCount.set(o.superclass, (instanceCount.get(o.superclass) ?? 0) + 1);

  const links = new Map<number, HTMLAnchorElement>();
  const items = new Map<number, HTMLLIElement>();
  const build = (parent: number): HTMLUListElement | null => {
    const kids = children.get(parent);
    if (!kids?.length) return null;
    const ul = el("ul");
    for (const c of kids) {
      const a = el("a", { href: ex.href(`class/${c.species}`) }, c.name);
      links.set(c.species, a);
      const n = instanceCount.get(c.species) ?? 0;
      const li = el("li", {}, a, " ", el("span", { className: "count" }, n ? `${n} instance${n > 1 ? "s" : ""}` : ""), build(c.species));
      items.set(c.species, li);
      ul.append(li);
    }
    return ul;
  };
  // Roots: no superclass, or a superclass that isn't a known class.
  const known = new Set(classes.map((c) => c.species));
  for (const c of classes) if (c.superclass >= 0 && !known.has(c.superclass)) children.set(-1, [...(children.get(-1) ?? []), c]);
  const filter = el("input", { type: "search", placeholder: "Filter classes…" });
  const element = el("div", { className: "tree" }, filter, build(-1));

  filter.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    const keep = new Set<number>();
    for (const c of classes) {
      if (q && !c.name.toLowerCase().includes(q)) continue;
      // Keep the match and its ancestors, so it stays in context.
      for (let s: number | undefined = c.species; s !== undefined && s >= 0 && !keep.has(s); s = classes.find((x) => x.species === s)?.superclass) keep.add(s);
    }
    for (const [species, li] of items) li.style.display = keep.has(species) ? "" : "none";
  });

  return {
    element,
    select(species) {
      for (const a of links.values()) a.classList.remove("active");
      if (species === undefined) return;
      const a = links.get(species);
      a?.classList.add("active");
      a?.scrollIntoView({ block: "nearest" });
    },
  };
}
