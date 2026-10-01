;;; Talk: text on screen, and the lines of message files said one after another.
(script 996)
(include "system.sh")

;; A box of text over the room: drawn by the interpreter into a bitmap, shown as a screen
;; item in the UI plane. Set text (and font, colours, width), then init.
(class TextItem of Obj
  (properties
    x 0 y 0 z 0
    view -1 loop 0 cel 0
    priority 100 fixPriority 1
    plane 0
    bitmap 0
    scaleSignal 0 scaleX 128 scaleY 128
    text 0
    font 0
    fore 0
    back 255
    skip 254
    mode 0          ; 0 left, 1 centred
    borderColor 0
    textLeft 0 textTop 0 textRight -1 textBottom -1
    width 200
    height 0)

  (method (init &tmp r)
    ;; As tall as the text needs, with a 4-pixel margin inside the border.
    (= r (Array ARRAY_NEW 4 0))
    (TextSize r text font (- width 8))
    (= height (+ (Array ARRAY_AT r 3) 9))
    (Array ARRAY_FREE r)
    (= textLeft 4)
    (= textTop 4)
    (= textRight (- width 5))
    (= textBottom (- height 5))
    (= plane uiPlane)
    (= bitmap (CreateTextBitmap 0 width height self))
    (AddScreenItem self))

  (method (dispose)
    (DeleteScreenItem self)
    (if bitmap (Bitmap 1 bitmap) (= bitmap 0))
    (super dispose:)))

;; Shows a line until it's been there long enough to read, or the player clicks; then
;; cues whoever asked.
(class Narrator of Obj
  (properties
    caller 0
    box 0
    until 0         ; the game time it goes
    font 0
    width 220
    y 16)

  (method (say txt whoCares)
    (self clear:)
    (= caller (if (> argc 1) whoCares else 0))
    (= box ((TextItem new:) text: txt font: font width: width x: (/ (- SCREEN_WIDTH width) 2) y: y yourself:))
    (box init:)
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
    (if box (box dispose:) (= box 0)))

  (method (done &tmp c)
    (self clear:)
    (= c caller)
    (= caller 0)
    (if c (c cue:))))

;; Says the lines of a message file for a noun, verb and condition, in sequence:
;; (messager say: noun verb [cond [seq [caller [module]]]]). Returns whether there was
;; anything to say; cues the caller after the last line.
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

  (method (sayNext &tmp c)
    (if (not buffer) (= buffer (String ARRAY_NEW 400)))
    (if (Message 2 module noun verb cond seq)
      (Message 0 module noun verb cond seq buffer)
      (++ seq)
      (narrator say: buffer self)
     else
      (= c caller)
      (= caller 0)
      (if c (c cue:))))

  (method (cue)
    (self sayNext:)))
