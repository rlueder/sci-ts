# Hello: polygon art

The approved visual direction for every demo element is a flat polygon style inspired by Out of This World: broad silhouettes,
a restrained night palette, angular planes and small pools of warm light. Scenery,
characters, props, cursors, conversation portrait and UI frames share the same drawing primitives
and colours. There are no textures, dithering, raster source images or generated-art
dependencies in this version.

The editable source is `../art.ts`. Its scanline polygon rasterizer draws directly
onto the engine's 320×200 indexed canvas. The two rooms retain their original moon,
lantern, sign and traveller positions and horizontal walking areas. The hill and
road share distant geography, with different foreground framing.

The hero has articulated body poses for the existing east, mirrored west, south
and north loops. The traveller is seated on his pack. The lantern keeps its two
flicker frames, and the 34×40 portrait retains separate animated eyes and mouth.
All cels preserve the engine's original anchor conventions and animation contracts.
Black (0), transparency (254) and white (255) remain reserved for the engine.

The story, room YAML, Yarn, messages, sound effect and music are unchanged. The only
script addition configures TextStyle in the game init: moonlight text on dark panels
with a small angular frame. Palette constants live in `../hello.sh`. The demo
overrides its own look, talk, walk, use, wait and startup cursors; shared engine and
class-library visuals stay reusable by other games. Keep future demo art within this
same visual direction, including new characters, props and interface elements.

Build and check from the repository root:

```sh
pnpm typecheck
pnpm exec vitest run packages/sci/test/game-build.test.ts
node --import tsx tools/game.ts build games/hello
```

The existing integration playthrough covers both rooms, walking, moon and sign
hotspots, lantern animation and chime, and traveller conversation topics, portrait,
mouth and eyes. The screenshots in `docs/screenshots` are captured from the engine.
