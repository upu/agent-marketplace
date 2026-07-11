"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isUnreleasedEmpty,
  latestReleaseSection,
  tagExists,
  findOpenMilestone,
  shouldCloseMilestone,
} = require("./release-tag.js");

test("isUnreleasedEmpty is true when [Unreleased] has no entries", () => {
  assert.equal(isUnreleasedEmpty("## [Unreleased]\n\n## [0.1.0] - 2026-07-11\n"), true);
});

test("isUnreleasedEmpty is false when [Unreleased] has entries", () => {
  assert.equal(
    isUnreleasedEmpty("## [Unreleased]\n\n### Added\n\n- something\n\n## [0.1.0] - 2026-07-11\n"),
    false
  );
});

test("isUnreleasedEmpty is true when there is no [Unreleased] heading at all", () => {
  assert.equal(isUnreleasedEmpty("## [0.1.0] - 2026-07-11\n\nstuff\n"), true);
});

test("latestReleaseSection extracts the version and body of the newest release", () => {
  const changelog = [
    "## [Unreleased]",
    "",
    "## [0.2.0] - 2026-08-01",
    "",
    "### Added",
    "",
    "- something new",
    "",
    "## [0.1.0] - 2026-07-11",
    "",
    "### Added",
    "",
    "- first thing",
    "",
    "[Unreleased]: https://example.com/compare/v0.2.0...HEAD",
    "[0.2.0]: https://example.com/releases/tag/v0.2.0",
    "[0.1.0]: https://example.com/releases/tag/v0.1.0",
    "",
  ].join("\n");
  const section = latestReleaseSection(changelog);
  assert.equal(section.version, "0.2.0");
  assert.equal(section.body, "### Added\n\n- something new");
});

test("latestReleaseSection strips trailing link-reference lines even with no other release below it", () => {
  const changelog = [
    "## [Unreleased]",
    "",
    "## [0.1.0] - 2026-07-11",
    "",
    "### Added",
    "",
    "- first thing",
    "",
    "[Unreleased]: https://example.com/compare/v0.1.0...HEAD",
    "[0.1.0]: https://example.com/releases/tag/v0.1.0",
  ].join("\n");
  const section = latestReleaseSection(changelog);
  assert.equal(section.version, "0.1.0");
  assert.equal(section.body, "### Added\n\n- first thing");
});

test("latestReleaseSection returns null when there is no released version yet", () => {
  assert.equal(latestReleaseSection("## [Unreleased]\n"), null);
});

test("tagExists is true only when git tag -l echoes back the exact tag", () => {
  const exec = (cmd, args) => {
    assert.equal(cmd, "git");
    assert.deepEqual(args, ["tag", "-l", "v0.1.0"]);
    return "v0.1.0\n";
  };
  assert.equal(tagExists("v0.1.0", exec), true);
});

test("tagExists is false when git tag -l prints nothing", () => {
  const exec = () => "\n";
  assert.equal(tagExists("v0.1.0", exec), false);
});

test("findOpenMilestone flattens paginated gh api output and matches by title", () => {
  const exec = (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.deepEqual(args, ["api", "repos/:owner/:repo/milestones?state=open", "--paginate", "--slurp"]);
    return JSON.stringify([
      [{ number: 1, title: "v0.1.0", state: "open", open_issues: 0 }],
      [{ number: 2, title: "v0.2.0", state: "open", open_issues: 3 }],
    ]);
  };
  assert.deepEqual(findOpenMilestone("v0.2.0", exec), { number: 2, title: "v0.2.0", state: "open", open_issues: 3 });
});

test("findOpenMilestone returns null when no open milestone matches the title", () => {
  const exec = () => JSON.stringify([[{ number: 1, title: "v0.1.0", state: "open", open_issues: 0 }]]);
  assert.equal(findOpenMilestone("v9.9.9", exec), null);
});

test("shouldCloseMilestone is true only for an open milestone with zero open issues", () => {
  assert.equal(shouldCloseMilestone({ state: "open", open_issues: 0 }), true);
});

test("shouldCloseMilestone is false when open issues remain", () => {
  assert.equal(shouldCloseMilestone({ state: "open", open_issues: 2 }), false);
});

test("shouldCloseMilestone is false when there is no milestone", () => {
  assert.equal(shouldCloseMilestone(null), false);
});
