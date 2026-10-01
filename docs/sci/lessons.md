# What the scripts quietly depend on

Most of SCI is in the scripts, and the scripts are written for one interpreter. Wherever the
interpreter did something the bytecode doesn't spell out, the scripts came to rely on it.
Each item below is a bug we had, how it showed, and what the original does. They're grouped
roughly by how long they took to find.

## Found in an afternoon

| what went wrong | what the interpreter does |
|---|---|
| The first disassembly had 38,000 stray `bnot` instructions | Call frame sizes are always two bytes in SCI2, whatever the small bit says |
| `isKindOf` failed or sent to -1 | `-super-` holds the superclass *object* at run time, and the root class's is null |
| An item claimed to be a different class | The loader fills `-classScript-` and an instance's `-propDict-`; `isKindOf` compares them |
| Dialog buttons were 1 pixel wide | View numbers are unsigned: system views live at 64000 and up; only 0xFFFF means "none" |
| Text in a dialog came out invisible | Colour 255 is always white, though the base palette doesn't define it |
| Arrow glyphs showed as `\1d` | Strings carry `\xx` hex escapes, expanded when drawn |
| Measuring a single space gave a width of 65535 | Text measurement doesn't trim a line to nothing |
| Scripts' timers stalled in tests | `GetTime` in ticks and in seconds must come from the same clock |
| An off-screen view's palette spoiled the screen | A cel's palette counts only when the cel is actually drawn |
| Arrow keys did nothing on a character sheet | Keys arrive as PC scan codes, and direction events have their own event type |

## Found in a day

| what went wrong | what the interpreter does |
|---|---|
| The hero arrived and froze | `Motion::doit` doesn't use the step kernel's result; the kernel sends `moveDone` itself |
| Voice lines never played | `Message` subfunction numbers moved by one between SCI1.1 and SCI2 |
| A printed literal showed an empty box | Duplicating a string also works on literal strings in a script's heap |
| Clicks on the hero hit a feature behind him | `IsOnMe` tests where the item is drawn now, not the object's stored rectangle |
| Restoring from inside a dialog crashed | The interpreter's stack survives a restore; code still running holds on to it |
| Typing a name needed Enter twice | `EditText` leaves the key that ended it in the queue for the dialog |

## Found after a week of play

| what went wrong | what the interpreter does |
|---|---|
| Characters kept the size they had at the door | Writing a drawing property sets a "changed" bit in `-info-`; actors only rescale when it's set |
| Restore always loaded slot 0 | `DisposeScript` returns its second argument; the Restore dialog passes the chosen slot that way |
| The Restore dialog drifted off screen, a bit more each time | `DisposeScript` really unloads a script, so its objects start fresh next time; the dialog positions its buttons relative to where they were |
| Unloading broke a pending callback | A script is only unloaded when nothing reachable still uses its objects |
| Lists kept dead objects alive | Removing a list node frees it; disposing a list frees all of its nodes |
| Waiting for a sound to end never ended | Playing a sound sets its `handle` property; the scripts only poll a sound for its end while `handle` is set |

## How we found them

Almost always the same way: a symptom in play, reproduced in a headless run, then a trace.
sci-ts's explore tool runs the game without a browser, takes scripted input (clicks, keys,
waits), logs kernel calls, method calls and every change to a chosen property along with the
send that made it, and writes frames to PNG. Most of the bugs above took one well-aimed trace
once the symptom was reproducible.

ScummVM's source was the reference whenever we needed to know what the original did, and it
was right every time. What this list adds is the *symptom*: what it looks like in a game when
one of these is missing.
