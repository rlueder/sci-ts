import type { Vm } from "@sci-ts/sci";

/** Input to play by frame number, while the game runs as fast as it can, until frame `until`. */
export interface FastForward {
  script: Record<number, () => void>;
  until: number;
}

/**
 * What the viewer knows about one game beyond its resources: so far, how to get from the
 * title screen to a character who can walk into rooms, quickly (the player's room links and
 * the editor use it). Profiles are the modules in ./games/; a game without one starts at
 * its title and the player gets there by hand.
 */
export interface GameProfile {
  name: string;
  /** Whether the loaded game is this one. */
  matches(vm: Vm): boolean;
  quickStart(vm: Vm): FastForward;
}

const profiles = Object.values(import.meta.glob<GameProfile>("./games/*.ts", { eager: true, import: "profile" }));

export function gameProfile(vm: Vm): GameProfile | undefined {
  return profiles.find((p) => p.matches(vm));
}
