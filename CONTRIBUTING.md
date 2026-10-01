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

Releases are made by CI. On every push to main, [semantic-release](https://semantic-release.gitbook.io)
reads the commits since the last tag (configured in `release.config.js`). If any of them is
a `feat`, `fix`, `perf`, `refactor` or `revert`, and something that goes into the package
changed (`packages`, `tools`, `lib`, `apps/viewer`, `package.json`, the README or the
license), it:

1. picks the version: a `feat` bumps the minor version, the others the patch version, and
   before 1.0 a breaking change bumps the minor version too;
2. adds the release to [CHANGELOG.md](CHANGELOG.md), in the sections in the table above, and
   sets the version in package.json;
3. commits both as `chore(release): vX.Y.Z [skip ci]`, tags the commit `vX.Y.Z` and makes the
   GitHub release;
4. builds the package from that commit (`pnpm package`) and publishes it to npm with
   provenance, after approval in the `npm-publish` environment if it has reviewers. There
   is no npm token: npm trusts `ci.yml` in that environment (trusted publishing).

So the changelog is only as good as the commit messages: write them for someone reading the
release notes, and don't edit CHANGELOG.md by hand. To see what the next release would be:

```sh
pnpm release:next    # a dry run: the version and the notes, nothing written
```

If a release was tagged but its publish didn't finish, publish the tag by hand:

```sh
gh workflow run ci.yml -f tag=vX.Y.Z
```

`publish-watch.yml` checks every day that npm and the tags agree and opens an issue if not.

To try the package locally, `pnpm package` builds it into out/package; `npm pack` there
makes the tarball a game can install.

The package build refuses files that look like a game's resources; everything in it has
already been checked for any game's text and names on its way into this repository.
