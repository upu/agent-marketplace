// Deletes local branches whose upstream was pruned (`gone`), replacing the
// prose in ship/SKILL.md step 13 that had the model read `git branch -vv`
// free text looking for `[origin/<branch>: gone]` and cross-check `gh pr
// view <pr|branch> --json mergedAt` by hand — a parse mistake there risks
// deleting an unmerged branch or leaving a merged one behind. Deletion is
// gated on the branch's PR being confirmed MERGED with a `mergedAt`
// timestamp; `git branch --merged`/commit-diff based checks are not used
// because they misjudge squash-merged branches (see ship/reference.md).
// Calls `gh`/`git` via execFileSync with argument arrays (no shell, no jq).
//
// Usage: node cleanup-merged-branches.js
// Exit codes: 0 = ran to completion (branches with no confirmed merge are
//                 left in place and reported, not treated as failure)
//             1 = `gh` not available, or an unexpected error
"use strict";

const { execFileSync } = require("node:child_process");

/** Run `cmd args`, surfacing stderr (not just "Command failed") on error. */
function run(cmd, args, exec) {
  try {
    return exec(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(detail);
  }
}

/**
 * List local branches whose upstream tracking ref is `[gone]` (the remote
 * branch was deleted, typically by `gh pr merge --delete-branch` or an
 * explicit post-merge `git push origin --delete`). Reads `for-each-ref`'s
 * structured `%(upstream:track)` field instead of parsing `git branch -vv`
 * free text, so a branch name that happens to contain "gone"-like text
 * can't be mistaken for a track marker.
 */
function listGoneBranches(exec) {
  const raw = run(
    "git",
    ["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(upstream:track)"],
    exec
  );
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, track] = line.split("\t");
      return { name, track: track || "" };
    })
    .filter((b) => b.track === "[gone]")
    .map((b) => b.name);
}

/**
 * Look up the merge status of the PR whose head branch is `branch`, via
 * `gh pr view <branch>` (matches a branch name to its PR directly, one call
 * per branch, same shape as merge-pr.js's `gh pr view <pr>` calls). Returns
 * `{ found: false }` when `gh` can't find a matching PR (e.g. deleted from
 * GitHub, or the branch never had one) so the caller reports it as
 * unconfirmed instead of silently skipping it.
 */
function fetchMergeStatus(branch, exec) {
  let raw;
  try {
    raw = run("gh", ["pr", "view", branch, "--json", "number,state,mergedAt"], exec);
  } catch (err) {
    return { found: false, reason: err.message };
  }
  const { number, state, mergedAt } = JSON.parse(raw);
  return { found: true, number, state, mergedAt, merged: state === "MERGED" && Boolean(mergedAt) };
}

/**
 * For each gone-upstream branch, confirm merge status via its PR's
 * `mergedAt` before deleting with `git branch -D`. Unconfirmed branches
 * (no PR found, or PR not merged) are left alone and reported, never
 * deleted. `exec`/`log` are injected so this is testable without real
 * `gh`/`git` calls.
 */
function cleanupMergedBranches({ exec, log = console.log }) {
  const branches = listGoneBranches(exec);
  const deleted = [];
  const skipped = [];

  if (branches.length === 0) {
    log("No local branches with a gone upstream found.");
    return { deleted, skipped };
  }

  for (const branch of branches) {
    const status = fetchMergeStatus(branch, exec);
    if (!status.found) {
      skipped.push({ branch, reason: `no PR found (${status.reason})` });
      log(`SKIP:${branch} - no PR found (${status.reason})`);
      continue;
    }
    if (!status.merged) {
      skipped.push({ branch, reason: `PR #${status.number} not confirmed merged (state=${status.state})` });
      log(`SKIP:${branch} - PR #${status.number} not confirmed merged (state=${status.state})`);
      continue;
    }
    run("git", ["branch", "-D", branch], exec);
    deleted.push(branch);
    log(`DELETED:${branch} (PR #${status.number} mergedAt=${status.mergedAt})`);
  }

  return { deleted, skipped };
}

function main() {
  // Without this, a missing `gh` binary looks identical to "no PR found" for
  // every branch, silently reporting a real setup problem as skips.
  try {
    run("gh", ["--version"], execFileSync);
  } catch (err) {
    console.error(`::error::\`gh\` is not available: ${err.message}`);
    process.exit(1);
  }
  let result;
  try {
    result = cleanupMergedBranches({ exec: execFileSync });
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    process.exit(1);
  }
  console.log(`Deleted ${result.deleted.length} branch(es), skipped ${result.skipped.length}.`);
  process.exit(0);
}

module.exports = { listGoneBranches, fetchMergeStatus, cleanupMergedBranches };

if (require.main === module) {
  main();
}
