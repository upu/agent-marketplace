# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `release` step 12 and `retro`'s latest-tag lookup no longer depend on POSIX-only shell syntax (`set -o pipefail; ... | tail -20`, `git tag --sort=-creatordate | head -1`), which stopped `gh run watch` and tag detection from ever running under Windows PowerShell instead of surfacing the workflow's own pass/fail. `release` step 12 now runs `gh run watch <run-id> --exit-status` directly (no pipe), trading `tail`'s output trimming for `--exit-status`'s exit code propagating unchanged in both shells. `retro`'s tag lookup now uses `git for-each-ref --count=1 --sort=-creatordate '--format=%(refname:short)' refs/tags`, with the format argument quoted — unquoted, PowerShell parses `%` as the `ForEach-Object` alias and fails.

- `dev-flow`'s `block-main-commit.js` PreToolUse hook now resolves the directory a `git commit` invocation actually targets — a leading `cd <dir>` segment and/or the invocation's own `-C <dir>` option — instead of always checking the hook process's own cwd (the session's working directory). Judging by the session's branch instead of the target repo's gave both false positives (session on `main`, target repo on a feature branch: wrongly blocked) and false negatives (session on a feature branch, target repo on `main`: wrongly allowed), the false-positive case being the one that surfaced in practice while committing to a different repository mid-session. When the target directory can't be resolved safely (shell variable/command expansion, or a path that doesn't exist on disk), it falls back to the hook's own cwd, matching the previous behavior. Separately, `isGitCommitCommand` now strips heredoc bodies before splitting a command into segments, so an example `git commit` line quoted inside a heredoc (e.g. `gh issue create --body "$(cat <<'EOF' ... EOF)"`) is no longer misread as a real invocation.

### Changed

- `dev-flow`'s `compile-if-ts.js` PostToolUse hook now reports a failing `npm run compile` as advice — exit 0 with the diagnostics in `hookSpecificOutput.additionalContext` — instead of exiting with tsc's status, which the harness surfaced as a blocking error on every `.ts` edit. `ship` step 3 writes tests before the implementation exists, and `npm run compile` type-checks the whole project including those tests, so the entire red phase failed by design; because the type errors come from the tests, editing implementation files failed too, which is why filtering the hook by file path cannot fix it. The failures also carried no information: `stdio: "inherit"` left tsc's output uncaptured, so every report read `No stderr output` and a real typo was indistinguishable from an expected red. The output is now captured and passed along (truncated past `ADVISORY_OUTPUT_MAX_CHARS`, 4000 characters, since one missing export can produce hundreds of diagnostics), prefixed with a note that the edit itself was applied and that a red immediately after writing tests is expected. Enforcement is unchanged and still lives where it always did: `ship` step 6's gate (the CI command sequence run locally) and CI. A successful compile stays silent, and `shouldCompile` / `hasCompileScript` behavior is untouched.

## [0.6.0] - 2026-07-18

### Changed

- `batch-ship` step 5 (confirming a wave finished before starting the next) now also removes the wave's worktrees once an issue's PR is confirmed merged, via a new `cleanup-worktrees.js` script, instead of only reporting leftover worktrees in the final report as step 7 used to. The `Agent` tool's `isolation: "worktree"` only auto-cleans up when a sub-agent made no changes, and `ship` always commits, so every wave otherwise left its worktree directories behind indefinitely. The script matches each confirmed-merged issue's PR head branch (via `gh pr view --json headRefName`) against `git worktree list --porcelain`'s structural state rather than having the orchestrator track paths returned by each `Agent` call by hand; a removal failure (e.g. a worktree still locked, or containing untracked files) is logged and skipped rather than forced or treated as fatal, so one stuck worktree never blocks cleanup of the rest of the wave. Step 7's report now describes the cleanup actually performed instead of just its status.

### Fixed

