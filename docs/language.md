# The script language

Games are written in the Lisp-like language Sierra used for SCI, as far as the compiler
implements it (`packages/sci/src/script/compiler.ts`). It compiles to SCI assembly, which
the assembler turns into script and heap resources. A game's scripts are compiled together,
so any script can use another's classes, globals and public procedures.

`pnpm game build games/<name>` compiles `scripts/*.sc` and writes what it made of each
script to `out/games/<name>/src/<n>.sca`.

```lisp
(script 0)                       ; every file starts by saying which script it is

(public hello 0)                 ; export 0: what the interpreter sends `play`

(define ALL_EVENTS $7fff)

(class Sprite of Obj
  (properties x 0 y 0 view -1)
  (method (moveTo newX newY)
    (= x newX)
    (= y newY)
    (UpdateScreenItem self)))

(instance lantern of Sprite
  (properties view 100 x 160 y 150))
```

## Declarations

| form | |
|---|---|
| `(script N)` | the script's number; required, once |
| `(include "file")` | the declarations in another file, relative to the game folder (defines, enums, externs) |
| `(define NAME value)` | a constant: a number, or arithmetic on numbers and other constants |
| `(enum [start] A B (= C 10) D)` | numbered constants, from `start` (0 if left out) |
| `(public name index ...)` | exports: objects and procedures other scripts reach by number |
| `(local a [buf 10] (= b 5) [c 3] = (1 2 3))` | script variables, arrays, initial values |
| `(extern name script index)` | a procedure exported by a script that isn't compiled with this one |
| `(class Name of Super ...)` | a class; without `of`, a root class (like `Obj`) |
| `(instance name of Class ...)` | an object |
| `(procedure (name params &tmp temps) body)` | a procedure |

Inside a class or instance:

```lisp
(properties name value ...)                   ; new properties, or new defaults for inherited ones
(method (name params &tmp temps [buf 4]) body)
```

Property values are numbers, constants, strings, or other instances in the same script.
Classes are numbered (their *species*) by the build: superclasses first, then in script
order.

**Script 0's variables are the globals.** Any script can use them by name.

## Names

Inside a method or procedure, a name means, in this order: a temporary or parameter, a
property of the object (in methods), a script variable, a global, `self`, `argc` (the number
of arguments this call got), a constant, an instance in the same script, or a class.
`TRUE`, `FALSE` and `NULL` are 1, 0 and 0.

## Expressions

Everything is an expression with a value.

| | |
|---|---|
| `42 -7 $1F %101` | numbers: decimal, hex, binary |
| `` `a `` | a character's code (`` `^a `` is control-A) |
| `"text"` or `{text}` | a string in the script; `\n` and `\xx` (hex) escapes |
| `#init` | a selector's number |
| `[buf i]` | an element of an array variable |
| `@buf` | a variable's address |
| `(= v e)` `(+= v e)` `(-= v e)` `(*= v e)` `(/= v e)` `(\|= v e)` `(&= v e)` | assignment, to a variable, a property or an array element |
| `(++ v)` `(-- v)` | increment and decrement, with the new value |
| `(+ a b ...)` `(- a b)` `(- a)` `(* a b ...)` `(/ a b)` `(mod a b)` | arithmetic on signed 16-bit numbers |
| `(<< a n)` `(>> a n)` `(& a b ...)` `(\| a b ...)` `(^ a b ...)` `(~ a)` | bits |
| `(== a b)` `(!= a b)` `(< a b)` `(> a b)` `(<= a b)` `(>= a b)` | comparison; `u<` `u>` `u<=` `u>=` compare unsigned |
| `(and a b ...)` `(or a b ...)` `(not a)` | logic; `and` and `or` stop at the first value that decides |

## Control

```lisp
(if test then ... else ...)
(cond (test body...) (test body...) (else body...))
(switch value (1 body...) (2 body...) (else body...))
(while test body...)
(repeat body...)                              ; until (break)
(for ((= i 0)) (< i 10) ((++ i)) body...)
(break) (continue)
(return) (return value)
```

## Sends and calls

```lisp
(lantern moveTo: 10 20)             ; send a message
(lantern x: 5 y: 6 show:)           ; several messages in one send
(lantern x?)                        ; read a property
(self show:) (super init: &rest)    ; to this object, or to its superclass's method
(send (ScriptID 100 0) init:)       ; to any expression
(helper 1 2)                        ; a procedure: in this script, public in another, or extern
(AddScreenItem self)                ; a kernel call, by name
(sum3 &rest)                        ; passes on this call's arguments after its named ones
(sum3 1 &rest b)                    ; ... or from parameter b on
```

A send to a property with an argument sets it; with none (or with `?`) it reads it.

## Not (yet) supported

Expressions as property values, `switchto`, `&rest` in the middle of arguments,
`@[buf i]`, and the `(asm ...)` escape. The compiler reports anything it doesn't know with
the file and line.
