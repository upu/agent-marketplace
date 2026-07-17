// Collects "what actually happened for a release" in one JSON call, so
// `retro` step 1 no longer has the model re-derive five separate `gh`/`git`
// invocations (CHANGELOG section, milestone issues, commit log, merged PRs,
// CI failure/re-run history) and their flags (`--limit`, `--state all`,
// `--search "merged:>=..."`) by hand each time — the same problem
// gh-issue-inventory.js already solved for `plan-next`/`propose-improvements`.
//
// Design notes (agent-marketplace#60):
// - The release window is derived from git tags, not release dates typed by
//   the caller: `<version>` (e.g. "0.4.0", a leading "v" is accepted and
//   stripped) resolves to tag `v<version>`, and the "previous tag" is the
//   next-most-recent tag before it in `git tag --sort=-creatordate` order.
//   For a first release (no previous tag), the window is left open-ended on
//   the lower bound (`<=<tag date>` instead of `<prev>..<tag>`).
// - CHANGELOG extraction is the only data source allowed to come back empty
//   without error (per the issue's acceptance criteria: repos that don't
//   keep a CHANGELOG must not fail the whole script) — a missing
//   CHANGELOG.md or a missing `## [x.y.z]` heading both just yield
//   `changelog: null`. The other four sources are expected to exist for any
//   repo this script is run against and their `gh`/`git` failures propagate.
// - CI history uses `gh run list --created <range>` with NO `--branch`/
//   `--workflow` filter: the friction retro cares about (re-runs, failures)
//   mostly happens on PR branches, not `main`, and PR branch names differ
//   per PR, so scoping to `main` would hide exactly the runs retro wants to
//   see. The date range is the same tag-derived window as everything else.
//   The raw list is filtered down to runs that are themselves signal —
//   conclusion is one of failure/cancelled/timed_out/startup_failure, or
//   `attempt > 1` (a re-run) — so the output stays focused on friction
//   rather than every green run in the window.
// - Calls `gh`/`git` via execFileSync with argument arrays (no shell, no
//   jq), matching merge-pr.js/cleanup-merged-branches.js/wait-ci.js/
//   fetch-copilot-feedback.js.
// - `mergedPRs`/`ciHistory`'s lower bound is the previous tag's commit date
//   advanced by one second (`exclusiveLowerBoundISO`, agent-marketplace#84),
//   not the raw date: GitHub's `merged:`/`--created` range syntax is
//   inclusive on both ends, so the raw date would re-include the previous
//   release's own PR/CI runs — unlike `commits`, which already excludes the
//   previous tag by construction via `git log <prev>..<tag>`.
//
// Usage: node release-evidence.js <version>
//   <version> is the released version without a leading "v" (e.g. "0.4.0");
//   a leading "v" is also accepted and stripped.
// Prints a single JSON object to stdout:
//   { version, tag, previousTag, changelog, milestoneIssues, commits,
//     mergedPRs, ciHistory }
// Exit codes: 0 = collected (individual sources may still be empty arrays)
//             1 = invalid/missing arguments, `gh`/`git` unavailable, the
//                 target tag does not exist locally, or a `gh`/`git` call
//                 failed
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MILESTONE_ISSUE_LIMIT = 200;
const PR_LIMIT = 200;
const CI_RUN_LIMIT = 100;
const FAILURE_CONCLUSIONS = ["failure", "cancelled", "timed_out", "startup_failure"];

function parseArgs(argv) {
  const positional = argv.filter((arg) => {
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    return true;
  });
  if (positional.length !== 1) {
    throw new Error("Usage: release-evidence.js <version>");
  }
  const version = positional[0].replace(/^v/, "");
  if (!version) {
    throw new Error(`<version> must not be empty (got: ${positional[0]})`);
  }
  return { version };
}

