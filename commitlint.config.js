// Commit messages follow Conventional Commits; CHANGELOG.md is generated from them (cliff.toml).
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Scopes are optional; when used, they name a part of the repo.
    "scope-enum": [2, "always", ["sci", "lib", "content", "viewer", "editor", "tools", "docs", "game", "deps", "ci", "release"]],
    "body-max-line-length": [1, "always", 100],
    // Subjects often start with a name: SCI, VM, YAML.
    "subject-case": [0],
  },
};
