// Releases are made by CI on every push to main (.github/workflows/ci.yml), from the
// Conventional Commits since the last tag: semantic-release picks the version, writes
// CHANGELOG.md, commits it with package.json as `chore(release): vX.Y.Z`, tags it and
// makes the GitHub release. The publish job then puts the package on npm.
//
//   pnpm release:next    what the next release would be, without making it

// Before 1.0, a breaking change bumps the minor version, not the major. Rules are tried
// before the defaults, so the breaking rule has to come first or `feat!` would match `feat`.
const releaseRules = [
  { breaking: true, release: "minor" },
  { type: "feat", release: "minor" },
  { type: "fix", release: "patch" },
  { type: "perf", release: "patch" },
  { type: "refactor", release: "patch" },
  { type: "revert", release: "patch" },
];

const changelogTitle = `# Changelog

All notable changes to this project. Versions follow [Semantic Versioning](https://semver.org/),
and the entries are generated from commit messages
([Conventional Commits](https://www.conventionalcommits.org/)) when a release is made.`;

export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", { config: "./release.preset.js", releaseRules }],
    ["@semantic-release/release-notes-generator", { config: "./release.preset.js" }],
    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md", changelogTitle }],
    // Only the version in package.json; tools/package.ts builds what goes to npm.
    ["@semantic-release/npm", { npmPublish: false }],
    ["@semantic-release/git", {
      assets: ["CHANGELOG.md", "package.json"],
      message: "chore(release): v${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
    }],
    ["@semantic-release/github", { successCommentCondition: false, failComment: false, releasedLabels: false }],
  ],
};
