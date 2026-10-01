# Plan: games of our own

sci-ts plays SCI2 games, and its content compiler writes rooms for them. But every SCI game
brings its own *class library*: the bytecode for rooms, actors, walking, dialogs, talkers,
input and the main loop. Rooms compiled today subclass a game's classes. To make games that
need no Sierra game at all, sci-ts needs its own library, written in a language that compiles
to SCI bytecode, and the few resources an interpreter expects every game to have.

The first game is a short Sherlock Holmes story, [docs/sherlock-teaser.md](sherlock-teaser.md):
small enough to finish, and it uses everything (talking, topics, flags, cutscenes, sound).

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

### 3. The class library
The smallest set a point-and-click game needs, written in that language:

| | |
|---|---|
| core | Obj, Collection/List/Set, Code, Script, Timer |
| world | Game (the main loop), Room, Region, Feature, View/Prop/Actor/Ego |
| motion | Motion, MoveTo, PolyPath, Polygon; cycles (Forward, End, Walk) |
| talk | Messager, Narrator, Talker (portraits), Print and Dialog windows |
| input | User, Event, cursors and verbs (look, use, talk, walk), an icon bar |
| sound | Sound (music and effects) |
| later | inventory, Save/Restore, menus |

Milestone done when a room compiled from YAML shows, the hero walks around it, and clicking a
feature says its line.

### 4. The content compiler targets it
A `sci-ts` target next to the existing one (room class, globals, verbs, talkers), so YAML and
Yarn rooms build against the library; characters, topic menus, flags and cutscenes map onto
its classes. The editor and player start a game at its first room instead of a game-specific
route to a hero.

### 5. The Sherlock Holmes teaser
Art drawn by scripts (backgrounds, Holmes and the cast, portraits), rooms in YAML and Yarn,
music and effects. A headless playthrough test plays it start to end: the test fixture CI can
run, since it needs no one's game files.

### 6. Publishing
CI (typecheck, tests, the playthrough), the docs as a site, the teaser playable in the
browser from the README.

## Ground rules

- Nothing Sierra made goes into this repository: no files, no script listings, no text, no
  art. Behaviour learned from running a game is written down in our own words and code.
- The engine stays game-agnostic; what's particular to a game lives in its target.
- Every milestone ends with something you can run.
