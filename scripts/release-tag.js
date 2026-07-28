// Creates the `vX.Y.Z` tag and GitHub Release for *this* repository's own
// releases (agent-marketplace#35). This repo has no package.json/vsce
// packaging step (it distributes Claude Code skills, not an npm/VSCode
// artifact), so the only post-merge automation it needs is a tag + a
// GitHub Release built from CHANGELOG.md's freshly finalized section.
//
// Runs on every push to `main`. Is a no-op unless CHANGELOG.md's
// [Unreleased] section is currently empty (i.e. this push finalized a
// release) — so ordinary feature merges (which leave [Unreleased]
// non-empty) do nothing. Once a release is detected, the tag, the GitHub
// Release, and the milestone close are each handled by an independent
// `ensure*`/`*IfComplete` stage that checks its own current state first, so
// re-running after a partial failure (e.g. tag pushed but Release creation
// hit a transient API error) resumes from wherever it stopped instead of
// short-circuiting on a single "does the tag exist" check.
//
// Usage: node release-tag.js [repoRoot]
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** Collapse CRLF/CR to LF and split into lines, so line-based parsing works regardless of the file's line endings. */
function toLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** Whether CHANGELOG's [Unreleased] section (up to the next "## [" heading) has any real entries. */
function isUnreleasedEmpty(changelogText) {
  const lines = toLines(changelogText);
  const startIdx = lines.findIndex((l) => l.trim() === "## [Unreleased]");
  if (startIdx === -1) {
    return true;
  }
  let endIdx = lines.findIndex((l, i) => i > startIdx && /^## \[/.test(l));
  if (endIdx === -1) {
    endIdx = lines.length;
  }
  const body = lines.slice(startIdx + 1, endIdx);
  return !body.some((l) => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !/^#{1,6}\s/.test(trimmed);
  });
}

/**
 * The most recently released version's heading and body: `{ version, body }`,
 * where `body` is the section's text (between its "## [x.y.z] - date" heading
 * and the next "## [" heading, or EOF) with trailing blank lines and
 * "[label]: url" link-reference lines stripped. Returns null if no released
 * version section exists yet (a brand new repo with only "## [Unreleased]").
 */