- `ship` step 13's `cleanup-merged-branches.js` no longer fails with an uncaught `git branch -D` error when run inside a linked worktree. `merge-pr.js`'s worktree branch already deletes the merged PR's remote branch, so by the time step 13's `git fetch --prune origin` runs, the branch this very worktree still has checked out also shows a gone upstream — indistinguishable from an unconfirmed branch. The script now collects every branch checked out across all worktrees via `git worktree list --porcelain` and excludes them from deletion up front, reporting them as `SKIP:<branch> - checked out in a worktree` instead of attempting (and failing) `git branch -D` on them. Normal (non-worktree) tree behavior is unchanged.
- `release-evidence.js`'s `mergedPRs`/`ciHistory` date-range query no longer re-includes the previous release's own PR and CI runs. GitHub's `merged:`/`--created` range syntax is inclusive on both ends, so using the previous tag's raw commit date as the lower bound matched anything that landed at that exact instant — typically the previous `release: vX.Y.Z` PR itself — while `commits` (via `git log <prev>..<tag>`) already excluded it. The lower bound is now that date advanced by one second (`exclusiveLowerBoundISO`), matching `commits`'s "excludes the previous tag, includes the target tag" boundary.
- `release` step 9 (waiting for CI) now runs the same `wait-ci.js` script `ship` step 9 uses, instead of a bare `gh pr checks <pr> --watch --fail-fast` foreground call. The common-script extraction in agent-marketplace#22 only ever scoped in `release` step 10 (Copilot review), so `release`'s CI wait never inherited `wait-ci.js`'s `CONFLICTING` auto-detection (agent-marketplace#64, fixing the silent-skipped-check issue from agent-marketplace#58) — a `release` PR left conflicting with `origin/main` by concurrent `ship`/`batch-ship` merges would silently wait out its full timeout instead of surfacing `CONFLICTING:`. SKILL.md now documents the same exit-code table and CONFLICTING recovery (rebase onto `origin/main`, force-push, retry) as `ship` step 9.
- `propose-improvements` step 1's duplicate-issue check now also re-fetches the full body (`gh issue view <n> --json body`) for candidates whose title or keywords look like they might overlap an existing issue, when `gh-issue-inventory.js` flagged them `bodyTruncated: true` — matching the same handling `plan-next` step 3 already had. `gh-issue-inventory.js` truncates issue bodies to 1000 characters by default, so a long existing issue's disambiguating detail past that point could be invisible to the check, risking a duplicate issue getting filed.
- `vscode-ext`'s `test-and-package` step 1 now also checks for `scripts["package:install"]` when `$ARGUMENTS` includes `install`, instead of only checking `compile`/`test`/`check:package`/`package` regardless of arguments. Step 6 already required `package:install` to run `npm run package:install` in that case, but step 1 never verified it existed, so a target repo missing that script only failed at the very end of step 6 — after step 2-5's compile and slow VS Code extension test run had already completed. Running without the `install` argument is unaffected: only the original four scripts are checked.

## [0.5.0] - 2026-07-17

### Added

- Codex CLI support: each plugin now ships a `.codex-plugin/plugin.json` and the repository root a `.agents/plugins/marketplace.json`, mirroring the Claude Code manifests (name/version/plugin list kept in sync, verified by tests), so `codex plugin marketplace add upu/agent-marketplace` can install the same plugins. README documents the Codex install steps.

### Changed

- `ship`'s final report now proposes a hands-on manual check whenever the change affects how the user operates the tool (new UI, new commands/options, changed workflows, changed input/output appearance, changed interactive flows). The proposal must pair concrete try-out steps (including prerequisites such as plugin updates or session reloads) with explicit pass criteria — what the user should see or get for the change to count as working — since automated tests and green CI can't cover look-and-feel, and the merge-by-default flow otherwise ships such changes without a human ever touching them. `batch-ship` forwards the same requirement to its sub-agents' reports and aggregates the proposals into a single "recommended manual checks" list at the end of its final report.

## [0.4.0] - 2026-07-15

### Changed

