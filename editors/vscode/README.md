# SCI Script for VS Code

Highlighting for SCI's Lisp-like script language as sci-ts compiles it: `.sc` scripts, and
the `.sh` headers they include (in `games/` and `lib/` only, so shell scripts elsewhere are
left alone). The language is described in docs/language.md.

To use it, copy (or link) this folder into VS Code's extensions folder and restart:

```sh
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/sci-script
```
