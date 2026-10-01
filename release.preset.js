// The Conventional Commits changelog preset with this project's section names (as they were
// under git-cliff). release.config.js names this file instead of the preset: semantic-release
// would otherwise load the preset's copy that commitlint brings, which is too new for it.
import conventionalCommits from "conventional-changelog-conventionalcommits";

export default () => conventionalCommits({
  types: [
    { type: "feat", section: "Added" },
    { type: "fix", section: "Fixed" },
    { type: "perf", section: "Performance" },
    { type: "refactor", section: "Changed" },
    { type: "revert", section: "Reverted" },
    { type: "docs", section: "Documentation" },
    { type: "test", section: "Tests" },
    { type: "build", section: "Maintenance" },
    { type: "ci", section: "Maintenance" },
    { type: "chore", section: "Maintenance" },
    { type: "style", section: "Maintenance" },
  ],
});
