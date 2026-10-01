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

**Art from a paint program** can live in `art/art.json` with its PNG exports and palette:
`resources.ts` returns `buildArt(manifest).resources`, keeping exact colours, anchors and
foreground layers ([art.md](art.md)). The build reports a resource number used twice.

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

## A game in its own repository

A game doesn't have to live in this repository: sci-ts is a package on npm, `sci2-ts`, and
its `sci-ts` command does what `pnpm game` does here. The Sherlock Holmes teaser is set up this way.

```json
{
  "devDependencies": { "sci2-ts": "^0.2.1" },
  "scripts": { "build": "sci-ts build", "play": "sci-ts play", "edit": "sci-ts edit" }
}
```

```sh
sci-ts new my-game        # in an empty folder, or anywhere
sci-ts build              # out/game: RESOURCE.MAP, RESOURCE.000, RESOURCE.SFX
sci-ts play               # build, then sci-ts's player for it
sci-ts edit               # build, then the live editor for its rooms and scripts
sci-ts site               # the game's README and docs, and the game, as a static site
sci-ts art check art/art.json
```

Code in the game imports what it needs from the package:

| import | |
|---|---|
| `sci2-ts` | the engine: resources, the VM and its kernels, graphics, sound, writers |
| `sci2-ts/kit` | for `resources.ts`: writers, the base palette's colours, the pixel font |
| `sci2-ts/build` | `buildGame`, for scripts that build and run the game (tests, previews) |
| `sci2-ts/art` | `buildArt`, for art from a paint program ([art.md](art.md)) |
| `sci2-ts/png` | reading and writing PNGs |
| `sci2-ts/viewer` | `GameSession`, to put the game in a page of your own |
| `sci2-ts/vite` | `sciGame`, a Vite plugin serving the built game to such a page |

The class library, the default font, palette and cursors, and the room compiler come with
the build: nothing to import. A game's own page uses the plugin:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { sciGame } from "sci2-ts/vite";
export default defineConfig({ plugins: [sciGame({ game: "out/game" })] });
```

```ts
// src/main.ts
import { GameSession } from "sci2-ts/viewer";
const session = await GameSession.create({ canvas: document.querySelector("canvas")! });
session.start();
```

The package is compiled JavaScript with type declarations; the `sci-ts` command runs
through `tsx`, so a game's own TypeScript (`resources.ts`) needs no build step. The player
ships as source, for Vite. To work on sci-ts and a game together, depend on a checkout
instead: `"sci2-ts": "link:../sci-ts"`.

