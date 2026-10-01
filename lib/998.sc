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
    (narrator doit:)
    (FrameOut)
    (user doit:)
    (if newRoomNum (self newRoom: newRoomNum)))

  ;; Leaves the current room for room n (its script's export 0).
  (method (newRoom n &tmp old)
    (= newRoomNum 0)
    (narrator clear:)
    (if curRoom
      (= old curRoomNum)
      (curRoom dispose:)
      (= curRoom 0)
      (DisposeScript old))
    (= prevRoomNum curRoomNum)
    (= curRoomNum n)
    (= curRoom (ScriptID n 0))
    (curRoom init:))

  (method (setScript s)
    (if script (script dispose:))
    (= script s)
    (if s (s init: self &rest))))

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

  (method (init)
    (if (== modNum -1) (= modNum curRoomNum))
    (= plane ((Plane new:) picture: picture priority: 1 yourself:))
    (plane init:)
    (= obstacles (List new:)))

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
    nsLeft 0 nsTop 0 nsRight 0 nsBottom 0)

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
    (UpdateScreenItem self))

  (method (onMe theX theY)
    (return (IsOnMe theX theY self)))

  (method (posn newX newY)
    (= x newX)
    (= y newY)
    (return self))

  ;; The room is going: so is this.
  (method (roomDisposed)
    (self dispose:))

  (method (dispose)
    (DeleteScreenItem self)
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
    heading 0)

  (method (doit)
    (if mover
      (mover doit:)
      (if (and mover (mover completed?)) (mover motionCue:)))
    (BaseSetter self)
    (super doit:))

  ;; cls is a Motion class (a new one is made) or object; 0 stops moving.
  (method (setMotion cls)
    (if mover (mover dispose:))
    (= mover 0)
    (if cls
      (= mover (if (& (cls -info-?) $8000) (cls new:) else cls))
      (mover init: self &rest))
    (return self))

  (method (setHeading h)
    (= heading h)
    (DirLoop self h))

  ;; Whether another actor is in the way (DoBresen asks).
  (method (cantBeHere)
    (return (CantBeHere self (cast elements?))))

  (method (dispose)
    (if mover (mover dispose:) (= mover 0))
    (super dispose:)))

;; The hero: walks where the player clicks, and goes from room to room.
(class Ego of Actor
  (method (roomDisposed)
    (self setMotion: 0)
    (DeleteScreenItem self)
    (cast delete: self)))
