import type { ArrayType, SciArray } from "../memory.ts";
import type { KernelFn, Vm } from "../vm.ts";
import { NULL, fromInt, isNumber, segmentOf, toSigned, type Value } from "../value.ts";

const arrayTypes: ArrayType[] = ["int16", "id", "byte", "string"];

/** Resolves an array argument: an array ref, or a String/Array object holding one in `data`. */
function resolve(vm: Vm, v: Value): SciArray | undefined {
  const direct = vm.memory.array(v);
  if (direct) return direct;
  const obj = vm.memory.object(v);
  if (obj) {
    const data = vm.getProp(obj, "data");
    if (data !== undefined) return vm.memory.array(data);
  }
  return undefined;
}

const store = (a: SciArray, value: Value) => (a.type === "byte" || a.type === "string" ? value & 0xff : value);

function setElements(vm: Vm, [ref = 0, index = 0, ...values]: Value[]): Value {
  const a = resolve(vm, ref);
  if (!a) return ref;
  const start = toSigned(index);
  values.forEach((v, i) => {
    a.data[start + i] = store(a, v);
  });
  for (let i = 0; i < a.data.length; i++) a.data[i] ??= 0;
  return ref;
}

/** Byte values of a string argument: literal in a script heap or an array. */
function chars(vm: Vm, v: Value): number[] {
  const a = resolve(vm, v);
  if (a) {
    const out: number[] = [];
    for (const c of a.data) {
      if ((c & 0xff) === 0) break;
      out.push(c & 0xff);
    }
    return out;
  }
  if (!v) return [];
  return [...vm.memory.string(v)].map((c) => c.charCodeAt(0));
}

const str = (vm: Vm, v: Value) => String.fromCharCode(...chars(vm, v));

function newString(vm: Vm, s: string): Value {
  const ref = vm.memory.newArray("string", s.length + 1);
  const a = vm.memory.array(ref)!;
  for (let i = 0; i < s.length; i++) a.data[i] = s.charCodeAt(i) & 0xff;
  return ref;
}

function writeString(vm: Vm, ref: Value, s: string): Value {
  const a = resolve(vm, ref);
  if (!a) return ref;
  a.data.length = 0;
  for (let i = 0; i < s.length; i++) a.data.push(s.charCodeAt(i) & 0xff);
  a.data.push(0);
  return ref;
}

function copy(vm: Vm, [dst = 0, dstIndex = 0, src = 0, srcIndex = 0, count = 0xffff]: Value[]): Value {
  const d = resolve(vm, dst);
  if (!d) return dst;
  const s = resolve(vm, src);
  const from = s ? s.data : chars(vm, src).concat(0);
  const start = toSigned(srcIndex);
  let n = toSigned(count);
  if (n < 0) n = from.length - start;
  for (let i = 0; i < n && start + i < from.length; i++) d.data[toSigned(dstIndex) + i] = store(d, from[start + i]!);
  for (let i = 0; i < d.data.length; i++) d.data[i] ??= 0;
  return dst;
}

/** printf-style formatting, as SCI's StringFormat understands it. */
export function sciFormat(vm: Vm, format: string, args: Value[]): string {
  let argi = 0;
  return format.replace(/%(-?)(0?)(\d*)([dsuxXc%])/g, (_m, left: string, zero: string, width: string, conv: string) => {
    if (conv === "%") return "%";
    const arg = args[argi++] ?? 0;
    let out: string;
    switch (conv) {
      case "d": out = String(toSigned(arg)); break;
      case "u": out = String(arg & 0xffff); break;
      case "x": out = (arg & 0xffff).toString(16); break;
      case "X": out = (arg & 0xffff).toString(16).toUpperCase(); break;
      case "c": out = String.fromCharCode(arg & 0xff); break;
      default: out = isNumber(arg) && arg !== 0 ? String(toSigned(arg)) : str(vm, arg);
    }
    const w = Number(width || 0);
    return left ? out.padEnd(w) : out.padStart(w, zero ? "0" : " ");
  });
}

const arraySubops: Record<number, KernelFn> = {
  0: (vm, [size = 0, type = 0]) => vm.memory.newArray(arrayTypes[type] ?? "int16", size),
  1: (vm, [ref = 0]) => resolve(vm, ref)?.data.length ?? 0,
  2: (vm, [ref = 0, index = 0]) => resolve(vm, ref)?.data[toSigned(index)] ?? 0,
  3: setElements,
  4: (vm, [ref = 0]) => {
    if (vm.memory.array(ref)) vm.memory.free(segmentOf(ref));
    return 0;
  },
  5: (vm, [ref = 0, index = 0, count = 0, value = 0]) => {
    const a = resolve(vm, ref);
    if (a) for (let i = 0; i < count; i++) a.data[toSigned(index) + i] = store(a, value);
    if (a) for (let i = 0; i < a.data.length; i++) a.data[i] ??= 0;
    return ref;
  },
  6: copy,
  8: (vm, [ref = 0]) => {
    const a = resolve(vm, ref);
    if (!a) return NULL;
    const dup = vm.memory.newArray(a.type, 0);
    vm.memory.array(dup)!.data = a.data.slice();
    return dup;
  },
  9: (vm, [ref = 0]) => {
    const obj = vm.memory.object(ref);
    return obj ? (vm.getProp(obj, "data") ?? ref) : ref;
  },
};

const stringSubops: Record<number, KernelFn> = {
  ...arraySubops,
  0: (vm, [size = 0]) => vm.memory.newArray("string", size),
  // Duplicate: also takes a literal string from a script's heap (e.g. `Prints "text"`).
  8: (vm, args) => (resolve(vm, args[0] ?? 0) ? arraySubops[8]!(vm, args) : newString(vm, str(vm, args[0] ?? 0))),
  7: (vm, [a = 0, b = 0, n]) => {
    let x = str(vm, a), y = str(vm, b);
    if (n !== undefined) (x = x.slice(0, n), (y = y.slice(0, n)));
    return fromInt(x < y ? -1 : x > y ? 1 : 0);
  },
  10: (vm, [s = 0]) => chars(vm, s).length,
  11: (vm, [format = 0, ...args]) => newString(vm, sciFormat(vm, str(vm, format), args)),
  12: (vm, [dst = 0, format = 0, ...args]) => writeString(vm, dst, sciFormat(vm, str(vm, format), args)),
  13: (vm, [s = 0]) => fromInt(parseInt(str(vm, s), 10) || 0),
  14: (vm, [s = 0, flags = 0]) => {
    let t = str(vm, s);
    if (flags & 1) t = t.trimStart();
    if (flags & 2) t = t.trimEnd();
    if (flags & 4) t = t.replace(/ /g, "");
    return writeString(vm, s, t);
  },
  15: (vm, [s = 0]) => writeString(vm, s, str(vm, s).toUpperCase()),
  16: (vm, [s = 0]) => writeString(vm, s, str(vm, s).toLowerCase()),
};

const dispatch = (name: string, table: Record<number, KernelFn>): KernelFn => (vm, [op = 0, ...args]) => {
  const fn = table[op];
  if (!fn) throw new Error(`${name} subop ${op} not implemented`);
  return fn(vm, args);
};

/** SCI32 dynamic arrays and strings. */
export const arrayKernels: Record<string, KernelFn> = {
  Array: dispatch("Array", arraySubops),
  String: dispatch("String", stringSubops),
};

export const stringHelpers = { str, newString, writeString, resolve };
