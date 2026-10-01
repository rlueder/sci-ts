;;; The core of the class library: objects, collections and scripts, and the globals
;;; the rest of the library and every game use.
(script 999)
(include "system.sh")

(public SetFlag 0 ClearFlag 1 IsFlag 2)

(global
  game          ; the Game
  curRoom       ; the Room being played
  curRoomNum
  newRoomNum    ; set to change rooms: the game changes at the end of the cycle
  prevRoomNum   ; where the hero came from
  ego           ; the hero
  cast          ; the Views on screen
  features      ; the Features that answer clicks
  sounds        ; the Sounds playing
  user          ; input
  theEvent      ; the Event the user fills each cycle
  messager      ; says message files' lines
  narrator      ; shows text
  heroTalker    ; says the hero's lines (the game sets it; the narrator otherwise)
  talking       ; whoever is showing a line now
  dialog        ; a menu waiting for a choice: it gets every click
  music         ; the Sound for music
  sfx           ; the Sound for effects
  uiPlane       ; the plane over the room, for text
  gameTime      ; cycles since the game started
  quit          ; set to end the game
  [gameFlags 64]  ; story flags, a bit each
  textStyle       ; how text boxes and menus look (a TextStyle)
  inventory       ; what the hero carries (an Inventory)
  theItem)        ; the item picked to use, or 0

(procedure (SetFlag n)
  (|= [gameFlags (/ n 16)] (<< 1 (mod n 16))))

(procedure (ClearFlag n)
  (&= [gameFlags (/ n 16)] (~ (<< 1 (mod n 16)))))

(procedure (IsFlag n)
  (return (!= 0 (& [gameFlags (/ n 16)] (<< 1 (mod n 16))))))

;; The root of every class.
(class Obj
  ;; A copy of this object (classes make instances this way).
  (method (new)
    (return (Clone self)))

  (method (init))

  (method (doit))

  ;; Frees an object made with new; does nothing to one declared in a script.
  (method (dispose)
    (DisposeClone self))

  ;; The object itself: (((Foo new:) x: 1 yourself:)) ends a chain of messages with it.
  (method (yourself)
    (return self))

  (method (respondsTo sel)
    (return (RespondsTo self sel)))

  ;; Runs a Code object's doit with this object as its first argument.
  (method (perform code)
    (return (code doit: self &rest))))

;; An object whose doit does one thing (for perform:).
(class Code of Obj)

;; A list of objects, kept by the interpreter.
(class Collection of Obj
  (properties
    elements 0      ; the kernel list
    size 0)

  (method (add item &tmp i)
    (if (not elements) (= elements (NewList)))
    (for ((= i 0)) (< i argc) ((++ i))
      (AddToEnd elements (NewNode [item i] [item i]))
      (++ size))
    (return self))

  (method (delete item &tmp i)
    (for ((= i 0)) (< i argc) ((++ i))
      (if (and elements (DeleteKey elements [item i]))
        (-- size)))
    (return self))

  (method (contains item)
    (return (and elements (FindKey elements item))))

  (method (isEmpty)
    (return (== size 0)))

  ;; Sends every element a message, with any further arguments.
  (method (eachElementDo sel &tmp node nextNode)
    (if (not elements) (return))
    (for ((= node (FirstNode elements))) node ((= node nextNode))
      ;; Read the next one first: the element may leave the list.
      (= nextNode (NextNode node))
      ((NodeValue node) [sel] &rest)))

  ;; The first element for which the message returns true, or 0.
  (method (firstTrue sel &tmp node nextNode obj)
    (if (not elements) (return 0))
    (for ((= node (FirstNode elements))) node ((= node nextNode))
      (= nextNode (NextNode node))
      (= obj (NodeValue node))
      (if (obj [sel] &rest) (return obj)))
    (return 0))

  ;; Empties the list (the elements themselves stay).
  (method (release)
    (if elements (DisposeList elements))
    (= elements 0)
    (= size 0))

  (method (dispose)
    (self release:)
    (super dispose:)))

(class List of Collection)

;; A Collection that holds each object once.
(class Set of Collection
  (method (add item &tmp i)
    (for ((= i 0)) (< i argc) ((++ i))
      (if (not (self contains: [item i]))
        (super add: [item i])))
    (return self)))

;; A sequence of steps. changeState: runs a step; cue: goes to the next one, now or when a
;; wait set by the step runs out: `cycles` (game cycles), `ticks` (1/60 s) or `seconds`.
(class Script of Obj
  (properties
    client 0        ; what this script runs on
    caller 0        ; cued when the script is disposed
    state -1
    start 0         ; the first state
    register 0      ; a value given to init
    script 0        ; a script of this script
    cycles 0
    ticks 0
    seconds 0
    lastSecond 0)

  (method (init who whoCares reg)
    (= client who)
    (= caller (if (> argc 1) whoCares else 0))
    (if (> argc 2) (= register reg))
    (= cycles 0)
    (= ticks 0)
    (= seconds 0)
    (self changeState: start))

  (method (doit)
    (if script (script doit:))
    (cond
      ((> cycles 0)
        (if (== (-- cycles) 0) (self cue:)))
      ((> ticks 0)
        (if (<= (-- ticks) 0) (self cue:)))
      ((> seconds 0)
        (if (not lastSecond) (= lastSecond gameTime))
        (if (>= (- gameTime lastSecond) 60)
          (= lastSecond gameTime)
          (if (== (-- seconds) 0)
            (= lastSecond 0)
            (self cue:))))))

  (method (changeState newState)
    (= state newState))

  (method (cue)
    (self changeState: (+ state 1)))

  (method (setScript s)
    (if script (script dispose:))
    (= script s)
    (if s (s init: self &rest)))

  (method (dispose &tmp c)
    (if script (script dispose:) (= script 0))
    (if (and client (== (client script?) self)) (client script: 0))
    (= c caller)
    (= client 0)
    (= caller 0)
    (= state -1)
    (super dispose:)
    (if c (c cue:))))
