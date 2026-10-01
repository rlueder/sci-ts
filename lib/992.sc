;;; Saving, restoring and restarting: the game menu (Escape), F5 to save and F7 to restore.
(script 992)
(include "system.sh")

;; A line to type into, for the interpreter's line editor (EditText): shown over the room
;; until Enter, Escape or a click outside it, each of which is left for the next event.
(class EditField of Obj
  (properties
    x 0 y 0 z 0
    view -1 loop 0 cel 0
    priority 300 fixPriority 1
    plane 0
    bitmap 0
    scaleSignal 0 scaleX 128 scaleY 128
    text 0
    font 0
    fore 0
    back 255
    skip 254
    mode 0
    borderColor 0
    nsLeft 0 nsTop 0 nsRight 0 nsBottom 0
    textLeft 3 textTop 3 textRight 0 textBottom 0
    width SAVE_DESCRIPTION) ; the most characters

  ;; At (x, y), w pixels wide and one line of text tall.
  (method (place theX theY w)
    (= x theX)
    (= y theY)
    (= plane uiPlane)
    (= font (textStyle font?))
    (= fore (textStyle fore?))
    (= back (textStyle back?))
    (= borderColor (if (== (textStyle border?) -1) (textStyle fore?) else (textStyle border?)))
    (= nsLeft x)
    (= nsTop y)
    (= nsRight (+ x w -1))
    (= nsBottom (+ y (PointSize font) 5))
    (= textRight (- w 4))
    (= textBottom (- (- nsBottom nsTop) 3))))

;; What the game menu, F5 and F7 open; (game save:), (game restore:) and (game showMenu:)
;; open them from a script. A save is a snapshot of the whole game, named with a line the
;; player types; only saves made by this build of the game are offered.
(class SaveRestore of Obj
  (properties
    mode 0          ; what the open menu is for: SR_MENU, SR_SAVE, SR_RESTORE, or SR_NAME
    descriptions 0  ; GetSaveFiles: SAVE_DESCRIPTION characters a save, newest first
    ids 0
    count 0
    field 0         ; the description being typed
    slot 0)         ; the save it goes into

  (method (showMenu &tmp menu)
    (= mode SR_MENU)
    (= menu (Menu new:))
    (menu
      add: SR_SAVE "Save the game"
      add: SR_RESTORE "Restore a game"
      add: SR_RESTART "Start again"
      add: SR_TEXT (String STRING_FORMAT "Text speed: %s" (self textSpeedName:))
      add: 0 "Carry on"
      show: self))

  (method (textSpeedName)
    (switch textSpeed
      (TEXT_SLOW (return "slow"))
      (TEXT_FAST (return "fast"))
      (TEXT_CLICK (return "until I click"))
      (else (return "normal"))))

  ;; The saves there are now.
  (method (load)
    (self release:)
    (= descriptions (String ARRAY_NEW 0))
    (= ids (Array ARRAY_NEW 0 0))
    (= count (GetSaveFiles "" descriptions ids)))

  (method (release)
    (if descriptions (String ARRAY_FREE descriptions) (= descriptions 0))
    (if ids (Array ARRAY_FREE ids) (= ids 0)))

  ;; The description of the i-th save (a new string).
  (method (description i &tmp s)
    (= s (String ARRAY_NEW SAVE_DESCRIPTION))
    (Array ARRAY_COPY s 0 descriptions (* i SAVE_DESCRIPTION) (- SAVE_DESCRIPTION 1))
    (return s))

  ;; One more than the highest save number.
  (method (nextSlot &tmp i n id)
    (= n 0)
    (for ((= i 0)) (< i count) ((++ i))
      (= id (Array ARRAY_AT ids i))
      (if (>= id n) (= n (+ id 1))))
    (return n))

  ;; Menu values are save numbers plus one (0 is cancel).
  (method (listSaves menu &tmp i)
    (for ((= i 0)) (and (< i count) (< i SAVES_SHOWN)) ((++ i))
      (menu add: (+ (Array ARRAY_AT ids i) 1) (self description: i))))

  (method (save &tmp menu)
    (game clearText:)
    (self load:)
    (= mode SR_SAVE)
    (= menu ((Menu new:) y: 12 yourself:))
    (menu add: (+ (self nextSlot:) 1) "A new saved game")
    (self listSaves: menu)
    (menu add: 0 "Cancel" show: self))

  (method (restore &tmp menu)
    (game clearText:)
    (self load:)
    (if (not count)
      (narrator say: "There are no saved games yet.")
      (return))
    (= mode SR_RESTORE)
    (= menu ((Menu new:) y: 12 yourself:))
    (self listSaves: menu)
    (menu add: 0 "Cancel" show: self))

  (method (choose v)
    (switch mode
      (SR_MENU
        (switch v
          (SR_SAVE (self save:))
          (SR_RESTORE (self restore:))
          (SR_RESTART (RestartGame))
          ;; The next speed, slowest first; the menu again, showing it.
          (SR_TEXT
            (switch textSpeed
              (TEXT_SLOW (= textSpeed TEXT_NORMAL))
              (TEXT_NORMAL (= textSpeed TEXT_FAST))
              (TEXT_FAST (= textSpeed TEXT_CLICK))
              (else (= textSpeed TEXT_SLOW)))
            (self showMenu:))))
      (SR_SAVE (if v (self askDescription: (- v 1))))
      (SR_RESTORE
        (if v
          ;; Returns only if it couldn't: the game starts again where the save left it.
          (RestoreGame "" (- v 1) "")
          (narrator say: "That saved game couldn't be restored.")))))

  ;; Types the description of save n: the old one, or the room's number to start from.
  (method (askDescription n &tmp i)
    (= slot n)
    (= field (EditField new:))
    (field text: (String ARRAY_NEW SAVE_DESCRIPTION))
    (for ((= i 0)) (< i count) ((++ i))
      (if (== (Array ARRAY_AT ids i) n)
        (Array ARRAY_COPY (field text?) 0 descriptions (* i SAVE_DESCRIPTION) (- SAVE_DESCRIPTION 1))))
    (if (not (String STRING_LENGTH (field text?)))
      (String STRING_FORMAT_INTO (field text?) "Room %d" curRoomNum))
    (field place: 40 80 240)
    (EditText field)
    ;; How it ended (Enter, Escape, a click) is the next event: wait for it.
    (= mode SR_NAME)
    (= dialog self))

  (method (handleEvent event)
    (event claimed: TRUE)
    (if (== mode SR_NAME)
      (cond
        ((and (== (event type?) EV_KEY_DOWN) (== (event message?) KEY_ENTER)) (self finishSave:))
        ((or (== (event type?) EV_KEY_DOWN) (== (event type?) EV_MOUSE_DOWN)) (self endNaming:))))
    (return TRUE))

  (method (dismiss)
    (self endNaming:))

  (method (endNaming)
    (if (== dialog self) (= dialog 0))
    (= mode 0)
    (if field
      (String ARRAY_FREE (field text?))
      (field dispose:)
      (= field 0)))

  (method (finishSave &tmp ok)
    ;; Nothing of this menu goes into the save.
    (if (== dialog self) (= dialog 0))
    (= mode 0)
    (= ok (SaveGame "" slot (field text?) ""))
    (self endNaming: release:)
    (narrator say: (if ok "Saved." else "The game couldn't be saved.")))

  (method (dispose)
    (self release:)
    (super dispose:)))
