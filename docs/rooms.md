# Rooms as YAML and Yarn

A room can be written as data instead of a script: `rooms/<n>.room.yaml` says what's in it,
`rooms/<n>.yarn` what's said and done there. `pnpm game build` compiles both for the class
library ([library.md](library.md)) into the same kind of script and message file a
hand-written room would be (`packages/content`, with the target in `tools/game/target.ts`).
`games/hello/rooms/2.room.yaml` is one.

```yaml
# yaml-language-server: $schema=../../../packages/content/room.schema.json
room: 2
picture: 101
music: 120                     # looped here; left alone if it's already playing
hero:
  at: [10, 175]                # where the hero appears
  enterTo: [40, 175]           # and walks to (the player waits until he's there)
  scale: { front: 100, back: 70, frontY: 186, backY: 122 }
walkable: [[0, 158], [300, 158], [300, 189], [0, 189]]
obstacles: [[[120, 160], [150, 160], [150, 170], [120, 170]]]
features:
  sign: { rect: [236, 128, 262, 160] }
exits:
  gate: { rect: [300, 150, 319, 189], walkTo: [310, 175], to: 3 }
props:
  traveller: { view: 300, at: [180, 172] }
  crow: { view: 310, at: [90, 60], cycle: forward, moves: true }
characters:
  traveller: { name: Traveller, portrait: 301 }
properties:
  room: { west: 1 }            # any property of any object here, by its name
```

| key | |
|---|---|
| `walkable` | the floor: a polygon the hero stays inside |
| `obstacles` | polygons he walks around |
| `features` | rectangles of the picture that answer clicks |
| `exits` | features that leave: *do* on one walks to `walkTo` and goes to room `to` |
| `props` | views on the picture; `cycle: forward` animates them; `moves: true` makes one that cutscenes can walk |
| `characters` | who speaks in this room's Yarn besides the narrator and the hero; `portrait` is a view (loop 0 the bust, 1 the mouth, 2 the eyes, all cels the same size and anchored at the top left), shown at the top left of the screen |

Rooms written this way and rooms written as scripts can be next to each other in one
game: the hero walks between them the same way.

## What's said: Yarn

[Yarn](https://docs.yarnspinner.dev) nodes named `<thing>.<verb>` are what happens when the
player uses a verb on a thing: `sign.look`, `traveller.talk`, `room.look`. The verbs are
look, talk, walk and do; `room.enter` runs when the hero arrives.

```
title: sign.look
---
The sign reads TOWN, 2 MILES.
===

title: traveller.talk
---
-> Where are you going?
    Traveller: To the town, same as everyone.
-> Was that your lantern on the hill?
    Traveller: I left it burning for whoever came next.
    Hero: That's kind of you.
    <<set $askedLantern to true>>
-> What's at the fair? <<if $askedLantern>>
    Traveller: Lanterns, mostly.
===
```

- A line is said by the narrator, or by whoever it names: `Traveller: ...`, `Hero: ...`
  (the game's `heroTalker`). A colon after the first words always names a speaker, so
  narration avoids one.
- A node of `->` choices is a conversation: a menu of topics, each answered by the lines
  under it, back to the menu until the player says goodbye. `<<if ...>>` after a choice
  offers it only when the condition holds.
- `$name` variables are flags, kept for the whole game: `<<set $x to true>>`,
  `<<if $x and not $y>> ... <<else>> ... <<endif>>`. The build numbers them in the game's
  `flags.yaml`; keep the numbers once people have saved games.

Commands for cutscenes; those that take time finish before the next line:

| command | |
|---|---|
| `<<walk hero x y>>`, `<<walk crow x y>>` | walk there (a prop needs `moves: true`) |
| `<<face hero left>>`, `<<face hero sign>>`, `<<face hero x y>>` | turn: up, down, left, right (and between), toward a thing, or toward a point |
| `<<wait 1.5>>` | seconds |
| `<<hide crow>>` `<<show crow>>` | |
| `<<loop crow 2>>` `<<cel crow 0>>` | |
| `<<animate crow once>>` `<<animate crow forever>>` `<<stop crow>>` | |
| `<<music 120>>` `<<music stop>>` `<<sound 40>>` `<<sound 40 wait>>` | |
| `<<room 3>>` | go to another room |

The player can't click while a node with commands runs (but can dismiss text).

Errors name the file and the line: `rooms/2.yarn:16: unknown speaker "The sign says"`.

## Editing live

With the game being served (`SCI_GAME=out/games/<name> pnpm viewer`), `/editor.html`
shows a room's YAML and Yarn next to the running game. Saving (or a pause in typing)
rebuilds the game and walks into the room again with the change: only what changed is
swapped into the running game. Outlines show the features, exits, props, floor and paths
by their names, and in Move mode you can drag things into place or paint the floor.
