# Text

## Fonts

The font format hasn't changed since SCI0: a header (character count, line height), a table of
offsets, and for each character its width, height and rows of one-bit pixels, most significant
bit first, each row padded to whole bytes. The games' fonts are 128 characters, plain ASCII.
Strings may contain `\xx` hex escapes, which the interpreter expands when drawing (dialog
buttons use them for arrow glyphs).

## Measuring and drawing

Scripts measure text with `TextSize` (it writes a rectangle into an integer array, right and
bottom inclusive, wrapping at a given width or three fifths of the screen) and render it with
`CreateTextBitmap` into a bitmap in memory. A screen item whose `bitmap` property is set draws
the bitmap instead of a view cel.

## Message files

Almost everything the game says is in message files, one per room (or module), addressed by
four numbers:

- **noun**: what it's about. Noun 0 is the room itself, a real noun, not "none".
- **verb**: the action: look, do, talk, an inventory item used on it, a spell.
- **cond**: a variant for the game's state: day or night, before or after a puzzle.
- **seq**: 1, 2, 3... for a sequence of lines.

Each record also names a **talker** (who says it; the meanings are up to the game's scripts)
and can *refer* to another tuple instead of having text: "same answer as looking at the door".
A record with any reference field set has no text of its own. (Our first check tested only the
noun field, and missed references to noun 0.)

Layout: a version number, the end of the strings (counted from offset 6), a trailer count, the
record count, 11-byte records (noun, verb, cond, seq, talker, a string offset, the four
reference fields), then the strings in record order, then a trailer the interpreter never
reads. Several version numbers share this layout.

The `Message` kernel call gets a line, gets the next line of a sequence, follows references,
and reports which tuple it returned last (scripts use that to find the matching voice clip).
In SCI2 its subfunction numbers shifted by one from SCI1.1 (one was dropped); with the old
numbering, every voice lookup asked for tuple 0,0,0,0.

## How a line gets on screen

The game's messager object takes `say: noun verb cond seq caller`. It fetches each line,
asks a function in the game which talker the talker number means, and hands the line to that
talker: the narrator draws a box; a character's talker shows their portrait (a bust view,
plus props for the mouth and eyes that animate while the text is up) next to the box. When
the last line is done, the messager cues the caller.

With speech, a line lasts as long as its recording. Without one (a new line in a mod), the
voice lookup returns a length of 0 and the line disappears at once; a host adding new
dialogue should report a reading time instead.

## Text input

`EditText` runs the editing loop for a text field. When it ends (Enter, Escape, Tab,
Shift-Tab, the arrows, a click outside the field), it **leaves the event that ended it in the
queue**, so the dialog sees it too. If the editor eats it, every dialog needs the key pressed
twice.
