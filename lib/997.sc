;;; Motion: movers that walk actors, polygons that say where they can walk, and cyclers
;;; that animate props.
(script 997)
(include "system.sh")

;; Walks its client in a straight line to (x, y), a step (xStep, yStep) every
;; moveSpeed cycles. The interpreter does the stepping (InitBresen, DoBresen) and sends
;; moveDone on arrival; the client then calls motionCue:, which cues the caller.
(class Motion of Obj
  (properties
    client 0
    caller 0
    x 0 y 0
    dx 0 dy 0
    b-moveCnt 0 b-i1 0 b-i2 0 b-di 0 b-xAxis 0 b-incr 0
    completed 0)

  (method (init who toX toY whoCares)
    (= client who)
    (= caller (if (> argc 3) whoCares else 0))
    (= completed FALSE)
    (self setTarget: toX toY))

  (method (setTarget toX toY)
    (= x toX)
    (= y toY)
    (= b-moveCnt gameTime)
    (client setHeading: (GetAngle (client x?) (client y?) x y))
    (InitBresen self))

  (method (doit)
    (if (>= (- gameTime b-moveCnt) (client moveSpeed?))
      (= b-moveCnt gameTime)
      (DoBresen self)))

  (method (moveDone)
    (= completed TRUE))

  ;; The client is done with this mover: it goes, and the caller hears about it.
  (method (motionCue &tmp c)
    (= c caller)
    (client mover: 0)
    (self dispose:)
    (if c (c cue:))))

(class MoveTo of Motion)

;; Walks around the room's obstacles: AvoidPath finds the way, and the mover walks it a
;; corner at a time.
(class PolyPath of Motion
  (properties
    points 0        ; the path: x y pairs, ending in PATH_END
    value 0)        ; where in it the next corner is

  (method (init who toX toY whoCares &tmp polygons)
    (= client who)
    (= caller (if (> argc 3) whoCares else 0))
    (= completed FALSE)
    (= polygons
      (if (and curRoom (curRoom obstacles?))
        ((curRoom obstacles?) elements?)
       else 0))
    (= points (AvoidPath (who x?) (who y?) toX toY polygons))
    ;; The first point is where the client stands.
    (= value 2)
    (self nextPoint:))

  (method (nextPoint &tmp px py)
    (= px (Array ARRAY_AT points value))
    (= py (Array ARRAY_AT points (+ value 1)))
    (+= value 2)
    (if (== px PATH_END)
      (= completed TRUE)
     else
      (self setTarget: px py)))

  (method (moveDone)
    (self nextPoint:))

  (method (dispose)
    (if points (Array ARRAY_FREE points) (= points 0))
    (super dispose:)))

;; An area that limits walking: (poly type: PT_BARRED init: x1 y1 x2 y2 ...).
(class Polygon of Obj
  (properties
    size 0          ; corners
    points 0        ; x y pairs
    type PT_BARRED
    dynamic 0)

  (method (init first &tmp i)
    (= size (/ argc 2))
    (= points (Array ARRAY_NEW argc 0))
    (for ((= i 0)) (< i argc) ((++ i))
      (Array ARRAY_AT_PUT points i [first i]))
    (return self))

  (method (dispose)
    (if points (Array ARRAY_FREE points) (= points 0))
    (super dispose:)))

;; Changes its client's cel every cycleSpeed cycles.
(class Cycle of Obj
  (properties
    client 0
    caller 0
    cycleDir 1
    cycleCnt 0
    completed 0)

  (method (init who whoCares)
    (= client who)
    (= caller (if (> argc 1) whoCares else 0))
    (= cycleCnt gameTime)
    (= completed FALSE))

  ;; The cel to show now: the next one if it's time, else the current one.
  (method (nextCel)
    (if (< (- gameTime cycleCnt) (client cycleSpeed?))
      (return (client cel?)))
    (= cycleCnt gameTime)
    (return (+ (client cel?) cycleDir)))

  (method (lastCel)
    (return (- (NumCels client) 1)))

  (method (cycleDone &tmp c)
    (= completed TRUE)
    (= c caller)
    (client cycler: 0)
    (self dispose:)
    (if c (c cue:))))

;; Round and round.
(class Forward of Cycle
  (method (doit &tmp c)
    (= c (self nextCel:))
    (if (> c (self lastCel:)) (= c 0))
    (client cel: c)))

