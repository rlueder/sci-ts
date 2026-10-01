/** Object property slots common to every object (SCI1.1/SCI2 layout, in words). */
export const ObjectSlot = {
  Magic: 0, // 0x1234
  Size: 1, // property count
  PropDict: 2, // script offset: selector id per property (classes only)
  MethDict: 3, // script offset: u16 count, then (selector, code offset) pairs
  ClassScript: 4,
  Species: 5, // class number; 0xFFFF on instances
  Super: 6, // superclass number
  Info: 7, // flags; 0x8000 = class
  Name: 8, // heap offset of the name string
} as const;

const OBJECT_MAGIC = 0x1234;
const INFO_CLASS = 0x8000;

export interface Method {
  selector: number;
  /** Code offset in the script resource. */
  offset: number;
}

export interface ScriptObject {
  /** Offset of the object in the heap resource. */
  offset: number;
  name: string;
  isClass: boolean;
  species: number;
  superclass: number;
  /** Raw property values, including the header slots above. */
  properties: number[];
  /** Selector id per property; only present on classes (instances use their class's). */
  propSelectors?: number[];
  methods: Method[];
}

export interface Export {
  index: number;
  offset: number;
  /** Objects live in the heap; procedures are code in the script. Offset 0 = unused slot. */
  kind: "object" | "code" | "empty";
}

/**
 * A loaded script: bytecode and dictionaries in the script resource, data (locals,
 * objects, strings) in the heap resource of the same number. SCI3 later merged the two.
 */
export interface Script {
  number: number;
  code: Uint8Array;
  heap: Uint8Array;
  exports: Export[];
  locals: number[];
  objects: ScriptObject[];
}

/** Reads a NUL-terminated Latin-1 string. */
export function readString(data: Uint8Array, offset: number): string {
  let end = offset;
  while (end < data.length && data[end] !== 0) end++;
  return new TextDecoder("latin1").decode(data.subarray(offset, end));
}

/**
 * Script resource:  +0 u16 relocation table offset | +6 u16 export count | +8 u16 exports
 * Heap resource:    +0 u16 relocation table offset | +2 u16 local count | locals |
 *                   objects (each starts with 0x1234) until a 0 word | strings
 */
export function parseScript(number: number, code: Uint8Array, heap: Uint8Array): Script {
  const cv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const hv = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
  const heapWord = (o: number) => hv.getUint16(o, true);
  const codeWord = (o: number) => cv.getUint16(o, true);

  const localCount = heapWord(2);
  const locals = Array.from({ length: localCount }, (_, i) => heapWord(4 + i * 2));

  const objects: ScriptObject[] = [];
  for (let pos = 4 + localCount * 2; pos + 2 <= heap.length && heapWord(pos) === OBJECT_MAGIC; ) {
    const size = heapWord(pos + 2);
    const properties = Array.from({ length: size }, (_, i) => heapWord(pos + i * 2));
    const isClass = (properties[ObjectSlot.Info]! & INFO_CLASS) !== 0;

    const methDict = properties[ObjectSlot.MethDict]!;
    const methods = Array.from({ length: codeWord(methDict) }, (_, i) => ({
      selector: codeWord(methDict + 2 + i * 4),
      offset: codeWord(methDict + 4 + i * 4),
    }));

    const propDict = properties[ObjectSlot.PropDict]!;
    objects.push({
      offset: pos,
      name: readString(heap, properties[ObjectSlot.Name]!),
      isClass,
      species: properties[ObjectSlot.Species]!,
      superclass: properties[ObjectSlot.Super]!,
      properties,
      propSelectors: isClass ? Array.from({ length: size }, (_, i) => codeWord(propDict + i * 2)) : undefined,
      methods,
    });
    pos += size * 2;
  }

  const objectOffsets = new Set(objects.map((o) => o.offset));
  const exports = Array.from({ length: codeWord(6) }, (_, index): Export => {
    const offset = codeWord(8 + index * 2);
    return { index, offset, kind: offset === 0 ? "empty" : objectOffsets.has(offset) ? "object" : "code" };
  });

  return { number, code, heap, exports, locals, objects };
}
