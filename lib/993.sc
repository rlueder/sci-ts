;;; Things: what the hero carries and the window to choose one from, and close looks at
;;; things.
(script 993)
(include "system.sh")

;; Something the hero can carry. Its view's loop 0 is its icon in the inventory window and
;; loop 1 the cursor while it's being used (the cel's anchor is the hotspot); both anchored
;; at the top-left corner. Using it on something sends that thing doVerb: with the item's
;; own verb, 10 and up, so the room answers with noun and that verb (in Yarn, a node like
;; filings.lens: the game names its items' verbs in items.yaml).
(class InvItem of Obj
  (properties
    view -1
    verb 0
    description 0)  ; what looking at it in the window says

  ;; Looked at in the inventory window.
  (method (doVerb v)
    (if (and (== v V_LOOK) description) (narrator say: description))))

;; What the hero carries (the `inventory` global): (inventory add: lens), (inventory
;; contains: lens). showSelf opens the window: the items in a row, one click picks one to
;; use (it becomes the cursor), a right-click on one looks at it, a click elsewhere closes.
(class Inventory of Set
  (properties
    window 0
    icons 0
    y 24)

  (method (showSelf &tmp node item icon x)
    (if (not size)
      (narrator say: "You aren't carrying anything.")
      (return))
    (= window
      ((TextItem new:)
        text: ""
        width: (+ (* size (+ INV_ICON INV_GAP)) INV_GAP (* 2 (textStyle margin?)))
        height: (+ INV_ICON (* 2 INV_GAP) (* 2 (textStyle margin?)))
        yourself:))
    (if (!= (textStyle frame?) -1)
      (window
        width: (+ (window width?) (CelWide (textStyle frame?) 0 6) (CelWide (textStyle frame?) 0 7))
        height: (+ (window height?) (CelHigh (textStyle frame?) 0 4) (CelHigh (textStyle frame?) 0 5))))
    (window x: (/ (- SCREEN_WIDTH (window width?)) 2) y: y init:)
    (= icons (List new:))
    (= x (+ (window x?) (window textLeft?) INV_GAP))
    (for ((= node (FirstNode elements))) node ((= node (NextNode node)))
      (= item (NodeValue node))
      ;; The icon keeps its item in `actions`.
      (= icon ((Icon new:) view: (item view?) loop: 0 cel: 0 actions: item x: x y: (+ (window y?) (window textTop?) INV_GAP) yourself:))
      (icon init:)
      (icon plane: uiPlane setPri: (+ (window priority?) 1))
      (icons add: icon)
      (+= x (+ INV_ICON INV_GAP)))
    (= dialog self))

  ;; The item whose icon is at (x, y), or 0.
  (method (itemAt ex ey &tmp icon)
    (= icon (icons firstTrue: #onMe ex ey))
    (return (if icon (icon actions?) else 0)))

  (method (handleEvent event &tmp item)
    (event claimed: TRUE)
    (if (!= (event type?) EV_MOUSE_DOWN) (return TRUE))
    (= item (self itemAt: (event x?) (event y?)))
    (cond
      ((not item) (self hide:))
      ((& (event modifiers?) MOD_RIGHT) (item doVerb: V_LOOK))
      (else
        (self hide:)
        (user useItem: item)))
    (return TRUE))

  (method (hide)
    (if (== dialog self) (= dialog 0))
    (if icons
      (icons eachElementDo: #dispose)
      (icons dispose:)
      (= icons 0))
    (if window (window dispose:) (= window 0)))

  (method (dismiss)
    (self hide:))

  (method (delete item)
    (if (== theItem item) (user useItem: 0))
    (super delete: item &rest)))

;; A close look at something: a view shown in the middle of the screen with the room dimmed
;; behind it, until a click; then it goes, and whoever asked is cued.
;;   ((CloseUp new:) show: view [loop [cel [whoCares]]])
;; Its cels are anchored at their top-left corner. The dimming is the library's view 996,
;; drawn in remap colour 253 (which the art palette keeps free) at `dim` percent.
(class CloseUp of Obj
  (properties
    shade 0
    picture 0
    caller 0
    dim 50)

  (method (show v l c whoCares &tmp lp cl)
    (= lp (if (> argc 1) l else 0))
    (= cl (if (> argc 2) c else 0))
    (= caller (if (> argc 3) whoCares else 0))
    (RemapColors REMAP_BY_PERCENT 253 dim)
    (= shade ((View new:) view: CLOSE_UP_SHADE x: 0 y: 0 yourself:))
    (shade init:)
    (shade plane: uiPlane setPri: 10)
    (= picture
      ((View new:)
        view: v loop: lp cel: cl
        x: (/ (- SCREEN_WIDTH (CelWide v lp cl)) 2)
        y: (/ (- SCREEN_HEIGHT (CelHigh v lp cl)) 2)
        yourself:))
    (picture init:)
    (picture plane: uiPlane setPri: 20)
    (= dialog self))

  (method (handleEvent event)
    (event claimed: TRUE)
    (if (== (event type?) EV_MOUSE_DOWN)
      (self close:))
    (return TRUE))

  (method (dismiss)
    (self close:))

  (method (close &tmp c)
    (if (== dialog self) (= dialog 0))
    (if picture (picture dispose:) (= picture 0))
    (if shade (shade dispose:) (= shade 0))
    (RemapColors REMAP_OFF 253)
    (= c caller)
    (self dispose:)
    (if c (c cue:))))
