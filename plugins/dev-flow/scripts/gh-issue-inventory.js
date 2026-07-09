// Fetches "current state of the issue tracker" (open issues + milestones)
// via `gh`, with the pagination/field flags baked in correctly, so every
// skill that needs this (plan-next, propose-improvements, ...) gets an
// identical, correct call instead of re-deriving `--limit`/`--paginate`
// each time in prose (a class of bug this plugin has hit before, e.g. the
// `gh pr view --jq --arg` misuse fixed in agent-marketplace#7).
//
// Usage: node gh-issue-inventory.js [--milestones-state=open|closed|all] [--max-body-chars=N]
// Prints a single JSON object `{ issues, milestones }` to stdout.
"use strict";

const { execSync } = require("node:child_process");

const DEFAULT_MAX_BODY_CHARS = 1000;
const VALID_MILESTONE_STATES = ["open", "closed", "all"];

function parseArgs(argv) {
  const args = { milestonesState: "open", maxBodyChars: DEFAULT_MAX_BODY_CHARS };
  for (const arg of argv) {
    const milestonesMatch = /^--milestones-state=(.+)$/.exec(arg);
    const maxBodyMatch = /^--max-body-chars=(\d+)$/.exec(arg);
    if (milestonesMatch) {
      if (!VALID_MILESTONE_STATES.includes(milestonesMatch[1])) {
        throw new Error(`--milestones-state must be one of ${VALID_MILESTONE_STATES.join("/")} (got: ${milestonesMatch[1]})`);
      }
      args.milestonesState = milestonesMatch[1];
    } else if (maxBodyMatch) {
      args.maxBodyChars = Number(maxBodyMatch[1]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Truncate an issue body to maxChars, reporting whether truncation happened. */
function truncateBody(body, maxChars) {
  const text = typeof body === "string" ? body : "";
  if (text.length <= maxChars) {
    return { body: text, truncated: false };
  }
  return { body: text.slice(0, maxChars), truncated: true };
}

/** Run a `gh` command, surfacing its stderr (not just "Command failed") on error. */
function runGh(command, exec) {
  try {
    return exec(command, { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(`${command} failed: ${detail}`);
  }
}

/**
 * `gh issue list --json ...` paginates internally up to `--limit` and
 * returns one flat JSON array — unlike raw `gh api`, it needs no
 * --paginate/--slurp handling.
 */
function fetchOpenIssues(maxBodyChars, exec = execSync) {
  const raw = runGh(
    "gh issue list --state open --limit 1000 --json number,title,labels,milestone,body",
    exec
  );
  const issues = JSON.parse(raw);
  return issues.map((issue) => {
    const { body, truncated } = truncateBody(issue.body, maxBodyChars);
    return {
      number: issue.number,
      title: issue.title,
      labels: (issue.labels || []).map((l) => l.name),
      milestone: issue.milestone ? { number: issue.milestone.number, title: issue.milestone.title } : null,
      body,
      bodyTruncated: truncated,
    };
  });
}

/**
 * Raw `gh api ... --paginate` prints each page as a separate top-level JSON
 * value, which is not valid to `JSON.parse` as-is once there's more than one
 * page. `--slurp` wraps the pages into one outer array, but each element of
 * that outer array is itself a page's array, so it still needs flattening
 * (verified empirically against gh 2.86.0 — the CLI's own --help text says
 * only that slurp "wraps pages into an outer JSON array", not that pages
 * are pre-flattened).
 */
function fetchMilestones(state, exec = execSync) {
  const raw = runGh(`gh api "repos/:owner/:repo/milestones?state=${state}" --paginate --slurp`, exec);
  const pages = JSON.parse(raw);
  const milestones = pages.flat();
  return milestones.map((m) => ({ number: m.number, title: m.title, state: m.state }));
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  try {
    const issues = fetchOpenIssues(args.maxBodyChars);
    const milestones = fetchMilestones(args.milestonesState);
    console.log(JSON.stringify({ issues, milestones }, null, 2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, truncateBody, fetchOpenIssues, fetchMilestones };

if (require.main === module) {
  main();
}
