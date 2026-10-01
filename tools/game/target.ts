import type { Target } from "@sci-ts/content";

/**
 * The class library (lib/) as a compile target for rooms written as YAML and Yarn
 * (packages/content). Global numbers depend on the game's script 0, so the target is made
 * for each build from the compiled globals' names.
 */
export function libraryTarget(globals: readonly string[], items: Record<string, number> = {}): Target {
  const g = (name: string) => {
    const n = globals.indexOf(name);
    if (n < 0) throw new Error(`the library's global ${name} isn't there: is script 0 compiled with the library?`);
    return n;
  };
  return {
    roomClass: "Room",
    roomDefaults: {},
    globals: {
      ego: g("ego"),
      game: g("game"),
      curRoom: g("curRoom"),
      messager: g("messager"),
      narratorObject: g("narrator"),
      music: g("music"),
      sound: g("sfx"),
    },
    // As in lib/system.sh.
    narrator: 99,
    heroTalker: 98,
    firstRoomTalker: 200,
    voice: { class: "Talker", props: {} },
    // Portraits stand at the top left, the text beside them.
    portrait: { class: "PortraitTalker", props: {}, at: [8, 8], frameSignal: 0, partSignal: 0 },
    teller: { class: "Teller", props: {}, verb: 2 },
    forwardCycle: "Forward",
    // room.enter lines: a verb the player can't use.
    narrationVerb: 0,
    // And the game's items (items.yaml): using one is its own verb.
    verbs: { look: 1, talk: 2, walk: 3, do: 4, ...items },
    messageVersion: 4321,
    // SetFlag, ClearFlag and IsFlag: script 999's exports 0, 1 and 2.
    flags: { script: 999, set: 0, clear: 1, test: 2, first: 0, last: 1023 },
  };
}
