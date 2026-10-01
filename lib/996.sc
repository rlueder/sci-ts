;;; Talk: text on screen, who says it, the lines of message files said one after another,
;;; and conversations as menus of topics.
(script 996)
(include "system.sh")

;; How text boxes and menus look, for the whole game (the `textStyle` global): the font, the
;; ink, paper and border colours, and a frame drawn around each box instead of the border.
;; The game sets it in its init, after (super init:):
;;   (textStyle font: 1 fore: 3 back: 12 frame: 260)
;; A frame is a view whose loop 0 has eight cels, each anchored at its top-left corner: the
;; corners (top-left, top-right, bottom-left, bottom-right), then the edges (top, bottom, left,
;; right). The edges are tiled between the corners; transparent pixels show the paper.
(class TextStyle of Obj
  (properties
    font 0
    fore 0          ; ink
    back 255        ; paper
    border 0        ; a one-pixel border's colour; -1: none
    frame -1        ; a frame view, or -1
    margin 4))      ; between the text and the border or frame

;; A box of text over the room: drawn by the interpreter into a bitmap, shown as a screen
;; item in the UI plane. Set text (and width, x, y), then init; it's as tall as the text
;; unless height is set. Font, colours and frame come from the textStyle unless set here.
(class TextItem of Obj
  (properties
    x 0 y 0 z 0
    view -1 loop 0 cel 0
    priority 100 fixPriority 1
    plane 0
    bitmap 0
    scaleSignal 0 scaleX 128 scaleY 128
    text 0
    font -1         ; -1 here and below: the textStyle's
    fore -1
    back -1
    skip 254
    mode 0          ; 0 left, 1 centred
    borderColor -2  ; -1: none
    frame -2        ; -1: none
    textLeft 0 textTop 0 textRight -1 textBottom -1
    width 200
    height 0)

  (method (init &tmp r m padL padT padR padB)
    (if (== font -1) (= font (textStyle font?)))
    (if (== fore -1) (= fore (textStyle fore?)))
    (if (== back -1) (= back (textStyle back?)))
    (if (== frame -2) (= frame (textStyle frame?)))
    (if (== borderColor -2) (= borderColor (if (!= frame -1) -1 else (textStyle border?))))
    ;; As tall as the text needs, inside the margin and the frame.
    (= m (textStyle margin?))
    (= padL m) (= padT m) (= padR m) (= padB m)
    (if (!= frame -1)
      (+= padL (CelWide frame 0 6))
      (+= padR (CelWide frame 0 7))
      (+= padT (CelHigh frame 0 4))
      (+= padB (CelHigh frame 0 5)))
    (if (not height)
      (= r (Array ARRAY_NEW 4 0))
      (TextSize r text font (- width (+ padL padR)))
      (= height (+ (Array ARRAY_AT r 3) 1 padT padB))
      (Array ARRAY_FREE r))
    (= textLeft padL)
    (= textTop padT)
    (= textRight (- width (+ padR 1)))
    (= textBottom (- height (+ padB 1)))
    (= plane uiPlane)
    (= bitmap (CreateTextBitmap 0 width height self))
    (if (!= frame -1) (self drawFrame:))
    (AddScreenItem self))

  ;; The edges, tiled, then the corners over their ends.
  (method (drawFrame &tmp i step)
    (if (< (= step (CelWide frame 0 4)) 1) (= step 1))
    (for ((= i (CelWide frame 0 0))) (< i width) ((+= i step))
      (Bitmap BITMAP_DRAW_VIEW bitmap frame 0 4 i 0)
      (Bitmap BITMAP_DRAW_VIEW bitmap frame 0 5 i (- height (CelHigh frame 0 5))))
    (if (< (= step (CelHigh frame 0 6)) 1) (= step 1))
    (for ((= i (CelHigh frame 0 0))) (< i height) ((+= i step))
      (Bitmap BITMAP_DRAW_VIEW bitmap frame 0 6 0 i)
      (Bitmap BITMAP_DRAW_VIEW bitmap frame 0 7 (- width (CelWide frame 0 7)) i))
    (Bitmap BITMAP_DRAW_VIEW bitmap frame 0 0 0 0)
    (Bitmap BITMAP_DRAW_VIEW bitmap frame 0 1 (- width (CelWide frame 0 1)) 0)
    (Bitmap BITMAP_DRAW_VIEW bitmap frame 0 2 0 (- height (CelHigh frame 0 2)))
    (Bitmap BITMAP_DRAW_VIEW bitmap frame 0 3 (- width (CelWide frame 0 3)) (- height (CelHigh frame 0 3))))

  (method (onMe theX theY)
    (return (and (>= theX x) (< theX (+ x width)) (>= theY y) (< theY (+ y height)))))

  (method (dispose)
    (DeleteScreenItem self)
    (if bitmap (Bitmap BITMAP_DISPOSE bitmap) (= bitmap 0))
    (super dispose:)))

