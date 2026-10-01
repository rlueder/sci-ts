# Sound

There are three kinds: MIDI music and effects (sound resources), digital effects
(`RESOURCE.SFX`) and speech (`RESOURCE.AUD`). A game plays a sound by setting a `Sound`
object's `number` and sending it `play`; whether that ends up as MIDI or a digital clip is the
interpreter's choice.

## Sound resources

A sound resource holds one track per sound device: AdLib (0x00), General MIDI (0x07), MT-32
(0x0C) and others. Each track is a list of channel streams. A channel stream starts with its
channel number and voice count, then `delta, event` pairs with MIDI running status. A delta
byte of `0xF8` adds 240 ticks and continues; ticks are 1/60 second. `0xFC` is an event (with
its own delta) that ends the stream. Notes usually end with a note-on of velocity 0.

**Channel 15 isn't music.** It's how a song talks to the scripts:

- a program change to N sets the sound object's `signal` to N (127 instead marks the loop
  point);
- controller 0x60 is a cue: a counter goes up and `signal` becomes counter + 127;
- when a song ends, `signal` becomes -1.

Scripts wait on these, so they have to work even with no synthesiser attached.

## Signals reach the scripts

The scripts poll: every cycle, `Sound::check` asks the interpreter for news
(`DoSound` update-cues), and if `signal` changed, it cues the sound's client. But it only
asks while the sound object's `handle` property is set. Playing a sound sets `handle`;
stopping clears it. (A Sound has a `nodePtr` too, set when it's initialised; it's a different
property.) If play forgets `handle`, every script waiting for a sound to end waits forever.

## Digital audio

Clips are **SOL**: a small header (`"SOL\0"`, sample rate, flags, size), then samples. Speech
is 11,025 Hz, 16-bit, compressed with a one-byte-per-sample DPCM; effects are plain 16-bit at
11,025 or 22,050 Hz.

Audio maps say where each clip is:

- one map per message module for speech: a base offset, then entries of a tuple (noun, verb,
  cond, seq) **stored big-endian**, the only big-endian field we met, and an offset delta.
  Flags in the sequence byte announce extra bytes (lip-sync data) before the audio.
- map 65535 for effects: a sound number and an offset delta.

A sound number that has a digital effect plays it; otherwise its MIDI track plays.

Scripts ask how long a clip is before it plays (the narrator times its lines by speech), so
lengths have to be known without reading the clip. They come from the gaps between sorted map
offsets: with one byte per sample, the gap is the length.

## AdLib

In 1994 most players heard the AdLib track, on the Yamaha OPL2 chip of a Sound Blaster. The
instrument bank is a patch resource: 190 instruments of 28 bytes (128 melodic, 62
percussion), then a 62-byte rhythm key map. Each instrument is two operators (a modulator and
a carrier) of 13 bytes, plus their waveforms. A flag of 1 means FM synthesis, which is the
opposite of the chip's own register bit; we settled that from the data (180 of 190
instruments use FM).

Each AdLib channel in a song asks for one voice, and nine channels fill the chip's nine
voices: the arrangements were written for the hardware. sci-ts drives a behavioural model of
the chip built from its datasheet (log-domain attenuation, the four waveforms, envelopes,
vibrato and tremolo).

## General MIDI

The GM track sounds right through any General MIDI synthesiser; sci-ts uses a SoundFont in the
browser.
