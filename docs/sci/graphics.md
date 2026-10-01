# Graphics

SCI2 draws with **planes** and **screen items**. A plane is a rectangle with a priority, an
optional picture and a background colour: the room is one plane, the status bar another,
each dialog box a third. A screen item is something drawn in a plane: a view cel (a sprite)
or a bitmap (rendered text). The interpreter composes the frame when a script calls
`FrameOut`.

Scripts drive all of this through their objects. A `View` adds itself with `AddScreenItem`,
changes are pushed with `UpdateScreenItem`, and the interpreter reads position, view, loop,
cel, priority and scale from the object's properties.

## Planes

- A plane's priority orders it against other planes; **priority -1 means hidden**.
- An empty or inverted rectangle means off screen.
- `picture` is a picture number, or -1 (none), or -2 (just the background colour).
- Screen coordinates in a plane are relative to its inner rectangle. `GlobalToLocal`
  converts event coordinates into a plane's space; menus are separate planes, so this matters
  for clicks.

## Screen items

Items in a plane sort by priority, then by `y` (things further down the screen are in front),
then by creation. An item with `fixPriority` set keeps the priority it was given; otherwise
its priority is its `y`.

Pictures can have several layers ("cels") with priorities of their own: a background at a
very low priority, and foreground pieces (a pillar, a table edge) at the `y` of their base,
so actors walk behind them when they're further up the screen.

## Cels

Pictures and views share one cel format: width, height, the origin (`displaceX`/`Y`, the
point placed at the object's x,y), the transparent colour, a compression byte, and offsets to
the data. Compression 0 is raw pixels. 0x8A is RLE, with a per-row table of offsets into two
streams: control bytes and literal pixels.

- `11nnnnnn`: n transparent pixels
- `10nnnnnn`: n pixels of the next literal colour
- `0nnnnnnn`: copy n literal pixels

In the game we used, every picture cel was raw and every view cel RLE.

Sierra's RLE encoder made choices we couldn't reduce to a rule: two equal pixels sometimes
became a run and sometimes stayed in a literal group, depending on what came after. The best
rules we tried matched a third of rows. sci-ts encodes new cels with a minimum-bytes split
(dynamic programming over each row), which comes out slightly smaller than Sierra's, and keeps
the original bytes of cels nobody changed.

## Views

A view has loops, and loops have cels: loop 0 might be walking right, loop 1 walking left,
each cel one frame. A loop can be *linked* to another and mirrored, so walking left is
walking right flipped and stores no pixels. Views may embed a palette.

## The palette

SCI2 uses one 256-colour palette for the whole screen, and every picture and view carries
part of it. Palettes merge: the room's picture sets its colours, a view's palette sets its
own. So rooms and sprites have to agree on who owns which colour. From measuring every
picture and view in the game:

| colours | owner |
|---|---|
| 0-111 | shared by everything: the characters and items (the base palette, 999, defines these) |
| 112-235 | the room: each picture picks its own |
| 236-252 | interface colours |
| 253, 254 | not colours: remap markers (see below) |
| 255 | white, and the transparent colour |

Palette 999 doesn't define colour 255, but text is drawn in it, so the interpreter sets it to
white.

Converting new art for a room means keeping 0-111 and 236-252 as they are, choosing 124
colours for the room (we use k-means with the fixed colours as anchors), and dithering.

## Remapping (shadows)

Colours 253 and 254 in a cel aren't drawn as themselves. The script tells the interpreter
what they mean with `RemapColors`, for example "254 darkens what's underneath to 60%". The
hero's shadow is drawn in 254 and darkens the floor under his feet. Remap tables are built
against the final palette for the frame, so composition has three steps: collect what to
draw, settle the palette (palette changes, cycling, fades), then draw, replacing remap
pixels with the darkened colour underneath.

## Palette effects

- `Palette`: load a palette, fade a range of colours to a percentage, find the closest colour.
- `PalCycle`: rotate a range of colours (fire, water, glowing lights).
- `PalVary`: blend towards another palette over time (day to night, a lightning flash).
- `SetShowStyle`: room transitions (wipes, shutters, iris, dissolves, fades) that reveal a
  plane's new content over the old screen.

## Scaling

Screen items scale by `scaleX`/`scaleY` out of 128 when bit 0 of `scaleSignal` is set.
Dialog boxes are a single stone cel scaled to the size of the text. Actors get a `Scaler`
that sets their scale from their `y` (bigger at the front of the room).

An actor only recomputes its scale, and only updates its screen item, when the interpreter
has marked it as changed since it was last drawn: bit 0x0008 of `-info-`. **No script sets
that bit.** The interpreter sets it whenever a property in the drawing-related range is
written (position, priority, scale, view, loop, cel, plane, bitmap; variable slots 26 to 44
of View) and clears it when the screen item is updated from the object. Without that, actors
keep the scale they had when their scaler was attached.

## Hit testing

`IsOnMe` (is a point on this object?) tests the screen item's *drawn* rectangle: current
position, current cel, scaled. An object's `nsLeft`...`nsBottom` properties are only updated
by `SetNowSeen`, so testing those finds where the object was, which can be in another room.
