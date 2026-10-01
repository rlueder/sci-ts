import { StreamLanguage, type StreamParser } from "@codemirror/language";

/**
 * Highlighting for the room editor: Yarn (headers, speakers, choices, <<commands>>,
 * $variables, comments, #tags) and the compiled SCI assembly. Token names are
 * CodeMirror's legacy names, which its highlight styles already colour.
 */

interface YarnState {
  /** Before a node's --- : `key: value` headers. */
  header: boolean;
  /** Inside <<...>>. */
  command: boolean;
}

const yarnParser: StreamParser<YarnState> = {
  name: "yarn",
  startState: () => ({ header: true, command: false }),
  token(stream, state) {
    if (stream.sol()) {
      if (stream.match(/^---\s*$/)) return (state.header = false), "meta";
      if (stream.match(/^===\s*$/)) return (state.header = true), "meta";
    }
    if (state.command) {
      if (stream.match(">>")) return (state.command = false), "keyword";
      if (stream.match(/^\$[A-Za-z_]\w*/)) return "variableName";
      if (stream.match(/^(true|false)\b/)) return "atom";
      if (stream.match(/^(not|and|or|to|is|eq|neq)\b/) || stream.match(/^(==|!=|&&|\|\||!)/)) return "operator";
      if (stream.match(/^-?\d+(\.\d+)?/)) return "number";
      if (stream.match(/^[A-Za-z_]\w*/)) return "variableName.special";
      stream.next();
      return null;
    }
    if (stream.match("//")) return stream.skipToEnd(), "comment";
    if (state.header && stream.sol()) {
      if (stream.match(/^[A-Za-z_][\w.-]*\s*:/)) return "propertyName";
    }
    if (state.header) return stream.skipToEnd(), "string";
    if (stream.match("<<")) {
      state.command = true;
      stream.eatSpace();
      return stream.match(/^(if|elseif|else|endif|set)\b/) ? "controlKeyword" : stream.match(/^\w+/) ? "keyword" : "keyword";
    }
    // A line's start: a choice, or "Speaker:".
    if (stream.column() === stream.indentation() || stream.sol()) {
      stream.eatSpace();
      if (stream.match("->")) return "operator";
      if (stream.match(/^[A-Za-z][\w ]*?:(?=\s)/)) return "typeName";
    }
    if (stream.match(/^\s#[^\s#]+/)) return "meta";
    stream.next();
    while (!stream.eol() && !stream.match(/^(?=<<|\s#|\/\/)/, false)) stream.next();
    return "content";
  },
};

export const yarn = StreamLanguage.define(yarnParser);

const DIRECTIVES = /^(script|exports|instance|class|method|strings|code|locals|of|owner)\b/;

/** The compiled .sca: directives, labels, mnemonics, #selectors, @heap labels, comments. */
export const sciAssembly = StreamLanguage.define<{ code: boolean }>({
  name: "sca",
  startState: () => ({ code: false }),
  token(stream, state) {
    if (stream.match(";")) return stream.skipToEnd(), "comment";
    if (stream.sol() && stream.match(/^\S+:\s*$/)) return "labelName";
    if (stream.eatSpace()) return null;
    if (stream.match(DIRECTIVES)) {
      if (stream.current() === "code") state.code = true;
      return "keyword";
    }
    if (stream.match(/^#\w+/)) return "propertyName";
    if (stream.match(/^@\w+/) || stream.match(/^\.\w+/)) return "labelName";
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^-?\$[0-9a-f]+|^-?\d+/i)) return "number";
    if (stream.match(/^[\w?&.]+/)) {
      const word = stream.current();
      return stream.column() === stream.indentation() && state.code && !word.includes("::") ? "operatorKeyword" : null;
    }
    stream.next();
    return null;
  },
});

/** Message text: noun verb cond seq talker "text" ; note */
export const sciMessages = StreamLanguage.define({
  name: "msg",
  token(stream) {
    if (stream.match(";")) return stream.skipToEnd(), "comment";
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^\d+/)) return "number";
    if (stream.match(/^\w+/)) return "keyword";
    stream.next();
    return null;
  },
});

/** SCI script source (.sc, .sh): the Lisp-like language games are written in. */
const SCRIPT_KEYWORDS = new Set([
  "script", "include", "define", "enum", "public", "local", "global", "extern", "class", "instance", "of", "kindof",
  "properties", "method", "procedure", "if", "else", "cond", "switch", "switchto", "while", "repeat", "for", "break",
  "continue", "return", "and", "or", "not", "send", "super", "self", "argc", "&rest", "&tmp",
]);

const scriptParser: StreamParser<{ braces: number }> = {
  name: "sci",
  startState: () => ({ braces: 0 }),
  token(stream, state) {
    if (state.braces) {
      // Inside a {string}: to its end.
      while (!stream.eol()) if (stream.next() === "}") return (state.braces = 0), "string";
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(";")) return stream.skipToEnd(), "comment";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.eat("{")) return (state.braces = 1), "string";
    if (stream.match(/^(-?\$[0-9a-fA-F]+|%[01]+|-?\d+)(?=[\s()[\]]|$)/) || stream.match(/^`\^?./)) return "number";
    if (stream.match(/^#[\w-]+/)) return "atom";
    if (stream.match(/^@\w+/)) return "variableName.special";
    if (stream.match(/^[()[\]]/)) return "bracket";
    const word = stream.match(/^[^\s()[\]"{;]+/) as RegExpMatchArray | null;
    if (!word) return stream.next(), null;
    const w = word[0];
    if (/^[\w-]+[:?]$/.test(w)) return "propertyName";
    if (SCRIPT_KEYWORDS.has(w)) return "keyword";
    if (/^[A-Z][A-Z0-9_]+$/.test(w)) return "atom";
    if (/^[A-Z]/.test(w)) return "typeName";
    if (/^[-+*/=<>!&|^~u]+$|^mod$/.test(w)) return "operator";
    return "variableName";
  },
};

export const sciScript = StreamLanguage.define(scriptParser);
