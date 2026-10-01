# Notes on SCI

SCI (Sierra's Creative Interpreter) ran Sierra's adventure games from 1988 to the late
nineties: King's Quest, Space Quest, Police Quest, Quest for Glory, Gabriel Knight and many
more. A game is a set of resources (pictures, sprites, text, sound) plus scripts compiled to
bytecode for a small object-oriented virtual machine. The interpreter executable is the same
for every game of a generation; the game is in the data.

There were several generations: SCI0 (16 colours, 1988), SCI1 and SCI1.1 (256 colours),
then SCI2 and SCI2.1 (1993 onwards, the "SCI32" engines with planes and scalable sprites),
and SCI3. sci-ts implements **SCI2**. We built it by running one game, the CD release of
Quest for Glory IV (1994), and making it play: reading its resources, executing its scripts,
and fixing whatever the game did differently from what we expected.

These notes are what we found. Most of it can be read in ScummVM's source if you know where
to look; some of it we only learned by measuring. Where a number appears (285 scripts,
9,628 cels) it's from that game.

| | |
|---|---|
| [resources.md](resources.md) | The resource map, volumes, patch files, compression, and each resource format |
| [scripts.md](scripts.md) | Script and heap resources, objects and classes, selectors, the bytecode |
| [vm.md](vm.md) | How the virtual machine runs: values, sends, frames, kernel calls, loading and unloading |
| [graphics.md](graphics.md) | Planes and screen items, pictures and views, the palette, remapping, transitions, scaling |
| [text.md](text.md) | Fonts, message files, how dialogue is addressed and shown, text input |
| [motion.md](motion.md) | Walking: movers, polygons, pathfinding, collisions, scalers |
| [sound.md](sound.md) | Music and effects: sound resources, MIDI channels and cues, digital audio, AdLib |
| [saves.md](saves.md) | Saving and restoring games |
| [lessons.md](lessons.md) | Things the original interpreter does that the scripts quietly depend on |
| [building.md](building.md) | What an interpreter needs from a game, learned by building one from nothing |
