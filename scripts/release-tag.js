// Creates the `vX.Y.Z` tag and GitHub Release for *this* repository's own
// releases (agent-marketplace#35). This repo has no package.json/vsce
// packaging step (it distributes Claude Code skills, not an npm/VSCode
// artifact), so the only post-merge automation it needs is a tag + a
// GitHub Release built from CHANGELOG.md's freshly finalized section.
//
// Runs on every push to `main`. Is a no-op unless CHANGELOG.md's
// [Unreleased] section is currently empty (i.e. this push finalized a
// release) AND no tag for that version exists yet — so ordinary feature
// merges (which leave [Unreleased] non-empty) do nothing, and re-running
// after a release already tagged does nothing either.
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

/** Whether the local git repo already has a tag named `tag`. */
function tagExists(tag, exec) {
  const out = exec("git", ["tag", "-l", tag], { encoding: "utf8" }).trim();
  return out === tag;
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
  if (tagExists(tag, execFileSync)) {
    console.log(`SKIP: tag ${tag} already exists`);
    return;
  }

  execFileSync("git", ["tag", tag], { stdio: "inherit" });
  execFileSync("git", ["push", "origin", tag], { stdio: "inherit" });

  const notesPath = path.join(root, `.release-notes-${section.version}.md`);
  fs.writeFileSync(notesPath, `${section.body}\n`);
  try {
    runGh(["release", "create", tag, "--title", tag, "--notes-file", notesPath], execFileSync);
  } finally {
    fs.rmSync(notesPath, { force: true });
  }
  console.log(`RELEASED: ${tag}`);

  closeMilestoneIfComplete(tag, execFileSync, console.log);
}

module.exports = {
  isUnreleasedEmpty,
  latestReleaseSection,
  tagExists,
  findOpenMilestone,
  shouldCloseMilestone,
};

if (require.main === module) {
  main();
}
