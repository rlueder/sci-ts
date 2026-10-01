# The virtual machine

## Values

Everything is a 16-bit word, or a reference. sci-ts packs a reference into one JavaScript
number as `segment * 0x10000 + offset`. Segment 0 is plain integers. Every other segment is
one thing: a script's code and heap, its locals, a clone, an array, a list, a list node, a
text bitmap, the stack. A reference is valid as long as its segment is.

This mirrors how the original interpreter's memory manager worked closely enough that saved
games become a matter of recreating the segment table (see saves.md).

## Loading a script

When a class or an export is needed, its script loads: the heap's objects are created, its
locals filled, and every object linked to its class, which may load other scripts. Two
things the loader must do that the bytes don't say:

- **`-super-` becomes the superclass object's address, and a class's `-species-` becomes its
  own address.** The heap stores class numbers there, but `Obj::isKindOf` sends messages to
  `-super-`, so it has to be an object.
- **`-classScript-` and an instance's `-propDict-` are set by the loader** (the script
  number, and the class's property dictionary). `isKindOf` compares them, and if they're left
  as raw heap values, unrelated objects can look like the same class.

The root class's `-super-` must be null, not -1, or `isKindOf` ends up sending to -1.

## Sends and frames

A send looks up each selector on the receiver. A property: the first argument, if any, is
written, and the value is returned. A method: a new frame starts with `self` = the receiver,
the parameters on the stack, and a fresh area for temporaries. Several messages in one send
run one after another, each frame finishing before the next message starts.

Details that matter:

- `&rest` pushes the caller's parameters from a given one on, and adds their count to the
  argument count of the message or call being built.
- Reading a parameter beyond the argument count gives 0.
- `super` sends to the class above the method's own class, not above the receiver's class.
- A kernel call's result is the accumulator. Kernels that return nothing leave it alone.

sci-ts keeps its own frame stack instead of using JavaScript recursion, so it can stop in the
middle of a script (at the end of a frame, when `FrameOut` draws) and resume later. Kernels
that call back into scripts (iterating a list, moving actors) are generators that ask the VM
to run the send, so a script can draw frames even inside those callbacks.

## The clock

Scripts time things in ticks (60 a second) through `GetTime`, and in seconds through
`GetTime(1)`. Both must follow the same clock. sci-ts lets the host provide it: real time in
the browser, one tick per frame in headless runs, which makes tests deterministic.

## The main loop

The interpreter starts by sending `play` to the game object (script 0, export 0). The
game's `play` loops forever: `doit` on the game, which handles input, runs every actor's
`doit`, the room's and its scripts', and draws with `FrameOut`. The interpreter's only
remaining part in the loop is the kernel calls.

Rooms change the same way in every SCI game we've seen: when `newRoomNum` differs from
`curRoomNum` (globals 13 and 11), the game calls `newRoom:`, which disposes the old room and
starts the new one. A tool can jump rooms by setting global 13 between frames.

## Unloading scripts

`DisposeScript` unloads a script. Code that's done with a dialog or a room calls it, and then
expects the script to come back fresh the next time: objects reset to their initial values.
A dialog in the game we used positioned its buttons relative to where they already were; it
only worked because the script was reloaded each time.

Two catches:

- A script can dispose itself while it's still running (the dialog's last call is to dispose
  its own script). Unloading has to wait until no frame is executing in it.
- Something else may still use it: a clone of one of its classes, a pending callback to one of
  its objects. sci-ts does what ScummVM does: it only unloads a script when nothing reachable
  points at it, walking from the roots (other scripts' locals and objects, the stack, the
  running frames, and whatever the host holds: planes, screen items, playing sounds). Words
  that merely look like addresses into the script's code don't count.

`DisposeScript` also returns its optional second argument. That's how the save dialog hands
back the chosen save slot after unloading the script it ran in.

## Lists

`NewList`, `NewNode`, `AddToEnd`, `DeleteKey`, `DisposeList`... are the kernel side of the
`List`/`Set`/`Collection` classes. Removing a node or disposing a list should free the
nodes. Ours didn't at first, and the leaked nodes kept references alive that stopped scripts
from unloading.
