/**
 * SCI bytecode. Each instruction's first byte is `opcode << 1 | size`: when the low bit is
 * set, "sized" operands are 1 byte instead of 2.
 *
 * Operand kinds:
 *   W  sized unsigned (word or byte)      S  sized signed
 *   R  sized signed, relative to the next instruction (jump/call target)
 *   B  always 1 byte                     U  always 2 bytes
 *
 * SCI2 quirk, found by measuring: the argument-frame operand of call/callk/callb/calle/super
 * is always 16-bit, even in the byte form; send and self frames follow the size bit.
 * (SCI0–1.1 used a fixed byte.) Decoding it as a byte leaves a stray 0x00, which shows up
 * as thousands of bogus `bnot` instructions.
 */
export type OperandKind = "W" | "S" | "R" | "B" | "U";

export interface OpcodeInfo {
  name: string;
  operands: OperandKind[];
}

const op = (name: string, ...operands: OperandKind[]): OpcodeInfo => ({ name, operands });

const base: OpcodeInfo[] = [
  // 0x00–0x16: arithmetic and comparison. Binary ops combine the stack top with acc.
  op("bnot"), op("add"), op("sub"), op("mul"), op("div"), op("mod"), op("shr"), op("shl"),
  op("xor"), op("and"), op("or"), op("neg"), op("not"), op("eq?"), op("ne?"), op("gt?"),
  op("ge?"), op("lt?"), op("le?"), op("ugt?"), op("uge?"), op("ult?"), op("ule?"),
  // 0x17–0x1e: branches and the stack
  op("bt", "R"), op("bnt", "R"), op("jmp", "R"), op("ldi", "S"), op("push"), op("pushi", "S"), op("toss"), op("dup"),
  // 0x1f–0x25: calls. The last operand is the argument frame size in bytes.
  op("link", "W"),
  op("call", "R", "U"), // local procedure
  op("callk", "W", "U"), // kernel (interpreter built-in)
  op("callb", "W", "U"), // export of script 0
  op("calle", "W", "W", "U"), // export of another script
  op("ret"),
  op("send", "W"), // send messages to the object in acc
  // 0x26–0x2f: objects
  op("dummy26"), op("dummy27"),
  op("class", "W"), // acc = class object
  op("dummy29"),
  op("self", "W"), op("super", "W", "U"), op("&rest", "W"),
  op("lea", "W", "W"), op("selfID"), op("dummy2f"),
  // 0x30–0x38: properties of the current object (operand = property offset in bytes)
  op("pprev"), op("pToa", "W"), op("aTop", "W"), op("pTos", "W"), op("sTop", "W"),
  op("ipToa", "W"), op("dpToa", "W"), op("ipTos", "W"), op("dpTos", "W"),
  // 0x39–0x3f
  op("lofsa", "W"), op("lofss", "W"), // address of a heap object/string
  op("push0"), op("push1"), op("push2"), op("pushSelf"), op("dummy3f"),
];

/**
 * 0x40–0x7f: variable access, generated from a pattern:
 *   bits 0-1: g(lobal) l(ocal) t(emp) p(aram)
 *   bit 2:    a = acc, s = stack
 *   bit 3:    i = indexed by acc
 *   bits 4-5: l(oad), s(tore), + (increment), - (decrement)
 */
const varOps = Array.from({ length: 64 }, (_, i) => {
  const kind = "gltp"[i & 3]!;
  const target = i & 4 ? "s" : "a";
  const indexed = i & 8 ? "i" : "";
  const action = ["l", "s", "+", "-"][i >> 4]!;
  return op(`${action}${target}${kind}${indexed}`, "W");
});

export const opcodes: readonly OpcodeInfo[] = [...base, ...varOps];

export type VarKind = "global" | "local" | "temp" | "param";
export const varKind = (opcode: number): VarKind | undefined =>
  opcode >= 0x40 ? (["global", "local", "temp", "param"] as const)[opcode & 3] : undefined;