;; Round and round while the client moves; cel 0 when it stands.
(class Walk of Forward
  (method (doit)
    (if (client mover?)
      (super doit:)
     else
      (client cel: 0))))

;; To the last cel, then done.
(class End of Cycle
  (method (doit &tmp c)
    (= c (self nextCel:))
    (if (> c (self lastCel:))
      (self cycleDone:)
     else
      (client cel: c))))

;; Back to cel 0, then done.
(class Beg of Cycle
  (method (init who)
    (super init: &rest who)
    (= cycleDir -1))

  (method (doit &tmp c)
    (= c (self nextCel:))
    (if (< c 0)
      (self cycleDone:)
     else
      (client cel: c))))

;; Eyes: cel 0 (open) most of the time; every two or three seconds, the other cels in turn
;; (shut) and back to 0.
(class Blink of Cycle
  (properties
    restSince 0
    restFor 0)

  (method (init who)
    (super init: who)
    (self rest:))

  (method (rest)
    (= restSince gameTime)
    (= restFor (+ 90 (Random 0 90))))

  (method (doit &tmp c)
    (if (== (client cel?) 0)
      (if (and (>= (- gameTime restSince) restFor) (> (self lastCel:) 0))
        (= cycleCnt gameTime)
        (client cel: 1))
     else
      (= c (self nextCel:))
      (if (> c (self lastCel:))
        (client cel: 0)
        (self rest:)
       else
        (client cel: c)))))

;; Sizes its client by how far up the screen it stands: frontSize percent at frontY,
;; backSize at backY, in between in proportion.
(class Scaler of Obj
  (properties
    client 0
    frontSize 100 backSize 100
    frontY 190 backY 0)

  (method (init who fs bs fy by)
    (= client who)
    (= frontSize fs)
    (= backSize bs)
    (= frontY fy)
    (= backY by)
    (self doit:))

  (method (doit &tmp y pct)
    (= y (client y?))
    (= pct
      (cond
        ((>= y frontY) frontSize)
        ((<= y backY) backSize)
        (else (+ backSize (/ (* (- frontSize backSize) (- y backY)) (- frontY backY))))))
    (client
      scaleX: (/ (* pct 128) 100)
      scaleY: (/ (* pct 128) 100)
      scaleSignal: (| (client scaleSignal?) SCALE_ON))))

;; Sizes its client on a floor seen at an angle, where one line across the screen isn't the
;; same depth all the way along. Sizes are measured at the back and front of the floor at
;; three places across it (left, middle, right): at each of those, size changes in a straight
;; line with y, as perspective does; between them, in a straight line with x.
;;   (actor setScaler: FloorScaler x1 backY1 back1 frontY1 front1  x2 ...  x3 ...)
(class FloorScaler of Scaler
  (properties
    x1 0 yb1 0 sb1 100 yf1 1 sf1 100
    x2 1 yb2 0 sb2 100 yf2 1 sf2 100
    x3 2 yb3 0 sb3 100 yf3 1 sf3 100)

  (method (init who a1 b1 c1 d1 e1 a2 b2 c2 d2 e2 a3 b3 c3 d3 e3)
    (= client who)
    (= x1 a1) (= yb1 b1) (= sb1 c1) (= yf1 d1) (= sf1 e1)
    (= x2 a2) (= yb2 b2) (= sb2 c2) (= yf2 d2) (= sf2 e2)
    (= x3 a3) (= yb3 b3) (= sb3 c3) (= yf3 d3) (= sf3 e3)
    (self doit:))

  ;; The size at y where one place was measured: the straight line through its back and front.
  (method (along y yb sb yf sf)
    (return (+ sb (/ (* (- sf sb) (- y yb)) (- yf yb)))))

  (method (doit &tmp x y a b c pct)
    (= x (client x?))
    (= y (client y?))
    (= a (self along: y yb1 sb1 yf1 sf1))
    (= b (self along: y yb2 sb2 yf2 sf2))
    (= c (self along: y yb3 sb3 yf3 sf3))
    (= pct
      (cond
        ((<= x x1) a)
        ((< x x2) (+ a (/ (* (- b a) (- x x1)) (- x2 x1))))
        ((< x x3) (+ b (/ (* (- c b) (- x x2)) (- x3 x2))))
        (else c)))
    (if (< pct 1) (= pct 1))
    (client
      scaleX: (/ (* pct 128) 100)
      scaleY: (/ (* pct 128) 100)
      scaleSignal: (| (client scaleSignal?) SCALE_ON))))
