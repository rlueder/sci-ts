# Art from a paint program

Besides art drawn in code, a game can use PNGs exported from any pixel art editor:
`sci-ts art` checks them against a manifest and the game's palette, and turns them into
pictures, views and fonts with the exact colours, anchors and foreground layers they were drawn
with (`tools/art/build.ts`). The Sherlock Holmes teaser works this way.

```sh
sci-ts art check art/art.json    # read and check every PNG; build the resources in memory
sci-ts art build art/art.json    # an art-only archive and palette.gpl (for the editor) in out/art
```

A game takes the art in through `resources.ts`:

```ts
import { fileURLToPath } from "node:url";
import { buildArt } from "sci2-ts/art";
export default () => buildArt(fileURLToPath(new URL("./art/art.json", import.meta.url))).resources;
```

The art's palette replaces the default palette 999. A resource number used twice is an
error.

## The manifest

```json
{
  "version": 1,
  "palette": "palette.json",
  "maxColours": 64,
  "pictures": [{
    "number": 102,
    "layers": [
      { "png": "export/workshop.png", "priority": -1000 },
      { "png": "export/workshop-front.png", "priority": 170 }
    ]
  }],
  "views": [{
    "number": 200,
    "loops": [
      { "cels": [{ "png": "export/walk-east-00.png", "anchor": [11, 46] }] },
      { "link": 0, "mirror": true }
    ]
  }]
}
```

Paths are relative to the manifest. A picture is layers: the first, at priority -1000, is
the background; each later one is drawn over actors whose feet are above its priority (a
y from 0 to 199), which is how things in front of the hero are made. A view is loops of
cels; a loop can instead reuse an earlier one, mirrored. `maxColours` (2 to 254) is a
budget the check enforces; without it, the limit is 254.

## The palette

`palette.json` is a list of 2 to 254 different `#rrggbb` colours, black first and white
last. Black is index 0, white 255, the rest 1 onwards; 254 is transparency and 253 is
kept free. Every picture and view uses this one palette, and every pixel must be one of its
colours exactly.

## Fonts

A font is a PNG sheet of glyphs, one character per cell of a fixed grid, left to right and
top to bottom:

```json
"fonts": [{ "number": 1, "png": "export/font-dialogue.png", "cell": [8, 12] }]
```

The first cell is the space (character 32) unless `first` says otherwise, so a 16-column
sheet of 95 cells holds the printable ASCII characters. Draw each glyph from its cell's left
edge: any opaque pixel is ink, whatever its colour (text is coloured when it's drawn), and
the glyph is as wide as its rightmost ink plus `spacing` (default 1). A cell with no ink is a
character the font doesn't have; the space is `space` pixels wide (default half a cell).
`lineHeight` sets the distance between lines (default the cell height).

A bitmap font that comes with its own metrics (exported from a BDF, say) keeps them: each
glyph's rectangle in an atlas, its top below the line's top, its bearing from the pen (which
can be negative, an italic j) and its advance. Give the metrics file instead of the sheet:

```json
"fonts": [{ "number": 4, "metrics": "export/italic.json" }]
```

The file has `lineHeight`, `first` and `last` (every character between needs a glyph),
`atlas` (the PNG, relative to the file), and `glyphs`: `{ code, rect: [x, y, w, h], bearingX,
top, advance }`. Nothing is trimmed or respaced; the font resource keeps the bearings and
advances in an extension at its end, which fonts without them don't have.

A game uses the font by number: `(narrator font: 1)`, or for every box at once, the text
style ([library.md](library.md)). Font 0 is sci-ts's own; a game can replace it too. In code,
`fontFromSheet` in `sci2-ts/kit` does the same from an image.

## What the PNGs must be

| | |
|---|---|
| Rooms | 320×200, every layer full size |
| Pixels | Exact palette colours; alpha 0 or 255 only; the background fully opaque |
| Export | 1×, no smoothing, scaling, dithering or colour-profile conversion |
| Sprites | Up to 320×200; every cel of a loop the same size (turn trimming off) |
| Anchors | A whole pixel inside the cel: the feet for actors |
| Animation | One PNG per cel, in playing order |
| Fonts | Ink opaque, the rest transparent; the sheet a whole number of cells |

The check names the file and the pixel for anything it rejects.
