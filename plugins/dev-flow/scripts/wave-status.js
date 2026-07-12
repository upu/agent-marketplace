// Reconciles a wave's issues against their closing PRs in one call, replacing
// the batch-ship/SKILL.md step 5 prose that told the model to run
// `gh issue list --milestone ... --state all` and `gh pr list --state merged
// --limit 200` separately and cross-reference the two raw JSON dumps itself
// — a manageable task for a handful of issues, but a growing context/accuracy
// burden as a milestone's issue count grows.
//
// Design note (agent-marketplace#61): the issue body proposed two designs —
// (1) `gh issue list` + `gh pr list --search "linked:<issue>"`/body-text
// reverse lookup, or (2) `gh issue view --json closedByPullRequestsReferences`.
// Verified empirically against gh 2.86.0: `closedByPullRequestsReferences` is
// available both on `gh issue view` (single issue) AND on `gh issue list`
// (bulk, confirmed against this repo's own milestone v0.4.0 issues #56-#61),
// so it needs no `--search`/body-parsing fallback. It does NOT report whether
// the referenced PR was actually merged (only that it's linked), so each
// linked PR's merge state is confirmed with a follow-up `gh pr view --json
// state` call. `gh` is called via execFileSync with argument arrays (no
// shell, no jq).
//
// Usage:
//   node wave-status.js <issue> [<issue> ...]
//   node wave-status.js --milestone=<title>
// Prints a JSON array of `{ number, state, linkedPr, prMerged }` to stdout,
// one entry per issue, in the order `gh` returned/the arguments were given.
// Exit codes: 0 = success
//             1 = invalid arguments, `gh` unavailable, or an unexpected error
"use strict";

const { execFileSync } = require("node:child_process");

function parseArgs(argv) {
  let milestone = null;
  const issueNumbers = [];
  for (const arg of argv) {
    const milestoneMatch = /^--milestone=(.*)$/.exec(arg);
    if (milestoneMatch) {
      if (!milestoneMatch[1]) {
        throw new Error("--milestone requires a value (got: --milestone=)");
      }
      milestone = milestoneMatch[1];
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      if (!/^\d+$/.test(arg)) {
        throw new Error(`Issue number must be a number (got: ${arg})`);
      }
      issueNumbers.push(Number(arg));
    }
  }
  if (milestone && issueNumbers.length > 0) {
    throw new Error("Usage: wave-status.js <issue...> | --milestone=<title> (cannot combine both)");
  }
  if (!milestone && issueNumbers.length === 0) {
    throw new Error("Usage: wave-status.js <issue> [<issue> ...] | --milestone=<title>");
  }
  return { milestone, issueNumbers: milestone ? null : issueNumbers };
}

/** Run `cmd args`, surfacing stderr (not just "Command failed") on error. */
function run(cmd, args, exec) {
  try {
    return exec(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(detail);
  }
}

const ISSUE_LIMIT = 200;

/**
 * Bulk fetch: one `gh issue list` call returns every issue in the milestone
 * with its `closedByPullRequestsReferences` already attached, avoiding one
 * `gh issue view` round-trip per issue.
 */
function fetchIssuesByMilestone(milestone, exec) {
  const raw = run(
    "gh",
    [
      "issue",
      "list",
      "--milestone",
      milestone,
      "--state",
      "all",
      "--limit",
      String(ISSUE_LIMIT),
      "--json",
      "number,state,closedByPullRequestsReferences",
    ],
    exec
  );
  return JSON.parse(raw);
}

/** Per-issue fetch, used when the caller passed explicit issue numbers instead of a milestone. */
function fetchIssueByNumber(number, exec) {
  const raw = run(
    "gh",
    ["issue", "view", String(number), "--json", "number,state,closedByPullRequestsReferences"],
    exec
  );
  return JSON.parse(raw);
}

/**
 * `closedByPullRequestsReferences` only says a PR is *linked* (e.g. via a
 * "Closes #N" body), not that it merged — an issue can list an open or even
 * abandoned-and-closed PR. This is the one additional `gh` call per linked
 * PR needed to confirm actual merge state.
 */
function fetchPrMerged(prNumber, exec) {
  const raw = run("gh", ["pr", "view", String(prNumber), "--json", "state"], exec);
  return JSON.parse(raw).state === "MERGED";
}

/**
 * Picks which linked PR to report when an issue references more than one
 * (e.g. an abandoned attempt followed by the PR that actually shipped it):
 * prefer a merged one over an unmerged one, otherwise report the first link
 * found so the caller still has something to investigate.
 */
function resolveLinkedPr(refs, isMerged) {
  if (!refs || refs.length === 0) {
    return { linkedPr: null, prMerged: false };
  }
  for (const ref of refs) {
    if (isMerged(ref.number)) {
      return { linkedPr: ref.number, prMerged: true };
    }
  }
  return { linkedPr: refs[0].number, prMerged: false };
}

function buildIssueStatus(issue, isMerged) {
  const { linkedPr, prMerged } = resolveLinkedPr(issue.closedByPullRequestsReferences, isMerged);
  return { number: issue.number, state: issue.state, linkedPr, prMerged };
}

function computeWaveStatus(issues, isMerged) {
  return issues.map((issue) => buildIssueStatus(issue, isMerged));
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

  try {
    const issues = args.milestone
      ? fetchIssuesByMilestone(args.milestone, execFileSync)
      : args.issueNumbers.map((n) => fetchIssueByNumber(n, execFileSync));
    // Memoized so an issue referencing the same PR more than once (or two
    // issues closed by the same PR) only queries that PR's merge state once.
    const mergedCache = new Map();
    const isMerged = (prNumber) => {
      if (!mergedCache.has(prNumber)) {
        mergedCache.set(prNumber, fetchPrMerged(prNumber, execFileSync));
      }
      return mergedCache.get(prNumber);
    };
    const status = computeWaveStatus(issues, isMerged);
    console.log(JSON.stringify(status, null, 2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  fetchIssuesByMilestone,
  fetchIssueByNumber,
  fetchPrMerged,
  resolveLinkedPr,
  buildIssueStatus,
  computeWaveStatus,
};

if (require.main === module) {
  main();
}
