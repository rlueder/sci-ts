# Saving and restoring

## What the scripts ask for

The game's own Save and Restore dialogs call a handful of kernels:

- `SaveGame(game, slot, description, version)`
- `RestoreGame(game, slot, version)`
- `CheckSaveGame(game, slot, version)`: does it exist, and was it made by this version?
- `GetSaveFiles(game, descriptions, slots)`: fills 36-byte description slots and a list of
  slot numbers ending in 0
- `GameIsRestarting`: 1 after a restart, 2 after a restore; any argument clears it.

The version string comes from a global that no script in the game we used ever set, so every
save records an empty version and every check compares empty with empty.

The Restore dialog hands the chosen slot back in an unusual way: its last act is to dispose
its own script, passing the slot as the second argument of `DisposeScript`, which returns it.
An interpreter that returns 0 there restores slot 0 whatever you picked.

## What a save is

The original interpreter wrote out its heap. sci-ts writes its own state instead. Because
every reference is a segment and an offset, a save is the segment table, recreated segment by
segment:

- each loaded script by number (its code and heap come from the resources again), with its
  locals and its objects' properties
- each clone, by the object it was cloned from, with its properties
- arrays, lists and nodes (linked by segment number), text bitmaps, the stack
- what the host holds: planes and screen items, the palette state, playing songs and their
  positions

About 130 KB per save. The call stack is not saved.

## How a restore runs

Like the original: memory is replaced, execution is dropped, and the interpreter sends
`replay` to the game object. The game's `replay` rebuilds the screen from the restored objects
(re-adding planes and screen items) and carries on in its main loop. `GameIsRestarting`
returns 2, so scripts can tell.

To put every script back at its saved segment, loading has two steps: create the segments,
locals and objects (at given segment numbers), then link instances to their classes, which may
load more scripts. Before anything is recreated, the segment table is grown to its saved size
with no free slots, so a script loaded on the side can't take a saved number.

A save made while something was wrong (a bug since fixed) carries that wrong state with it.
After fixing engine bugs, old saves can still misbehave; make new ones.
