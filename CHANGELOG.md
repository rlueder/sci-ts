# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/),
and the entries are generated from commit messages
([Conventional Commits](https://www.conventionalcommits.org/)) when a release is made.

## [0.15.1](https://github.com/rlueder/sci-ts/compare/v0.15.0...v0.15.1) (2026-10-02)

### Fixed

* **viewer:** fetch game files with the build's version ([#18](https://github.com/rlueder/sci-ts/issues/18)) ([370e490](https://github.com/rlueder/sci-ts/commit/370e490d9c618d78223fbba1df4850a8c6ebb0a2))

## [0.15.0](https://github.com/rlueder/sci-ts/compare/v0.14.0...v0.15.0) (2026-10-02)

### Added

* bitmap fonts with bearings and advances, styled text, and skinned icon bar and inventory ([#17](https://github.com/rlueder/sci-ts/issues/17)) ([0cec83b](https://github.com/rlueder/sci-ts/commit/0cec83be7211ee532c6846a08826a2b09f462ee1))

## [0.14.0](https://github.com/rlueder/sci-ts/compare/v0.13.0...v0.14.0) (2026-10-02)

### Added

* **lib:** figures drawn smaller walk and step slower, and change size in steps ([#16](https://github.com/rlueder/sci-ts/issues/16)) ([06f2b1d](https://github.com/rlueder/sci-ts/commit/06f2b1d91fd95d5b648104b435eb58e3355ba808))

## [0.13.0](https://github.com/rlueder/sci-ts/compare/v0.12.0...v0.13.0) (2026-10-02)

### Added

* **content:** perspective measured across the floor, for rooms painted at an angle ([#15](https://github.com/rlueder/sci-ts/issues/15)) ([8020031](https://github.com/rlueder/sci-ts/commit/8020031785b75c966ba449c7bcbe159002868fec))

## [0.12.0](https://github.com/rlueder/sci-ts/compare/v0.11.0...v0.12.0) (2026-10-02)

### Added

* **lib:** portraits that face the middle from their character's side, framed, and one for the hero ([#14](https://github.com/rlueder/sci-ts/issues/14)) ([e7be055](https://github.com/rlueder/sci-ts/commit/e7be0555af2c49743c539e7231cf979ac274617e))

## [0.11.0](https://github.com/rlueder/sci-ts/compare/v0.10.0...v0.11.0) (2026-10-02)

### Added

* **lib:** menus as one framed box, and text boxes that sit on the bottom of the screen ([#13](https://github.com/rlueder/sci-ts/issues/13)) ([83cf03d](https://github.com/rlueder/sci-ts/commit/83cf03d0bb4e044d24cbff769a102294e3a66a03))

## [0.10.0](https://github.com/rlueder/sci-ts/compare/v0.9.0...v0.10.0) (2026-10-02)

### Added

* perspective for rooms, and spoken lines ([#12](https://github.com/rlueder/sci-ts/issues/12)) ([b8a504b](https://github.com/rlueder/sci-ts/commit/b8a504bc972c85818f37f00597ac209ff6916843)), closes [#11](https://github.com/rlueder/sci-ts/issues/11)

## [0.9.0](https://github.com/rlueder/sci-ts/compare/v0.8.2...v0.9.0) (2026-10-02)

### Added

* **game:** redesign hello demo with flat polygon art ([#11](https://github.com/rlueder/sci-ts/issues/11)) ([0ab23aa](https://github.com/rlueder/sci-ts/commit/0ab23aacd7e604a90ea9b309cbbe6c871c5a70bd))

## [0.8.2](https://github.com/rlueder/sci-ts/compare/v0.8.1...v0.8.2) (2026-10-02)

### Fixed

* **lib:** actors walk past each other and are clicked only where they're drawn ([#10](https://github.com/rlueder/sci-ts/issues/10)) ([99deb4a](https://github.com/rlueder/sci-ts/commit/99deb4a1e63bb5170ab0742942041ce3fde1801d))

## [0.8.1](https://github.com/rlueder/sci-ts/compare/v0.8.0...v0.8.1) (2026-10-02)

### Fixed

* timers past 32767 cycles, waits on missing sounds, methods hidden by properties ([#9](https://github.com/rlueder/sci-ts/issues/9)) ([7ec09d7](https://github.com/rlueder/sci-ts/commit/7ec09d765ab2818cf0171d5e96d9fa1b6744b576))

### Documentation

* AGENTS.md for people and agents working here ([#8](https://github.com/rlueder/sci-ts/issues/8)) ([42bec1f](https://github.com/rlueder/sci-ts/commit/42bec1fafbb2798b26539923608882fef0c5118d))

## [0.8.0](https://github.com/rlueder/sci-ts/compare/v0.7.0...v0.8.0) (2026-10-02)

### Added

* **content:** poses, idles and prop behaviours ([#7](https://github.com/rlueder/sci-ts/issues/7)) ([1413ca3](https://github.com/rlueder/sci-ts/commit/1413ca334a29255d9a67ca136f01607187e7bee6))

## [0.7.0](https://github.com/rlueder/sci-ts/compare/v0.6.1...v0.7.0) (2026-10-01)

### Added

* **lib:** text speed, and dismissing a line from the keyboard ([#6](https://github.com/rlueder/sci-ts/issues/6)) ([3ab244b](https://github.com/rlueder/sci-ts/commit/3ab244b0d96a34dd0c3e7d13b1f52404fdceccfe))

## [0.6.1](https://github.com/rlueder/sci-ts/compare/v0.6.0...v0.6.1) (2026-10-01)

### Fixed

* **tools:** the site uses the game's own SoundFont ([#5](https://github.com/rlueder/sci-ts/issues/5)) ([b275b0d](https://github.com/rlueder/sci-ts/commit/b275b0d89479c233153e3efb31fafabdbc5fdcdb))

## [0.6.0](https://github.com/rlueder/sci-ts/compare/v0.5.0...v0.6.0) (2026-10-01)

### Added

* **content:** items made from items.yaml, given and taken in Yarn ([#4](https://github.com/rlueder/sci-ts/issues/4)) ([129c439](https://github.com/rlueder/sci-ts/commit/129c43965f318d8815957e6efd6ce9290eced619))

## [0.5.0](https://github.com/rlueder/sci-ts/compare/v0.4.0...v0.5.0) (2026-10-01)

### Added

* **lib:** an icon bar for players without a right button ([#3](https://github.com/rlueder/sci-ts/issues/3)) ([a28d5b2](https://github.com/rlueder/sci-ts/commit/a28d5b244417af6985c0c82c825a3af29ad68067))

## [0.4.0](https://github.com/rlueder/sci-ts/compare/v0.3.0...v0.4.0) (2026-10-01)

### Added

* **lib:** saving and restoring ([#2](https://github.com/rlueder/sci-ts/issues/2)) ([117ad9d](https://github.com/rlueder/sci-ts/commit/117ad9ddf4ca87d443d8b7143d66eef380dced9a))

## [0.3.0](https://github.com/rlueder/sci-ts/compare/v0.2.2...v0.3.0) (2026-10-01)

### Added

* **content:** close-ups from Yarn ([0546752](https://github.com/rlueder/sci-ts/commit/054675216342747bc5565301aff3d39d27a900c2))
* **lib:** a text style for every box and menu ([0350a4e](https://github.com/rlueder/sci-ts/commit/0350a4e28a57d951277372ff6144bd8e9e534bee))
* **lib:** an inventory and close-ups ([6d401d8](https://github.com/rlueder/sci-ts/commit/6d401d8f92d33a4b694dcc617adbb1d5878da246))
* **lib:** cursors a game can replace, and a wait cursor ([aa55d11](https://github.com/rlueder/sci-ts/commit/aa55d1142568aeb4b14681e44881a4223192d5d2))
* **lib:** portraits at the top left, with blinking eyes ([8fd6aa1](https://github.com/rlueder/sci-ts/commit/8fd6aa16e83f9608666f67fd998ac852be1a5a99))
* **tools:** fonts from sheets of glyphs drawn in a paint program ([cb13669](https://github.com/rlueder/sci-ts/commit/cb13669363fb419425b0a54f0a5afb9ca1576dcf))

### Maintenance

* release from CI with semantic-release ([1757412](https://github.com/rlueder/sci-ts/commit/17574126c257961dd1058f596c6174445f3d9f16))

## [0.2.2] - 2026-10-01

### Fixed

- **tools:** Republish as 0.2.2: 0.2.1 is stuck in npm's staging

## [0.2.1] - 2026-10-01

### Fixed

- **tools:** Publish as sci2-ts

## [0.2.0] - 2026-10-01

### Added

- **tools:** An art tool for PNGs exported from a paint program (pnpm art)
- **tools:** Sci-ts as a package, with the sci-ts command
- **tools:** Publish sci-ts to npm

### Fixed

- **viewer:** Play games without an AdLib bank or a SoundFont
- **viewer:** A neutral sample text in the font preview

### Changed

- **game:** Sherlock moves to its own repository, sci-sherlock

### Documentation

- A game in its own repository, and the art tool
- The README shows the tools, and the package is on npm

## [0.1.0] - 2026-10-01

### Added

- SCI2 engine, content compiler, viewer and tools
- **sci:** Resource archive, vocab and font writers
- **tools:** Build games from nothing with pnpm game build
- **sci:** Script compiler
- **sci:** Global declarations and computed selectors
- **lib:** The class library
- **game:** Hello on the class library
- **lib:** Talkers, portraits, conversations, flags and cutscenes
- **tools:** YAML and Yarn rooms for the class library, and the editor for our games
- **game:** Hello's road as a YAML room with someone to talk to
- **sci:** Write sound resources, SOL clips and sound effects
- **sci:** Switchto, @[buf i], selectors as values, and warnings for unknown sends
- **tools:** Music and effects, new games, a static site, and editing scripts live
- **game:** Music for hello, and a lantern that chimes

### Changed

- **tools:** Games/hello in the script language

### Documentation

- README, how SCI works, the plan and the Sherlock Holmes teaser
- Making a game, and milestone 1 done
- The script language, and milestone 2 done
- The class library, and milestone 3 done
- Rooms as YAML and Yarn, and milestone 4 done
- Building a game from nothing, sound, the site and the tooling

### Maintenance

- Workspace, typecheck, tests and CI
- Build every game, and publish the site to GitHub Pages by hand
