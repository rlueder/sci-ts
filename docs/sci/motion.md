# Motion and walking

## Movers

An actor moves by having a *mover*: `MoveTo` heads for a point, `PolyPath` follows a list of
points around obstacles, others chase or wander. Each game cycle the mover asks the kernel to
step the actor (`DoBresen`): an integer Bresenham line, one step of `xStep`/`yStep` per
update. When the actor arrives, the mover cues whoever set it in motion.

In SCI2, `Motion::doit` ignores what the stepping kernel returns and keeps one of the mover's
own properties as a timestamp. So the kernel has to send `moveDone` itself when the actor
arrives, and must not touch that property. Getting this wrong leaves actors standing at their
destination forever, never cueing anyone.

## Walkable areas

A room describes where actors can go with `Polygon` objects in its obstacle list. Each has a
`points` array of x,y pairs and a type:

| type | meaning |
|---|---|
| 0, total access | can't enter it, can walk out of it |
| 1, nearest point | a click inside sends the actor to its edge |
| 2, barred | never |
| 3, contained | the walkable area itself: can't leave it |

Rooms use these in different ways. One room in the game we used has no contained polygon at
all: its first barred polygon covers a frame larger than the screen with a slit cut into the
outline of the floor, so everything but the floor is barred.

## Pathfinding

`AvoidPath(x1, y1, x2, y2, obstacles)` returns the path as an array of points ending with
`0x7777 0x7777`. sci-ts finds it like this:

1. Obstacles that contain the starting point are ignored (an actor can always walk out).
2. Start and end snap to the nearest walkable point.
3. If the straight line is clear, that's the path. Otherwise build a visibility graph over the
   polygons' corners. An edge counts only if it crosses no polygon side *and* stays walkable
   along its length: a diagonal between two corners of the same obstacle crosses no side but
   runs through the middle of it.
4. Shortest path (Dijkstra). A couple of milliseconds per path.

`InPolygon` counts the boundary as inside.

## Collisions

In SCI2, `CantBeHere` only checks actors against other actors: whether their base rectangles
overlap, skipping actors flagged as hidden or as ignoring others. Walls are the pathfinder's
job alone.

## Scalers

A room attaches a `Scaler` to the hero: full size at one `y`, a smaller percentage at another,
linear in between. It's what makes characters shrink as they walk away. See graphics.md for
the interpreter flag that decides when the scale is recomputed.
