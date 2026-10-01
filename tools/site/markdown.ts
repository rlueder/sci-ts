/**
 * Markdown to HTML, for the docs pages of a built site: the parts the docs use (headings,
 * paragraphs, lists, tables, fenced code, quotes; code, links, images, bold and italic
 * inline). Links to .md files become links to the .html pages made from them.
 */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const slug = (text: string) =>
  text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

const pageLink = (href: string) =>
  /^[a-z]+:/i.test(href) || href.startsWith("#") ? href : href.replace(/(^|\/)README\.md(?=#|$)/, "$1index.md").replace(/\.md(?=#|$)/, ".html");

export function inline(text: string): string {
  const code: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${code.push(`<code>${escape(c)}</code>`) - 1}\u0000`);
  s = escape(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, src: string) => `<img src="${src}" alt="${alt}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => `<a href="${pageLink(href)}">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)]!);
}

export function markdown(source: string): { html: string; title: string } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let title = "";
  let i = 0;
  const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, "|")));
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) body.push(lines[i]!);
      i++;
      out.push(`<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ""}>${escape(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = inline(heading[2]!);
      if (!title && heading[1]!.length === 1) title = heading[2]!.replace(/[*`]/g, "");
      out.push(`<h${heading[1]!.length} id="${slug(text)}">${text}</h${heading[1]!.length}>`);
      i++;
      continue;
    }
    if (line.startsWith("|") && /^\|?\s*:?-+/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) rows.push(cells(lines[i]!));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith(">"); i++) body.push(lines[i]!.replace(/^>\s?/, ""));
      out.push(`<blockquote>${markdown(body.join("\n")).html}</blockquote>`);
      continue;
    }
    const item = /^(\s*)([-*]|\d+\.)\s+/;
    if (item.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        if (item.test(l)) items.push(l.replace(item, ""));
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
        else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    // A paragraph: lines up to a blank one or the start of another block (always at least one).
    const para: string[] = [lines[i++]!.trim()];
    for (; i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|\||>|\s*([-*]|\d+\.)\s)/.test(lines[i]!); i++) para.push(lines[i]!.trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { html: out.join("\n"), title };
}
