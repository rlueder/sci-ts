# A game from nothing

What an SCI2 interpreter needs from a game, learned by making one with nothing of Sierra's in
it (`games/hello`): no scripts, no class library, no fonts or palettes from any game.

## The files

`RESOURCE.MAP` and `RESOURCE.000`. Entries can be stored uncompressed (method 0); the
interpreter doesn't mind. Digital effects go in `RESOURCE.SFX`, found through map 65535
(see [sound.md](sound.md)).

The resources every game has:

| resource | what |
|---|---|
| vocab 997 | selector names, in number order |
| vocab 996 | for each class number (*species*), the script that defines it |
| script 0 | export 0 is the game object: the interpreter starts by sending it `play` |
| palette 999 | the base palette |
| a font | font 0 is the usual default |
| a cursor | any view: scripts choose it with `SetCursor` |

How selectors are numbered is up to the game, as long as vocab 997 lists them in order.
Interpreters that look the selectors they use up by name (ScummVM's, and ours) take any
numbering.

## Objects

Every object starts with nine slots: `-objID-` (0x1234), `-size-` (the property count),
`-propDict-` and `-methDict-` (offsets into the script), `-classScript-`, `-species-`,
`-super-`, `-info-` (0x8000 on a class), and `name`. A class's property dictionary lists a
selector for every property, the inherited ones first, in its superclass's order: that's
what makes a subclass's object readable as its superclass. An instance has no dictionary of
its own; it uses its class's.

When a script loads, `-super-` and `-species-` stop being numbers and become the addresses
of class objects (see [vm.md](vm.md)). A clone made with `Clone` has 0x8000 cleared and
0x0001 set, so scripts can tell classes, instances and clones apart by `-info-`.

A property holding a string or another object in the same script is a heap offset, and
must be listed in the heap's relocation table; the interpreter turns listed words into
addresses when it loads the script, and leaves the rest as numbers.

## Calls and sends

A kernel call pushes its argument count, then the arguments, then `callk kernel frame`,
where *frame* is the arguments' size in bytes (the count itself isn't included). Calls to
procedures (`call`, `calle`, `callb`) do the same.

A send pushes, for each message, the selector, the argument count and the arguments; the
receiver goes in the accumulator, and `send frame` gives the size of all of it in bytes.
`self` and `super` (with a class number) are sends to the current object. A message to a
property reads it with no arguments and sets it with one.

`&rest n` pushes the current call's arguments from the n-th on and adds them to the next
call's or send's frame: that's how a method passes along "whatever else I was given".

## Variables

There are four kinds: globals (script 0's variables), the script's own variables,
temporaries (`link n` makes room for n) and parameters (parameter 0 is the argument count).
Each has load, store, increment and decrement instructions, to the accumulator or the stack.

The indexed forms add the accumulator to the variable number. Storing from the accumulator
when the accumulator holds the index has an odd shape: the value comes off the stack, and
ends up in the accumulator too. `lea` makes a variable's address, for kernels that write
into arrays: its first operand is the kind (0 global, 1 script, 2 temporary, 3 parameter),
plus 8 if indexed, shifted left once.

## Drawing and input

The interpreter reads objects' properties by name: a plane, a screen item or an event is
any object with the properties its kernel calls read. A game without Sierra's class library
needs its own classes with those properties (the sci-ts library has them; see
[../library.md](../library.md)). Text is drawn into a bitmap by `CreateTextBitmap`, which
reads the object's `text`, `font`, colours and text rectangle; an empty rectangle (right
before left) means the whole bitmap.

## Sound

A sound resource has a track per device, each a list of channel streams of MIDI events
timed in 1/60 s ([sound.md](sound.md)). A game that plays only on General MIDI needs one
track; channel 16 (15 counting from 0) is never music, since the interpreter reads it as
signals for the scripts.