;; Shows a line until it's been there long enough to read, or the player clicks; then
;; cues whoever asked. The narrator speaks for no one in particular.
(class Narrator of Obj
  (properties
    caller 0
    box 0
    until 0         ; the game time it goes
    font -1         ; -1: the textStyle's
    x -1            ; -1: centred
    y 16
    width 220)

  (method (say txt whoCares)
    (self clear:)
    (if (and talking (!= talking self)) (talking clear:))
    (= caller (if (> argc 1) whoCares else 0))
    (= box
      ((TextItem new:)
        text: txt
        font: font
        width: width
        x: (if (== x -1) (/ (- SCREEN_WIDTH width) 2) else x)
        y: y
        yourself:))
    (box init:)
    (= talking self)
    ;; Two seconds, and more for longer lines.
    (= until (+ gameTime 120 (* 3 (String STRING_LENGTH txt)))))

  (method (doit)
    (if (and box (>= gameTime until)) (self done:)))

  ;; A click while a line is up dismisses it (and nothing else).
  (method (handleEvent event)
    (if (and box (== (event type?) EV_MOUSE_DOWN))
      (event claimed: TRUE)
      (self done:)
      (return TRUE))
    (return FALSE))

  (method (clear)
    (if box (box dispose:) (= box 0))
    (if (== talking self) (= talking 0)))

  (method (done &tmp c)
    (self clear:)
    (= c caller)
    (= caller 0)
    (if c (c cue:))))

;; Someone with a name: their lines start with it.
(class Talker of Narrator
  (properties
    line 0)

  (method (say txt whoCares)
    (if line (String ARRAY_FREE line))
    (= line (String 11 "%s: %s" name txt))
    (super say: line &rest whoCares)))

;; Someone with a portrait: a view whose loop 0 is the bust, loop 1 the mouth and loop 2 the
;; eyes, every cel the same size and anchored at its top-left corner. The room's talker hands
;; its parts to init: mouth bust eyes frame, where frame is drawn first (the bust), placed
;; where the portrait goes (the top left of the screen). The text goes to its right. While
;; the line is said the mouth moves, then closes; the eyes blink.
(class PortraitTalker of Talker
  (properties
    mouth 0 bust 0 eyes 0 frame 0
    priority 150
    mouthUntil 0)   ; the game time the mouth stops

  (method (init theMouth theBust theEyes theFrame)
    (= mouth theMouth)
    (= bust theBust)
    (= eyes theEyes)
    (= frame theFrame))

  (method (say txt whoCares &tmp portrait)
    (self init:)
    (= portrait (if frame frame else bust))
    (if portrait
      (= x (+ (portrait x?) (CelWide (portrait view?) (portrait loop?) (portrait cel?)) 6))
      (= y (portrait y?))
      (= width (- SCREEN_WIDTH (+ x 6))))
    (super say: txt &rest whoCares)
    (self showPart: frame priority)
    (self showPart: bust priority)
    (self showPart: eyes (+ priority 1))
    (self showPart: mouth (+ priority 1))
    (if eyes (eyes setCycle: Blink))
    (if mouth
      (mouth setCycle: Forward)
      ;; About as long as it takes to say: half a second, and two cycles a letter.
      (= mouthUntil (+ gameTime 30 (* 2 (String STRING_LENGTH txt))))))

  (method (doit)
    (if (and mouth (mouth cycler?) (>= gameTime mouthUntil))
      (mouth setCycle: 0 setCel: 0))
    (super doit:))

  (method (showPart part pri)
    (if part
      (part init:)
      (part plane: uiPlane setPri: pri)))

  (method (clear)
    (if frame (frame dispose:))
    (if bust (bust dispose:))
    (if eyes (eyes dispose:))
    (if mouth (mouth dispose:))
    (super clear:)))

