/**
 * Yarn Spinner's file format (https://docs.yarnspinner.dev), the part rooms use so far:
 *
 *   title: wisp.talk        <- headers, `key: value`, until ---
 *   ---
 *   Golden pods hang from the rock.     <- a line; `Speaker: text` names who says it
 *   <<if $met_wisp>>                    <- conditions on true/false variables:
 *       They hum when you're near.         not, and, or, ==, !=, (...), true, false
 *   <<else>>
 *       They're silent.
 *   <<endif>>
 *   <<set $looked to true>>
 *   -> Who are you?                     <- a choice; its body is indented below it
 *       Wisp: A memory of this place.
 *   -> Sing for me <<if $met_wisp>>     <- a choice only offered when its condition holds
 *       Wisp: Not yet.
 *   // a comment
 *   ===
 *
 * Other commands (<<walk hero 110 160>>, <<wait 2>>...) are kept as name + arguments for
 * the compiler to check. Choices inside choices or inside <<if>> are rejected with the
 * line they're on, until the compiler supports them.
 */
export interface YarnNode {
  title: string;
  headers: Record<string, string>;
  body: YarnItem[];
  /** Where the node starts, for error messages. */
  line: number;
}

export type YarnItem = YarnLine | YarnChoice | YarnSet | YarnIf | YarnCommand;

/** Any other <<command arg arg ...>>; the compiler knows which exist (walk, wait, ...). */
export interface YarnCommand {
  kind: "command";
  name: string;
  args: string[];
  line: number;
}

export interface YarnLine {
  kind: "line";
  speaker?: string;
  text: string;
  line: number;
}

export interface YarnChoice {
  kind: "choice";
  text: string;
  /** Only offered when this holds. */
  when?: YarnExpr;
  body: YarnItem[];
  line: number;
}

export interface YarnSet {
  kind: "set";
  name: string;
  value: YarnExpr;
  line: number;
}

export interface YarnIf {
  kind: "if";
  /** `if` and `elseif` branches in order; a final `else` has no condition. */
  branches: { when?: YarnExpr; body: YarnItem[] }[];
  line: number;
}

/** Boolean expressions over variables (each a flag). */
export type YarnExpr =
  | { kind: "var"; name: string }
  | { kind: "const"; value: boolean }
  | { kind: "not"; of: YarnExpr }
  | { kind: "and" | "or"; a: YarnExpr; b: YarnExpr };

export class YarnError extends Error {
  constructor(readonly file: string, readonly line: number, message: string) {
    super(`${file}:${line}: ${message}`);
  }
}

