// Polls `gh pr checks` until every check resolves, replacing the ~35-line
// bash loop that used to live inline in ship/release SKILL.md (quoting and
// jq-escaping bugs there were a repeat failure source for lighter models —
// see agent-marketplace#22). Calls `gh` via execFileSync with an argument
// array (no shell string building, no jq) and parses its plain --json
// output itself, so there is nothing left to mis-quote.
//
// Usage: node wait-ci.js <pr> [--interval-ms=20000] [--timeout-ms=1200000]
// Exit codes: 0 = all checks passed, or this PR has no checks configured
//             1 = at least one check failed or was cancelled, invalid/missing
//                 arguments, or `gh` is not available
//             2 = timed out before checks resolved
"use strict";

const { execFileSync } = require("node:child_process");

const DEFAULT_INTERVAL_MS = 20000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

function parseArgs(argv) {
  const args = { pr: null, intervalMs: DEFAULT_INTERVAL_MS, timeoutMs: DEFAULT_TIMEOUT_MS };
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
  if (positional.length !== 1) {
    throw new Error("Usage: wait-ci.js <pr> [--interval-ms=N] [--timeout-ms=N]");
  }
  // A non-numeric <pr> makes every `gh pr checks` call fail the same way a
  // transient API error would, so without this check a typo'd PR number
  // polls silently until the timeout instead of failing fast.
  if (!/^\d+$/.test(positional[0])) {
    throw new Error(`<pr> must be a number (got: ${positional[0]})`);
  }
  args.pr = positional[0];
  // `\d+` also matches "0", which would otherwise sleep for 0ms between
  // polls (hammering the GitHub API) or time out before a single poll runs.
  if (args.intervalMs <= 0) {
    throw new Error(`--interval-ms must be a positive number (got: ${args.intervalMs})`);
  }
  if (args.timeoutMs <= 0) {
    throw new Error(`--timeout-ms must be a positive number (got: ${args.timeoutMs})`);
  }
  return args;
}

/** Classify a `gh pr checks --json name,bucket` result into a terminal or pending state. */
function classifyChecks(checks) {
  const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
  if (failed.length > 0) {
    return { status: "FAILED", message: failed.map((c) => c.name).join(",") };
  }
  // Every check's state goes into the message, including still-pending ones —
  // otherwise a poll where nothing has resolved yet (e.g. right after the PR
  // opens) reports an empty message, which waitForChecks then never logs,
  // and the watcher goes silent until the first check resolves.
  const message = checks.map((c) => `${c.name}=${c.bucket}`).join(",");
  const allResolved = checks.every((c) => c.bucket !== "pending");
  return { status: allResolved ? "DONE" : "PENDING", message };
}

/**
 * `gh pr checks` exits non-zero with "no checks reported on the '<branch>'
 * branch" on stderr when the repo has no CI wired up at all (verified
 * against a real PR) — distinct from a transient API/auth error, and the
 * one case that should end the wait immediately rather than retry.
 */
function isNoChecksError(message) {
  return /no checks reported/.test(message);
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

function fetchChecksOnce(pr, exec) {
  const raw = runGh(["pr", "checks", String(pr), "--json", "name,bucket"], exec);
  return JSON.parse(raw);
}

/** Synchronously block for `ms` without spawning a subprocess. */
function sleepSync(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Poll until checks resolve, fail, or the timeout elapses, emitting one line
 * only when the observed state changes (so a Monitor-style watcher sees a
 * steady trickle, not per-poll noise). `exec`/`sleepFn`/`now`/`log` are
 * injected so this orchestration is testable without real `gh` calls, real
 * sleeps, or a real clock.
 */
function waitForChecks(pr, { intervalMs, timeoutMs, exec, sleepFn, now = Date.now, log = console.log }) {
  const deadline = now() + timeoutMs;
  let prevMessage = null;
  // A single "no checks reported" is not enough to conclude NO_CHECKS: right
  // after a push, `gh pr checks` can report this before GitHub has finished
  // registering the triggered workflow run as a check on the PR (observed
  // in practice, not just theoretical) — a false NO_CHECKS here would make
  // the caller skip CI verification entirely. Require it twice in a row,
  // one intervalMs apart, before trusting it.
  let consecutiveNoChecks = 0;
  while (true) {
    try {
      const checks = fetchChecksOnce(pr, exec);
      consecutiveNoChecks = 0;
      const { status, message } = classifyChecks(checks);
      if (status === "FAILED") {
        log(`FAILED:${message}`);
        return 1;
      }
      if (status === "DONE") {
        log(`DONE:${message}`);
        return 0;
      }
      if (message && message !== prevMessage) {
        log(message);
        prevMessage = message;
      }
    } catch (err) {
      if (isNoChecksError(err.message)) {
        consecutiveNoChecks++;
        if (consecutiveNoChecks >= 2) {
          log("NO_CHECKS: nothing to wait for");
          return 0;
        }
        log("no checks reported yet, confirming before concluding none are configured");
      } else {
        consecutiveNoChecks = 0;
        log(`ERROR (retrying): ${err.message}`);
      }
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      log("TIMEOUT: checks did not resolve within the timeout");
      return 2;
    }
    // Cap the sleep to what's left before the deadline, so a poll that
    // finds nothing new right before the deadline doesn't push the actual
    // wait past --timeout-ms by up to a full intervalMs.
    sleepFn(Math.min(intervalMs, remainingMs));
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
  // Without this, a missing `gh` binary looks identical to a transient API
  // error to fetchChecksOnce, so the script would retry silently until
  // --timeout-ms and exit 2 (TIMEOUT) — misleading for a problem that will
  // never resolve itself.
  try {
    runGh(["--version"], execFileSync);
  } catch (err) {
    console.error(`::error::\`gh\` is not available: ${err.message}`);
    process.exit(1);
  }
  const exitCode = waitForChecks(args.pr, {
    intervalMs: args.intervalMs,
    timeoutMs: args.timeoutMs,
    exec: execFileSync,
    sleepFn: sleepSync,
  });
  process.exit(exitCode);
}

module.exports = { parseArgs, classifyChecks, isNoChecksError, waitForChecks };

if (require.main === module) {
  main();
}
