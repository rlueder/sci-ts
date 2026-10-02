;;; The icon bar: the verbs, the item, the inventory and the game menu, for players without
;;; a right mouse button (touch screens, trackpads).
(script 991)
(include "system.sh")

;; An icon: a View hit anywhere in its square, not only where it's drawn. Its `actions`
;; says what it stands for.
(class Icon of View
  (properties
    size ICON_SIZE)

  (method (onMe theX theY)
    (return (and (>= theX x) (< theX (+ x size)) (>= theY y) (< theY (+ y size))))))

;; Slides down when the pointer reaches the top edge of the screen, or on a tap there. Its
;; icons are the cels of `view`, loop 0 as they are and loop 1 picked, each `size`
;; square and anchored at the top-left corner: walk, look, do, talk, the inventory, the
;; game menu (the item in use shows its own icon). A game with its own sets view in its
;; init: (iconBar view: 266). Picking one, or a click below the bar, closes it.
;; With `skin`, a view drawn across the top of the screen (loop 0, cel 0, anchored at its top
;; left) instead of the box, the icons `size` square at `left`, `left` + `spacing` and on, at
;; `top`; the item in use goes in the fifth place, between the verbs and the inventory.
;;   (iconBar view: 266 skin: 267 size: 32 left: 16 spacing: 42 top: 8)
(class IconBar of Obj
  (properties
    view ICON_BAR_VIEW
    skin -1
    size ICON_SIZE
    left -1         ; -1 here and below: laid out inside the box
    spacing -1
    top -1
    box 0
    icons 0
    height 0)

  (method (show &tmp x y step)
    (if box (return))
    (if (!= skin -1)
      (= box ((View new:) view: skin loop: 0 cel: 0 x: 0 y: 0 yourself:))
      (box init:)
      (box plane: uiPlane setPri: 100)
      (= height (CelHigh skin 0 0))
      (= x (if (!= left -1) left else ICON_GAP))
      (= y (if (!= top -1) top else ICON_GAP))
     else
      (= box
        ((TextItem new:)
          text: ""
          width: SCREEN_WIDTH
          height: (+ size (* 2 ICON_GAP) (* 2 (textStyle margin?)))
          x: 0 y: 0
          yourself:))
      (if (!= (textStyle frame?) -1)
        (box height: (+ (box height?) (CelHigh (textStyle frame?) 0 4) (CelHigh (textStyle frame?) 0 5))))
      (box init:)
      (= height (box height?))
      (= x (if (!= left -1) left else (+ (box textLeft?) ICON_GAP)))
      (= y (if (!= top -1) top else (+ (box textTop?) ICON_GAP))))
    (= step (if (!= spacing -1) spacing else (+ size ICON_GAP)))
    (= icons (List new:))
    ;; The verbs, then the item, the inventory and the menu.
    (self addIcon: x y 0 V_WALK)
    (self addIcon: (+ x step) y 1 V_LOOK)
    (self addIcon: (+ x (* 2 step)) y 2 V_DO)
    (self addIcon: (+ x (* 3 step)) y 3 V_TALK)
    (self addIcon: (+ x (* 4 step)) y -1 V_ITEM)
    (self addIcon: (+ x (* 5 step)) y 4 ICON_INVENTORY)
    (self addIcon: (+ x (* 6 step)) y 5 ICON_MENU)
    (= dialog self))

  ;; An icon at (x, y): cel c of the bar's view (-1: the item in use), standing for `what`.
  (method (addIcon theX theY c what &tmp icon)
    (if (and (== c -1) (not theItem)) (return))
    (= icon
      ((Icon new:)
        view: (if (== c -1) (theItem view?) else view)
        loop: (if (and (!= c -1) (== what (user verb?))) 1 else 0)
        cel: (if (== c -1) 0 else c)
        actions: what
        size: size
        x: theX
        y: theY
        yourself:))
    (icon init:)
    (icon plane: uiPlane setPri: (+ (box priority?) 1))
    (icons add: icon))

  (method (hide)
    (if (== dialog self) (= dialog 0))
    (if icons
      (icons eachElementDo: #dispose)
      (icons dispose:)
      (= icons 0))
    (if box (box dispose:) (= box 0)))

  (method (dismiss)
    (self hide:))

  ;; While it's open, the pointer going well below it closes it too.
  (method (pointerAt theX theY)
    (if (and box (> theY (+ height ICON_BAR_SLACK))) (self hide:)))

  (method (handleEvent event &tmp icon what)
    (event claimed: TRUE)
    (if (!= (event type?) EV_MOUSE_DOWN) (return TRUE))
    (= icon (icons firstTrue: #onMe (event x?) (event y?)))
    (if (not icon)
      (self hide:)
      (return TRUE))
    (= what (icon actions?))
    (self hide:)
    (switch what
      (ICON_INVENTORY (inventory showSelf:))
      (ICON_MENU (game showMenu:))
      (else (user setVerb: what)))
    (return TRUE)))
