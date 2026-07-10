// Polls for a Copilot code review on a PR, pinned to one commit sha,
// replacing the ~30-line bash loop that used to live inline in ship/release
// SKILL.md — see agent-marketplace#22. The two Copilot identities are easy
// to mix up (`Copilot` on a pending `reviewRequests` entry vs.
// `copilot-pull-request-reviewer` as `author.login` once a review is
// submitted; a submitted review's inline comments use `user.login` instead
// of `author.login`), and `gh pr view --jq` only accepts a single jq
// expression — it has no `--arg`-style variable injection, so building the
// sha filter as a jq string was a prior failure source (agent-marketplace#7).
// This script sidesteps all of it: `gh` is called via execFileSync with an
// argument array (no shell, no jq) and the JSON it returns is filtered in
// Node.
//
// Usage: node wait-copilot-review.js <pr> [sha] [--interval-ms=25000] [--timeout-ms=900000]
//   [sha] defaults to `git rev-parse HEAD` when omitted.
// Exit codes: 0 = a review was submitted for this sha, or Copilot review
//                 was never requested for this PR (nothing to wait for)
//             2 = timed out with no review submitted for this sha yet
//                 (may still arrive later — the caller may proceed)
"use strict";

const { execFileSync } = require("node:child_process");

const DEFAULT_INTERVAL_MS = 25000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const COPILOT_REVIEWER_LOGIN = "copilot-pull-request-reviewer";

function parseArgs(argv) {
  const args = { pr: null, sha: null, intervalMs: DEFAULT_INTERVAL_MS, timeoutMs: DEFAULT_TIMEOUT_MS };
  const positional = [];
  for (const arg of argv) {
    const intervalMatch = /^--interval-ms=(\d+)$/.exec(arg);
    const timeoutMatch = /^--timeout-ms=(\d+)$/.exec(arg);
    if (intervalMatch) {
      args.intervalMs = Number(intervalMatch[1]);
    } else if (timeoutMatch) {
      args.timeoutMs = Number(timeoutMatch[1]);
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new Error("Usage: wait-copilot-review.js <pr> [sha] [--interval-ms=N] [--timeout-ms=N]");
  }
  args.pr = positional[0];
  args.sha = positional[1] || null;
  return args;
}

/** The state of the most recent Copilot review submitted for `sha`, or null if none. */
function findSubmittedReview(reviews, sha) {
  const matches = reviews.filter(
    (r) => r.author && r.author.login === COPILOT_REVIEWER_LOGIN && r.commit && r.commit.oid === sha
  );
  if (matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1].state;
}

/** Whether a Copilot review is currently outstanding (requested, not yet submitted). */
function hasPendingCopilotRequest(reviewRequests) {
  return reviewRequests.some((r) => {
    const name = r.login || r.name;
    return typeof name === "string" && /copilot/i.test(name);
  });
}

/** Whether Copilot was ever requested as a reviewer on this PR, per its timeline. */
function everRequestedCopilot(timelineEvents) {
  return timelineEvents.some((e) => {
    if (e.event !== "review_requested") {
      return false;
    }
    const reviewer = e.requested_reviewer || e.requested_team;
    const name = reviewer && (reviewer.login || reviewer.name);
    return typeof name === "string" && /copilot/i.test(name);
  });
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

function fetchReviewRequests(pr, exec) {
  const raw = runGh(["pr", "view", String(pr), "--json", "reviewRequests"], exec);
  return JSON.parse(raw).reviewRequests || [];
}

/**
 * `gh api ... --paginate` prints one JSON array per page with no separator,
 * which isn't valid to JSON.parse once there's more than one page; `--slurp`
 * wraps those pages into one outer array but doesn't flatten them (same gh
 * behavior already relied on in gh-issue-inventory.js's fetchMilestones).
 */
function fetchTimelineEvents(pr, exec) {
  const raw = runGh(["api", `repos/:owner/:repo/issues/${pr}/timeline`, "--paginate", "--slurp"], exec);
  return JSON.parse(raw).flat();
}

/** Synchronously block for `ms` without spawning a subprocess. */
function sleepSync(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function safeCall(fn, log) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    log(`ERROR (retrying): ${err.message}`);
    return { ok: false };
  }
}

/**
 * Poll until a Copilot review lands for `sha`, or until the timeout elapses.
 * A single early "not configured" exit is only taken once one full,
 * error-free poll has come back with neither a pending request nor a
 * submitted review AND the timeline shows Copilot was never requested on
 * this PR — a short run of empty polls is not enough on its own, since
 * review requests can lag behind the push that triggers them.
 * `fetch*`/`sleepFn`/`now`/`log` are injected so this is testable without
 * real `gh` calls, real sleeps, or a real clock.
 */
function waitForCopilotReview(
  pr,
  sha,
  { intervalMs, timeoutMs, fetchReviews, fetchReviewRequests, fetchEverRequested, sleepFn, now = Date.now, log = console.log }
) {
  const deadline = now() + timeoutMs;
  let seenPending = false;
  let checkedNotConfigured = false;

  while (true) {
    const reviewsResult = safeCall(fetchReviews, log);
    if (reviewsResult.ok) {
      const state = findSubmittedReview(reviewsResult.value, sha);
      if (state) {
        log(`SUBMITTED:${state}`);
        return 0;
      }
    }

    const requestsResult = safeCall(fetchReviewRequests, log);
    if (requestsResult.ok) {
      const pending = hasPendingCopilotRequest(requestsResult.value);
      if (pending && !seenPending) {
        log("review requested, still awaiting submission");
        seenPending = true;
      }
    }

    if (!seenPending && !checkedNotConfigured && reviewsResult.ok && requestsResult.ok) {
      const everResult = safeCall(fetchEverRequested, log);
      if (everResult.ok) {
        checkedNotConfigured = true;
        if (!everResult.value) {
          log("NOT_CONFIGURED: no Copilot review request found for this PR");
          return 0;
        }
      }
    }

    if (now() >= deadline) {
      log("TIMEOUT: no Copilot review submitted within the timeout");
      return 2;
    }
    sleepFn(intervalMs);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
  const sha = args.sha || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const exitCode = waitForCopilotReview(args.pr, sha, {
    intervalMs: args.intervalMs,
    timeoutMs: args.timeoutMs,
    fetchReviews: () => fetchReviews(args.pr, execFileSync),
    fetchReviewRequests: () => fetchReviewRequests(args.pr, execFileSync),
    fetchEverRequested: () => everRequestedCopilot(fetchTimelineEvents(args.pr, execFileSync)),
    sleepFn: sleepSync,
  });
  process.exit(exitCode);
}

module.exports = {
  parseArgs,
  findSubmittedReview,
  hasPendingCopilotRequest,
  everRequestedCopilot,
  waitForCopilotReview,
};

if (require.main === module) {
  main();
}
