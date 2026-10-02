# The class library

Every game built with `pnpm game build` gets sci-ts's class library (`lib/`): the classes a
point-and-click game is made of, written in the [script language](language.md). It knows
nothing about any particular game. `games/hello` uses all of it.

| script | file | what |
|---|---|---|
| 999 | `lib/999.sc` | the core: `Obj`, `Code`, `Collection`, `List`, `Set`, `Script`; the globals and flags |
| 998 | `lib/998.sc` | the world: `Game`, `Plane`, `Room`, `Feature`, `View`, `Prop`, `Actor`, `Ego` |
| 997 | `lib/997.sc` | motion: `Motion`, `MoveTo`, `PolyPath`, `Polygon`, `Scaler`, `FloorScaler`; `Cycle`, `Forward`, `Walk`, `End`, `Beg`, `Blink` |
| 996 | `lib/996.sc` | talk: `TextStyle`, `TextItem`, `Narrator`, `Talker`, `PortraitTalker`, `Messager`, `Menu`, `Teller` |
| 995 | `lib/995.sc` | input: `Event`, `User` |
| 994 | `lib/994.sc` | `Sound` |
| 993 | `lib/993.sc` | things: `InvItem`, `Inventory`, `CloseUp` |
| 992 | `lib/992.sc` | the game menu: `SaveRestore`, `EditField` |
| 991 | `lib/991.sc` | the icon bar: `IconBar`, `Icon` |

`lib/system.sh` has the constants games share with the library (verbs, event types,
polygon types); include it with `(include "system.sh")`. The library also brings a cursor
for each verb (views 991 to 994), one for waiting (995), the shade behind close-ups (996)
and the icon bar's icons (990), in `lib/resources.ts`. A game that wants none of this says so
in `game.json`: `{ "library": false }`.

## A game

Script 0 exports the game object. The game sets up, names the hero, and goes to its first
room:

```lisp
(script 0)
(include "system.sh")
(public hello 0)

(class Hello of Game
  (method (init)
    (super init:)
    (= ego hero)
    (self newRoom: 1)))

(instance hello of Hello)
(instance hero of Ego (properties view 200 xStep 2 yStep 1))
```

`Game::play` calls `init`, then `doit` until `quit` is set. Each cycle (`doit`) runs, in
order: the game's script, the sounds, the room (its script, and whether the hero has walked
off an edge), everything in the cast (movers, cyclers, scripts), the narrator, `FrameOut`,
and the player's input. A room change asked for during the cycle happens at its end.

## A room

