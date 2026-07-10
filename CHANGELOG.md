# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a `version` field to the `dev-flow` plugin's `plugin.json` and started tracking it with SemVer.
- Added `CHANGELOG.md` / `CHANGELOG.ja.md` in Keep a Changelog format so consumers can follow behavior changes to the skills.

### Changed

- `ship` now waits for CI checks, and `ship`/`release` now wait for Copilot reviews, by launching bundled Node scripts (`wait-ci.js`, `wait-copilot-review.js`) instead of having the model reproduce long inline bash/jq loops, removing a recurring source of quoting mistakes. (`release`'s own CI wait still uses `gh pr checks --watch`.)
- Rewrote the `ship` skill body into short imperative steps with explicit condition→action branching (bullet lists and exit-code tables), moving rationale and field notes to a `reference.md` read only on demand — shrinking the context loaded on every invocation (22,204 chars when filed → 5,936) without dropping any behavioral rule.

### Docs

- Documented in the README how to pull in skill updates via `/plugin marketplace update upu-agent-marketplace`.
- Extended the README's skill-writing conventions: SKILL.md bodies use short imperatives with structured branching (bullets/tables), and whys / field notes live in each skill's `reference.md`, referenced from the body by a single line.

[Unreleased]: https://github.com/upu/agent-marketplace/compare/bd3a70fe000928f67ae7eb15caea25f8729211b0...HEAD
