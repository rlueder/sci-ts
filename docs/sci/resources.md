# Resources

A game's data lives in a resource map and one or more volume files, plus loose patch files
that override them. Each resource is identified by a type and a number: picture 250, script
250, message file 250 and so on. Numbers are often shared on purpose: a room's script, its
picture and its message file usually all carry the room's number.

## The map and the volume (SCI2)

`RESOURCE.MAP` starts with a table of types: `{ type u8, offset u16 }` repeated, ended by
type `0xFF` (whose offset marks the end of the last table). Each type's table is a list of
`{ number u16, offset u32 }`, six bytes per entry.

Earlier versions packed the offset into three bytes (five-byte entries). A map read with the
wrong entry size doesn't fail loudly; it just produces nonsense offsets, so it's worth
checking that every entry lands on a valid volume header.

`RESOURCE.000` holds the resources back to back. Each starts with a 13-byte header:
`type u8, number u16, packed size u32, unpacked size u32, method u16`. Method 0 is stored
as is; method 32 is STACpack (LZS), an LZ77 variant with a bit-level stream. In the game we
used, nine resources in ten were compressed.

## Patch files

A file named `<number>.<ext>` in the game folder (or a `PATCHES` folder) replaces the
resource of that type and number: `250.SCR` replaces script 250. The file starts with
`type u8, header size u8`, then that many extra header bytes, then the data. Pictures and
views may set the top bit of the header-size byte to mean a fixed extra size (codes 0, 1
and 4 mean 24, 2 and 8 bytes).

Patches are how Sierra shipped fixes, and how mods work: a mod is a folder of patch files.

## The types SCI2 uses

| type | what |
|---|---|
| view | sprites: loops of cels (animation frames), with an optional palette |
| pic | room backgrounds: one or more layers with a priority, and a palette |
| script, heap | bytecode and data for one script number (see scripts.md) |
| text, message | strings; message files address lines by noun, verb, condition and sequence |
| font | bitmap fonts |
| sound | music and sound effects, one track per sound device |
| palette | colour tables; palette 999 is the base palette |
| vocab | 997 selector names, 996 the class table, plus older tables |
| audio map | where each digital clip lives in RESOURCE.AUD / RESOURCE.SFX |
| patch | device data, for example the AdLib instrument bank |
| cursor, bitmap, robot, vmd | other media (cursors in SCI2 games are usually views) |

## Formats, briefly

The details are in the other notes. A few rules hold across formats:

- Offsets inside a resource are from the start of the resource, after its patch header.
- Multi-byte numbers are little-endian, with one exception noted in sound.md.
- SCI2 pictures and views share a cel format (see graphics.md) and embed palettes in the
  same "hunk palette" layout.
- Unused or editor-only bytes are common: message files end with what looks like the
  message editor's history (timestamps from late 1993), pictures carry a few constant
  fields nobody reads. Writers that want byte-exact output keep them as found.

## Byte-exact round trips

sci-ts can write every format it reads, and for the game we tested with, reading and writing
again gives back the same bytes for every script (285), message file (152), picture (59)
and view (500). That's the test that the format is fully understood: any field we'd
misread or dropped would show up as a difference. The one place we couldn't match Sierra
was the view RLE encoder (see graphics.md); there the writer keeps the original encoding of
unchanged cels.
