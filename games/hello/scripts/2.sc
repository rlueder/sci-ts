;;; The road: it goes on to the town, which isn't in this game.
(script 2)
(include "system.sh")
(include "hello.sh")

(public road 0)

(instance road of Room
  (properties
    picture 101
    noun N_ROAD
    west 1)

  (method (init)
    (super init:)
    (self addObstacle: ((Polygon new:) type: PT_CONTAINED init: 0 158 300 158 300 189 0 189))
    (sign init:)
    (ego posn: 10 175 init: setCycle: Walk)))

(instance sign of Feature
  (properties
    noun N_SIGN
    nsLeft 236 nsTop 128 nsRight 262 nsBottom 160))
