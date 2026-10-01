# The class library

Every game built with `pnpm game build` gets sci-ts's class library (`lib/`): the classes a
point-and-click game is made of, written in the [script language](language.md). It knows
nothing about any particular game. `games/hello` uses all of it.

| script | file | what |
|---|---|---|
| 999 | `lib/999.sc` | the core: `Obj`, `Code`, `Collection`, `List`, `Set`, `Script`; the globals and flags |
| 998 | `lib/998.sc` | the world: `Game`, `Plane`, `Room`, `Feature`, `View`, `Prop`, `Actor`, `Ego` |
| 997 | `lib/997.sc` | motion: `Motion`, `MoveTo`, `PolyPath`, `Polygon`, `Scaler`; `Cycle`, `Forward`, `Walk`, `End`, `Beg` |
| 996 | `lib/996.sc` | talk: `TextItem`, `Narrator`, `Talker`, `PortraitTalker`, `Messager`, `Menu`, `Teller` |
| 995 | `lib/995.sc` | input: `Event`, `User` |
| 994 | `lib/994.sc` | `Sound` |

`lib/system.sh` has the constants games share with the library (verbs, event types,
polygon types); include it with `(include "system.sh")`. The library also brings a cursor
for each verb (views 991 to 994, `lib/resources.ts`). A game that wants none of this says so
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

## Verbs and clicks

The player has four verbs: walk (the first), do, look and talk. Right-click goes to the
next one, and the cursor changes with it. A click with walk sends the hero there along a
path around the obstacles (`PolyPath`); with any other verb it goes to the first thing
under the cursor, cast first, then features, then the room.

## Messages

Message files are text in `games/<name>/messages/<n>.msg`:

```
messages 1 version 4321
; noun verb cond seq talker "text"
2 1 0 1 99 "The moon is full tonight."
2 1 0 2 99 "Bright enough to read by."
```

`(messager say: noun verb [cond [seq [caller [module]]]])` says each line in sequence,
waiting for a click or the time it takes to read, then cues the caller. It returns 0 when
there's no such message.

Each line goes to its talker (the message's talker number): 99 the narrator, 98 the game's
`heroTalker`, 200 and up the room's characters (its `findTalker:`). A `Narrator` shows
the line in a box over the room; a `Talker` starts it with their name; a `PortraitTalker`
shows their portrait beside it, the mouth moving while the line is up.

A `Teller` makes talking to something a conversation: a `Menu` of topics, each answered
from the message file, back to the menu until the player says goodbye. Rooms written as
YAML and Yarn get these from their conversation nodes.

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

## Not there yet

An icon bar, inventory, and saving and restoring. See [plan.md](plan.md).
