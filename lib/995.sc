;;; Input: events, and what clicks do.
(script 995)
(include "system.sh")

;; What GetEvent fills in.
(class Event of Obj
  (properties
    type 0
    message 0
    modifiers 0
    x 0 y 0
    claimed 0))

;; Turns clicks into walking and verbs. Right-click goes to the next verb (and cursor);
;; a click walks the hero there, or does the verb to what's under the cursor: an actor or
;; prop, a feature, or else the room. A click while a line is shown dismisses it; while a
;; menu is open, it goes to the menu.
;;
;; The cursor is a view for each verb, and another while the player can't act (handsOff).
;; A game with its own sets them in its init: (user walkCursor: 261 waitCursor: 265 ...).
(class User of Obj
  (properties
    verb V_WALK
    canInput TRUE
    lookCursor 991  ; the library's: CURSOR_BASE + verb
    talkCursor 992
    walkCursor 993
    doCursor 994
    waitCursor 995  ; CURSOR_WAIT
    cursor -1)      ; the view showing now

  (method (init)
    (self setVerb: verb))

  (method (setVerb v)
    (= verb v)
    (self showCursor:))

  ;; The cursor for a verb (0: waiting).
  (method (cursorFor v)
    (switch v
      (V_LOOK (return lookCursor))
      (V_TALK (return talkCursor))
      (V_WALK (return walkCursor))
      (V_DO (return doCursor))
      (else (return waitCursor))))

  (method (showCursor &tmp c)
    (= c (self cursorFor: (if canInput verb else 0)))
    (if (!= c cursor)
      (= cursor c)
      (SetCursor c 0 0)))

  (method (doit)
    (self showCursor:)
    (while (GetEvent EV_ALL theEvent)
      (self handleEvent: theEvent)))

  (method (handleEvent event &tmp obj ex ey)
    (event claimed: FALSE)
    ;; A line being shown, then an open menu, get clicks first.
    (if (and talking (talking handleEvent: event)) (return))
    (if dialog
      (dialog handleEvent: event)
      (return))
    (if (or (not canInput) (!= (event type?) EV_MOUSE_DOWN)) (return))
    (if (& (event modifiers?) MOD_RIGHT)
      (self setVerb: (+ (mod verb VERB_COUNT) 1))
      (return))
    (= ex (event x?))
    (= ey (event y?))
    (if (== verb V_WALK)
      (if ego (ego setMotion: PolyPath ex ey))
      (return))
    (= obj (cast firstTrue: #onMe ex ey))
    (if (not obj) (= obj (features firstTrue: #onMe ex ey)))
    (if (not obj) (= obj curRoom))
    (if obj (obj doVerb: verb))))
