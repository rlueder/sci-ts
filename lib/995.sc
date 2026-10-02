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
;; I or Tab opens the inventory; an item picked there is used like a verb (V_ITEM), with
;; its own cursor, until right-click goes back to walking.
;; Escape opens the game menu (save, restore, start again); F5 saves and F7 restores.
(class User of Obj
  (properties
    verb V_WALK
    canInput TRUE
    lookCursor 991  ; the library's: CURSOR_BASE + verb
    talkCursor 992
    walkCursor 993
    doCursor 994
    waitCursor 995  ; CURSOR_WAIT
    cursor -1       ; the view and loop showing now
    cursorLoop 0)

  (method (init)
    (self setVerb: verb))

  (method (setVerb v)
    (= verb v)
    (self showCursor:))

  ;; Picks an item to use (0: none).
  (method (useItem item)
    (= theItem item)
    (cond
      (item (self setVerb: V_ITEM))
      ((== verb V_ITEM) (self setVerb: V_WALK))))

  ;; The cursor for a verb (0: waiting).
  (method (cursorFor v)
    (switch v
      (V_LOOK (return lookCursor))
      (V_TALK (return talkCursor))
      (V_WALK (return walkCursor))
      (V_DO (return doCursor))
      (else (return waitCursor))))

  (method (showCursor &tmp v l)
    (= l 0)
    (cond
      ((not canInput) (= v waitCursor))
      ((and (== verb V_ITEM) theItem) (= v (theItem view?)) (= l 1))
      (else (= v (self cursorFor: verb))))
    (if (or (!= v cursor) (!= l cursorLoop))
      (= cursor v)
      (= cursorLoop l)
      (SetCursor v l 0)
      (if (and (== l 1) theItem (theItem magnify?))
        (AddMagnify v 2 0 (theItem magnify?))
       else
        (DeleteMagnify))))

  (method (doit)
    (self showCursor:)
    (while (GetEvent EV_ALL theEvent)
      (self handleEvent: theEvent))
    ;; theEvent now says where the pointer is: at the top edge, the icon bar comes down.
    (cond
      ((== dialog iconBar) (iconBar pointerAt: (theEvent x?) (theEvent y?)))
      ((and canInput (not dialog) (not talking) (<= (theEvent y?) ICON_BAR_EDGE)) (iconBar show:))))

  ;; The verb right-click goes to: walk, do, look, talk, the item picked (if any), walk.
  (method (nextVerb)
    (cond
      ((== verb V_ITEM) (return V_WALK))
      ((and (== verb V_TALK) theItem) (return V_ITEM))
      (else (return (+ (mod verb VERB_COUNT) 1)))))

  (method (handleEvent event &tmp obj ex ey)
    (event claimed: FALSE)
    ;; A line being shown, then an open menu, get clicks first.
    (if (and talking (talking handleEvent: event)) (return))
    (if dialog
      (dialog handleEvent: event)
      (return))
    (if (not canInput) (return))
    (if (== (event type?) EV_KEY_DOWN)
      (switch (event message?)
        (KEY_ESCAPE (event claimed: TRUE) (game showMenu:) (return))
        (KEY_F5 (event claimed: TRUE) (game save:) (return))
        (KEY_F7 (event claimed: TRUE) (game restore:) (return))))
    (if (and (== (event type?) EV_KEY_DOWN)
          (or (== (event message?) KEY_TAB) (== (event message?) KEY_i) (== (event message?) KEY_I)))
      (event claimed: TRUE)
      (inventory showSelf:)
      (return))
    (if (!= (event type?) EV_MOUSE_DOWN) (return))
    (if (& (event modifiers?) MOD_RIGHT)
      (self setVerb: (self nextVerb:))
      (return))
    ;; A tap at the top edge (touch has no pointer to hover there) opens the icon bar.
    (if (<= (event y?) (* 3 ICON_BAR_EDGE))
      (event claimed: TRUE)
      (iconBar show:)
      (return))
    (= ex (event x?))
    (= ey (event y?))
    (if (== verb V_WALK)
      (if ego (ego setMotion: PolyPath ex ey))
      (return))
    (= obj (cast firstTrue: #onMe ex ey))
    (if (not obj) (= obj (features firstTrue: #onMe ex ey)))
    (if (not obj) (= obj curRoom))
    (if obj (obj doVerb: (if (== verb V_ITEM) (theItem verb?) else verb)))))
