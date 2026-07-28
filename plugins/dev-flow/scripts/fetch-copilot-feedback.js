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
// Design note (agent-marketplace#96): inline comments are scoped to the
// matched review's numeric id (comment.pull_request_review_id), not just to
// `user.login === "Copilot"` — a PR reviewed more than once otherwise leaks
// still-open inline comments from earlier reviews on older commits into the
// latest review's feedback, even when that review added no new comments.
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
 * Design decision (agent-marketplace#96, option 1 of the issue's design
 * memo): resolve `sha`'s numeric REST review id — the value inline comments
 * reference via `pull_request_review_id` — by scanning the REST reviews
 * list, since GraphQL's `gh pr view --json reviews` (used by
 * findMatchingReview above, for body/state, unchanged) exposes only a
 * non-numeric node id. REST's `user.login` for the bot carries a `[bot]`
 * suffix that GraphQL's `author.login` omits, hence `startsWith` rather than
 * an exact match against COPILOT_REVIEWER_LOGIN.
 */
function findMatchingReviewId(restReviews, sha) {
  const matches = restReviews.filter(
    (r) => r.user && r.user.login.startsWith(COPILOT_REVIEWER_LOGIN) && r.commit_id === sha
  );
  if (matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1].id;
}

/**
 * Inline review comments use `user.login`, not `author.login` (see the
 * header note) — filtering these by the review-body login, or vice versa,
 * silently returns an empty result instead of an error.
 *
 * Scoping to `reviewId` (the target review's numeric id) is what keeps
 * comments left over from earlier Copilot reviews on the same PR out of the
 * result — without it, a PR reviewed multiple times bleeds every prior
 * review's still-open inline comments into the latest review's feedback,
 * even when that review added none (agent-marketplace#96).
 */
function filterCopilotInlineComments(comments, reviewId) {
  return comments
    .filter((c) => c.user && c.user.login === COPILOT_COMMENTER_LOGIN && c.pull_request_review_id === reviewId)
    .map((c) => ({ path: c.path, line: c.line, body: c.body }));
}

function buildFeedback(review, comments, reviewId) {
  return {
    summary: review.body,
    state: review.state,
    inlineComments: filterCopilotInlineComments(comments, reviewId),
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
 * REST review objects (unlike `gh pr view --json reviews`'s GraphQL-backed
 * ones) carry the numeric `id` that inline comments reference via
 * `pull_request_review_id` — see findMatchingReviewId. Same `--paginate
 * --slurp` shape as fetchInlineComments below, for the same reason.
 */
function fetchReviewsRest(pr, exec) {
  const raw = runGh(["api", `repos/:owner/:repo/pulls/${pr}/reviews`, "--paginate", "--slurp"], exec);
  return JSON.parse(raw).flat();
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
 * resolve its REST review id and fetch/filter inline comments — skipping
 * those calls entirely when there's nothing to attach them to.
 * `fetchReviews`/`fetchReviewsRest`/`fetchInlineComments` are injected so
 * this is testable without real `gh` calls.
 *
 * If the REST id can't be resolved for a review GraphQL already confirmed
 * exists (unexpected — e.g. an API inconsistency between the two calls),
 * fall back to an empty inlineComments array rather than either guessing
 * which comments belong to it or returning stale/unrelated ones; summary and
 * state are unaffected since they come from the already-matched review.
 */
function fetchCopilotFeedback(pr, sha, { fetchReviews, fetchReviewsRest, fetchInlineComments, log = console.log }) {
  const review = findMatchingReview(fetchReviews(), sha);
  if (!review) {
    log(`NOT_FOUND: no Copilot review submitted for sha ${sha}`);
    return 1;
  }
  const reviewId = findMatchingReviewId(fetchReviewsRest(), sha);
  const comments = reviewId === null ? [] : fetchInlineComments();
  const feedback = buildFeedback(review, comments, reviewId);
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
    fetchReviewsRest: () => fetchReviewsRest(args.pr, execFileSync),
    fetchInlineComments: () => fetchInlineComments(args.pr, execFileSync),
  });
  process.exit(exitCode);
}

module.exports = {
  parseArgs,
  findMatchingReview,
  findMatchingReviewId,
  filterCopilotInlineComments,
  buildFeedback,
  fetchCopilotFeedback,
};

if (require.main === module) {
  main();
}
