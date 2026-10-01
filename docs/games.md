# Making a game

A game is a folder under `games/`. `pnpm game new <name>` starts one (a room, a hero,
placeholder art), and `pnpm game build games/<name>` turns it into the files an SCI
interpreter opens, `RESOURCE.MAP` and `RESOURCE.000` (and `RESOURCE.SFX` with sound
effects), in `out/games/<name>`:

```sh
pnpm game new night-walk
pnpm game build games/hello
SCI_GAME=out/games/hello pnpm viewer      # then open /play.html
SCI_GAME=out/games/hello pnpm play --frames 60 --png-every 60
```

![games/hello](screenshots/hello.png)

## What's in a game folder

```
games/hello/
  scripts/0.sc       script 0: exports the game object
  scripts/1.sc       more scripts: rooms are numbered like their scripts
  rooms/2.room.yaml  a room as data, with what's said in it in rooms/2.yarn
  flags.yaml         the numbers of the rooms' Yarn variables (the build keeps it)
  messages/1.msg     message files, as text
  music/100.mid      music: sound 100, from a MIDI file
  sounds/50.wav      a sound effect: sound 50, from a WAV file
  hello.sh           definitions the scripts include (here, the nouns)
  resources.ts       optional: pictures, views and anything else made in code
  game.json          optional: { "library": false } to build without the class library
```

**Scripts** are written in SCI's Lisp-like language ([language.md](language.md)), as
`scripts/<n>.sc`, and build on the class library ([library.md](library.md)), which is
compiled with them: scripts 994 to 999 are its. A script can also be hand-written assembly (`scripts/<n>.sca`, described
at the top of `packages/sci/src/script/assembly.ts`), and the two can use each other's
classes. Script 0's first export is the game object, and the interpreter starts the game by
sending it `play`.

**resources.ts** default-exports a function returning resources (`{ type, number, data }`).
It imports what it needs from `tools/game/kit.ts`: the writers for pictures, views, fonts and
palettes, and the base palette's colours. `games/hello/resources.ts` draws a picture and a
view pixel by pixel.

**Editor-authored art** can instead live in `art/art.json` with its PNG exports and palette.
Return `buildArt(manifestPath).resources` from the game’s `resources.ts` to preserve
exact colours, anchors and foreground priorities. `games/sherlock/resources.ts` is an example. See [the graphics workflow](art-workflow.md) for Pixelorama setup and
`pnpm art check` / `pnpm art build`. Keep imported art IDs distinct from other resources returned by
that hook; the build reports duplicates.

**Rooms** can be YAML and Yarn instead of scripts ([rooms.md](rooms.md)).

**Messages** are `messages/<n>.msg`, one file per room (or other module), in the text form
`pnpm msg` prints: a `messages N version V` line, then `noun verb cond seq talker "text"`.

**Music** is `music/<n>.mid`: a Standard MIDI File from any sequencer, played through
General MIDI. Its tempo changes are kept; channel 16 moves to a free channel, since SCI keeps
it for signals to the scripts. Music can also be made in code (`writeSound` in the kit;
`games/hello` composes its tune that way). **Sound effects** are `sounds/<n>.wav` (PCM,
8- or 16-bit, mono or stereo). A Sound object playing number n plays the effect if there is
one, else the music.

**Defaults.** Unless the game makes its own, the build adds:

| resource | what |
|---|---|
| font 0 | a pixel font, 10 pixels a line, ASCII 32 to 126 (`tools/game/font.ts`) |
| palette 999 | the base palette: 16 basic colours, a 6×6×6 colour cube from 16, greys from 232, 254 for transparency, 255 white |
| view 999 | an arrow cursor with its hotspot at the tip |

`cube(r, g, b)` in the kit gives the colour-cube index nearest an RGB colour.

## What the build does

1. Compiles the `.sc` scripts and the class library together, then the YAML rooms, and
   assembles them and any `.sca` scripts. Classes
   come from the scripts themselves; a class name nobody defines is reported with its file
   and line.
2. Numbers selectors as the scripts use them, starting with the nine slots every object
   begins with (`-objID-` to `name`), and writes them to vocab 997.
3. Writes vocab 996, which says which script defines each class (by species number), and
   vocab 990, the globals' names (the player, editor and explorer find the room and the
   hero by them).
4. Adds the message files, `resources.ts`'s resources, the library's and the defaults, and
   refuses any resource made twice.

## Classes the interpreter works with

The interpreter reads properties by name, so a class works with a kernel as long as it has
the properties the kernel reads: a plane needs `priority`, `inLeft`...`inBottom`, `picture`
and `back`; a screen item `x`, `y`, `view`, `loop`, `cel`, `plane`, `bitmap`; a mover the
`b-` properties `DoBresen` keeps its place in. The library's classes have them; a game
without the library has to declare its own.
