/**
 * Commit message rules: Conventional Commits with the type list from CONTRIBUTING.md
 * and the 72-character subject limit used throughout the project.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "chore", "refactor", "style", "test", "ci", "build", "perf", "revert"],
    ],
    "header-max-length": [2, "always", 72],
  },
  // Dependabot writes its own subjects, which occasionally exceed 72 characters.
  ignores: [(message) => message.includes("Signed-off-by: dependabot[bot]")],
};