;; Says the lines of a message file for a noun, verb and condition, in sequence:
;; (messager say: noun verb [cond [seq [caller [module]]]]). Each line goes to its talker.
;; Returns whether there was anything to say; cues the caller after the last line.
(class Messager of Obj
  (properties
    caller 0
    module 0
    noun 0 verb 0 cond 0 seq 0
    buffer 0)

  (method (say n v c s whoCares mod)
    (= noun n)
    (= verb v)
    (= cond (if (> argc 2) c else 0))
    (= seq (if (and (> argc 3) s) s else 1))
    (= module (if (and (> argc 5) (!= mod -1)) mod else curRoomNum))
    (if (not (Message 2 module noun verb cond seq))
      (return FALSE))
    (= caller (if (> argc 4) whoCares else 0))
    (self sayNext:)
    (return TRUE))

  (method (sayNext &tmp c talker)
    (if (not buffer) (= buffer (String ARRAY_NEW 400)))
    (if (Message 2 module noun verb cond seq)
      (= talker (Message 0 module noun verb cond seq buffer))
      (++ seq)
      ((self findTalker: talker) say: buffer self)
     else
      (= c caller)
      (= caller 0)
      (if c (c cue:))))

  ;; Who says lines with this talker number.
  (method (findTalker n)
    (cond
      ((and (== n TALKER_HERO) heroTalker) (return heroTalker))
      ((and (>= n ROOM_TALKERS) curRoom (curRoom respondsTo: #findTalker)) (return (curRoom findTalker: n)))
      (else (return narrator))))

  (method (cue)
    (self sayNext:)))

;; One choice in a Menu.
(class MenuItem of TextItem
  (properties
    value 0)

  (method (dispose)
    ;; Its text was made for it (a literal string is left alone).
    (String ARRAY_FREE text)
    (super dispose:)))

;; Choices in boxes, one under another; the first click on one ends it. While it's open it
;; gets every click (it's the `dialog`). The caller hears the choice by `choose: value`.
(class Menu of Obj
  (properties
    items 0
    caller 0
    y 20
    width 240)

  (method (add v txt &tmp item)
    (if (not items) (= items (List new:)))
    (= item ((MenuItem new:) value: v text: txt width: width x: (/ (- SCREEN_WIDTH width) 2) y: y yourself:))
    (item init:)
    (+= y (+ (item height?) 2))
    (items add: item)
    (return self))

  (method (show whoCares)
    (= caller whoCares)
    (= dialog self))

  (method (handleEvent event &tmp item v c)
    (event claimed: TRUE)
    (if (!= (event type?) EV_MOUSE_DOWN) (return TRUE))
    (= item (items firstTrue: #onMe (event x?) (event y?)))
    (if item
      (= v (item value?))
      (= c caller)
      (self dispose:)
      (c choose: v))
    (return TRUE))

  ;; Closed without a choice.
  (method (dismiss)
    (self dispose:))

  (method (dispose)
    (if (== dialog self) (= dialog 0))
    (if items
      (items eachElementDo: #dispose)
      (items dispose:)
      (= items 0))
    (super dispose:)))

;; A conversation with something: talking to it opens a menu of topics, choosing one says
;; the answer, and the menu comes back until the player says goodbye.
;;   (teller init: client modNum sayNoun verb rootNoun)
;; Topic n's label is the message rootNoun/verb/n, its answer sayNoun/verb/n. A room can
;; leave topics out (showCases: topic offered? ...), or answer one with a script
;; (sayMessage, with the topic in iconValue).
(class Teller of Obj
  (properties
    client 0
    modNum -1
    sayNoun 0
    verb 0
    rootNoun 0
    actionVerb V_TALK
    iconValue 0
    hidden 0)       ; topics left out, by number

  (method (init who mod sn v rn)
    (= client who)
    (= modNum mod)
    (= sayNoun sn)
    (= verb v)
    (= rootNoun rn)
    (client actions: self))

  (method (handleVerb v)
    (if (== v actionVerb)
      (self showMenu:)
      (return TRUE))
    (return FALSE))

  (method (showCases first &tmp i)
    (if (not hidden) (= hidden (Array ARRAY_NEW 141 0)))
    (for ((= i 0)) (< i argc) ((+= i 2))
      (Array ARRAY_AT_PUT hidden [first i] (not [first (+ i 1)]))))

  (method (showMenu &tmp menu topic buf)
    (self showCases:)
    (= menu (Menu new:))
    (for ((= topic 1)) (Message 2 modNum rootNoun verb topic 1) ((++ topic))
      (if (not (and hidden (Array ARRAY_AT hidden topic)))
        (= buf (String ARRAY_NEW 200))
        (Message 0 modNum rootNoun verb topic 1 buf)
        (menu add: topic buf)))
    (menu add: 0 "Goodbye.")
    (menu show: self))

  (method (choose v)
    (= iconValue v)
    (if v (self sayMessage:)))

  (method (sayMessage)
    (messager say: sayNoun verb iconValue 0 self modNum))

  ;; An answer is over: the topics again.
  (method (cue)
    (self showMenu:)))
