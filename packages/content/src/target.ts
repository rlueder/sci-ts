/**
 * What the compiler needs to know about the game it builds for: which classes rooms
 * subclass, where the system objects live (globals) and how messages are numbered. The
 * compiler itself knows nothing about any particular game.
 */
export interface Target {
  /** The class new rooms subclass: the game's own room class. */
  roomClass: string;
  /** Property values every room gets unless the YAML overrides them. */
  roomDefaults: Record<string, number>;
  /** Global variable numbers (SCI's script 0 locals). */
  globals: {
    ego: number;
    game: number;
    curRoom: number;
    /** The Messager instance whose `say:` shows a message. */
    messager: number;
    /** The narrator object (what unknown talker numbers fall back to). */
    narratorObject: number;
    /** The Sound object playing the music, and the one for sound effects. */
    music: number;
    sound: number;
    /** The collection of what the hero carries (`add:`, `delete:`), if the target has one. */
    inventory?: number;
  };
  /** Message talker number for narration (no speaker). */
  narrator: number;
  /** Message talker number for the hero (`Hero:` lines, and the topics they pick). */
  heroTalker: number;
  /**
   * Talker numbers from here up are characters defined by compiled rooms: the game asks
   * the current room's `findTalker:` for them (needs the target's support patch).
   */
  firstRoomTalker: number;
  /** A character without a portrait: a plain text box, this class and properties. */
  voice: { class: string; props: Record<string, number> };
  /**
   * A character with a portrait view: loop 0 the bust, loop 1 mouth shapes, loop 2 eyes
   * (cel 0 open), all cels the same size so the parts line up. The talker class gets
   * `init: mouth bust eyes frame`; parts are a View (bust) and Props at `at`. With `who`,
   * the talker is also told the character's prop in the room, if it has one (`who:`).
   */
  portrait: { class: string; props: Record<string, number>; at: [number, number]; frameSignal: number; partSignal: number; who?: boolean };
  /**
   * Conversations: an instance of this class runs a menu of topics for a thing (e.g. a
   * Teller with `init: client modNum sayNoun verb rootNoun`; topic labels are messages at
   * rootNoun/verb/cond, answers at sayNoun/verb/cond).
   */
  teller: { class: string; props: Record<string, number>; verb: number };
  /** The class that cycles a prop's cels forever (<<animate x forever>>, cycle: forward). */
  forwardCycle: string;
  /**
   * Close-ups (<<closeup view [loop [cel]]>>), if the target has them: a class whose new
   * instance takes `show: view loop cel caller` and cues the caller when it's dismissed.
   */
  closeUp?: string;
  /**
   * Items rooms can give and take (<<get lens>>, <<drop lens>>): objects exported by
   * `script`, by name, added to and deleted from the inventory global.
   */
  items?: { script: number; exports: Record<string, number> };
  /** Verb number for "said on arrival" messages. */
  narrationVerb: number;
  /** Verb names as used in Yarn node titles (lower case) -> verb numbers. */
  verbs: Record<string, number>;
  /** Message file version written in new message files. */
  messageVersion: number;
  /**
   * Flags (Yarn's true/false variables): procedures `set`, `clear`, `test` (export numbers
   * of `script`, each taking the flag number), and the range a mod may use.
   */
  flags: { script: number; set: number; clear: number; test: number; first: number; last: number };
  /**
   * The game's fonts for Yarn's [b] and [i] markup, which become SCI's font codes (|f3|...|f|)
   * in the message text. Without them, markup is refused.
   */
  fonts?: { bold: number; italic: number; boldItalic: number };
}
