/**
 * A message is addressed by (noun, verb, condition, sequence), all scoped to a room/module
 * number (the resource number):
 *   noun      the thing involved (an object, a character, the room itself)
 *   verb      what the player did to it (look, do, talk, use an inventory item...)
 *   condition a game-state variant (e.g. day vs night, class, puzzle solved)
 *   sequence  1, 2, 3... for multi-line exchanges
 */
export interface MessageTuple {
  noun: number;
  verb: number;
  cond: number;
  seq: number;
}

export interface MessageRecord extends MessageTuple {
  /** Who says it. Talker ids are defined by the game scripts (e.g. 99 narrator, 97 hero). */
  talker: number;
  text: string;
  /** Another message to use instead of this one. See `hasRef`. */
  ref: MessageTuple;
}

export interface MessageFile {
  version: number;
  records: MessageRecord[];
  /**
   * Bytes after the strings, kept only so files round-trip: the engine never reads them.
   * `trailerCount` is the header's entry count; the entries look like editor bookkeeping
   * (many start with a 4-byte timestamp) and aren't fixed-size.
   */
  trailer?: Uint8Array;
  trailerCount?: number;
}

/**
 * SCI1.1/SCI32 message resource (versions 4000–5000 share this layout):
 *
 *   +0 u32 version
 *   +4 u16 end of the strings, counted from +6   +6 u16 trailer entry count
 *   +8 u16 record count
 *   +10 records, 11 bytes each:
 *       noun, verb, cond, seq, talker, u16 string offset, refNoun, refVerb, refCond, refSeq
 *   NUL-terminated Latin-1 strings, one per record, in record order
 *   trailer (unused by the engine; editor bookkeeping)
 *
 * Measured on all 152 message files of an SCI2 game (versions 4210, 4321, 4341, 5000): no gaps, no
 * shared strings, so `writeMessages` reproduces them byte for byte.
 */
export function parseMessages(data: Uint8Array): MessageFile {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = v.getUint32(0, true);
  if (version < 4000) throw new Error(`Message version ${version} not supported`);

  const decoder = new TextDecoder("latin1");
  const count = v.getUint16(8, true);
  const records: MessageRecord[] = [];

  let stringsEnd = 10 + count * 11;
  for (let i = 0; i < count; i++) {
    const r = 10 + i * 11;
    const start = v.getUint16(r + 5, true);
    let end = start;
    while (end < data.length && data[end] !== 0) end++;
    stringsEnd = Math.max(stringsEnd, end + 1);
    records.push({
      noun: data[r]!,
      verb: data[r + 1]!,
      cond: data[r + 2]!,
      seq: data[r + 3]!,
      talker: data[r + 4]!,
      text: decoder.decode(data.subarray(start, end)),
      ref: { noun: data[r + 7]!, verb: data[r + 8]!, cond: data[r + 9]!, seq: data[r + 10]! },
    });
  }
  return { version, records, trailer: data.slice(stringsEnd), trailerCount: v.getUint16(6, true) };
}

const encoder = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

/** The binary resource for a message file (the inverse of `parseMessages`). */
export function writeMessages(file: MessageFile): Uint8Array {
  const strings = file.records.map((r) => encoder(r.text));
  const recordsEnd = 10 + file.records.length * 11;
  const stringsEnd = recordsEnd + strings.reduce((n, s) => n + s.length + 1, 0);
  const trailer = file.trailer ?? new Uint8Array(0);
  const out = new Uint8Array(stringsEnd + trailer.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, file.version, true);
  v.setUint16(4, stringsEnd - 6, true);
  v.setUint16(6, file.trailerCount ?? 0, true);
  v.setUint16(8, file.records.length, true);
  let at = recordsEnd;
  file.records.forEach((r, i) => {
    const o = 10 + i * 11;
    out.set([r.noun, r.verb, r.cond, r.seq, r.talker], o);
    v.setUint16(o + 5, at, true);
    out.set([r.ref.noun, r.ref.verb, r.ref.cond, r.ref.seq], o + 7);
    out.set(strings[i]!, at);
    at += strings[i]!.length + 1;
  });
  if (stringsEnd > 0xffff) throw new Error("Message file too large (string offsets are 16-bit)");
  out.set(trailer, stringsEnd);
  return out;
}

