# Contributing

## Ground rules

- No game data. Nothing from a Sierra game goes into this repository: no resources, no
  decompiled or disassembled scripts, no text, art or music, not even in a test or a comment.
  Tests use data made up for the test. Behaviour learned from a game is described in our own
  words (see [docs/sci](docs/sci/README.md)).
- Code, docs and comments say what the engine does with SCI, not what one game does.

## Setup

```sh
pnpm install         # also installs the commit-msg hook
pnpm check           # typecheck, then all tests
```

Node 22 or later, pnpm 10.

## Tests

[Vitest](https://vitest.dev). Tests live next to each package in `test/` and are named
`*.test.ts`.

```sh
pnpm test            # once
pnpm test:watch      # rerun on change
pnpm test:coverage   # with a coverage report (coverage/index.html)
```

Write a test for each bug fixed and each format or kernel added. For file formats, the useful
test is a round trip: build the data in the test, write it, read it back, and write it again
to check the bytes don't change (see `packages/sci/test/formats.test.ts`).

CI runs the typecheck and the tests with coverage on every push and pull request.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), checked by a commit-msg hook and
in CI:

```
<type>(<scope>): <what changed, no full stop>

<why, if it isn't obvious>
```

| type | for | changelog section |
|---|---|---|
| `feat` | something new a user of the engine or tools can do | Added |
| `fix` | a bug fix | Fixed |
| `perf` | faster or smaller, same behaviour | Performance |
| `refactor` | code changes that don't change behaviour | Changed |
| `docs` | documentation only | Documentation |
| `test` | tests only | Tests |
| `build`, `ci`, `chore`, `style` | everything else | Maintenance |

Scopes are optional: `sci`, `lib`, `content`, `viewer`, `editor`, `tools`, `docs`, `game`, `deps`,
`ci`, `release`. A breaking change gets a `!` after the type (`feat(sci)!: ...`) or a
`BREAKING CHANGE:` footer.

## Changelog and releases

[CHANGELOG.md](CHANGELOG.md) is generated from the commit messages by
[git-cliff](https://git-cliff.org) (configured in `cliff.toml`); don't edit it by hand.

```sh
pnpm changelog:next  # what the next release would add, and its version
pnpm release         # write CHANGELOG.md for the next version
```

Then commit it as `chore(release): vX.Y.Z`, tag it `vX.Y.Z`, and publish the npm package:

```sh
pnpm package                 # out/package: one sci-ts package, compiled, with its checks
cd out/package && npm publish
```

The package build refuses files that look like a game's resources; everything in it has
already been checked for any game's text and names on its way into this repository. Before 1.0, a breaking change
bumps the minor version and everything else the patch version.
