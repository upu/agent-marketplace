# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-11

### Added

- Added two `dev-flow` hooks, ported from upu/ghost-align's local setup: `block-main-commit` (`PreToolUse`/`Bash`) denies `git commit` while on the `main` branch, including through wrapper commands (`env`/`sudo`/`command`) and compound commands (`&&`/`;`/`|`); `compile-if-ts` (`PostToolUse`/`Edit|Write`) runs `npm run compile` after editing a `.ts` file. `compile-if-ts` no-ops on repositories without a `package.json` or a `scripts.compile` entry, so enabling the plugin is safe on non-npm repositories such as this one.
- Added a new `vscode-ext` plugin with a `test-and-package` skill, ported and generalized from upu/ghost-align's local skill: runs compile → test → a `check:package` content-allowlist gate, and only builds a `.vsix` when both pass. It's a separate plugin rather than a new branch in `dev-flow`, since `dev-flow` stays language/ecosystem-agnostic and this skill assumes a vsce-based npm project. Stops and reports if the target repository is missing the `compile`/`test`/`check:package`/`package` npm scripts it depends on.

### Fixed

- `wait-ci.js` and `wait-copilot-review.js` now reject `--interval-ms=0` and `--timeout-ms=0` instead of silently polling with no sleep between requests (hammering the GitHub API) or timing out before a single poll runs.

## [0.1.0] - 2026-07-11

### Added

- Added a `version` field to the `dev-flow` plugin's `plugin.json` and started tracking it with SemVer.
- Added `CHANGELOG.md` / `CHANGELOG.ja.md` in Keep a Changelog format so consumers can follow behavior changes to the skills.

### Changed

- `ship` now waits for CI checks, and `ship`/`release` now wait for Copilot reviews, by launching bundled Node scripts (`wait-ci.js`, `wait-copilot-review.js`) instead of having the model reproduce long inline bash/jq loops, removing a recurring source of quoting mistakes. (`release`'s own CI wait still uses `gh pr checks --watch`.)
- Rewrote the `ship` skill body into short imperative steps with explicit condition→action branching (bullet lists and exit-code tables), moving rationale and field notes to a `reference.md` read only on demand — shrinking the context loaded on every invocation (22,204 chars when filed → 5,936) without dropping any behavioral rule.
- Applied the same rewrite to the remaining five skills — `release`, `plan-next`, `retro`, `batch-ship`, `propose-improvements`: bodies compressed to rule-centric imperatives with explicit branching, and rationale / field notes moved to each skill's `reference.md` (release 8,094 → 5,917 chars, plan-next 5,252 → 4,417, retro 4,724 → 4,166, batch-ship 3,811 → 2,941, propose-improvements 2,460 → 2,220).
- Shortened all six skills' frontmatter `description` to a one-line purpose plus the `when use` trigger examples, halving the skill-list context loaded into every session (1,112 → 554 chars in total).

### Docs

- Documented in the README how to pull in skill updates via `/plugin marketplace update upu-agent-marketplace`.
- Extended the README's skill-writing conventions: SKILL.md bodies use short imperatives with structured branching (bullets/tables), and whys / field notes live in each skill's `reference.md`, referenced from the body by a single line.

[Unreleased]: https://github.com/upu/agent-marketplace/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.2.0
[0.1.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.1.0
