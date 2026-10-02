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
    margin 4        ; between the text and the border or frame
    portraitFrame -1 ; a view around portraits: loop 0 behind the face, loop 1 over its edges
    portraitX 8     ; where a portrait's face goes on the left (mirrored on the right)
    portraitY 8
    nameFont -1))   ; the font for a speaker's name before their line (-1: the text's)

;; A box of text over the room: drawn by the interpreter into a bitmap, shown as a screen
;; item in the UI plane. Set text (and width, x, y), then init; it's as tall as the text
;; unless height is set. Font, colours and frame come from the textStyle unless set here.
;; With bottom set, y is worked out so the box ends there: it grows upwards with the text.
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
    height 0
    bottom -1)      ; -1: placed at y

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
    (if (!= bottom -1) (= y (- bottom height)))
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

;; Shows a line until it's been there long enough to read (as long as `textSpeed` says), or
;; the player clicks or presses Enter, Space or "."; then cues whoever asked. The narrator
;; speaks for no one in particular.
;;
;; A line from a message file (the Messager sets module, noun, verb, cond and seq before
;; say:) is heard too if it has a recording, unless `speech` is SPEECH_TEXT. A heard line
;; stays until its recording ends, and a moment more; with SPEECH_VOICE it isn't shown.
(class Narrator of Obj
  (properties
    caller 0
    box 0
    shownAt 0       ; the game time it went up (or its recording ended)
    readFor 0       ; how long it stays (-1: until dismissed, or while it's heard)
    voiced 0        ; its recording is playing
    module 0        ; the message the next say: is, if it's one (set by the Messager)
    noun 0 verb 0 cond 0 seq 0
    font -1         ; -1: the textStyle's
    x -1            ; -1: centred
    y 16            ; below 0: that far above the bottom of the screen, growing upwards
    width 220)

  (method (say txt whoCares)
    (self clear:)
    (if (and talking (!= talking self)) (talking clear:))
    (= caller (if (> argc 1) whoCares else 0))
    (if (and module (!= speech SPEECH_TEXT))
      (= voiced (!= 0 (DoAudio 2 module noun verb cond seq))))
    (= module 0)
    (if (or (not voiced) (!= speech SPEECH_VOICE))
      (= box
        ((TextItem new:)
          text: txt
          font: font
          width: width
          x: (if (== x -1) (/ (- SCREEN_WIDTH width) 2) else x)
          y: (if (< y 0) 0 else y)
          bottom: (if (< y 0) (+ SCREEN_HEIGHT y) else -1)
          yourself:))
      (box init:))
    (= talking self)
    (= shownAt gameTime)
    (= readFor (if voiced -1 else (self readingTime: (String STRING_LENGTH txt)))))

  ;; Cycles to read a line of n characters: normally two seconds, and more for longer lines;
  ;; -1 is until the player dismisses it.
  (method (readingTime n)
    (switch textSpeed
      (TEXT_SLOW (return (+ 180 (* 5 n))))
      (TEXT_FAST (return (+ 70 (* 2 n))))
      (TEXT_CLICK (return -1))
      (else (return (+ 120 (* 3 n))))))

  ;; Time is measured as cycles since, which stays right when gameTime wraps past 32767.
  ;; When a heard line's recording ends, it stays a moment (or until a click, if the text
  ;; is up and that's the text speed).
  (method (doit)
    (if (and voiced (== (DoAudio 6) -1))
      (= voiced 0)
      (= shownAt gameTime)
      (= readFor (if (and box (== textSpeed TEXT_CLICK)) -1 else VOICE_PAUSE)))
    (if (and (== talking self) (!= readFor -1) (>= (- gameTime shownAt) readFor)) (self done:)))

  ;; A click, Enter, Space or "." while a line is up dismisses it (and nothing else).
  (method (handleEvent event)
    (if (and (== talking self)
          (or (== (event type?) EV_MOUSE_DOWN)
            (and (== (event type?) EV_KEY_DOWN)
              (or (== (event message?) KEY_ENTER) (== (event message?) KEY_SPACE) (== (event message?) KEY_PERIOD)))))
      (event claimed: TRUE)
      (self done:)
      (return TRUE))
    (return FALSE))

  (method (clear)
    (if voiced (DoAudio 3) (= voiced 0))
    (if box (box dispose:) (= box 0))
    (if (== talking self) (= talking 0)))

  (method (done &tmp c)
    (self clear:)
    (= c caller)
    (= caller 0)
    (if c (c cue:))))

;; Someone with a name: their lines start with it (in the textStyle's nameFont, if it has one).
(class Talker of Narrator
  (properties
    line 0)

  (method (say txt whoCares)
    (if line (String ARRAY_FREE line))
    (= line
      (if (!= (textStyle nameFont?) -1)
        (String 11 "|f%d|%s:|f| %s" (textStyle nameFont?) name txt)
       else
        (String 11 "%s: %s" name txt)))
    (super say: line &rest whoCares)))

;; Someone with a portrait: a view whose loop 0 is the bust, loop 1 the mouth and loop 2 the
;; eyes, every cel the same size and anchored at its top-left corner; loops 3 to 5, if there
;; are any, are the same facing left. A room's talker is handed its parts (init: mouth bust
;; eyes frame, where frame is drawn as the bust); one with a view of its own (the hero's)
;; makes them. While the line is said the mouth moves, then closes; the eyes blink.
;;
;; The portrait goes at the top left facing right, or the top right facing left, with the
;; text beside it on the side towards the middle. A character takes the side of the hero
;; it stands on (who: is its body in the room; without one, the right); the hero takes the
;; side opposite whoever spoke last. The textStyle places it (portraitX, portraitY) and can
;; frame it (portraitFrame).
(class PortraitTalker of Talker
  (properties
    mouth 0 bust 0 eyes 0 frame 0
    view -1         ; the portrait's view, for a talker that makes its own parts
    who 0           ; the character's body in the room
    side 0          ; where the portrait is: 0 the left, 1 the right
    otherSide 1     ; the hero's: the side of whoever spoke last
    back 0 front 0  ; the portraitFrame, behind the face and over its edges
    priority 150
    mouthFor 0)     ; cycles the mouth moves for

  (method (init theMouth theBust theEyes theFrame)
    (if argc
      (= mouth theMouth)
      (= bust theBust)
      (= eyes theEyes)
      (= frame theFrame)))

  (method (makeParts)
    (if (and (!= view -1) (not bust) (not frame))
      (= bust ((View new:) view: view yourself:))
      (= mouth ((Prop new:) view: view yourself:))
      (= eyes ((Prop new:) view: view yourself:))))

  ;; This line's side: see above. A side whose portrait would cover the speaker or the hero
  ;; (a face under the frame) gives way to the other, if that one covers no one.
  (method (pickSide face &tmp s)
    (= s
      (cond
        ((== self heroTalker) (- 1 otherSide))
        ((and who ego (< (who x?) (ego x?))) 0)
        (else 1)))
    (if (and face (self covers: face s) (not (self covers: face (- 1 s)))) (= s (- 1 s)))
    (if (and (!= self heroTalker) heroTalker (heroTalker respondsTo: #otherSide)) (heroTalker otherSide: s))
    (return s))

  ;; Whether the portrait on side s (frame and all) would be over the speaker or the hero.
  (method (covers face s &tmp pw ph over left right bottom)
    (= pw (CelWide (face view?) 0 0))
    (= ph (CelHigh (face view?) 0 0))
    (= over (if (!= (textStyle portraitFrame?) -1) (/ (- (CelWide (textStyle portraitFrame?) 0 0) pw) 2) else 0))
    (= left (if s (- SCREEN_WIDTH (+ (textStyle portraitX?) pw over)) else (- (textStyle portraitX?) over)))
    (= right (+ left pw over over))
    (= bottom (+ (textStyle portraitY?) ph over))
    (return
      (or
        (self over: (if (== self heroTalker) ego else who) left right bottom)
        (and (!= self heroTalker) (self over: ego left right bottom)))))

  ;; Whether someone's figure reaches into the screen's top band from left to right, down to bottom.
  (method (over body left right bottom &tmp w h)
    (if (or (not body) (not (body respondsTo: #view)) (& (body signal?) SIG_HIDDEN)) (return FALSE))
    (= w (CelWide (body view?) (body loop?) (body cel?)))
    (= h (CelHigh (body view?) (body loop?) (body cel?)))
    (if (& (body scaleSignal?) SCALE_ON)
      (= w (/ (* w (body scaleX?)) 128))
      (= h (/ (* h (body scaleY?)) 128)))
    (return
      (and (< (- (body x?) (/ w 2)) right) (> (+ (body x?) (/ w 2)) left) (< (- (body y?) h) bottom))))

  (method (say txt whoCares &tmp face l pw f fx fy over)
    (self init: makeParts:)
    (= face (if frame frame else bust))
    (if face
      (= side (self pickSide: face))
      (= l (if (and side (>= (NumLoops face) 6)) 3 else 0))
      (= pw (CelWide (face view?) l 0))
      (= f (textStyle portraitFrame?))
      (= over (if (!= f -1) (/ (- (CelWide f 0 0) pw) 2) else 0))
      (= fx (if side (- SCREEN_WIDTH (+ (textStyle portraitX?) pw)) else (textStyle portraitX?)))
      (= fy (textStyle portraitY?))
      (face x: fx y: fy loop: l cel: 0)
      (if mouth (mouth x: fx y: fy loop: (+ l 1) cel: 0))
      (if eyes (eyes x: fx y: fy loop: (+ l 2) cel: 0))
      (if (!= f -1)
        (if (not back) (= back ((View new:) view: f loop: 0 cel: 0 yourself:)))
        (back x: fx y: fy)
        (if (and (not front) (>= (NumLoops back) 2)) (= front ((View new:) view: f loop: 1 cel: 0 yourself:)))
        (if front (front x: fx y: fy)))
      ;; The text beside it, towards the middle.
      (= y fy)
      (if side
        (= x 6)
        (= width (- fx (+ over 12)))
       else
        (= x (+ fx pw over 6))
        (= width (- SCREEN_WIDTH (+ x 6)))))
    (super say: txt &rest whoCares)
    (self showPart: back (- priority 1))
    (self showPart: face priority)
    (self showPart: mouth (+ priority 1))
    (self showPart: eyes (+ priority 1))
    (self showPart: front (+ priority 2))
    (if eyes (eyes setCycle: Blink))
    (if mouth
      (mouth setCycle: Forward)
      ;; While it's heard; or about as long as it takes to say: half a second, and two
      ;; cycles a letter.
      (= mouthFor (if voiced 0 else (+ 30 (* 2 (String STRING_LENGTH txt)))))))

  (method (doit)
    (if (and mouth (mouth cycler?) (not voiced) (>= (- gameTime shownAt) mouthFor))
      (mouth setCycle: 0 setCel: 0))
    (super doit:))

  (method (showPart part pri)
    (if part
      (part init:)
      (part plane: uiPlane setPri: pri)))

  ;; Off the screen, kept for the next line.
  (method (hidePart part)
    (if part
      (DeleteScreenItem part)
      (cast delete: part)))

  (method (clear)
    (self hidePart: front)
    (self hidePart: back)
    (self hidePart: frame)
    (self hidePart: bust)
    (self hidePart: eyes)
    (self hidePart: mouth)
    (super clear:)))

;; Says the lines of a message file for a noun, verb and condition, in sequence:
;; (messager say: noun verb [cond [seq [caller [module]]]]). Each line goes to its talker,
;; told which message it is so it can play the line's recording.
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
      (= talker (self findTalker: (Message 0 module noun verb cond seq buffer)))
      (talker module: module noun: noun verb: verb cond: cond seq: seq)
      (++ seq)
      (talker say: buffer self)
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

;; Choices one under another in a box (the textStyle's frame around them all); the first
;; click on one ends it. While it's open it gets every click (it's the `dialog`). The caller
;; hears the choice by `choose: value`.
(class Menu of Obj
  (properties
    items 0
    caller 0
    panel 0
    y 20            ; the top of the box
    width 240
    next 0)         ; where the next choice goes

  (method (add v txt &tmp item f)
    (= f (textStyle frame?))
    (if (not items)
      (= items (List new:))
      (= next (+ y (if (!= f -1) (CelHigh f 0 4) else 1))))
    (= item
      ((MenuItem new:)
        value: v
        text: txt
        frame: -1
        borderColor: -1
        width: (- width (if (!= f -1) (+ (CelWide f 0 6) (CelWide f 0 7)) else 2))
        x: (+ (/ (- SCREEN_WIDTH width) 2) (if (!= f -1) (CelWide f 0 6) else 1))
        y: next
        yourself:))
    (item init:)
    (+= next (item height?))
    (items add: item)
    (return self))

  ;; The box behind the choices, then it waits for one.
  (method (show whoCares &tmp f)
    (= f (textStyle frame?))
    (= caller whoCares)
    (if items
      (= panel
        ((TextItem new:)
          text: ""
          x: (/ (- SCREEN_WIDTH width) 2)
          y: y
          width: width
          height: (+ (- next y) (if (!= f -1) (CelHigh f 0 5) else 1))
          priority: 99
          yourself:))
      (panel init:))
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
    (if panel (panel dispose:) (= panel 0))
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
