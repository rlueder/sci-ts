;;; hello: a hill at night and the road beyond it. The smallest game that uses the whole
;;; class library: rooms, a hero who walks where you click, things that answer when you
;;; look at them or use them (right-click for the next verb), and a way out.
(script 0)
(include "system.sh")

(public hello 0)

(class Hello of Game
  (method (init)
    (super init:)
    (= ego hero)
    (self newRoom: 1)))

(instance hello of Hello)

(instance hero of Ego
  (properties
    view 200
    xStep 2 yStep 1
    cycleSpeed 8))
