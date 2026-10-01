/**
 * The reader for SCI script source: parenthesised lists, with a few kinds of atom.
 *
 *   (send obj x: 1)      a list                  [buf 3]   an array element (or declaration)
 *   foo  x:  y?  &rest   symbols                  42 -7 $1F %101 `a   numbers
 *   "text" {text}        strings                  #init     a selector
 *   @buf  @[buf i]       a variable's address, an element's   ; ...  a comment, to the end of the line
 */
export type Node =
  | { kind: "list"; items: Node[]; line: number }
  | { kind: "index"; items: Node[]; line: number }
  | { kind: "sym"; name: string; line: number }
  | { kind: "num"; value: number; line: number }
  | { kind: "str"; value: string; line: number }
  | { kind: "sel"; name: string; line: number }
  | { kind: "addr"; name: string; index?: Node; line: number };

export class ReadError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

const DELIMITERS = new Set([..."()[]{}\";"]);
const isSpace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

export function read(text: string): Node[] {
  let p = 0, line = 1;
  const top: Node[] = [];
  const stack: { node: Node & { items: Node[] }; close: string }[] = [];
  const add = (n: Node) => (stack.length ? stack[stack.length - 1]!.node.items : top).push(n);

  while (p < text.length) {
    const c = text[p]!;
    if (c === "\n") { line++; p++; continue; }
    if (isSpace(c)) { p++; continue; }
    if (c === ";") { while (p < text.length && text[p] !== "\n") p++; continue; }
    if (c === "(" || c === "[") {
      const node = { kind: c === "(" ? "list" : "index", items: [], line } as Node & { items: Node[] };
      add(node);
      stack.push({ node, close: c === "(" ? ")" : "]" });
      p++;
      continue;
    }
    if (c === ")" || c === "]") {
      const open = stack.pop();
      if (!open) throw new ReadError(`unexpected ${c}`, line);
      if (open.close !== c) throw new ReadError(`expected ${open.close} to close the ${open.close === ")" ? "(" : "["} on line ${open.node.line}, got ${c}`, line);
      p++;
      continue;
    }
    if (c === '"' || c === "{") {
      const end = c === '"' ? '"' : "}";
      const start = line;
      let value = "";
      p++;
      for (;;) {
        if (p >= text.length) throw new ReadError("string never ends", start);
        const ch = text[p]!;
        if (ch === end) { p++; break; }
        if (ch === "\n") line++;
        if (ch === "\\") {
          const n = text[p + 1] ?? "";
          if (n === "n") value += "\n";
          else if (n === "t") value += "\t";
          else if (/[0-9a-fA-F]/.test(n) && /[0-9a-fA-F]/.test(text[p + 2] ?? "")) {
            value += String.fromCharCode(parseInt(text.slice(p + 1, p + 3), 16));
            p++;
          } else value += n;
          p += 2;
          continue;
        }
        value += ch;
        p++;
      }
      add({ kind: "str", value, line: start });
      continue;
    }
    if (c === "`") {
      // A character: `a is 97; `^a is control-A; `#4 is a key with a scan code (not supported).
      const ch = text[p + 1];
      if (ch === undefined) throw new ReadError("` needs a character", line);
      if (ch === "^" && text[p + 2] && !isSpace(text[p + 2]!)) {
        add({ kind: "num", value: text[p + 2]!.toUpperCase().charCodeAt(0) - 64, line });
        p += 3;
      } else {
        add({ kind: "num", value: ch.charCodeAt(0), line });
        p += 2;
      }
      continue;
    }
    let e = p;
    while (e < text.length && !isSpace(text[e]!) && !DELIMITERS.has(text[e]!)) e++;
    const token = text.slice(p, e);
    p = e;
    add(atom(token, line));
  }
  if (stack.length) throw new ReadError(`( never closed`, stack[stack.length - 1]!.node.line);
  return addresses(top);
}

/** `@` then `[buf i]` is one thing: the address of an element. */
function addresses(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const next = nodes[i + 1];
    if (n.kind === "sym" && n.name === "@" && next?.kind === "index" && next.items.length === 2 && next.items[0]!.kind === "sym") {
      out.push({ kind: "addr", name: (next.items[0] as { name: string }).name, index: addresses([next.items[1]!])[0], line: n.line });
      i++;
      continue;
    }
    if (n.kind === "list" || n.kind === "index") out.push({ ...n, items: addresses(n.items) });
    else out.push(n);
  }
  return out;
}

function atom(token: string, line: number): Node {
  if (/^-?\d+$/.test(token)) return { kind: "num", value: Number(token), line };
  if (/^-?\$[0-9a-fA-F]+$/.test(token)) return { kind: "num", value: (token.startsWith("-") ? -1 : 1) * parseInt(token.replace(/^-?\$/, ""), 16), line };
  if (/^%[01]+$/.test(token)) return { kind: "num", value: parseInt(token.slice(1), 2), line };
  if (token.startsWith("#") && token.length > 1) return { kind: "sel", name: token.slice(1), line };
  if (token.startsWith("@") && token.length > 1) return { kind: "addr", name: token.slice(1), line };
  return { kind: "sym", name: token, line };
}

/** A node as source text again, for error messages. */
export function show(n: Node): string {
  switch (n.kind) {
    case "list": return `(${n.items.map(show).join(" ")})`;
    case "index": return `[${n.items.map(show).join(" ")}]`;
    case "sym": return n.name;
    case "num": return String(n.value);
    case "str": return JSON.stringify(n.value);
    case "sel": return `#${n.name}`;
    case "addr": return n.index ? `@[${n.name} ${show(n.index)}]` : `@${n.name}`;
  }
}
