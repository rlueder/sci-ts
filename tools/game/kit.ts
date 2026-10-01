/**
 * What a game's resources.ts imports to make art and music in code: the engine's writers
 * and types, and the default palette's colours.
 */
export {
  ResourceType, SoundDevice, writeFont, writeHunkPalette, writePic, writeSound, writeView,
  type Cel, type Font, type HunkPaletteFile, type MidiEvent, type PicFile, type ResourceData, type SoundSpec, type ViewFile,
} from "@sci-ts/sci";
export { BASE_PALETTE, CURSOR_VIEW, Colour, DEFAULT_FONT, basePalette, cube } from "./defaults.ts";
export { pixelFont } from "./font.ts";
export { fontFromSheet, type FontSheet } from "../art/font.ts";