A room is export 0 of its script. Its number is its script's number, and its message file
has the same number. A room can also be written as YAML and Yarn ([rooms.md](rooms.md)).
The game calls `setUp` (which makes the room's plane and obstacle list), then `init`.

```lisp
(script 1)
(include "system.sh")
(include "hello.sh")              ; the game's nouns
(public hill 0)

(instance hill of Room
  (properties picture 100 noun N_HILL east 2)
  (method (init)
    (super init:)
    (self addObstacle: ((Polygon new:) type: PT_CONTAINED init: 0 158 319 158 319 189 0 189))
    (moon init:)
    (ego posn: (if (== prevRoomNum 2) 310 else 40) 175 init: setCycle: Walk)))

(instance moon of Feature
  (properties noun N_MOON nsLeft 250 nsTop 20 nsRight 270 nsBottom 40))
```

**Exits**: `north`, `south`, `east`, `west` are room numbers; the hero going past `edgeN`,
`edgeS`, `edgeE` or `edgeW` takes him there. `prevRoomNum` says where he came from.

**Walking**: `addObstacle:` takes `Polygon`s. A `PT_CONTAINED` polygon is the floor;
`PT_BARRED` ones are things in the way. A click outside the floor walks to its nearest edge.

**Leaving**: when the room goes, so does everything in it (features, views, props), except
the hero, who is added to the next room by its `init`.

## Things in a room

| class | is | add |
|---|---|---|
| `Feature` | a rectangle of the picture (`nsLeft`...`nsBottom`) that answers clicks | `noun`, `modNum` |
| `View` | a Feature drawn with a view's cel | `view`, `loop`, `cel`, `x`, `y`, `priority` |
| `Prop` | a View that animates and runs scripts | `setCycle:`, `setScript:`, `cycleSpeed` |
| `Actor` | a Prop that walks | `setMotion:`, `setHeading:`, `setScaler:`, `moveSpeed`, `xStep`, `yStep` |
| `Ego` | the Actor the player walks | `normalize` (back to walking) |

Views also take `hide`, `show`, `setLoop:` (a loop that stays when it turns; -1 to follow
the heading again), `setCel:` and `setPri:` (a fixed priority; -1 to sort by y again).

`(thing doVerb: verb)` says the line for its `noun` and the verb in the room's message file
(the room answers if there isn't one).

## The hero at rest

Standing still while the player can act, the hero plays an idle now and then: after
`idleAfter` seconds (8 unless set), one loop of `idleView`, chosen at random, once through,
then he stands again. Walking, a line, a menu or a cutscene stops one at once. Without an
`idleView` there are none:

```lisp
(instance holmes of Ego (properties view 200 idleView 206 idleAfter 10))
```

`normalize` puts him back to walking: his walking view (the one he was first normalized
with), cycling as he moves and turning as he goes. In Yarn, `<<view hero 204>>` switches to
a pose and `<<normal hero>>` back.

## Actors in each other's way

Actors walk through one another: `ignoreActors` is 1 unless a game sets it to 0. The
interpreter measures an actor's footprint by its whole cel, and characters are often drawn
on canvases much wider than they are, so blocking would stop them while still far apart,
and a cutscene waiting for one to arrive would wait for ever. Obstacles and the walkable
floor still apply. For the same reason an actor is clicked only where it's drawn
(`checkPixels`, 1 for actors), so a click just beside the hero reaches what's behind him;
any View can set it.

## Verbs and clicks

The player has four verbs: walk (the first), do, look and talk. Right-click goes to the
next one, and the cursor changes with it. A click with walk sends the hero there along a
path around the obstacles (`PolyPath`); with any other verb it goes to the first thing
under the cursor, cast first, then features, then the room.

Each verb has its cursor, and there's one more for while the player can't act (between
`handsOff` and `handsOn`). They're `User` properties holding view numbers, so a game with its
own sets them in its `init`:

```lisp
(user walkCursor: 261 lookCursor: 262 doCursor: 263 talkCursor: 264 waitCursor: 265)
```

A cursor's hotspot is its cel's anchor. Any it leaves alone stay the library's.

Without a right button (on a touch screen, or a trackpad), the icon bar does the same: it
slides down when the pointer reaches the top edge of the screen, or on a tap there, with
an icon for each verb, the item in use, the inventory and the game menu. The picked verb's
icon is shown picked; choosing an icon, or a click or the pointer well below the bar,
closes it. Its icons are a view, `iconBar`'s `view`: loop 0 as they are and loop 1 picked,
six cels 24 pixels square anchored at their top-left corner, in the order walk, look, do,
talk, inventory, menu (the item in use shows its own icon). The library's are plain black
and white (view 990); a game with its own sets `(iconBar view: 266)` in its `init`.

It slides down from above the screen as it opens, easing to a stop, and back up when it
closes; `(iconBar slides: FALSE)` makes it appear and go at once. A painted bar is a `skin`: a view drawn across the top of the screen (loop 0, cel 0,
anchored at its top left) instead of the box. Its icons can be any `size`, at `left`,
`left + spacing` and on, at `top`; the item in use takes the fifth place, between the verbs
and the inventory.

```lisp
(iconBar view: 266 skin: 267 size: 32 left: 16 spacing: 42 top: 8)
```

## Messages

Message files are text in `games/<name>/messages/<n>.msg`:

```
messages 1 version 4321
; noun verb cond seq talker "text"
2 1 0 1 99 "The moon is full tonight."
2 1 0 2 99 "Bright enough to read by."
```

`(messager say: noun verb [cond [seq [caller [module]]]])` says each line in sequence,
waiting for a click (or Enter, Space or ".") or the time it takes to read, then cues the
caller. How long that is, the player chooses in the game menu: normal, slow, fast, or until
they dismiss it (the `textSpeed` global, kept in saved games). It returns 0 when
there's no such message.

A line with a recording (`voices/`, [rooms.md](rooms.md#spoken-lines)) is heard as well, and
stays until the recording ends and a moment more; a click stops it. The `speech` global
(SPEECH_BOTH, SPEECH_TEXT, SPEECH_VOICE), set in the game menu when the game has
recordings, says whether lines are heard, read, or both; with voice only, a heard line
draws no box.

Each line goes to its talker (the message's talker number): 99 the narrator, 98 the game's
`heroTalker`, 200 and up the room's characters (its `findTalker:`). A `Narrator` shows
the line in a box over the room; a `Talker` starts it with their name; a `PortraitTalker`
shows their portrait at the top of the screen and the line beside it.

A portrait is a view whose loop 0 is the bust, loop 1 the mouth alone (cel 0 closed, then
the open shapes) and loop 2 the eyes alone (cel 0 open, then the blink), every cel the same
size and anchored at its top-left corner. Loops 3 to 5, if the view has them, are the same
facing left. While a line is said the mouth moves (while it's heard, for a recorded line;
otherwise about as long as saying it takes), then closes; the eyes blink every few seconds
(`Blink`).

The portrait goes at the top left facing right, or the top right facing left, with the line
beside it on the side towards the middle. A character takes the side of the hero they
stand on: a room character's talker is told which prop in the room has its name (`who:`),
and one with no prop takes the right. The hero takes the side opposite whoever spoke last,
so a conversation's two portraits face each other. A portrait doesn't cover a face: if on
its side it would be over the speaker's or the hero's head, it goes on the other side. In a
room where people's heads are near the top of the screen, portraits at the bottom keep clear
of them altogether. The hero can have a portrait too: a
`PortraitTalker` with a `view` makes its own parts.

```lisp
(instance holmesVoice of PortraitTalker
  (properties name "Holmes" view 213))
```

`textStyle` places portraits and can frame them:

| property | | default |
|---|---|---|
| `portraitX`, `portraitY` | where the face goes on the left; on the right, the same distance from the right edge. A negative `portraitY` puts it at the bottom of the screen, the face's bottom that far above it, with the text box ending level with the frame and growing upwards | 8, 8 |
| `portraitFrame` | a view drawn behind every face (loop 0) and, if it has a loop 1, over its edges; anchor its cels so they sit around a face drawn at the same place | -1 |

A `Teller` makes talking to something a conversation: a `Menu` of topics, each answered
from the message file, back to the menu until the player says goodbye. Rooms written as
YAML and Yarn get these from their conversation nodes.

## How text looks

Every text box and menu takes its look from `textStyle`, a `TextStyle` the game
makes at the start. A game sets it once, in its `init` after `(super init:)`:

```lisp
(textStyle font: 1 fore: 3 back: 12 border: 5)   ; ink, paper and a one-pixel border
(textStyle frame: 260)                           ; or a frame drawn around each box
```

| property | | default |
|---|---|---|
| `font` | the font | 0, sci-ts's own |
| `fore` | the ink colour | 0 |
| `back` | the paper colour | 255 |
| `border` | a one-pixel border's colour; -1 for none | 0 |
| `frame` | a frame view, drawn instead of the border; -1 for none | -1 |
| `margin` | pixels between the text and the border or frame | 4 |

A frame view has eight cels in loop 0, each anchored at its top-left corner: the four
corners (top-left, top-right, bottom-left, bottom-right), then the four edges (top, bottom,
left, right). Each edge is repeated along its side between the corners; transparent pixels
show the paper. A box can still set its own `font`, `fore`, `back` or `frame`.

A menu (a conversation's topics, the game menu, the list of saves) is one box with the
choices inside it, one under another, so a frame goes round the menu rather than each
choice.

Text can change font and colour part-way, with SCI's codes: `|f3|` switches to font 3 and
`|f|` back to the box's own, `|c5|` and `|c|` the same for the colour. The codes take no
room, and a word whose style changes is still one word when the text is wrapped. Rooms
write them with Yarn markup ([rooms.md](rooms.md#whats-said-yarn)). `textStyle`'s
`nameFont` puts a speaker's name in its own font, `(textStyle nameFont: 3)` for a bold one.
A font's glyphs can start left of the pen or reach past it (an italic's tail): the ink goes
into the box's margin, and the pen, wrapping and alignment go by each glyph's advance.

Where a line's box goes is the talker's `x`, `y` and `width`. A negative `y` puts it that
far above the bottom of the screen: the box ends there whatever the line's length, and a
longer line grows it upwards. `(narrator y: -4 width: 294)` keeps every line at the foot of
the screen. Any `TextItem` can do the same with `bottom:`.

## Things the hero carries

An `InvItem` is something the hero can carry: a view and a verb of its own, 10 and up.

```lisp
(instance lens of InvItem
  (properties view 250 verb 10 description "A brass magnifying lens."))
```

Loop 0 of its view is its icon in the inventory window (24 by 24) and loop 1 the cursor
while it's in use (its anchor is the hotspot), both anchored at the top-left corner.
`inventory` holds what the hero has: `(inventory add: lens)`, `(inventory delete: lens)`,
`(inventory contains: lens)`.

The player opens the inventory with I or Tab, or a script does with `(inventory showSelf:)`:
the icons in a box at the top of the screen, in the text style. A painted case is a `skin`:
the view at `x`, `y`, with the items in a grid of slots on it, `cols` across, the first at
`slotLeft`, `slotTop` in the skin and the rest `slotWidth` and `slotHeight` on, each icon
`inset` into its slot and `iconSize` square:

```lisp
(inventory skin: 268 x: 32 y: 30 cols: 4 slotLeft: 13 slotTop: 28
  slotWidth: 60 slotHeight: 47 inset: 7 iconSize: 32)
```

 A right-click on one says its
`description`; a click picks it, and it becomes the cursor. Clicking something with it sends
that thing `doVerb:` with the item's verb, so the room's messages for that noun and verb
answer. In Yarn that's a node named for the item, `filings.lens`; the game lists its items in
`items.yaml`. With a view, the build makes the item itself (in script 989), and a room gives
it with `<<get lens>>` and takes it back with `<<drop lens>>`:

```yaml
lens: { verb: 10, view: 250, description: "A brass magnifying lens." }
```

A game whose scripts make the item (like the `lens` instance above) gives just the verb,
`lens: 10`, and adds it with `(inventory add: lens)`.

An item that magnifies, a lens, has `magnify` (how much bigger, 2 to 8) and its glass as
loop 2 of its view, placed like the cursor: while it's in use, the room shows through the
glass that many times larger, centred on the hotspot. `items.yaml` takes it too:
`lens: { verb: 10, view: 250, magnify: 2 }`. Under it is `(AddMagnify view loop cel zoom)`
and `(DeleteMagnify)`, which a script can use for a magnifier of its own.

The item stays picked until right-click, which goes on to walking (from talk, right-click
goes to the item first). `theItem` is the item picked, or 0.

## Close-ups

`((CloseUp new:) show: view [loop [cel [caller]]])` shows a cel in the middle of the screen
with the room dimmed behind it, until the player clicks; then the caller is cued, so a
Script can wait for it. The cel is anchored at its top-left corner. The dimming draws the
library's view 996 in colour 253, which the art palette keeps free, made a remap colour at
`dim` percent brightness (50 unless set).

## Saving and restoring

Escape opens the game menu: save the game, restore a game, start again, the text speed,
speech (in a game with recorded lines), carry on. F5 goes
straight to saving and F7 to restoring; a script can do the same with `(game showMenu:)`,
`(game save:)` and `(game restore:)`. None of them work during a cutscene (between
`handsOff` and `handsOn`).

Saving offers a new save or any of the newest eight to replace, then asks for a
description: the old one, or the room's number to start from. The interpreter saves a
snapshot of the whole game. Restoring starts the game again where the snapshot left it, at
`Game::replay` instead of `play`: memory is as it was, but nothing is on screen and nothing
is playing, so `replay` puts the planes and the cast back (each View's `replay:`) and starts
sounds that loop forever (each Sound's `replay:`). A game that keeps its own planes or
screen items outside the cast puts them back in its own `replay`.

A save only fits the scripts it was made with. Each save records which those were, and a
game is only offered the saves its scripts made: after a rebuild that changes a script,
older saves don't appear. In the browser, saves live in IndexedDB, each game's apart.

## Flags

`(SetFlag n)`, `(ClearFlag n)` and `(IsFlag n)` (script 999's exports) keep 1024 story
flags. Yarn's `$variables` are flags; the build numbers them.

## Cutscenes

`(game handsOff:)` stops clicks doing anything but dismissing text, until
`(game handsOn:)`. Movers, cyclers, `setHeading:` and the messager cue a caller when they
finish, so a Script can wait for each.

## Scripts

A `Script` is a sequence of states: `changeState:` runs one, `cue:` goes to the next.
A state can wait by setting `cycles`, `ticks` (sixtieths of a second) or `seconds`, after
which the script cues itself. Movers and cyclers given a script as their `caller` cue it
when they finish, and so does the messager.

```lisp
(instance walkIn of Script
  (method (changeState newState)
    (= state newState)
    (switch state
      (0 (ego setMotion: PolyPath 160 175 self))
      (1 (messager say: N_MOON V_LOOK 0 1 self))
      (2 (self dispose:)))))
```

## Sound

`music` and `sfx` are Sounds the game makes: `(music number: 100 setLoop: -1 play:)`
loops sound 100, `(sfx number: 50 play: self)` plays 50 once and cues the caller when it
ends. Their numbers are the game's `music/` and `sounds/` files ([games.md](games.md)).

## What's next

See [plan.md](plan.md) for what's next.
