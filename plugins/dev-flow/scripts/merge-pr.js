// Merges a PR via `gh pr merge`, choosing between `--delete-branch` (normal
// git tree) and an explicit `git push origin --delete` (linked worktree).
// `--delete-branch`'s post-merge cleanup does a local `git checkout main`,
// which always fails inside a linked worktree because `main` is already
// checked out in the primary tree — batch-ship v1.4.0 (2026-07-10) hit this
// on nearly every worktree-isolated sub-agent run, each needing manual
// recovery (see agent-marketplace#56). Calls `gh`/`git` via execFileSync
// with argument arrays (no shell, no jq).
//
// Usage: node merge-pr.js <pr>
// Exit codes: 0 = merged (remote branch deleted, or deletion skipped/failed
//                 without undoing the merge itself — see the logged message)
//             1 = merge failed (e.g. CI not green, conflicts), the merge
//                 reported success but `mergedAt` is still unset, invalid/
//                 missing arguments, or `gh` is not available
"use strict";

const { execFileSync } = require("node:child_process");

function parseArgs(argv) {
  if (argv.length !== 1) {
    throw new Error("Usage: merge-pr.js <pr>");
  }
  // A non-numeric <pr> makes every `gh` call fail the same way a real
  // merge failure would, so without this check a typo'd PR number reports
  // a generic merge error instead of failing fast on the actual mistake.
  if (!/^\d+$/.test(argv[0])) {
    throw new Error(`<pr> must be a number (got: ${argv[0]})`);
  }
  return { pr: argv[0] };
}

/** Run `gh`/`git <args>`, surfacing stderr (not just "Command failed") on error. */
function run(cmd, args, exec) {
  try {
    return exec(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(detail);
  }
}

/**
 * A linked worktree's `git rev-parse --git-common-dir` resolves to the main
 * worktree's absolute `.git` path; the main worktree itself reports the
 * literal string `.git` (verified against a real linked worktree checkout).
 */
function isLinkedWorktree(exec) {
  const out = run("git", ["rev-parse", "--git-common-dir"], exec).trim();
  return out !== ".git";
}

function fetchHeadRefName(pr, exec) {
  const raw = run("gh", ["pr", "view", String(pr), "--json", "headRefName"], exec);
  return JSON.parse(raw).headRefName;
}

function fetchMergedAt(pr, exec) {
  const raw = run("gh", ["pr", "view", String(pr), "--json", "mergedAt"], exec);
  return JSON.parse(raw).mergedAt;
}

/**
 * Merge `pr`, branching on whether the current tree is a linked worktree.
 * Lets errors from `gh pr merge` itself (not mergeable, CI not green, etc.)
 * propagate uncaught so the caller can distinguish "merge never happened"
 * from the worktree branch's own post-merge steps. `exec`/`log` are injected
 * so this is testable without real `gh`/`git` calls.
 */
function mergePr(pr, { exec, log = console.log }) {
  const worktree = isLinkedWorktree(exec);

  if (!worktree) {
    run("gh", ["pr", "merge", String(pr), "--squash", "--delete-branch"], exec);
    log(`MERGED:${pr} (branch deleted via --delete-branch)`);
    return 0;
  }

  // Fetched before merging (not after) so a lookup failure here fails fast
  // instead of leaving a successfully-merged PR with no known branch to clean up.
  const branch = fetchHeadRefName(pr, exec);
  run("gh", ["pr", "merge", String(pr), "--squash"], exec);

  const mergedAt = fetchMergedAt(pr, exec);
  if (!mergedAt) {
    log(`ERROR: gh pr merge reported success but mergedAt is not set for #${pr}`);
    return 1;
  }

  // Mirrors the normal-tree path's "don't assume the remote branch always
  // gets deleted" (`gh pr merge --delete-branch` itself can fail to delete):
  // the merge already succeeded, so a cleanup failure here is logged but
  // does not flip the overall result to failure.
  try {
    run("git", ["push", "origin", "--delete", branch], exec);
    log(`MERGED:${pr} (worktree: mergedAt=${mergedAt}, remote branch ${branch} deleted)`);
  } catch (err) {
    log(`MERGED:${pr} but remote branch ${branch} deletion failed: ${err.message}`);
  }
  return 0;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
  // Without this, a missing `gh` binary looks identical to a real merge
  // failure, obscuring a problem that will never resolve itself.
  try {
    run("gh", ["--version"], execFileSync);
  } catch (err) {
    console.error(`::error::\`gh\` is not available: ${err.message}`);
    process.exit(1);
  }
  let exitCode;
  try {
    exitCode = mergePr(args.pr, { exec: execFileSync });
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    process.exit(1);
  }
  process.exit(exitCode);
}

module.exports = { parseArgs, isLinkedWorktree, mergePr };

if (require.main === module) {
  main();
}
