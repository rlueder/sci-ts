;;; NAME: the game. It sets up, names the hero, and goes to the first room.
(script 0)
(include "system.sh")

(public NAME 0)

(class NameGame of Game
  (method (init)
    (super init:)
    (= ego hero)
    (= heroTalker heroVoice)
    (self newRoom: 1)))

(instance NAME of NameGame)

(instance hero of Ego
  (properties
    view 200
    xStep 2 yStep 1
    cycleSpeed 8))

;; Who says the hero's lines (Hero: in Yarn).
(instance heroVoice of Talker
  (properties name "You"))
