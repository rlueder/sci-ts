;;; hello: the smallest game that shows something and answers the mouse. A night sky
;;; (picture 100), a title in the default font, the default cursor, and a lantern (view 100)
;;; that goes wherever you click.
(script 0)

(public hello 0)

(define CURSOR_VIEW 999)
(define ALL_EVENTS $7fff)
(define MOUSE_DOWN 1)

;; What the interpreter reads from a plane: where it is, what it shows, how it's stacked.
(class Plane of Obj
  (properties
    priority 0
    inLeft 0 inTop 0 inRight 319 inBottom 199
    picture -1
    back 0))

;; A screen item: a view's cel, or a bitmap the scripts made.
(class Sprite of Obj
  (properties
    x 0 y 0 z 0
    view -1 loop 0 cel 0
    priority 0 fixPriority 0
    plane 0
    bitmap 0
    scaleSignal 0 scaleX 128 scaleY 128)

  (method (show)
    (AddScreenItem self))

  (method (moveTo newX newY)
    (= x newX)
    (= y newY)
    (UpdateScreenItem self)))

;; A line of text: the interpreter draws it into a bitmap, which the screen item shows.
(class Label of Sprite
  (properties
    text 0
    font 0
    fore 255
    back 254
    skip 254
    mode 1                          ; centred
    borderColor -1
    ;; an empty rectangle (right before left) means the whole bitmap
    textLeft 0 textTop 0 textRight -1 textBottom -1)

  (method (show)
    (= bitmap (CreateTextBitmap 0 320 12 self))
    (super show:)))

;; What GetEvent fills in.
(class Event of Obj
  (properties type 0 message 0 modifiers 0 x 0 y 0))

(class Game of Obj
  (method (play)
    (AddPlane screen)
    (title show:)
    (hint show:)
    (SetCursor CURSOR_VIEW 0 0)
    (lantern show:)
    (while TRUE
      (if (and (GetEvent ALL_EVENTS event) (== (event type?) MOUSE_DOWN))
        (lantern moveTo: (event x?) (event y?)))
      (FrameOut))))

(instance hello of Game)

(instance screen of Plane
  (properties picture 100))

(instance title of Label
  (properties
    plane screen
    y 12
    fixPriority 1 priority 200
    text "sci-ts: a game built from nothing"))

(instance hint of Label
  (properties
    plane screen
    y 182
    fixPriority 1 priority 200
    fore 230
    text "Click anywhere to move the lantern"))

(instance lantern of Sprite
  (properties plane screen view 100 x 160 y 150))

(instance event of Event)
