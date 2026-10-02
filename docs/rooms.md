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
| `perspective` | the picture's camera: `{ horizon: 72, fullSize: 176 }` sizes people by where they stand (below) |
| `hero.scale` | sizes the hero alone, between two lines: `front`% at y `frontY`, `back`% at y `backY` |
| `walkable` | the floor: a polygon the hero stays inside |
| `obstacles` | polygons he walks around |
| `features` | rectangles of the picture that answer clicks |
| `exits` | features that leave: *do* on one walks to `walkTo` and goes to room `to` |
| `props` | views on the picture; `cycle: forward` animates them; `moves: true` makes one that cutscenes can walk; `script: Scurry` runs a Script class of the game's on it (a mouse's comings and goings); `scale: true` sizes a still one by the room's perspective; under `properties`, `clickable: 0` makes one clicks pass through (rain on a window) |
| `characters` | who speaks in this room's Yarn besides the narrator and the hero; `portrait` is a view (loop 0 the bust, 1 the mouth, 2 the eyes, 3 to 5 the same facing left; all cels the same size and anchored at the top left), shown at the top of the screen on the side of the hero where the prop of the same name stands ([library.md](library.md)) |

Rooms written this way and rooms written as scripts can be next to each other in one
game: the hero walks between them the same way.

### Perspective

With a camera held level, someone's height on screen is in proportion to how far below the
horizon their feet are: twice as far below it, twice as tall. So two numbers size everyone
in a room: `horizon`, the y the floor's receding lines meet at, and `fullSize`, the y of a
figure's feet where its view is drawn at full size.

```yaml
perspective: { horizon: 72, fullSize: 176 }
```

Halfway from `fullSize` up to the horizon (y 124) a figure is drawn at half size; below
`fullSize` it's drawn bigger than its view. The hero and props with `moves: true` are sized as
they walk. A still prop is left as drawn (someone sitting in a chair is usually painted at
the chair's depth already) unless it has `scale: true`, which sizes it once for where it
stands; `scale: false` keeps a moving prop as drawn (a bird in the air isn't on the floor).
A room without `perspective` or `hero.scale` draws the hero at full size.

A picture painted at an angle often doesn't keep to one horizon: the same height on the
screen can be nearer the camera on one side of the room than the other, and one line can't
size people right on both. Measure instead: stand the hero at the back and front of the
floor at up to three places across it, find the size that fits what's painted around him
(a door, a chair, a mantelpiece), and give those.

```yaml
perspective:
  columns:              # x, then [y, percent] at the back and the front of the floor
    - { x: 100, back: [152, 62], front: [190, 96] }
    - { x: 190, back: [148, 82], front: [190, 104] }
    - { x: 290, back: [150, 92], front: [190, 112] }
```

At each place, size changes in a straight line from back to front (beyond them too); between
places, in a straight line across. With two places the middle is halfway between them; with
one, everyone is sized the same across the room.

Someone drawn smaller is farther off, so they walk slower in proportion, and their walk
cycle slows with them: at 50% they cover half the ground in the same time, legs and all,
instead of sliding. Their size changes in steps of at least 2% (the scaler's `step`),
because a pixel-art figure redrawn at a new size for every line it moves shimmers.

A room with a lot of depth makes for a lot of scaling, and pixel art shows it. Rooms are
easiest to scale when they face the camera, with the floor going back up the screen, so
that walking across the room doesn't change anyone's size, and when people stay between
about 75% and 110%.

## What's said: Yarn

[Yarn](https://docs.yarnspinner.dev) nodes named `<thing>.<verb>` are what happens when the
player uses a verb on a thing: `sign.look`, `traveller.talk`, `room.look`. The verbs are
look, talk, walk and do; `room.enter` runs when the hero arrives. Using something the hero
carries is a verb too, named in the game's `items.yaml`: `filings.lens` is the lens used on
the filings ([library.md](library.md)).

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

Lines can be **bold** and *italic* with Yarn's markup, `[b]`...`[/b]` and `[i]`...`[/i]`
(nested for both), in the game's fonts for them, named in `game.json`:

```
I am in my armchair, with yesterday's [i]Standard[/i], read twice over.
```

```json
{ "fonts": { "bold": 3, "italic": 4, "boldItalic": 5 } }
```

What's said and what recordings are filed under is the text without it. `\[` is a bracket.

Commands for cutscenes; those that take time finish before the next line:

| command | |
|---|---|
| `<<walk hero x y>>`, `<<walk crow x y>>` | walk there (a prop needs `moves: true`) |
| `<<face hero left>>`, `<<face hero sign>>`, `<<face hero x y>>` | turn: up, down, left, right (and between), toward a thing, or toward a point |
| `<<wait 1.5>>` | seconds |
| `<<hide crow>>` `<<show crow>>` | |
| `<<loop crow 2>>` `<<cel crow 0>>` | |
| `<<view hero 204>>` `<<normal hero>>` | another view (a pose: a reach, a kneel), and back to walking |
| `<<animate crow once>>` `<<animate crow forever>>` `<<stop crow>>` | |
| `<<music 120>>` `<<music stop>>` `<<sound 40>>` `<<sound 40 wait>>` | |
| `<<closeup 240>>` `<<closeup 240 0 1>>` | a close look: view 240 (loop, cel) over the dimmed room, until a click |
| `<<get lens>>` `<<drop lens>>` | give the hero an item `items.yaml` describes, or take it |
| `<<room 3>>` | go to another room |

The player can't click while a node with commands runs (but can dismiss text).

Errors name the file and the line: `rooms/2.yarn:16: unknown speaker "The sign says"`.

## Spoken lines

A line can have a recording. Each line that's said gets an id with a `#line:` tag, which
stays with the line when lines or things are added around it:

```
Traveller: I left it burning for whoever came next. #line:2-004
```

`sci-ts lines tag` gives every line without one an id (`<room>-001` on), and leaves the rest
of the file alone. The build refuses an id used twice in the game.

The recording for a line is `voices/<id>.wav`: any rate, mono or stereo. The build makes it
mono at 11,025 Hz, trims the silence before and after it, brings it to the same level as the
others, and writes it to RESOURCE.AUD, with a map per room for the interpreter to find it by.

`voices/lines.json` is the script: every line with an id, who says it, what's said just
before it, and whether it's recorded. The build keeps it up to date, and it remembers which
text each recording was made for: when a line changes after it was recorded, the build says
so until it's recorded again. `sci-ts lines script` writes it and says, for each speaker,
what's recorded and what's left.

In the game, a line with a recording is heard and stays up until the recording ends; a
click stops it. Lines without one are timed as text, so a game can be recorded a bit at a
time. The game menu gets a setting for speech: voice and text, voice only, or text only. The
player fetches each recording when it's said, not the whole of RESOURCE.AUD.

## Editing live

With the game being served (`SCI_GAME=out/games/<name> pnpm viewer`), `/editor.html`
shows a room's YAML and Yarn next to the running game. Saving (or a pause in typing)
rebuilds the game and walks into the room again with the change: only what changed is
swapped into the running game. Outlines show the features, exits, props, floor and paths
by their names, and in Move mode you can drag things into place or paint the floor.
