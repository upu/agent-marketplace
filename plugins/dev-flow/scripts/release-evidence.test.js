"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  resolveTagInfo,
  dateRangeQualifier,
  exclusiveLowerBoundISO,
  extractChangelogSection,
  readChangelogSection,
  fetchCommitLog,
  fetchMilestoneIssues,
  fetchMergedPRs,
  fetchCiHistory,
  collectReleaseEvidence,
} = require("./release-evidence.js");

test("parseArgs strips a leading v and accepts a bare version", () => {
  assert.deepEqual(parseArgs(["v0.4.0"]), { version: "0.4.0" });
  assert.deepEqual(parseArgs(["0.4.0"]), { version: "0.4.0" });
});

test("parseArgs rejects missing/extra positional args", () => {
  assert.throws(() => parseArgs([]), /Usage: release-evidence\.js <version>/);
  assert.throws(() => parseArgs(["0.4.0", "extra"]), /Usage: release-evidence\.js <version>/);
});

test("parseArgs rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("resolveTagInfo finds the tag immediately before the target in creatordate order", () => {
  const exec = () => "v0.3.0\nv0.2.0\nv0.1.0\n";
  assert.deepEqual(resolveTagInfo("0.2.0", exec), { tag: "v0.2.0", previousTag: "v0.1.0" });
});

test("resolveTagInfo returns previousTag null for the oldest tag (first release)", () => {
  const exec = () => "v0.3.0\nv0.2.0\nv0.1.0\n";
  assert.deepEqual(resolveTagInfo("0.1.0", exec), { tag: "v0.1.0", previousTag: null });
});

test("resolveTagInfo throws when the target tag does not exist locally", () => {
  const exec = () => "v0.3.0\nv0.2.0\n";
  assert.throws(() => resolveTagInfo("9.9.9", exec), /tag v9\.9\.9 not found locally/);
});

test("resolveTagInfo surfaces git's stderr on failure", () => {
  const exec = () => {
    const err = new Error("Command failed");
    err.stderr = "fatal: not a git repository\n";
    throw err;
  };
  assert.throws(() => resolveTagInfo("0.1.0", exec), /not a git repository/);
});

test("dateRangeQualifier builds a from..to range when a previous tag exists", () => {
  assert.equal(dateRangeQualifier("2026-01-01T00:00:00+09:00", "2026-02-01T00:00:00+09:00"),
    "2026-01-01T00:00:00+09:00..2026-02-01T00:00:00+09:00");
});

test("dateRangeQualifier builds an open-ended <=to qualifier for a first release", () => {
  assert.equal(dateRangeQualifier(null, "2026-02-01T00:00:00+09:00"), "<=2026-02-01T00:00:00+09:00");
});

test("exclusiveLowerBoundISO advances a tag's commit date by one second, preserving its offset", () => {
  assert.equal(exclusiveLowerBoundISO("2026-02-01T00:00:00+09:00"), "2026-02-01T00:00:01+09:00");
  assert.equal(exclusiveLowerBoundISO("2026-01-01T12:30:45-05:00"), "2026-01-01T12:30:46-05:00");
});

test("exclusiveLowerBoundISO rolls over minute/hour/day/month/year boundaries", () => {
  assert.equal(exclusiveLowerBoundISO("2026-01-01T23:59:59+00:00"), "2026-01-02T00:00:00+00:00");
  assert.equal(exclusiveLowerBoundISO("2025-12-31T23:59:59Z"), "2026-01-01T00:00:00Z");
});

test("exclusiveLowerBoundISO strips sub-second precision before advancing", () => {
  assert.equal(exclusiveLowerBoundISO("2026-02-01T00:00:00.500+09:00"), "2026-02-01T00:00:01+09:00");
});

test("exclusiveLowerBoundISO throws on an unrecognized date format", () => {
  assert.throws(() => exclusiveLowerBoundISO("not-a-date"), /unrecognized ISO 8601 date/);
});

test("extractChangelogSection extracts the matching version's section up to the next heading", () => {
  const content = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- wip",
    "",
    "## [0.3.0] - 2026-07-11",
    "",
    "### Changed",
    "",
    "- did a thing",
    "",
    "## [0.2.0] - 2026-07-10",
    "",
    "- older",
    "",
  ].join("\n");
  const section = extractChangelogSection(content, "0.3.0");
  assert.match(section, /^## \[0\.3\.0\] - 2026-07-11/);
  assert.match(section, /- did a thing/);
  assert.doesNotMatch(section, /older/);
});

test("extractChangelogSection returns null when the version heading is absent", () => {
  const content = "# Changelog\n\n## [0.2.0] - 2026-07-10\n\n- older\n";
  assert.equal(extractChangelogSection(content, "9.9.9"), null);
});

