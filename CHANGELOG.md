# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/), and the entries are generated
from commit messages ([Conventional Commits](https://www.conventionalcommits.org/)).

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


