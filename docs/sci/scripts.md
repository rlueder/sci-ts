# Scripts, objects and bytecode

Everything a game does is in its scripts: the main loop, rooms, characters, menus, even the
dialog boxes. The interpreter provides objects, a stack machine and about 150 kernel calls
(drawing, sound, files, pathfinding); scripts do the rest.

## Script and heap

In SCI2 each script number has two resources. The **script** holds code and dictionaries;
the **heap** holds data: local variables, objects and strings. (SCI3 merged them again.)

Script: `relocation table offset u16, 0 u16, 0 u16, export count u16, exports u16...`, then
for each object in heap order its class's property dictionary (classes only) and its method
dictionary, then the bytecode, then the relocation table.

Heap: `relocation table offset u16, local count u16, locals...`, the objects, a zero word,
strings, and its own relocation table.

The relocation tables list the words that hold addresses inside the heap, so a loader can
turn them into pointers. In script code, every `lofsa`/`lofss` operand (load the address of a
heap object or string) is relocated; in the heap, every object's `name` and any property
holding a string or object address.

An export is either an object (a room's export 0 is the room object itself) or a code
offset (a procedure). An export of 0 is an empty slot, not code at offset 0.

## Objects and classes

An object in the heap is a run of 16-bit slots:

| slot | name | |
|---|---|---|
| 0 | `-magic-` | 0x1234 |
| 1 | `-size-` | number of slots |
| 2 | `-propDict-` | the property dictionary (a class's own; an instance points at its methods) |
| 3 | `-methDict-` | the method dictionary |
| 4 | `-classScript-` | the script number |
| 5 | `-species-` | the class number (classes); -1 on instances |
| 6 | `-super-` | the superclass number |
| 7 | `-info-` | flags; 0x8000 marks a class |
| 8 | `name` | address of the name string |
| 9+ | properties | |

A class's property dictionary lists the selector number of each slot; instances use their
class's. A method dictionary is a count and pairs of (selector, code offset). Methods are
looked up by walking `-super-`, as you'd expect.

At run time two of those slots change meaning, which matters (see vm.md): `-super-` and a
class's `-species-` become object addresses, not class numbers.

## Selectors and the class table

Properties and methods share one namespace of **selectors**: small integers that vocab 997
names (`init`, `doit`, `x`, `y`, `view`...; over four thousand in a big game). Vocab 996 maps
each class number to the script that defines it, so the interpreter can load a class on
first use. System classes conventionally live in high-numbered scripts (64999 for `Obj`, the
root class, in the games we looked at).

Kernel calls are numbered too. Their names aren't in any resource: the interpreter has a
table in its executable. The table is the same across games of a generation.

## The bytecode

One byte of opcode, `opcode << 1 | small`: when `small` is set, operands that come in two
sizes are one byte instead of two. There are about 128 opcodes:

- stack and arithmetic: `push`, `pushi`, `dup`, `toss`, `add`, `mul`, `eq?`, `gt?`, `not`...
- control: `bt`, `bnt`, `jmp`, `call` (local procedure), `callk` (kernel), `callb`/`calle`
  (another script's export), `ret`
- objects: `send`, `self`, `super`, `class`, `pToa`/`aTop` (read/write a property of self by
  offset), `ipToa`... (increment a property), `lofsa` (address of a heap object or string)
- variables: 64 generated opcodes for loading and storing globals, locals, temps and
  parameters, with or without an index, to the accumulator or the stack.

A **send** pushes, for each message: the selector, the argument count, the arguments; then
the receiver goes in the accumulator and `send N` names the frame size in bytes. One send can
carry several messages, run in order:

```
pushi #setLoop   push1   push0          ; setLoop: 0
pushi #setCycle  push1   class Walk  push   ; setCycle: Walk
lag 0                                    ; the receiver: global 0 (the hero)
send 12                                  ; 6 words: two messages of 3
```

Calls work the same way: arguments on the stack, the frame size as the operand, the result in
the accumulator.

### The SCI2 detail that broke our first disassembler

The frame-size operand of `call`, `callk`, `callb`, `calle` and `super` is **always two
bytes** in SCI2, even when the small bit is set. `send` and `self` do follow the bit.
Decoding it the SCI1.1 way leaves a stray zero after each call, which reads as a `bnot`;
our first pass produced 38,000 of them.

A good check that every operand width is right: simulate the stack through each function and
see whether every `send` splits cleanly into selector, count and arguments. In the game we
used, 96% did on the first try; the rest involve values that cross branches or `&rest`.

## Assembling it back

An assembler that reproduces Sierra's compiler output byte for byte has to deal with one
inconsistency: Sierra's compiler didn't always pick the smallest operand form. Forward jumps
are word-sized 55% of the time, and a quarter of selector pushes are byte-sized for no
visible reason. sci-ts's assembly text uses the smallest form unless an instruction says
`.w` or `.b`, which about 4.5% of instructions need for an exact match.

Property operands (`pToa` and friends) address a slot of `self` by byte offset, and the same
offset means different properties in different classes. To show names, the assembly text
tracks which class owns the code it's in (a method's label says so; procedures get an
`owner` line), and a few ambiguous cases stay numeric.
