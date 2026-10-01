# sci-ts

An engine for Sierra's SCI2 adventure games, written from scratch in TypeScript, and a
toolchain for making new ones: rooms written as YAML and [Yarn](https://docs.yarnspinner.dev),
a live room editor, and byte-exact writers for every kind of resource.

It runs in the browser and in Node. It was developed against *Quest for Glory IV: Shadows of
Darkness* (CD), which it plays from the title screen on, and it's on its way to running games
of its own: the first one is a short Sherlock Holmes story,
[sci-sherlock](https://github.com/rlueder/sci-sherlock), which uses sci-ts as a package. See
[docs/plan.md](docs/plan.md).

> **No game data here.** This repository contains no files, scripts, art, text or music from
> any Sierra game, and none are needed to build or test it. To play a Sierra game, point the
> tools at your own copy. Sierra, Quest for Glory and other names are trademarks of their
> owners and are used only to say what the software works with.

## What's in it

**The engine** (`packages/sci`)
- Resources: the resource map, volumes and patch files, LZS decompression; pictures, views,
  palettes (cycling, fades, PalVary), fonts and message files.
- The SCI2 virtual machine and its kernel calls: objects and sends, lists, arrays and strings,
  planes and screen items with scaling, pathfinding (polygons, PolyPath), text and dialogs,
  timing, script loading and unloading.
- Sound: digital effects and speech, General MIDI music through a SoundFont, AdLib music
  through an OPL2 emulator.
- Saved games, kept in the browser.
- Byte-exact readers and writers: scripts (an assembler and disassembler), message files,
  pictures and views; PNGs become pictures and animated views.

**Content** (`packages/content`): a room is a `.room.yaml` (what's in it: picture, music, the
hero's start, walkable floor, features, exits, props) and a `.yarn` (what's said and done:
`<thing>.<verb>` nodes, characters with talking portraits, conversations as topic menus,
flags and conditions, cutscenes, sound). It compiles to SCI assembly and messages for a
*target*, the class library a game provides. Errors point at the file and line.

**Apps** (`apps/viewer`, `pnpm viewer`)
- Resource viewer: every resource with thumbnails, keyboard navigation, search by the names
  and descriptions the game's own scripts give its assets, and a sound player.
- Player: the game in a page, with saves, room jumps and mods.
- Explorer: a map of every room and how they connect, objects on their pictures, the class
  hierarchy, and a live view with outlines and an inspector.
- Room editor: YAML and Yarn next to the running game, rebuilt and replayed as you type;
  drag things into place and paint walk areas.

**Tools** (`tools`): resource listing and extraction, disassembly, assembly and message
round trips, picture and view export, headless play and scripted exploration, static analysis
of a game's rooms and exits, mod building.

## Setup

```sh
pnpm install
pnpm check           # typecheck and tests; runs without any game files
pnpm test:coverage   # coverage report in coverage/
```

With a game of your own (developed against QfG4 CD 1.0) copied into `original/`, or
anywhere else with `SCI_GAME=<dir>`:

```sh
pnpm viewer        # http://localhost:5173: resources; /play.html, /explore.html, /editor.html
pnpm res list script
pnpm asm dump 100            # a script as assembly text (round-trips byte for byte)
pnpm play --frames 1500      # headless run
```

## Making a game

```sh
pnpm game new night-walk               # a room, a hero, placeholder art in games/night-walk
pnpm game build games/hello
SCI_GAME=out/games/hello pnpm viewer   # /play.html, and /editor.html to edit rooms live
pnpm game site games/hello             # the docs and the game as a static site, in out/site
```

`editors/vscode` highlights the script language in VS Code.

`games/hello` is built from nothing: its scripts, art, font, palette and cursor are all in
this repository. Scripts are written in SCI's Lisp-like language and compiled
([docs/language.md](docs/language.md)), on a class library of our own: rooms, a hero who
walks where you click, verbs, messages, conversations, sound
([docs/library.md](docs/library.md)). Rooms can also be written as YAML and Yarn
([docs/rooms.md](docs/rooms.md)) and edited live. See [docs/games.md](docs/games.md).

## Status

The engine and tools work with SCI2 games you own, and games can be built without one,
with scripts compiled from SCI's own language on our own class library, and rooms in
YAML and Yarn. Next, in [docs/plan.md](docs/plan.md): the first story.

Building rooms (the mod builder and the room editor) needs a *target* for the game: a module
in `tools/targets/` that tells the content compiler the game's room class, globals and verbs,
named by the mod's `mod.yaml`. None ships yet; the first will be for our own class library.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md),
which is generated from commit messages.

## License

MIT. See [LICENSE](LICENSE).
