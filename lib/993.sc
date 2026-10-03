;;; Things: what the hero carries and the window to choose one from, and close looks at
;;; things.
(script 993)
(include "system.sh")

;; Something the hero can carry. Its view's loop 0 is its icon in the inventory window and
;; loop 1 the cursor while it's being used (the cel's anchor is the hotspot); both anchored
;; at the top-left corner. One that magnifies (a lens) has its glass as loop 2, placed like
;; the cursor: while it's in use, the room shows through the glass `magnify` times larger. Using it on something sends that thing doVerb: with the item's
;; own verb, 10 and up, so the room answers with noun and that verb (in Yarn, a node like
;; filings.lens: the game names its items' verbs in items.yaml).
(class InvItem of Obj
  (properties
    view -1
    verb 0
    magnify 0       ; 0, or how much bigger things look through it
    description 0)  ; what looking at it in the window says

  ;; Looked at in the inventory window.
  (method (doVerb v)
    (if (and (== v V_LOOK) description) (narrator say: description))))

;; What the hero carries (the `inventory` global): (inventory add: lens), (inventory
;; contains: lens). showSelf opens the window: the items in a row, one click picks one to
;; use (it becomes the cursor), a right-click on one looks at it, a click elsewhere closes.
;;
;; With `skin`, the window is that view (loop 0, cel 0, anchored at its top left) at x, y,
;; and the items go in a grid on it: `cols` across, the first slot at (slotLeft, slotTop) in
;; the skin and the rest slotWidth and slotHeight on, each icon `inset` into its slot.
;;   (inventory skin: 268 x: 32 y: 30 cols: 4 slotLeft: 13 slotTop: 28 slotWidth: 60
;;     slotHeight: 47 inset: 7 iconSize: 32)
(class Inventory of Set
  (properties
    window 0
    icons 0
    x -1            ; -1: centred
    y 24
    skin -1
    cols 4 slotLeft 0 slotTop 0 slotWidth 0 slotHeight 0 inset 0
    iconSize INV_ICON
    newest 0)       ; the item gained last (the icon bar offers it)

  (method (add item &tmp i)
    (super add: item &rest)
    (= newest [item (- argc 1)])
    (return self))

  (method (showSelf &tmp node item icon ix i)
    (if (not size)
      (narrator say: "You aren't carrying anything.")
      (return))
    (if (!= skin -1) (self showCase:) (return))
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
    (window x: (if (== x -1) (/ (- SCREEN_WIDTH (window width?)) 2) else x) y: y init:)
    (= icons (List new:))
    (= ix (+ (window x?) (window textLeft?) INV_GAP))
    (for ((= node (FirstNode elements))) node ((= node (NextNode node)))
      (= item (NodeValue node))
      ;; The icon keeps its item in `actions`.
      (= icon ((Icon new:) view: (item view?) loop: 0 cel: 0 actions: item size: iconSize x: ix y: (+ (window y?) (window textTop?) INV_GAP) yourself:))
      (icon init:)
      (icon plane: uiPlane setPri: (+ (window priority?) 1))
      (icons add: icon)
      (+= ix (+ iconSize INV_GAP)))
    (= dialog self))

  ;; The window as the skin, with the items in its slots (as many as it has).
  (method (showCase &tmp node item icon i wx wy)
    (= wx (if (== x -1) (/ (- SCREEN_WIDTH (CelWide skin 0 0)) 2) else x))
    (= wy y)
    (= window ((View new:) view: skin loop: 0 cel: 0 x: wx y: wy yourself:))
    (window init:)
    (window plane: uiPlane setPri: 100)
    (= icons (List new:))
    (= i 0)
    (for ((= node (FirstNode elements))) node ((= node (NextNode node)))
      (= item (NodeValue node))
      (= icon
        ((Icon new:)
          view: (item view?) loop: 0 cel: 0 actions: item size: iconSize
          x: (+ wx slotLeft (* (mod i cols) slotWidth) inset)
          y: (+ wy slotTop (* (/ i cols) slotHeight) inset)
          yourself:))
      (icon init:)
      (icon plane: uiPlane setPri: 101)
      (icons add: icon)
      (++ i))
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
    (super delete: item &rest)
    ;; Gone: the bar offers whatever is left, the last-gained first.
    (if (not (self contains: newest))
      (= newest (if size (NodeValue (LastNode elements)) else 0)))))

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
