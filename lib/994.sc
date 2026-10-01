;;; Sound: music and effects. A sound resource number plays as a digital effect if there
;;; is one, else as music.
(script 994)
(include "system.sh")

(class Sound of Obj
  (properties
    number 0
    loop 1          ; -1: forever
    vol 127
    priority 0
    handle 0        ; set while playing (the interpreter's)
    signal 0        ; -1 when it has ended
    dataInc 0
    nodePtr 0
    client 0)       ; cued when it ends

  (method (init)
    (DoSound SND_INIT self)
    (sounds add: self))

  (method (play who)
    (if (not nodePtr) (self init:))
    (= client (if argc who else 0))
    (DoSound SND_PLAY self))

  (method (stop)
    (DoSound SND_STOP self))

  ;; How many times to play: -1 forever.
  (method (setLoop n)
    (= loop n)
    (return self))

  ;; Each cycle (from the game): has it ended?
  (method (check &tmp c)
    (if handle
      (DoSound SND_UPDATE_CUES self)
      (if (== signal -1)
        (self stop:)
        (= c client)
        (= client 0)
        (if c (c cue:)))))

  (method (dispose)
    (DoSound SND_STOP self)
    (DoSound SND_DISPOSE self)
    (sounds delete: self)
    (super dispose:)))