/**
 * Message files as text, one record per line, for editing and mods:
 *
 *   messages 770 version 4321
 *   ; noun verb cond seq talker "text"  [-> noun verb cond seq]
 *   4 1 0 1 99 "You see an old stone altar."
 *   5 1 0 1 99 "" -> 4 1 0 1
 *   trailer 134 005e7c962c2c0000...
 *
 * `labels` can annotate lines with comments (e.g. verb names), which parsing ignores.
 */
export function messagesToText(number: number, file: MessageFile, labels?: (r: MessageRecord) => string | undefined): string {
  const lines = [`messages ${number} version ${file.version}`, "; noun verb cond seq talker \"text\" [-> noun verb cond seq]"];
  for (const r of file.records) {
    const ref = r.ref.noun || r.ref.verb || r.ref.cond || r.ref.seq ? ` -> ${r.ref.noun} ${r.ref.verb} ${r.ref.cond} ${r.ref.seq}` : "";
    const note = labels?.(r);
    lines.push(`${r.noun} ${r.verb} ${r.cond} ${r.seq} ${r.talker} ${quoteText(r.text)}${ref}${note ? ` ; ${note}` : ""}`);
  }
  if (file.trailer?.length || file.trailerCount) {
    lines.push(`trailer ${file.trailerCount ?? 0} ${[...(file.trailer ?? [])].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function messagesFromText(text: string): { number: number; file: MessageFile } {
  let number: number | undefined;
  const file: MessageFile = { version: 4321, records: [] };
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const fail = (why: string): never => {
      throw new Error(`line ${line}: ${why}`);
    };
    const src = raw.trim();
    if (!src || src.startsWith(";")) return;
    let m = /^messages\s+(\d+)\s+version\s+(\d+)$/.exec(src);
    if (m) {
      number = Number(m[1]);
      file.version = Number(m[2]);
      return;
    }
    m = /^trailer\s+(\d+)\s*([0-9a-f]*)$/i.exec(src);
    if (m) {
      file.trailerCount = Number(m[1]);
      file.trailer = Uint8Array.from(m[2]!.match(/../g) ?? [], (h) => parseInt(h, 16));
      return;
    }
    m = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\s*(?:->\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+))?\s*(?:;.*)?$/.exec(src);
    if (!m) fail("expected: noun verb cond seq talker \"text\" [-> noun verb cond seq]");
    const [n, v, c, s, t, body, rn = "0", rv = "0", rc = "0", rs = "0"] = m!.slice(1);
    const byte = (x: string, what: string) => {
      const value = Number(x);
      if (value > 255) fail(`${what} ${value} doesn't fit in a byte`);
      return value;
    };
    file.records.push({
      noun: byte(n!, "noun"), verb: byte(v!, "verb"), cond: byte(c!, "cond"), seq: byte(s!, "seq"), talker: byte(t!, "talker"),
      text: unquoteText(body!),
      ref: { noun: byte(rn, "ref noun"), verb: byte(rv, "ref verb"), cond: byte(rc, "ref cond"), seq: byte(rs, "ref seq") },
    });
  });
  if (number === undefined) throw new Error("missing `messages N version V`");
  return { number, file };
}

function quoteText(text: string): string {
  let s = '"';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (ch === '"') s += '\\"';
    else if (ch === "\\") s += "\\\\";
    else if (ch === "\n") s += "\\n";
    else if (ch === "\r") s += "\\r";
    else if (c >= 0x20 && c < 0x7f) s += ch;
    else s += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  return `${s}"`;
}

function unquoteText(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, e: string) =>
    e === "n" ? "\n" : e === "r" ? "\r" : e.startsWith("x") && e.length === 3 ? String.fromCharCode(parseInt(e.slice(1), 16)) : e);
}

/** Noun 0 means "the room itself", so a reference is any non-zero noun, verb or condition. */
export const hasRef = (r: MessageRecord): boolean => r.ref.noun !== 0 || r.ref.verb !== 0 || r.ref.cond !== 0;

const same = (a: MessageTuple, b: MessageTuple) =>
  a.noun === b.noun && a.verb === b.verb && a.cond === b.cond && a.seq === b.seq;

/** Finds a message, following references (bounded, in case of cycles). */
export function findMessage(file: MessageFile, tuple: MessageTuple): MessageRecord | undefined {
  let t = tuple;
  for (let hops = 0; hops < 8; hops++) {
    const rec = file.records.find((r) => same(r, t));
    if (!rec || !hasRef(rec)) return rec;
    t = rec.ref;
  }
  return undefined;
}
