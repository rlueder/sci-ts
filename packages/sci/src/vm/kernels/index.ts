import type { KernelFn } from "../vm.ts";
import { arrayKernels } from "./arrays.ts";
import { audioKernels } from "./audio.ts";
import { coreKernels, mathKernels } from "./core.ts";
import { graphicsKernels } from "./graphics.ts";
import { listKernels } from "./lists.ts";
import { motionKernels } from "./motion.ts";
import { paletteKernels } from "./palette.ts";
import { saveKernels } from "./saves.ts";
import { systemKernels } from "./system.ts";
import { textKernels } from "./text.ts";

export { graphics, Graphics, type Frame, SCREEN_WIDTH, SCREEN_HEIGHT, ShowStyle, frameRgb } from "./graphics.ts";
export { input, Input, EventType, SciKey, hostFiles, type SciEvent } from "./system.ts";
export { audio, AudioState, readingTime } from "./audio.ts";
export { paletteEffects, PaletteEffects } from "./palette.ts";
export { saves, restoreGame, scriptsFingerprint, MemorySaveStore, type SaveStore, type SaveInfo } from "./saves.ts";

export const allKernels: Record<string, KernelFn> = {
  ...coreKernels,
  ...mathKernels,
  ...listKernels,
  ...arrayKernels,
  ...graphicsKernels,
  ...paletteKernels,
  ...motionKernels,
  ...systemKernels,
  ...textKernels,
  ...audioKernels,
  ...saveKernels,
};
export { stringHelpers } from "./arrays.ts";
