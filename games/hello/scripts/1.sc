;;; The hill: a lantern in the grass, the moon, and the road to the east.
(script 1)
(include "system.sh")
(include "hello.sh")

(public hill 0)

(instance hill of Room
  (properties
    picture 100
    noun N_HILL
    east 2)

  (method (init)
    (super init:)
    ;; Where you can walk: the grass below the crest of the hill.
    (self addObstacle: ((Polygon new:) type: PT_CONTAINED init: 0 158 319 158 319 189 0 189))
    (moon init:)
    (lantern init:)
    (lantern setCycle: Forward)
    (ego posn: (if (== prevRoomNum 2) 310 else 40) 175 init: setCycle: Walk)))

(instance moon of Feature
  (properties
    noun N_MOON
    nsLeft 250 nsTop 20 nsRight 270 nsBottom 40))

(instance lantern of Prop
  (properties
    noun N_LANTERN
    view 100
    x 160 y 172
    cycleSpeed 12))