test("extractChangelogSection escapes regex-special characters in the version", () => {
  // A naive `new RegExp("## \\[" + version + "\\]")` without escaping would
  // treat "1.2.3"'s dots as "any character", silently matching "1x2x3" too.
  const content = "## [1.2.3]\n\nbody\n";
  assert.equal(extractChangelogSection(content, "1x2x3"), null);
  assert.match(extractChangelogSection(content, "1.2.3"), /body/);
});

test("readChangelogSection returns null when CHANGELOG.md does not exist (ENOENT)", () => {
  const readFileSync = () => {
    const err = new Error("no such file");
    err.code = "ENOENT";
    throw err;
  };
  assert.equal(readChangelogSection("0.3.0", { cwd: "/repo", readFileSync }), null);
});

test("readChangelogSection reads CHANGELOG.md from cwd and extracts the section", () => {
  const content = "## [0.3.0] - 2026-07-11\n\n- did a thing\n";
  const readFileSync = (filePath) => {
    assert.match(filePath, /CHANGELOG\.md$/);
    return content;
  };
  assert.match(readChangelogSection("0.3.0", { cwd: "/repo", readFileSync }), /did a thing/);
});

test("readChangelogSection rethrows non-ENOENT errors", () => {
  const readFileSync = () => {
    throw new Error("permission denied");
  };
  assert.throws(() => readChangelogSection("0.3.0", { cwd: "/repo", readFileSync }), /permission denied/);
});

test("fetchCommitLog parses git log's unit-separated sha/subject pairs", () => {
  const exec = () => "abc123\x1fFirst commit\ndef456\x1fSecond: has a colon\n";
  assert.deepEqual(fetchCommitLog("v0.1.0..v0.2.0", () => exec()), [
    { sha: "abc123", subject: "First commit" },
    { sha: "def456", subject: "Second: has a colon" },
  ]);
});

test("fetchCommitLog returns an empty array for an empty range", () => {
  assert.deepEqual(fetchCommitLog("v0.1.0..v0.1.0", () => ""), []);
});

test("fetchMilestoneIssues maps gh's JSON into the trimmed shape", () => {
  const ghOutput = JSON.stringify([
    { number: 52, title: "Something", labels: [{ name: "enhancement" }], state: "CLOSED" },
    { number: 53, title: "Something else", labels: [], state: "OPEN" },
  ]);
  const issues = fetchMilestoneIssues("0.3.0", () => ghOutput);
  assert.deepEqual(issues, [
    { number: 52, title: "Something", labels: ["enhancement"], state: "CLOSED" },
    { number: 53, title: "Something else", labels: [], state: "OPEN" },
  ]);
});

test("fetchMilestoneIssues returns an empty array for a milestone with no issues", () => {
  assert.deepEqual(fetchMilestoneIssues("9.9.9", () => "[]"), []);
});

test("fetchMergedPRs surfaces gh's JSON as-is", () => {
  const ghOutput = JSON.stringify([
    { number: 54, title: "A PR", mergedAt: "2026-07-11T13:22:26Z", url: "https://example/54" },
  ]);
  assert.deepEqual(fetchMergedPRs("2026-01-01..2026-02-01", () => ghOutput), [
    { number: 54, title: "A PR", mergedAt: "2026-07-11T13:22:26Z", url: "https://example/54" },
  ]);
});

test("fetchCiHistory keeps failures and re-runs, drops clean single-attempt runs", () => {
  const ghOutput = JSON.stringify([
    { databaseId: 1, name: "test", conclusion: "success", attempt: 1, event: "pull_request" },
    { databaseId: 2, name: "test", conclusion: "failure", attempt: 1, event: "push" },
    { databaseId: 3, name: "test", conclusion: "success", attempt: 2, event: "pull_request" },
    { databaseId: 4, name: "release", conclusion: "cancelled", attempt: 1, event: "push" },
  ]);
  const history = fetchCiHistory("2026-01-01..2026-02-01", () => ghOutput);
  assert.deepEqual(
    history.map((r) => r.databaseId),
    [2, 3, 4]
  );
});

test("fetchCiHistory returns an empty array when every run in range was a clean single attempt", () => {
  const ghOutput = JSON.stringify([{ databaseId: 1, conclusion: "success", attempt: 1 }]);
  assert.deepEqual(fetchCiHistory("2026-01-01..2026-02-01", () => ghOutput), []);
});

