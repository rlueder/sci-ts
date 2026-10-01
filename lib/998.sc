;;; The world: the game and its main loop, rooms, and the things in them.
(script 998)
(include "system.sh")

;; A layer of the screen: a room's picture and what's on it, or text over the room.
(class Plane of Obj
  (properties
    priority 0
    inLeft 0 inTop 0 inRight 319 inBottom 199
    picture -1      ; -1: filled with `back`; -2: transparent
    back 0)

  (method (init)
    (AddPlane self))

  (method (dispose)
    (DeletePlane self)
    (super dispose:)))

;; The game: sets everything up, then runs one cycle after another until `quit`.
(class Game of Obj
  (properties
    script 0)

  (method (init)
    (= game self)
    (= cast (Set new:))
    (= features (Set new:))
    (= sounds (Set new:))
    (= theEvent (Event new:))
    (= messager (Messager new:))
    (= narrator (Narrator new:))
    (= textStyle (TextStyle new:))
    (= inventory (Inventory new:))
    (= music (Sound new:))
    (= sfx (Sound new:))
    (= uiPlane ((Plane new:) priority: 200 picture: -2 yourself:))
    (uiPlane init:)
    (= user (User new:))
    (user init:))

  (method (play)
    (self init:)
    (while (not quit)
      (self doit:)))

  ;; One cycle: scripts, the room, everything on screen, text, drawing, then input.
  (method (doit)
    (++ gameTime)
    (if script (script doit:))
    (sounds eachElementDo: #check)
    (if curRoom (curRoom doit:))
    (cast eachElementDo: #doit)
    (if talking (talking doit:))
    (FrameOut)
    (user doit:)
    (if newRoomNum (self newRoom: newRoomNum)))

  ;; Leaves the current room for room n (its script's export 0).
  (method (newRoom n &tmp old)
    (= newRoomNum 0)
    (if talking (talking clear:))
    (if dialog (dialog dispose:))
    (if curRoom
      (= old curRoomNum)
      (curRoom dispose:)
      (= curRoom 0)
      (DisposeScript old))
    (= prevRoomNum curRoomNum)
    (= curRoomNum n)
    (= curRoom (ScriptID n 0))
    (curRoom setUp:)
    (curRoom init:))

  (method (setScript s)
    (if script (script dispose:))
    (= script s)
    (if s (s init: self &rest)))

  ;; Clicks do nothing (but dismiss text) until handsOn: for cutscenes.
  (method (handsOff)
    (user canInput: FALSE showCursor:))

  (method (handsOn)
    (user canInput: TRUE showCursor:)))

;; A room: its picture, where you can walk, its exits, and what's said about it.
(class Room of Obj
  (properties
    picture -1
    plane 0
    obstacles 0     ; Polygons limiting where actors walk
    script 0
    noun 0
    modNum -1       ; its message file (the room's number unless set)
    north 0 south 0 east 0 west 0
    edgeN 40 edgeS 189 edgeE 319 edgeW 0)

  ;; Before init (the game calls it): the room's plane and its list of obstacles, so init
  ;; can add things in any order.
  (method (setUp)
    (if (== modNum -1) (= modNum curRoomNum))
    (= plane ((Plane new:) picture: picture priority: 1 yourself:))
    (plane init:)
    (= obstacles (List new:)))

  ;; What's in the room: rooms add their features, props and obstacles here.
  (method (init))

  ;; Leaves through an edge when the hero reaches it, if there's a room that way.
  (method (doit &tmp n)
    (if script (script doit:))
    (if (and ego (not newRoomNum) (== (ego plane?) plane))
      (= n
        (cond
          ((<= (ego y?) edgeN) north)
          ((>= (ego y?) edgeS) south)
          ((>= (ego x?) edgeE) east)
          ((<= (ego x?) edgeW) west)
          (else 0)))
      (if n (self newRoom: n))))

  (method (newRoom n)
    (= newRoomNum n))

  (method (setScript s)
    (if script (script dispose:))
    (= script s)
    (if s (s init: self &rest)))

  (method (addObstacle)
    (obstacles add: &rest))

  (method (doVerb verb)
    (messager say: noun verb 0 0 0 modNum))

  (method (dispose)
    (if script (script dispose:))
    ;; Everything in the room goes, except the hero, who walks into the next one.
    (cast eachElementDo: #roomDisposed)
    (features eachElementDo: #dispose)
    (obstacles eachElementDo: #dispose)
    (obstacles dispose:)
    (= obstacles 0)
    (plane dispose:)
    (= plane 0)))

;; Something in the room that answers clicks: a rectangle of the picture and a noun in the
;; room's message file.
(class Feature of Obj
  (properties
    x 0 y 0
    noun 0
    modNum -1
    nsLeft 0 nsTop 0 nsRight 0 nsBottom 0
    sightAngle 180
    approachX 0 approachY 0
    actions 0)      ; an object whose handleVerb: gets the first say (a Teller)

  (method (init)
    (if (== modNum -1) (= modNum curRoomNum))
    (features add: self))

  (method (dispose)
    (features delete: self)
    (super dispose:))

  (method (onMe theX theY)
    (return (and (>= theX nsLeft) (<= theX nsRight) (>= theY nsTop) (<= theY nsBottom))))

  ;; Says the line for this noun and verb; with none, the room answers.
  (method (doVerb verb)
    (if (and actions (actions handleVerb: verb)) (return))
    (if (not (and noun (messager say: noun verb 0 0 0 modNum)))
      (curRoom doVerb: verb))))

;; A Feature drawn with a view: a screen item in the room's plane.
(class View of Feature
  (properties
    view -1 loop 0 cel 0
    z 0
    priority 0 fixPriority 0
    plane 0
    bitmap 0
    signal 0
    scaleSignal 0 scaleX 128 scaleY 128
    brLeft 0 brTop 0 brRight 0 brBottom 0
    xStep 3 yStep 2)

  (method (init)
    (if (== modNum -1) (= modNum curRoomNum))
    (= plane (curRoom plane?))
    (cast add: self)
    (AddScreenItem self))

  (method (doit)
    (if (not (& signal SIG_HIDDEN)) (UpdateScreenItem self)))

  (method (onMe theX theY)
    (return (and (not (& signal SIG_HIDDEN)) (IsOnMe theX theY self))))

  (method (hide)
    (|= signal SIG_HIDDEN)
    (DeleteScreenItem self))

  (method (show)
    (if (& signal SIG_HIDDEN)
      (&= signal (~ SIG_HIDDEN))
      (AddScreenItem self)))

  ;; A loop that stays when the actor turns; -1 lets it follow the heading again.
  (method (setLoop l)
    (if (== l -1)
      (&= signal (~ SIG_FIXED_LOOP))
     else
      (= loop l)
      (|= signal SIG_FIXED_LOOP))
    (return self))

  (method (setCel c)
    (= cel c)
    (return self))

  ;; A fixed priority (drawn above things with lower ones); -1: by y again.
  (method (setPri p)
    (if (== p -1)
      (= fixPriority 0)
     else
      (= priority p)
      (= fixPriority 1))
    (return self))

  (method (posn newX newY)
    (= x newX)
    (= y newY)
    (return self))

  ;; The room is going: so is this.
  (method (roomDisposed)
    (self dispose:))

  (method (dispose)
    (if (not (& signal SIG_HIDDEN)) (DeleteScreenItem self))
    (cast delete: self)
    (DisposeClone self)))

;; A View that animates (a cycler) and can run a script.
(class Prop of View
  (properties
    cycler 0
    cycleSpeed 6    ; cycles between cels
    script 0)

  (method (doit)
    (if script (script doit:))
    (if cycler (cycler doit:))
    (super doit:))

  ;; cls is a Cycle class (a new one is made) or object; 0 stops cycling.
  (method (setCycle cls)
    (if cycler (cycler dispose:))
    (= cycler 0)
    (if cls
      (= cycler (if (& (cls -info-?) $8000) (cls new:) else cls))
      (cycler init: self &rest))
    (return self))

  (method (setScript s)
    (if script (script dispose:))
    (= script s)
    (if s (s init: self &rest))
    (return self))

  (method (dispose)
    (if cycler (cycler dispose:) (= cycler 0))
    (if script (script dispose:))
    (super dispose:)))

;; A Prop that moves (a mover), facing where it goes.
(class Actor of Prop
  (properties
    mover 0
    moveSpeed 2     ; cycles between steps
    heading 0
    scaler 0)       ; sizes it by where it stands (perspective)

  (method (doit)
    (if mover
      (mover doit:)
      (if (and mover (mover completed?)) (mover motionCue:)))
    (if scaler (scaler doit:))
    (BaseSetter self)
    (super doit:))

  ;; (actor setScaler: Scaler frontSize backSize frontY backY), sizes in percent; 0 stops.
  (method (setScaler cls)
    (if scaler (scaler dispose:))
    (= scaler 0)
    (if cls
      (= scaler (cls new:))
      (scaler init: self &rest)
     else
      (= scaleSignal 0))
    (return self))

  ;; cls is a Motion class (a new one is made) or object; 0 stops moving.
  (method (setMotion cls)
    (if mover (mover dispose:))
    (= mover 0)
    (if cls
      (= mover (if (& (cls -info-?) $8000) (cls new:) else cls))
      (mover init: self &rest))
    (return self))

  ;; Turns to face a direction (0 is up, clockwise in degrees); cues whoCares if given.
  (method (setHeading h whoCares)
    (= heading h)
    (DirLoop self h)
    (if (> argc 1) (whoCares cue:)))

  ;; Whether another actor is in the way (DoBresen asks).
  (method (cantBeHere)
    (return (CantBeHere self (cast elements?))))

  (method (dispose)
    (if mover (mover dispose:) (= mover 0))
    (if scaler (scaler dispose:) (= scaler 0))
    (super dispose:)))

;; The hero: walks where the player clicks, and goes from room to room.
(class Ego of Actor
  ;; Back to walking: cycling as he moves, turning as he goes, seen.
  (method (normalize)
    (self setLoop: -1 setCycle: Walk show:)
    (return self))

  (method (roomDisposed)
    (self setMotion: 0)
    (DeleteScreenItem self)
    (cast delete: self)))
