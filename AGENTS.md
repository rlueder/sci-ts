# Working in this repository

Notes for anyone changing sci-ts, people and coding agents alike. Start with
[CONTRIBUTING.md](CONTRIBUTING.md): the ground rules (no game data, ever), setup, tests,
commit messages and how releases are made. This adds what working here alongside others
needs.

## Pull requests and releases

Branch from `origin/main`, open a pull request, and squash-merge it once CI is green; the
repository only allows squash merges. The pull request's title becomes the commit on
`main`, and that commit decides the release: a `feat` publishes a new minor version of
`sci2-ts` to npm, a `fix` a patch, and `docs`, `ci` or `chore` nothing. So the title follows
the commit convention and its type is the one that fits the change.

Before pushing, run `pnpm check`. Change the docs (`docs/`, the README) in the same pull
request as what they describe.

## Working beside others

Several sessions often work here at once. Work in a git worktree, start branches from
`origin/main` (not a local `main` that may hold someone else's unpushed commits), and don't
touch files someone else has uncommitted changes in. A new worktree needs `pnpm install` before
its first commit: the commit-msg hook runs commitlint from `node_modules`.

## Files that come from upstream

The engine is developed in another repository and copied here. `.exported-files` lists the
files that came that way, with the hash each had. Changing one here is fine, in a pull
request: say so in its description, so the change is carried back. The next copy leaves
a file changed here alone rather than overwriting it.

## Commits and writing

Don't add co-author, "generated with" or similar attribution lines to commits or pull
requests. Docs, comments and commit messages are written plainly and specifically, in our
own words.
