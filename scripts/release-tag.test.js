"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isUnreleasedEmpty,
  latestReleaseSection,
  tagExists,
  releaseExists,
  findOpenMilestone,
  shouldCloseMilestone,
  ensureTag,
  ensureRelease,
  closeMilestoneIfComplete,
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

test("tagExists is true when git ls-remote lists a matching refs/tags/<tag> line", () => {
  const exec = (cmd, args) => {
    assert.equal(cmd, "git");
    assert.deepEqual(args, ["ls-remote", "--tags", "origin"]);
    return "abc123\trefs/tags/v0.1.0\n";
  };
  assert.equal(tagExists("v0.1.0", exec), true);
});

test("tagExists is false when git ls-remote prints nothing", () => {
  const exec = () => "\n";
  assert.equal(tagExists("v0.1.0", exec), false);
});

test("tagExists does not match a tag whose name only starts with the target (e.g. v0.1.0 vs v0.1.0-rc1)", () => {
  const exec = () => "abc123\trefs/tags/v0.1.0-rc1\n";
  assert.equal(tagExists("v0.1.0", exec), false);
});

test("tagExists finds the matching tag among several remote tags", () => {
  const exec = () =>
    ["abc111\trefs/tags/v0.1.0", "abc222\trefs/tags/v0.2.0", "abc333\trefs/tags/v0.1.0-rc1"].join("\n") + "\n";
  assert.equal(tagExists("v0.2.0", exec), true);
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

test("releaseExists is true when gh release view succeeds", () => {
  const exec = (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.deepEqual(args, ["release", "view", "v0.1.0"]);
    return "";
  };
  assert.equal(releaseExists("v0.1.0", exec), true);
});

test("releaseExists is false when gh release view fails (release not found)", () => {
  const exec = () => {
    const err = new Error("release not found");
    err.stderr = "release not found";
    throw err;
  };
  assert.equal(releaseExists("v0.1.0", exec), false);
});

test("ensureTag: no tag on remote -> creates and pushes the tag", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "git" && args[0] === "ls-remote") {
      return "";
    }
    return "";
  };
  const logs = [];
  ensureTag("v0.1.0", exec, (msg) => logs.push(msg));
  assert.deepEqual(calls.slice(1), [
    ["git", ["tag", "v0.1.0"]],
    ["git", ["push", "origin", "v0.1.0"]],
  ]);
  assert.ok(logs.some((l) => l.startsWith("TAG_CREATED")));
});

test("ensureTag: tag already on remote -> does not create or push, leaves existing tag untouched", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "git" && args[0] === "ls-remote") {
      return "abc123\trefs/tags/v0.1.0\n";
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  ensureTag("v0.1.0", exec, (msg) => logs.push(msg));
  assert.deepEqual(calls, [["git", ["ls-remote", "--tags", "origin"]]]);
  assert.ok(logs.some((l) => l.startsWith("TAG_EXISTS")));
});

test("ensureRelease: no release yet -> creates it via gh release create and cleans up the notes file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-tag-test-"));
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      throw new Error("release not found");
    }
    return "";
  };
  const logs = [];
  try {
    ensureRelease("v0.2.0", "### Added\n\n- something", root, exec, (msg) => logs.push(msg));
    const createCall = calls.find((c) => c[1][0] === "release" && c[1][1] === "create");
    assert.ok(createCall, "expected gh release create to be called");
    assert.deepEqual(createCall[1].slice(0, 3), ["release", "create", "v0.2.0"]);
    assert.ok(fs.readdirSync(root).length === 0, "notes file should be cleaned up");
    assert.ok(logs.some((l) => l.startsWith("RELEASE_CREATED")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureRelease: release already exists -> does not create a duplicate or write a notes file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-tag-test-"));
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      return "";
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  try {
    ensureRelease("v0.2.0", "### Added\n\n- something", root, exec, (msg) => logs.push(msg));
    assert.deepEqual(calls, [["gh", ["release", "view", "v0.2.0"]]]);
    assert.ok(fs.readdirSync(root).length === 0, "no notes file should be written");
    assert.ok(logs.some((l) => l.startsWith("RELEASE_EXISTS")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closeMilestoneIfComplete: release created but milestone still open with remaining issues -> does not close", () => {
  const exec = (cmd, args) => {
    if (args[0] === "api" && args[1] === "repos/:owner/:repo/milestones?state=open") {
      return JSON.stringify([[{ number: 5, title: "v0.2.0", state: "open", open_issues: 1 }]]);
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  closeMilestoneIfComplete("v0.2.0", exec, (msg) => logs.push(msg));
  assert.ok(logs.some((l) => l.includes("MILESTONE_OPEN")));
});

test("closeMilestoneIfComplete: release created, milestone has zero open issues -> closes it via PATCH", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, args]);
    if (args[0] === "api" && args[1] === "repos/:owner/:repo/milestones?state=open") {
      return JSON.stringify([[{ number: 5, title: "v0.2.0", state: "open", open_issues: 0 }]]);
    }
    return "";
  };
  const logs = [];
  closeMilestoneIfComplete("v0.2.0", exec, (msg) => logs.push(msg));
  const patchCall = calls.find((c) => c[1].includes("--method") && c[1].includes("PATCH"));
  assert.ok(patchCall, "expected a PATCH call to close the milestone");
  assert.deepEqual(patchCall[1], ["api", "--method", "PATCH", "repos/:owner/:repo/milestones/5", "-f", "state=closed"]);
  assert.ok(logs.some((l) => l.startsWith("MILESTONE_CLOSED")));
});
