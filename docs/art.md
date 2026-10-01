# Art from a paint program

Besides art drawn in code, a game can use PNGs exported from any pixel art editor:
`sci-ts art` checks them against a manifest and the game's palette, and turns them into
pictures and views with the exact colours, anchors and foreground layers they were drawn
with (`tools/art/build.ts`). The Sherlock Holmes teaser works this way.

```sh
sci-ts art check art/art.json    # read and check every PNG; build the resources in memory
sci-ts art build art/art.json    # an art-only archive and palette.gpl (for the editor) in out/art
```

A game takes the art in through `resources.ts`:

```ts
import { fileURLToPath } from "node:url";
import { buildArt } from "sci-ts/art";
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

## What the PNGs must be

| | |
|---|---|
| Rooms | 320×200, every layer full size |
| Pixels | Exact palette colours; alpha 0 or 255 only; the background fully opaque |
| Export | 1×, no smoothing, scaling, dithering or colour-profile conversion |
| Sprites | Up to 320×200; every cel of a loop the same size (turn trimming off) |
| Anchors | A whole pixel inside the cel: the feet for actors |
| Animation | One PNG per cel, in playing order |

The check names the file and the pixel for anything it rejects.
