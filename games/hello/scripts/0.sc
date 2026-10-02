;;; hello: a hill at night and the road beyond it. The smallest game that uses the whole
;;; class library: rooms, a hero who walks where you click, things that answer when you
;;; look at them or use them (right-click for the next verb), and a way out. Room 1 is
;;; written as a script (scripts/1.sc), room 2 as data (rooms/2.room.yaml and 2.yarn).
(script 0)
(include "system.sh")
(include "hello.sh")

(public hello 0)

(class Hello of Game
  (method (init)
    (super init:)
    ;; Presentation only: the same palette and flat planes as the room art.
    (textStyle fore: UI_INK back: UI_PANEL frame: UI_FRAME)
    (= ego hero)
    (= heroTalker heroVoice)
    (self newRoom: 1)))

(instance hello of Hello)

(instance hero of Ego
  (properties
    view 200
    xStep 2 yStep 1
    cycleSpeed 8))

;; Who says the hero's lines (Hero: in Yarn).
(instance heroVoice of Talker
  (properties name "You"))
