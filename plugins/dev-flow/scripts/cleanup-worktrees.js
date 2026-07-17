// Removes the linked worktrees a batch-ship wave used, once each issue's PR
// is confirmed merged, replacing SKILL.md step 7 prose that only asked the
// model to *report* leftover worktrees without ever deleting them
// (agent-marketplace#78).
//
// Design note: the issue body offered two designs — (1) have the orchestrator
// record each `Agent` tool call's returned worktree path and `git worktree
// remove` it directly, or (2) re-derive the wave's worktrees from git's own
// state (`git worktree list --porcelain`) after the fact. Option 1 depends on
// the orchestrating model correctly parsing and retaining a path out of each
// sub-agent's free-form result text — exactly the class of "model transcribes
// a raw value by hand" failure mode `wave-status.js` and
// `cleanup-merged-branches.js` were already written to avoid (see their own
// header comments and reference.md). Option 2 is chosen here for the same
// reason: it asks git for the structural fact instead. Concretely, each
// worktree's checked-out branch (`git worktree list --porcelain`'s `branch`
// line) is matched against the head branch of the wave issue's merged PR
// (`gh pr view <pr> --json headRefName`, the same lookup `merge-pr.js`
// already does) — reusing `wave-status.js`'s merge-confirmation logic
// (`resolveLinkedPr`/`fetchPrMerged`) so "is this issue's PR actually merged"
// is answered identically in both scripts.
//
// Only issues whose PR is confirmed merged are ever candidates for removal.
// An issue that isn't confirmed merged (still in progress, or stopped for
// recovery per SKILL.md step 6) never gets its worktree touched here, so a
// wave that's only partially done doesn't lose in-progress work.
//
// Removal itself never forces past uncommitted/untracked files: a merged
// wave's worktree should always be clean (everything was committed, pushed,
// and merged already), so anything left behind (e.g. a stray build artifact)
// is treated as unexpected and reported rather than force-deleted — the
// issue's design memo explicitly flags `--force` as a "swallow an unfinished
// wave's work" risk. A *locked* worktree (the state `Agent` tool worktree
// isolation leaves things in) is unlocked first and then removed normally,
// since a confirmed-merged PR means the lock no longer protects anything.
// Any removal failure is logged and the loop continues — a stuck worktree is
// never a reason to abort cleanup for the rest of the wave.
//
// Calls `gh`/`git` via execFileSync with argument arrays (no shell, no jq).
//
// Usage:
//   node cleanup-worktrees.js <issue> [<issue> ...]
//   node cleanup-worktrees.js --milestone=<title>
// Prints one log line per issue (`REMOVED:`/`SKIP:`/`FAILED:`) plus a summary
// line, and a JSON array of `{ number, path, result }` to stdout.
// Exit codes: 0 = ran to completion (individual removal failures are logged,
//                 not treated as a fatal error)
//             1 = invalid arguments, `gh` unavailable, or an unexpected error
"use strict";

const { execFileSync } = require("node:child_process");
const {
  parseArgs,
  fetchIssuesByMilestone,
  fetchIssueByNumber,
  fetchPrMerged,
  resolveLinkedPr,
} = require("./wave-status.js");

/** Run `cmd args`, surfacing stderr (not just "Command failed") on error. */
function run(cmd, args, exec) {
  try {
    return exec(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(detail);
  }
}

function fetchHeadRefName(pr, exec) {
  const raw = run("gh", ["pr", "view", String(pr), "--json", "headRefName"], exec);
  return JSON.parse(raw).headRefName;
}

/**
 * Parse `git worktree list --porcelain` into `{ path, branch }` entries.
 * Detached-HEAD worktrees (no `branch` line) get `branch: null` and never
 * match a PR's head branch, so they're naturally never removal candidates.
 */
function listWorktrees(exec) {
  const raw = run("git", ["worktree", "list", "--porcelain"], exec);
  const entries = [];
  let current = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Remove one worktree, unlocking first if `git worktree remove` reports it's
 * locked. Any other failure (most commonly "contains modified or untracked
 * files") is left alone rather than retried with `--force` — see the header
 * comment for why forcing is deliberately not the fallback here.
 */
function removeWorktree(path, exec, log) {
  try {
    run("git", ["worktree", "remove", path], exec);
    log(`REMOVED:${path}`);
    return "removed";
  } catch (err) {
    if (/is locked/i.test(err.message)) {
      try {
        run("git", ["worktree", "unlock", path], exec);
        run("git", ["worktree", "remove", path], exec);
        log(`REMOVED:${path} (was locked, unlocked first)`);
        return "removed";
      } catch (err2) {
        log(`FAILED:${path} - ${err2.message}`);
        return "failed";
      }
    }
    log(`FAILED:${path} - ${err.message}`);
    return "failed";
  }
}

/**
 * For each wave issue, remove the worktree tied to its merged PR's head
 * branch. `exec`/`log` are injected so this is testable without real
 * `gh`/`git` calls.
 */
function cleanupWaveWorktrees(issues, { exec, log = console.log }) {
  const removed = [];
  const skipped = [];
  const failed = [];

  const mergedCache = new Map();
  const isMerged = (prNumber) => {
    if (!mergedCache.has(prNumber)) {
      mergedCache.set(prNumber, fetchPrMerged(prNumber, exec));
    }
    return mergedCache.get(prNumber);
  };

  const worktreeByBranch = new Map(
    listWorktrees(exec)
      .filter((w) => w.branch)
      .map((w) => [w.branch, w.path])
  );

  for (const issue of issues) {
    const { linkedPr, prMerged } = resolveLinkedPr(issue.closedByPullRequestsReferences, isMerged);
    if (!prMerged) {
      skipped.push({ number: issue.number, reason: "not confirmed merged" });
      log(`SKIP:#${issue.number} - not confirmed merged`);
      continue;
    }

    const branch = fetchHeadRefName(linkedPr, exec);
    const path = worktreeByBranch.get(branch);
    if (!path) {
      skipped.push({ number: issue.number, reason: `no worktree found for branch ${branch}` });
      log(`SKIP:#${issue.number} - no worktree found for branch ${branch} (already cleaned up, or the sub-agent made no changes)`);
      continue;
    }

    const result = removeWorktree(path, exec, log);
    if (result === "removed") {
      removed.push({ number: issue.number, path });
    } else {
      failed.push({ number: issue.number, path });
    }
  }

  return { removed, skipped, failed };
}

function fetchIssues(args, exec) {
  return args.milestone
    ? fetchIssuesByMilestone(args.milestone, exec)
    : args.issueNumbers.map((n) => fetchIssueByNumber(n, exec));
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  // Without this, a missing `gh` binary looks identical to every other
  // failure mode below instead of a clear setup problem.
  try {
    run("gh", ["--version"], execFileSync);
  } catch (err) {
    console.error(`::error::\`gh\` is not available: ${err.message}`);
    process.exit(1);
  }

  let result;
  try {
    const issues = fetchIssues(args, execFileSync);
    result = cleanupWaveWorktrees(issues, { exec: execFileSync });
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  console.log(
    `Removed ${result.removed.length} worktree(s), skipped ${result.skipped.length}, failed ${result.failed.length}.`
  );
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

module.exports = { fetchHeadRefName, listWorktrees, removeWorktree, cleanupWaveWorktrees, fetchIssues };

if (require.main === module) {
  main();
}