function latestReleaseSection(changelogText) {
  const lines = toLines(changelogText);
  const startIdx = lines.findIndex((l) => /^## \[\d+\.\d+\.\d+\]/.test(l.trim()));
  if (startIdx === -1) {
    return null;
  }
  const version = /^## \[(\d+\.\d+\.\d+)\]/.exec(lines[startIdx].trim())[1];
  let endIdx = lines.findIndex((l, i) => i > startIdx && /^## \[/.test(l));
  if (endIdx === -1) {
    endIdx = lines.length;
  }
  const body = lines.slice(startIdx + 1, endIdx);
  while (
    body.length > 0 &&
    (body[body.length - 1].trim() === "" || /^\[[^\]]+\]:\s*\S+$/.test(body[body.length - 1].trim()))
  ) {
    body.pop();
  }
  return { version, body: body.join("\n").trim() };
}

function runGh(args, exec) {
  try {
    return exec("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(detail);
  }
}

/**
 * Whether `origin` already has a tag named `tag`, checked against the remote
 * directly (`git ls-remote`) rather than the local checkout: a fresh
 * `actions/checkout` clone doesn't necessarily fetch tags that already exist
 * on the remote, so a local `git tag -l` can miss a tag another run just
 * pushed and cause a duplicate `git push` that the remote then rejects.
 */
function tagExists(tag, exec) {
  const out = exec("git", ["ls-remote", "--tags", "origin"], { encoding: "utf8" }).trim();
  if (!out) {
    return false;
  }
  return out.split("\n").some((line) => line.split("\t")[1] === `refs/tags/${tag}`);
}

/**
 * The open milestone titled `title`, or null if none exists. `gh api ...
 * --paginate` prints one JSON array per page with no separator, so `--slurp`
 * (wrapping pages into one outer array, not flattening them — see
 * agent-marketplace's gh-issue-inventory.js) is required before `.flat()`.
 */
function findOpenMilestone(title, exec) {
  const raw = runGh(["api", "repos/:owner/:repo/milestones?state=open", "--paginate", "--slurp"], exec);
  const milestones = JSON.parse(raw).flat();
  return milestones.find((m) => m.title === title) || null;
}

/**
 * Whether a GitHub Release named `tag` already exists. `gh release view`
 * exits non-zero (and `runGh` throws) both when the release is genuinely
 * missing and on transient API errors; either way the safe move for a
 * resumable script is to treat "couldn't confirm it exists" as "doesn't
 * exist yet" and let the subsequent create call surface any real problem.
 */
function releaseExists(tag, exec) {
  try {
    runGh(["release", "view", tag], exec);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates and pushes `tag` only if it isn't already on the remote, so a
 * re-run after a partial failure (e.g. Release creation failed) never
 * re-tags or re-pushes — `git push` on an existing tag would fail anyway,
 * but checking first keeps the step a true no-op and the log unambiguous.
 */
function ensureTag(tag, exec, log) {
  if (tagExists(tag, exec)) {
    log(`TAG_EXISTS: ${tag} (skipping tag creation)`);
    return;
  }
  exec("git", ["tag", tag], { stdio: "inherit" });
  exec("git", ["push", "origin", tag], { stdio: "inherit" });
  log(`TAG_CREATED: ${tag}`);
}

/**
 * Creates the GitHub Release for `tag` only if it doesn't already exist, so
 * re-running after e.g. a milestone-close failure doesn't attempt (and fail
 * on) a duplicate `gh release create`.
 */
function ensureRelease(tag, body, root, exec, log) {
  if (releaseExists(tag, exec)) {
    log(`RELEASE_EXISTS: ${tag} (skipping release creation)`);
    return;
  }
  const notesPath = path.join(root, `.release-notes-${tag.replace(/^v/, "")}.md`);
  fs.writeFileSync(notesPath, `${body}\n`);
  try {
    runGh(["release", "create", tag, "--title", tag, "--notes-file", notesPath], exec);
  } finally {
    fs.rmSync(notesPath, { force: true });
  }
  log(`RELEASE_CREATED: ${tag}`);
}

/** Whether an open milestone with zero remaining open issues should be closed. */
function shouldCloseMilestone(milestone) {
  return milestone != null && milestone.state === "open" && milestone.open_issues === 0;
}

function closeMilestoneIfComplete(tag, exec, log) {
  const milestone = findOpenMilestone(tag, exec);
  if (!milestone) {
    log(`MILESTONE_NOT_FOUND: no open milestone titled "${tag}"`);
    return;
  }
  if (!shouldCloseMilestone(milestone)) {
    log(`::warning::MILESTONE_OPEN: "${tag}" still has ${milestone.open_issues} open issue(s); not closing`);
    return;
  }
  runGh(["api", "--method", "PATCH", `repos/:owner/:repo/milestones/${milestone.number}`, "-f", "state=closed"], exec);
  log(`MILESTONE_CLOSED: ${tag}`);
}

function main() {
  const root = path.resolve(process.argv[2] || process.cwd());
  const changelogText = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

  if (!isUnreleasedEmpty(changelogText)) {
    console.log("SKIP: [Unreleased] has entries; this push did not finalize a release");
    return;
  }
  const section = latestReleaseSection(changelogText);
  if (!section) {
    console.log("SKIP: no released version section found in CHANGELOG.md");
    return;
  }
  const tag = `v${section.version}`;

  // Each stage independently checks its own current state before acting, so
  // re-running after a partial failure (tag pushed but Release creation
  // failed, or Release created but milestone close failed) resumes from
  // wherever it stopped instead of bailing out on the tag-exists check.
  ensureTag(tag, execFileSync, console.log);
  ensureRelease(tag, section.body, root, execFileSync, console.log);
  closeMilestoneIfComplete(tag, execFileSync, console.log);
}

module.exports = {
  isUnreleasedEmpty,
  latestReleaseSection,
  tagExists,
  releaseExists,
  findOpenMilestone,
  shouldCloseMilestone,
  ensureTag,
  ensureRelease,
  closeMilestoneIfComplete,
};

if (require.main === module) {
  main();
}