/** Run `cmd <args>`, surfacing stderr (not just "Command failed") on error. */
function run(cmd, args, exec) {
  try {
    return exec(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(detail);
  }
}

/**
 * The target tag plus the tag immediately before it in creation order (or
 * `null` if the target tag is the oldest/only tag). Throws if the target
 * tag doesn't exist locally — the caller likely needs `git fetch --tags`.
 */
function resolveTagInfo(version, exec) {
  const tag = `v${version}`;
  const raw = run("git", ["tag", "--sort=-creatordate"], exec);
  const tags = raw.split("\n").map((t) => t.trim()).filter(Boolean);
  const idx = tags.indexOf(tag);
  if (idx === -1) {
    throw new Error(`tag ${tag} not found locally (try \`git fetch --tags\`)`);
  }
  const previousTag = idx + 1 < tags.length ? tags[idx + 1] : null;
  return { tag, previousTag };
}

/** The ISO 8601 author date of a tag's commit, used as a range boundary. */
function fetchTagDate(tag, exec) {
  return run("git", ["log", "-1", "--format=%aI", tag], exec).trim();
}

/**
 * A `from..to` range, or `<=to` when there is no lower bound (first
 * release). Shared by the `gh pr list --search` and `gh run list --created`
 * date qualifiers, which both accept this syntax.
 *
 * Callers must pass an already-*exclusive* `fromISO` (see
 * `exclusiveLowerBoundISO`) when it comes from a tag's own commit date —
 * GitHub's date-range syntax is inclusive on both ends, so a raw commit
 * date as `<from>` re-includes anything that landed at that exact instant.
 */
function dateRangeQualifier(fromISO, toISO) {
  return fromISO ? `${fromISO}..${toISO}` : `<=${toISO}`;
}

/**
 * `tagISO` advanced by one second, used to turn a tag's own commit date
 * into an *exclusive* lower bound for `dateRangeQualifier`.
 *
 * Why this exists (agent-marketplace#84): `git log <prev>..<tag>` already
 * excludes `<prev>`'s own commit by construction, but GitHub's `merged:`/
 * `--created` search syntax used for `mergedPRs`/`ciHistory` is inclusive on
 * both ends — passing the previous tag's raw commit date as `<from>`
 * re-includes anything that merged/ran at that exact instant, which in
 * practice is the previous release's own `release: vX.Y.Z` PR (and its CI
 * runs). Advancing by one second closes that gap and makes `mergedPRs`/
 * `ciHistory` use the same "excludes the previous tag, includes the target
 * tag" boundary that `commits` already gets from git's range syntax.
 *
 * Manipulates the wall-clock digits directly (via a UTC-labelled `Date` used
 * purely as a calendar calculator) rather than round-tripping through the
 * instant, so the original numeric offset (e.g. `+09:00`) is preserved
 * as-is instead of being collapsed to `Z` — the arithmetic is
 * offset-independent since the offset is a constant shift.
 */
function exclusiveLowerBoundISO(tagISO) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(tagISO);
  if (!match) {
    throw new Error(`exclusiveLowerBoundISO: unrecognized ISO 8601 date: ${tagISO}`);
  }
  const [, datePart, offset] = match;
  const asCalendar = new Date(`${datePart}Z`);
  asCalendar.setUTCSeconds(asCalendar.getUTCSeconds() + 1);
  const pad = (n) => String(n).padStart(2, "0");
  const shiftedDatePart =
    `${asCalendar.getUTCFullYear()}-${pad(asCalendar.getUTCMonth() + 1)}-${pad(asCalendar.getUTCDate())}` +
    `T${pad(asCalendar.getUTCHours())}:${pad(asCalendar.getUTCMinutes())}:${pad(asCalendar.getUTCSeconds())}`;
  return `${shiftedDatePart}${offset}`;
}

/**
 * Extracts the `## [x.y.z]` ... section (up to the next `## [` heading or
 * end of file) from a CHANGELOG.md's raw content. Returns `null` if no
 * matching heading is found — callers use this to distinguish "not
 * adopted"/"no such section yet" from an actual error, per the issue's
 * requirement that a missing CHANGELOG must not fail the whole script.
 */
function extractChangelogSection(content, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^## \\[${escaped}\\].*$`, "m");
  const match = headingRe.exec(content);
  if (!match) {
    return null;
  }
  const start = match.index;
  const rest = content.slice(start + match[0].length);
  const nextHeadingMatch = /^## \[/m.exec(rest);
  const end = nextHeadingMatch ? start + match[0].length + nextHeadingMatch.index : content.length;
  return content.slice(start, end).trim();
}