- `ship` and `release` now merge PRs via a new `merge-pr.js` script instead of an inline prose branch on `gh pr merge --delete-branch`. The script itself detects whether the current tree is a linked worktree (`git rev-parse --git-common-dir` returning something other than `.git`) and merges accordingly: `--delete-branch` on a normal tree, or a plain squash merge followed by a `mergedAt` check and an explicit `git push origin --delete <branch>` on a worktree (never `git checkout main`, which always fails there). This replaces prose that sub-agents running in worktree isolation repeatedly misread, misapplying `--delete-branch` and requiring manual recovery.
- `ship` step 13 (local branch cleanup) now runs a new `cleanup-merged-branches.js` script instead of prose telling the model to read `git branch -vv` output looking for `[origin/<branch>: gone]` and cross-check each PR's `mergedAt` by hand. The script enumerates local branches with a gone upstream via `git for-each-ref`'s structured `%(upstream:track)` field, confirms merge status per branch via `gh pr view <branch> --json number,state,mergedAt` (never `git branch --merged`, which misjudges squash-merged branches), deletes only confirmed-merged branches with `git branch -D`, and reports unconfirmed branches without touching them.
- `wait-ci.js` now checks `gh pr view <pr> --json mergeable` itself instead of leaving it to a `ship` step 9 footnote the model had to remember to apply manually. When a PENDING check's message stays identical for several consecutive polls, or the timeout is about to elapse, it checks mergeability; a `CONFLICTING` result now ends the wait with a dedicated `CONFLICTING:` log line and a new exit code `3` (rebasing onto `origin/main` itself is still left to the caller). Normal mergeable PRs are unaffected — the mergeable check never runs on the fast DONE/FAILED path.
- `ship` step 10 and `release` step 10 now read a submitted Copilot review's body and inline comments via a single new `fetch-copilot-feedback.js <pr> [sha]` script instead of two separate raw `gh` calls described in prose, one of them a hand-written `--jq` expression (the class of operation that caused agent-marketplace#7). The script calls `gh` via `execFileSync` argument arrays (no jq dependency) and prints `{ summary, state, inlineComments: [{path, line, body}] }`. Implemented as a standalone script (rather than a `--dump` flag on `wait-copilot-review.js`) to keep "wait for a review" and "read its content" as separate responsibilities.
- `retro` step 1 (reconstructing what actually happened) now runs a single new `release-evidence.js <version>` script instead of five separate hand-typed `gh`/`git` invocations for the CHANGELOG section, milestone issue list, commit log, merged PR list, and CI failure/re-run history. The release window is derived from git tags (`git tag --sort=-creatordate`, target tag vs. the one immediately before it); CI history is queried across all branches (not just `main`) via `gh run list --created <range>` and filtered down to failed or re-run (`attempt > 1`) entries, since the friction retro cares about mostly happens on PR branches. A missing `CHANGELOG.md`, or a missing version heading in it, yields `changelog: null` without failing the rest of the script, so repos that don't keep a CHANGELOG still get every other data source.
- `batch-ship` step 5 (confirming a wave finished before starting the next) now runs a new `wave-status.js <issue...>|--milestone=<title>` script instead of prose telling the model to run `gh issue list --milestone ... --state all` and `gh pr list --state merged --limit 200` separately and cross-reference the two raw JSON dumps itself — a growing context/accuracy burden on milestones with many issues. The script reconciles each issue's `closedByPullRequestsReferences` (confirmed available both on `gh issue view` and, in bulk, on `gh issue list`, against gh 2.86.0) with a follow-up `gh pr view --json state` check per linked PR (since a linked PR isn't necessarily merged yet), printing `{ number, state, linkedPr, prMerged }` per issue.

## [0.3.0] - 2026-07-11

### Changed

- `ship` now verifies, after merging a PR that adds or changes a `.github/workflows/*.yml` trigger not covered by `pull_request`, that the workflow's real first run (e.g. on a `push`-only trigger) actually succeeds — a PR's own CI never exercises such a workflow, so it could previously be reported as done while still untested in production.

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

[Unreleased]: https://github.com/upu/agent-marketplace/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.6.0
[0.5.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.5.0
[0.4.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.4.0
[0.3.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.3.0
[0.2.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.2.0
[0.1.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.1.0
