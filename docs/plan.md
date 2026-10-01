# Plan: games of our own

sci-ts plays SCI2 games, and its content compiler writes rooms for them. But every SCI game
brings its own *class library*: the bytecode for rooms, actors, walking, dialogs, talkers,
input and the main loop. Rooms compiled today subclass a game's classes. To make games that
need no Sierra game at all, sci-ts needs its own library, written in a language that compiles
to SCI bytecode, and the few resources an interpreter expects every game to have.

The first game is a short Sherlock Holmes story, in its own repository,
sci-sherlock (not public yet): small enough to finish, and it
uses everything (talking, topics, flags, cutscenes, sound).

## What a game is, to the engine

- **Resources** in a resource map and volume, or as loose patch files: scripts and heaps,
  pictures, views, palettes, fonts, messages, sounds, cursors.
- **Vocab 997**: selector names, in the order their numbers are assigned. **Vocab 996**: the
  class table, each class's species number to the script that defines it.
- **Script 0**, export 0: the game object. The interpreter sends it `play`.
- **Palette 999**: the base palette. A font, and a cursor view.

All of these are ours to write: the engine never needed Sierra's, it only read them.

## Milestones

### 0. The open-source repo (done)
Exported from the private research repo by an allowlist; a check refuses any file that
contains Sierra's text or looks like a game resource. MIT.

### 1. Building a game from nothing (done)
- Resource map and volume writers.
- Vocab 997/996 writers: selectors and classes numbered by the build.
- A font of our own (a pixel font drawn in code), a palette, a cursor.
- `pnpm game build games/<name>` puts it together; the viewer opens it like any game.

The first game, `games/hello`, is a night sky with a lantern that goes where you click.
See [games.md](games.md).

### 2. A script compiler (done)
Sierra's games were written in a Lisp-like language that maps one to one onto the bytecode:

```lisp
(class Lantern of Prop
  (properties lit 0)
  (method (doVerb theVerb)
    (if (== theVerb V_DO)
      (= lit (not lit))
      (self setCel: lit)
    else
      (super doVerb: theVerb &rest)
    )
  )
)
```

The compiler parses it and emits the assembly the assembler already builds byte for byte:
sends, properties, locals and globals, `&rest`, `switch`/`cond`, procedures, exports, strings.
Every line of the library is ours. The language as implemented: [language.md](language.md);
`games/hello` is written in it, and the compiler's tests run what it compiles.

### 3. The class library (done)
The smallest set a point-and-click game needs, written in that language
([library.md](library.md)):

| | |
|---|---|
| core | Obj, Code, Collection/List/Set, Script (with cycles, ticks and seconds) |
| world | Game (the main loop), Plane, Room (exits, obstacles), Feature, View/Prop/Actor/Ego |
| motion | Motion, MoveTo, PolyPath, Polygon; cycles (Forward, Walk, End, Beg) |
| talk | Messager, Narrator, text boxes |
| input | User, Event, verbs (walk, do, look, talk) with their cursors |
| sound | Sound (music and effects) |

`games/hello` is built on it: two rooms, a hero who walks around obstacles and from one
room to the other, and things that answer when looked at or used. Its test plays it.

Since then: talkers with portraits and topic menus (milestone 4), a text style with
frames, cursors a game can replace, an inventory and close-ups, saving and restoring. Not
yet: an icon bar.

### 4. The content compiler targets it (done)
A target for the library (`tools/game/target.ts`), so rooms written as YAML and Yarn
([rooms.md](rooms.md)) build against it: features, exits, props, walkable areas, characters
with portraits, conversations as topic menus, flags and conditions, cutscene commands and
music. The library gained what they need (talkers, portraits, menus, tellers, flags, a
scaler, hands off and on). `games/hello`'s road is such a room, with a traveller to talk to.

The player's room links and the live editor work with these games: a game names its
globals in a vocab, and the editor edits the served game's rooms, swapping in what each
build changes.

### 5. The Sherlock Holmes teaser
In its own repository, sci-sherlock (not public yet), using sci-ts
as a package ([games.md](games.md)): pixel art from a paint program ([art.md](art.md)),
rooms in YAML and Yarn, music and effects. Its plan, art direction and art workflow are
there. A headless playthrough test plays it start to end.

### 6. Publishing (started)
CI runs the typecheck and the tests (hello's playthrough among them) and builds every game.
`pnpm game site` builds a static site: the docs as pages and a game in the player, for any
web server; `.github/workflows/pages.yml` publishes it to GitHub Pages when run by hand.
Still to do: the teaser in it, and a link from the README once the repository is public.

## Ground rules

- Nothing Sierra made goes into this repository: no files, no script listings, no text, no
  art. Behaviour learned from running a game is written down in our own words and code.
- The engine stays game-agnostic; what's particular to a game lives in its target.
- Every milestone ends with something you can run.