/** Reads CHANGELOG.md from `cwd` and extracts `version`'s section, or `null` if either is missing. */
function readChangelogSection(version, { cwd = process.cwd(), readFileSync = fs.readFileSync } = {}) {
  let content;
  try {
    content = readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  return extractChangelogSection(content, version);
}

/** `git log <range> --format=...` parsed into `{ sha, subject }` entries, newest first. */
function fetchCommitLog(range, exec) {
  const raw = run("git", ["log", range, "--format=%H\x1f%s"], exec);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf("\x1f");
      return { sha: line.slice(0, sep), subject: line.slice(sep + 1) };
    });
}

function fetchMilestoneIssues(version, exec) {
  const raw = run(
    "gh",
    [
      "issue", "list",
      "--milestone", `v${version}`,
      "--state", "all",
      "--limit", String(MILESTONE_ISSUE_LIMIT),
      "--json", "number,title,labels,state",
    ],
    exec
  );
  const issues = JSON.parse(raw);
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: (issue.labels || []).map((l) => l.name),
    state: issue.state,
  }));
}

function fetchMergedPRs(qualifier, exec) {
  const raw = run(
    "gh",
    [
      "pr", "list",
      "--state", "merged",
      "--base", "main",
      "--search", `merged:${qualifier}`,
      "--limit", String(PR_LIMIT),
      "--json", "number,title,mergedAt,url",
    ],
    exec
  );
  return JSON.parse(raw);
}

/** Whether a `gh run list` entry is itself friction signal (a failure, or a re-run). */
function isNotableRun(run_) {
  return FAILURE_CONCLUSIONS.includes(run_.conclusion) || run_.attempt > 1;
}

function fetchCiHistory(qualifier, exec) {
  const raw = run(
    "gh",
    [
      "run", "list",
      "--created", qualifier,
      "--limit", String(CI_RUN_LIMIT),
      "--json", "databaseId,name,displayTitle,status,conclusion,createdAt,headBranch,event,attempt,url",
    ],
    exec
  );
  const runs = JSON.parse(raw);
  return runs.filter(isNotableRun);
}

/**
 * Orchestrates all five sources into one JSON-able object. `exec`/`readFileSync`
 * are injected so this is testable without real `gh`/`git`/filesystem access.
 */
function collectReleaseEvidence(version, { exec, readFileSync, cwd }) {
  const { tag, previousTag } = resolveTagInfo(version, exec);
  const toISO = fetchTagDate(tag, exec);
  const fromISO = previousTag ? exclusiveLowerBoundISO(fetchTagDate(previousTag, exec)) : null;
  const qualifier = dateRangeQualifier(fromISO, toISO);
  const commitRange = previousTag ? `${previousTag}..${tag}` : tag;

  return {
    version,
    tag,
    previousTag,
    changelog: readChangelogSection(version, { cwd, readFileSync }),
    milestoneIssues: fetchMilestoneIssues(version, exec),
    commits: fetchCommitLog(commitRange, exec),
    mergedPRs: fetchMergedPRs(qualifier, exec),
    ciHistory: fetchCiHistory(qualifier, exec),
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
  // Without this, a missing `gh` binary fails one of the later `gh` calls
  // with a confusing error instead of a clear "gh is not available" message.
  try {
    run("gh", ["--version"], execFileSync);
  } catch (err) {
    console.error(`::error::\`gh\` is not available: ${err.message}`);
    process.exit(1);
  }
  try {
    const evidence = collectReleaseEvidence(args.version, { exec: execFileSync });
    console.log(JSON.stringify(evidence, null, 2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  resolveTagInfo,
  fetchTagDate,
  dateRangeQualifier,
  exclusiveLowerBoundISO,
  extractChangelogSection,
  readChangelogSection,
  fetchCommitLog,
  fetchMilestoneIssues,
  fetchMergedPRs,
  fetchCiHistory,
  collectReleaseEvidence,
};

if (require.main === module) {
  main();
}