test("collectReleaseEvidence orchestrates all five sources into one object", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "git" && args[0] === "tag") {
      return "v0.2.0\nv0.1.0\n";
    }
    if (cmd === "git" && args[0] === "log" && args[1] === "-1") {
      // tag date lookup: args = ["log", "-1", "--format=%aI", <tag>]
      return args[3] === "v0.2.0" ? "2026-02-01T00:00:00+09:00\n" : "2026-01-01T00:00:00+09:00\n";
    }
    if (cmd === "git" && args[0] === "log") {
      return "abc123\x1fA commit\n";
    }
    if (cmd === "gh" && args[0] === "issue") {
      return JSON.stringify([{ number: 1, title: "An issue", labels: [], state: "CLOSED" }]);
    }
    if (cmd === "gh" && args[0] === "pr") {
      return JSON.stringify([{ number: 2, title: "A PR", mergedAt: "2026-01-15T00:00:00Z", url: "u" }]);
    }
    if (cmd === "gh" && args[0] === "run") {
      return JSON.stringify([{ databaseId: 9, conclusion: "failure", attempt: 1 }]);
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const readFileSync = () => "## [0.2.0] - 2026-02-01\n\n- shipped\n";

  const evidence = collectReleaseEvidence("0.2.0", { exec, readFileSync, cwd: "/repo" });

  assert.equal(evidence.version, "0.2.0");
  assert.equal(evidence.tag, "v0.2.0");
  assert.equal(evidence.previousTag, "v0.1.0");
  assert.match(evidence.changelog, /shipped/);
  assert.deepEqual(evidence.milestoneIssues, [{ number: 1, title: "An issue", labels: [], state: "CLOSED" }]);
  assert.deepEqual(evidence.commits, [{ sha: "abc123", subject: "A commit" }]);
  assert.deepEqual(evidence.mergedPRs, [{ number: 2, title: "A PR", mergedAt: "2026-01-15T00:00:00Z", url: "u" }]);
  assert.deepEqual(evidence.ciHistory, [{ databaseId: 9, conclusion: "failure", attempt: 1 }]);
});

test("collectReleaseEvidence returns changelog: null for a repo without CHANGELOG.md", () => {
  const exec = (cmd, args) => {
    if (cmd === "git" && args[0] === "tag") {
      return "v0.1.0\n";
    }
    if (cmd === "git" && args[0] === "log" && args[1] === "-1") {
      return "2026-01-01T00:00:00+09:00\n";
    }
    if (cmd === "git" && args[0] === "log") {
      return "";
    }
    if (cmd === "gh" && args[0] === "issue") {
      return "[]";
    }
    if (cmd === "gh" && args[0] === "pr") {
      return "[]";
    }
    if (cmd === "gh" && args[0] === "run") {
      return "[]";
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const readFileSync = () => {
    const err = new Error("no such file");
    err.code = "ENOENT";
    throw err;
  };

  const evidence = collectReleaseEvidence("0.1.0", { exec, readFileSync, cwd: "/repo" });
  assert.equal(evidence.changelog, null);
  assert.equal(evidence.previousTag, null);
});

test("collectReleaseEvidence excludes the previous tag's own commit date from the mergedPRs/ciHistory range (agent-marketplace#84)", () => {
  // The previous tag's commit landed at exactly 2026-01-01T00:00:00+09:00 —
  // e.g. the previous release's own `release: vX.Y.Z` PR merged at that
  // instant. Before the fix, that raw date was used as the inclusive lower
  // bound, so a PR/CI run at that exact instant would be re-included even
  // though `commits` (via `git log <prev>..<tag>`) already excludes it.
  const prevTagDate = "2026-01-01T00:00:00+09:00";
  let searchQualifier;
  let createdQualifier;
  const exec = (cmd, args) => {
    if (cmd === "git" && args[0] === "tag") {
      return "v0.2.0\nv0.1.0\n";
    }
    if (cmd === "git" && args[0] === "log" && args[1] === "-1") {
      return args[3] === "v0.2.0" ? "2026-02-01T00:00:00+09:00\n" : `${prevTagDate}\n`;
    }
    if (cmd === "git" && args[0] === "log") {
      return "";
    }
    if (cmd === "gh" && args[0] === "issue") {
      return "[]";
    }
    if (cmd === "gh" && args[0] === "pr") {
      const searchArg = args[args.indexOf("--search") + 1];
      searchQualifier = searchArg.replace(/^merged:/, "");
      // Simulates GitHub's inclusive-both-ends range semantics: a PR that
      // merged at exactly the previous tag's commit date is "in range" iff
      // the qualifier's lower bound is <= that instant.
      const [from] = searchQualifier.split("..");
      const included = from <= prevTagDate;
      return included
        ? JSON.stringify([{ number: 69, title: "release: v0.1.0", mergedAt: prevTagDate, url: "u" }])
        : "[]";
    }
    if (cmd === "gh" && args[0] === "run") {
      createdQualifier = args[args.indexOf("--created") + 1];
      return "[]";
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const readFileSync = () => {
    const err = new Error("no such file");
    err.code = "ENOENT";
    throw err;
  };

  const evidence = collectReleaseEvidence("0.2.0", { exec, readFileSync, cwd: "/repo" });

  assert.equal(searchQualifier, "2026-01-01T00:00:01+09:00..2026-02-01T00:00:00+09:00");
  assert.equal(createdQualifier, "2026-01-01T00:00:01+09:00..2026-02-01T00:00:00+09:00");
  assert.deepEqual(evidence.mergedPRs, []);
});
