import type { ResourceId } from "../resource/types.ts";
import { graphics } from "./kernels/graphics.ts";
import { forgetMessages } from "./kernels/text.ts";
import type { Vm } from "./vm.ts";

/**
 * Swaps resources in a running game (a live editor's rebuild): the resource manager serves
 * the new data from now on and parsed views, pictures and messages are forgotten. Scripts
 * already loaded keep their old code until they're loaded again, so callers restore a
 * snapshot taken outside the rebuilt rooms (or jump to a room that isn't loaded).
 */
export function replaceResources(vm: Vm, resources: (ResourceId & { data: Uint8Array })[]): void {
  for (const r of resources) vm.resources.override(r, r.data);
  graphics(vm).forgetResources();
  forgetMessages(vm);
}
