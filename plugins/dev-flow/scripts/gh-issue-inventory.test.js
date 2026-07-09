"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  truncateBody,
  fetchOpenIssues,
  fetchMilestones,
} = require("./gh-issue-inventory.js");

test("parseArgs defaults", () => {
  assert.deepEqual(parseArgs([]), { milestonesState: "open", maxBodyChars: 1000 });
});

test("parseArgs reads --milestones-state and --max-body-chars", () => {
  assert.deepEqual(parseArgs(["--milestones-state=all", "--max-body-chars=200"]), {
    milestonesState: "all",
    maxBodyChars: 200,
  });
});

test("parseArgs rejects an invalid milestones-state", () => {
  assert.throws(() => parseArgs(["--milestones-state=bogus"]), /must be one of/);
});

test("parseArgs rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("truncateBody leaves short bodies untouched", () => {
  assert.deepEqual(truncateBody("short body", 1000), { body: "short body", truncated: false });
});

test("truncateBody truncates long bodies and reports it", () => {
  const long = "x".repeat(50);
  assert.deepEqual(truncateBody(long, 10), { body: "x".repeat(10), truncated: true });
});

test("truncateBody treats a missing body as empty", () => {
  assert.deepEqual(truncateBody(undefined, 10), { body: "", truncated: false });
});

test("fetchOpenIssues maps gh's JSON into the trimmed shape, truncating long bodies", () => {
  const ghOutput = JSON.stringify([
    {
      number: 12,
      title: "Something broke",
      labels: [{ name: "bug" }, { name: "priority:high" }],
      milestone: { number: 3, title: "v1.2.0", description: "ignored" },
      body: "x".repeat(50),
    },
    {
      number: 13,
      title: "No milestone yet",
      labels: [],
      milestone: null,
      body: "short",
    },
  ]);
  const exec = () => ghOutput;
  const issues = fetchOpenIssues(10, exec);
  assert.deepEqual(issues, [
    {
      number: 12,
      title: "Something broke",
      labels: ["bug", "priority:high"],
      milestone: { number: 3, title: "v1.2.0" },
      body: "x".repeat(10),
      bodyTruncated: true,
    },
    {
      number: 13,
      title: "No milestone yet",
      labels: [],
      milestone: null,
      body: "short",
      bodyTruncated: false,
    },
  ]);
});

test("fetchOpenIssues surfaces gh's stderr on failure", () => {
  const exec = () => {
    const err = new Error("Command failed");
    err.stderr = "gh: authentication required\n";
    throw err;
  };
  assert.throws(() => fetchOpenIssues(1000, exec), /authentication required/);
});

test("fetchMilestones flattens gh api --paginate --slurp's array-of-pages shape", () => {
  // Verified empirically against gh 2.86.0: --paginate --slurp wraps each
  // page (itself a JSON array) inside an outer array, it does not flatten
  // pages into one array on its own.
  const pages = [
    [{ number: 1, title: "v0.1.0", state: "closed", description: "ignored" }],
    [{ number: 2, title: "v0.2.0", state: "open", description: "ignored" }],
  ];
  const exec = () => JSON.stringify(pages);
  const milestones = fetchMilestones("all", exec);
  assert.deepEqual(milestones, [
    { number: 1, title: "v0.1.0", state: "closed" },
    { number: 2, title: "v0.2.0", state: "open" },
  ]);
});

test("fetchMilestones handles a single empty page", () => {
  const exec = () => JSON.stringify([[]]);
  assert.deepEqual(fetchMilestones("open", exec), []);
});

test("fetchMilestones surfaces gh's stderr on failure", () => {
  const exec = () => {
    const err = new Error("Command failed");
    err.stderr = "gh: not a git repository\n";
    throw err;
  };
  assert.throws(() => fetchMilestones("open", exec), /not a git repository/);
});
