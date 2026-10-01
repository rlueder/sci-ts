# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/),
and the entries are generated from commit messages
([Conventional Commits](https://www.conventionalcommits.org/)) when a release is made.

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
