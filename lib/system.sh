;;; Constants for the sci-ts class library and the games that use it:
;;; (include "system.sh")

;; Verbs: what a click does. Right-click goes to the next one.
(enum 1
  V_LOOK
  V_TALK
  V_WALK
  V_DO)
(define VERB_COUNT 4)

;; Cursors: the library's are views CURSOR_BASE + verb, and CURSOR_WAIT while the player
;; can't act (a game can bring its own: User).
(define CURSOR_BASE 990)
(define CURSOR_WAIT 995)

;; Event types, as GetEvent reports them.
(define EV_NULL 0)
(define EV_MOUSE_DOWN 1)
(define EV_MOUSE_UP 2)
(define EV_KEY_DOWN 4)
(define EV_ALL $7fff)
;; The right button arrives as a click with shift held.
(define MOD_RIGHT 3)

;; Polygon types: how a polygon limits walking.
(define PT_TOTAL_ACCESS 0)          ; can't go in, can walk out
(define PT_NEAREST 1)               ; a click inside goes to its edge
(define PT_BARRED 2)                ; never
(define PT_CONTAINED 3)             ; the walkable area: can't leave it

;; What AvoidPath ends a path with.
(define PATH_END $7777)

;; Array and String kernel calls.
(define ARRAY_NEW 0)
(define ARRAY_AT 2)
(define ARRAY_AT_PUT 3)
(define ARRAY_FREE 4)
(define STRING_LENGTH 10)

;; Bitmap subfunctions.
(define BITMAP_DISPOSE 1)
(define BITMAP_DRAW_VIEW 3)

;; DoSound kernel calls.
(define SND_INIT 6)
(define SND_DISPOSE 7)
(define SND_PLAY 8)
(define SND_STOP 9)
(define SND_UPDATE_CUES 17)

(define SCREEN_WIDTH 320)
(define SCREEN_HEIGHT 200)

;; Who says a message line (its talker number).
(define TALKER_HERO 98)             ; the game's heroTalker, if it has one
(define TALKER_NARRATOR 99)
(define ROOM_TALKERS 200)           ; and up: the room's own characters (its findTalker:)

;; View signal bits.
(define SIG_HIDDEN $0008)
(define SIG_FIXED_LOOP $0800)
;; scaleSignal: scale the cel by scaleX and scaleY.
(define SCALE_ON 1)

;; Story flags: SetFlag, ClearFlag and IsFlag (script 999's exports 0 to 2) take 0 to 1023.
(define FLAG_COUNT 1024)
