// Fetches a submitted Copilot review's body + inline comments in one call,
// replacing the ship/SKILL.md and release/SKILL.md step 10 prose that told
// the model to run two separate raw `gh` calls to read review content once
// wait-copilot-review.js reports SUBMITTED — one of them a hand-written
// `gh pr view --jq` expression, the class of operation that caused
// agent-marketplace#7. As in wait-copilot-review.js, the two Copilot
// identities are NOT interchangeable: a submitted review's author is
// `author.login === "copilot-pull-request-reviewer"`, while its inline
// comments are posted as `user.login === "Copilot"`. `gh` is called via
// execFileSync with an argument array (no shell, no jq); the raw JSON is
// filtered/shaped in Node.
//
// Design note (agent-marketplace#59): implemented as a standalone script
// rather than a `--dump` flag on wait-copilot-review.js, so "wait for a
// review" and "read a review's content" stay separate responsibilities,
// matching the one-script-per-concern split already used by
// merge-pr.js/cleanup-merged-branches.js/wait-ci.js.
//
// Usage: node fetch-copilot-feedback.js <pr> [sha]
//   [sha] defaults to `git rev-parse HEAD` when omitted, pinning to the same
//   commit wait-copilot-review.js waited on.
// Exit codes: 0 = a Copilot review was found for `sha`; its body/state and
//                 inline comments are printed to stdout as one JSON object:
//                 { summary, state, inlineComments: [{path, line, body}] }
//             1 = invalid/missing arguments, a local preflight failure
//                 (e.g. `gh` unavailable, `git rev-parse HEAD` failed), or
//                 no Copilot review was found for `sha` (the caller should
//                 confirm SUBMITTED via wait-copilot-review.js first)
"use strict";

const { execFileSync } = require("node:child_process");

const COPILOT_REVIEWER_LOGIN = "copilot-pull-request-reviewer";
const COPILOT_COMMENTER_LOGIN = "Copilot";

function parseArgs(argv) {
  const positional = argv.filter((arg) => {
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    return true;
  });
  if (positional.length < 1 || positional.length > 2) {
    throw new Error("Usage: fetch-copilot-feedback.js <pr> [sha]");
  }
  // A malformed <pr>/[sha] makes every `gh` call fail the same way a
  // transient API error would, so without this check a typo'd argument
  // reports a confusing NOT_FOUND instead of failing fast on the actual mistake.
  if (!/^\d+$/.test(positional[0])) {
    throw new Error(`<pr> must be a number (got: ${positional[0]})`);
  }
  if (positional[1] && !/^[0-9a-f]{7,40}$/i.test(positional[1])) {
    throw new Error(`[sha] must look like a git commit sha (got: ${positional[1]})`);
  }
  return { pr: positional[0], sha: positional[1] || null };
}

/** The most recent submitted Copilot review pinned to `sha`, or null if none. */
function findMatchingReview(reviews, sha) {
  const matches = reviews.filter(
    (r) => r.author && r.author.login === COPILOT_REVIEWER_LOGIN && r.commit && r.commit.oid === sha
  );
  if (matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1];
}

/**
 * Inline review comments use `user.login`, not `author.login` (see the
 * header note) — filtering these by the review-body login, or vice versa,
 * silently returns an empty result instead of an error.
 */
function filterCopilotInlineComments(comments) {
  return comments
    .filter((c) => c.user && c.user.login === COPILOT_COMMENTER_LOGIN)
    .map((c) => ({ path: c.path, line: c.line, body: c.body }));
}

function buildFeedback(review, comments) {
  return {
    summary: review.body,
    state: review.state,
    inlineComments: filterCopilotInlineComments(comments),
  };
}

/** Run `gh <args>`, surfacing stderr (not just "Command failed") on error. */
function runGh(args, exec) {
  try {
    return exec("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(detail);
  }
}

function fetchReviews(pr, exec) {
  const raw = runGh(["pr", "view", String(pr), "--json", "reviews"], exec);
  return JSON.parse(raw).reviews || [];
}

/**
 * `--paginate` prints one JSON array per page with no separator, which isn't
 * valid to JSON.parse once there's more than one page; `--slurp` wraps those
 * pages into one outer array but doesn't flatten them (same gh behavior
 * already relied on in wait-copilot-review.js's fetchTimelineEvents).
 */
function fetchInlineComments(pr, exec) {
  const raw = runGh(["api", `repos/:owner/:repo/pulls/${pr}/comments`, "--paginate", "--slurp"], exec);
  return JSON.parse(raw).flat();
}

/**
 * Look up the Copilot review pinned to `sha` and, only if one is found,
 * fetch and filter inline comments — skipping that second `gh` call entirely
 * when there's nothing to attach it to. `fetchReviews`/`fetchInlineComments`
 * are injected so this is testable without real `gh` calls.
 */
function fetchCopilotFeedback(pr, sha, { fetchReviews, fetchInlineComments, log = console.log }) {
  const review = findMatchingReview(fetchReviews(), sha);
  if (!review) {
    log(`NOT_FOUND: no Copilot review submitted for sha ${sha}`);
    return 1;
  }
  const feedback = buildFeedback(review, fetchInlineComments());
  log(JSON.stringify(feedback));
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
  // Without this, a missing `gh` binary looks identical to "no review found"
  // for every call, obscuring a problem that will never resolve itself.
  try {
    runGh(["--version"], execFileSync);
  } catch (err) {
    console.error(`::error::\`gh\` is not available: ${err.message}`);
    process.exit(1);
  }
  let sha = args.sha;
  if (!sha) {
    try {
      sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch (err) {
      const detail = err.stderr ? err.stderr.toString().trim() : err.message;
      console.error(`::error::Could not resolve the current commit via \`git rev-parse HEAD\`: ${detail}`);
      process.exit(1);
    }
  }
  const exitCode = fetchCopilotFeedback(args.pr, sha, {
    fetchReviews: () => fetchReviews(args.pr, execFileSync),
    fetchInlineComments: () => fetchInlineComments(args.pr, execFileSync),
  });
  process.exit(exitCode);
}

module.exports = {
  parseArgs,
  findMatchingReview,
  filterCopilotInlineComments,
  buildFeedback,
  fetchCopilotFeedback,
};

if (require.main === module) {
  main();
}
