;;; Constants for the sci-ts class library and the games that use it:
;;; (include "system.sh")

;; Verbs: what a click does. Right-click goes to the next one.
(enum 1
  V_LOOK
  V_TALK
  V_WALK
  V_DO)
(define VERB_COUNT 4)

;; Cursors: one view per verb, CURSOR_BASE + verb.
(define CURSOR_BASE 990)

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

;; DoSound kernel calls.
(define SND_INIT 6)
(define SND_DISPOSE 7)
(define SND_PLAY 8)
(define SND_STOP 9)
(define SND_UPDATE_CUES 17)

(define SCREEN_WIDTH 320)
(define SCREEN_HEIGHT 200)