/** Trailing #tags (Yarn's line ids and metadata) don't belong to the text. */
const stripTags = (s: string) => s.replace(/(\s+#[^\s#]+)+\s*$/, "");
const indentOf = (s: string) => /^[ \t]*/.exec(s)![0].replace(/\t/g, "    ").length;

export function parseYarn(source: string, file = "<yarn>"): YarnNode[] {
  const nodes: YarnNode[] = [];
  const lines = source.split(/\r?\n/);
  let i = 0;
  const fail = (line: number, why: string): never => {
    throw new YarnError(file, line, why);
  };
  while (i < lines.length) {
    // Headers.
    const start = i + 1;
    const headers: Record<string, string> = {};
    for (; i < lines.length && lines[i]!.trim() !== "---"; i++) {
      const raw = lines[i]!.trim();
      if (!raw || raw.startsWith("//")) continue;
      const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(raw);
      if (!m) fail(i + 1, `expected a header (key: value) or ---, got "${raw}"`);
      headers[m![1]!] = m![2]!.trim();
    }
    if (i >= lines.length) {
      if (Object.keys(headers).length) fail(start, "node has no body: expected --- after its headers");
      break;
    }
    const title = headers.title;
    if (!title) fail(start, "node has no title: header");
    if (nodes.some((n) => n.title === title)) fail(start, `a node called "${title}" already exists`);
    i++; // ---
    // The body's lines up to ===, then parsed into a tree.
    const body: { text: string; indent: number; line: number }[] = [];
    let closed = false;
    for (; i < lines.length; i++) {
      const raw = lines[i]!.trim();
      if (raw === "===") {
        closed = true;
        i++;
        break;
      }
      if (!raw || raw.startsWith("//")) continue;
      body.push({ text: raw, indent: indentOf(lines[i]!), line: i + 1 });
    }
    if (!closed) fail(start, `node "${title}" isn't closed with ===`);
    const parser = new BodyParser(body, fail);
    nodes.push({ title: title!, headers, body: parser.block(-1, false, false, []), line: start });
    if (parser.at < body.length) {
      const extra = body[parser.at]!;
      fail(extra.line, `unexpected ${extra.text.split(/\s/)[0]} (no <<if>> is open)`);
    }
  }
  return nodes;
}

class BodyParser {
  at = 0;
  constructor(
    readonly lines: { text: string; indent: number; line: number }[],
    readonly fail: (line: number, why: string) => never,
  ) {}

  /**
   * Items until a line indented at most `parentIndent` (the end of a choice's body) or, in
   * an <<if>>, one of `stopAt` (elseif/else/endif).
   */
  block(parentIndent: number, inChoice: boolean, inIf: boolean, stopAt: string[]): YarnItem[] {
    const items: YarnItem[] = [];
    let choiceIndent: number | undefined;
    while (this.at < this.lines.length) {
      const { text, indent, line } = this.lines[this.at]!;
      if (indent <= parentIndent) break;
      const command = /^<<\s*(\w+)\s*(.*?)\s*>>$/.exec(text);
      if (command && stopAt.includes(command[1]!)) break;
      this.at++;
      if (text.startsWith("->")) {
        if (inChoice) this.fail(line, "choices inside choices aren't supported yet");
        if (inIf) this.fail(line, "choices inside <<if>> aren't supported yet (use -> text <<if $x>>)");
        if (choiceIndent !== undefined && indent !== choiceIndent) this.fail(line, "choices in a group must line up");
        choiceIndent = indent;
        let rest = stripTags(text.slice(2).trim());
        let when: YarnExpr | undefined;
        const cond = /^(.*?)\s*<<\s*if\s+(.+?)\s*>>$/.exec(rest);
        if (cond) {
          rest = cond[1]!;
          when = parseExpr(cond[2]!, (why) => this.fail(line, why));
        }
        if (!rest) this.fail(line, "a choice needs text after ->");
        items.push({ kind: "choice", text: rest, when, body: this.block(indent, true, false, []), line });
        continue;
      }
      if (command) {
        const [, name, args] = command;
        if (name === "set") {
          const m = /^\$([A-Za-z_]\w*)\s*(?:to|=)\s*(.+)$/.exec(args!);
          if (!m) this.fail(line, "expected <<set $name to true>> (or false, or a condition)");
          items.push({ kind: "set", name: m![1]!, value: parseExpr(m![2]!, (why) => this.fail(line, why)), line });
        } else if (name === "if") {
          items.push(this.ifBlock(args!, line, indent, inChoice));
        } else if (["elseif", "else", "endif"].includes(name!)) {
          this.fail(line, `<<${name}>> without an <<if>>`);
        } else {
          items.push({ kind: "command", name: name!, args: args ? args.split(/[\s,]+/).filter(Boolean) : [], line });
        }
        continue;
      }
      if (text.startsWith("<<")) this.fail(line, `expected <<command ...>>, got "${text}"`);
      const clean = stripTags(text);
      const m = /^([A-Za-z][\w ]*?)\s*:\s+(.+)$/.exec(clean);
      items.push(m ? { kind: "line", speaker: m[1]!, text: m[2]!, line } : { kind: "line", text: clean, line });
    }
    return items;
  }

  private ifBlock(firstCond: string, line: number, indent: number, inChoice: boolean): YarnIf {
    const fail = (why: string) => this.fail(line, why);
    const branches: YarnIf["branches"] = [{ when: parseExpr(firstCond, fail), body: [] }];
    // An <<if>>'s body is whatever comes before its <<elseif>>/<<else>>/<<endif>>, at any
    // indentation deeper than the enclosing choice (Yarn doesn't require indenting it).
    for (;;) {
      branches[branches.length - 1]!.body = this.block(inChoice ? indent - 1 : -1, inChoice, true, ["elseif", "else", "endif"]);
      const next = this.lines[this.at];
      const command = next && /^<<\s*(\w+)\s*(.*?)\s*>>$/.exec(next.text);
      if (!command) this.fail(line, "<<if>> without <<endif>>");
      this.at++;
      if (command![1] === "endif") return { kind: "if", branches, line };
      if (branches.at(-1)!.when === undefined) this.fail(next!.line, `<<${command![1]}>> after <<else>>`);
      if (command![1] === "else") branches.push({ body: [] });
      else branches.push({ when: parseExpr(command![2]!, (why) => this.fail(next!.line, why)), body: [] });
    }
  }
}

/** `$a and not ($b or $c == false)`: Yarn's boolean operators, both spellings. */
export function parseExpr(source: string, fail: (why: string) => never): YarnExpr {
  const tokens = source.match(/\$[A-Za-z_]\w*|&&|\|\||==|!=|[()!]|[A-Za-z_]\w*|\S/g) ?? [];
  let p = 0;
  const peek = () => tokens[p];
  const take = () => tokens[p++];
  const word = (t: string | undefined, ...names: string[]) => t !== undefined && names.includes(t.toLowerCase());
  const or = (): YarnExpr => {
    let a = and();
    while (word(peek(), "or", "||")) (take(), (a = { kind: "or", a, b: and() }));
    return a;
  };
  const and = (): YarnExpr => {
    let a = compare();
    while (word(peek(), "and", "&&")) (take(), (a = { kind: "and", a, b: compare() }));
    return a;
  };
  const compare = (): YarnExpr => {
    const a = unary();
    if (word(peek(), "==", "!=", "is", "eq", "neq")) {
      const op = take()!.toLowerCase();
      const b = unary();
      // a == b is (a and b) or (not a and not b).
      const same: YarnExpr = { kind: "or", a: { kind: "and", a, b }, b: { kind: "and", a: { kind: "not", of: a }, b: { kind: "not", of: b } } };
      return op === "!=" || op === "neq" ? { kind: "not", of: same } : same;
    }
    return a;
  };
  const unary = (): YarnExpr => {
    const t = take();
    if (t === undefined) fail(`incomplete condition "${source}"`);
    if (word(t, "not", "!")) return { kind: "not", of: unary() };
    if (t === "(") {
      const e = or();
      if (take() !== ")") fail(`missing ) in "${source}"`);
      return e;
    }
    if (word(t, "true", "false")) return { kind: "const", value: t!.toLowerCase() === "true" };
    if (t!.startsWith("$")) return { kind: "var", name: t!.slice(1) };
    return fail(`unexpected "${t}" in "${source}" (variables are $name; numbers and text aren't supported yet)`);
  };
  const e = or();
  if (p < tokens.length) fail(`unexpected "${tokens[p]}" in "${source}"`);
  return e;
}
