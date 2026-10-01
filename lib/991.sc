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
;; icons are the cels of `view`, loop 0 as they are and loop 1 picked, each ICON_SIZE
;; square and anchored at the top-left corner: walk, look, do, talk, the inventory, the
;; game menu (the item in use shows its own icon). A game with its own sets view in its
;; init: (iconBar view: 266). Picking one, or a click below the bar, closes it.
(class IconBar of Obj
  (properties
    view ICON_BAR_VIEW
    box 0
    icons 0
    height 0)

  (method (show &tmp x)
    (if box (return))
    (= box
      ((TextItem new:)
        text: ""
        width: SCREEN_WIDTH
        height: (+ ICON_SIZE (* 2 ICON_GAP) (* 2 (textStyle margin?)))
        x: 0 y: 0
        yourself:))
    (if (!= (textStyle frame?) -1)
      (box height: (+ (box height?) (CelHigh (textStyle frame?) 0 4) (CelHigh (textStyle frame?) 0 5))))
    (box init:)
    (= height (box height?))
    (= icons (List new:))
    (= x (+ (box textLeft?) ICON_GAP))
    ;; The verbs, then the item, the inventory and the menu.
    (self addIcon: x 0 V_WALK)
    (+= x (+ ICON_SIZE ICON_GAP))
    (self addIcon: x 1 V_LOOK)
    (+= x (+ ICON_SIZE ICON_GAP))
    (self addIcon: x 2 V_DO)
    (+= x (+ ICON_SIZE ICON_GAP))
    (self addIcon: x 3 V_TALK)
    (+= x (+ ICON_SIZE ICON_GAP))
    (self addIcon: x -1 V_ITEM)
    (+= x (+ ICON_SIZE ICON_GAP))
    (self addIcon: x 4 ICON_INVENTORY)
    (+= x (+ ICON_SIZE ICON_GAP))
    (self addIcon: x 5 ICON_MENU)
    (= dialog self))

  ;; An icon at x: cel c of the bar's view (-1: the item in use), standing for `what`.
  (method (addIcon theX c what &tmp icon)
    (if (and (== c -1) (not theItem)) (return))
    (= icon
      ((Icon new:)
        view: (if (== c -1) (theItem view?) else view)
        loop: (if (and (!= c -1) (== what (user verb?))) 1 else 0)
        cel: (if (== c -1) 0 else c)
        actions: what
        x: theX
        y: (+ (box textTop?) ICON_GAP)
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
