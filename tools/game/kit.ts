/**
 * What a game's resources.ts imports to make art and sounds in code: the engine's writers
 * and types, and the default palette's colours.
 */
export {
  ResourceType, writeFont, writeHunkPalette, writePic, writeView,
  type Cel, type Font, type HunkPaletteFile, type PicFile, type ResourceData, type ViewFile,
} from "@sci-ts/sci";
export { BASE_PALETTE, CURSOR_VIEW, Colour, DEFAULT_FONT, basePalette, cube } from "./defaults.ts";
