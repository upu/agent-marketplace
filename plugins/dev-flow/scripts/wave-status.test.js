"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  fetchIssuesByMilestone,
  fetchIssueByNumber,
  fetchPrMerged,
  resolveLinkedPr,
  buildIssueStatus,
  computeWaveStatus,
} = require("./wave-status.js");

test("parseArgs reads a milestone flag", () => {
  assert.deepEqual(parseArgs(["--milestone=v0.4.0"]), { milestone: "v0.4.0", issueNumbers: null });
});

test("parseArgs reads a list of issue numbers", () => {
  assert.deepEqual(parseArgs(["56", "57", "58"]), { milestone: null, issueNumbers: [56, 57, 58] });
});

test("parseArgs rejects no arguments", () => {
  assert.throws(() => parseArgs([]), /Usage:/);
});

test("parseArgs rejects mixing --milestone with issue numbers", () => {
  assert.throws(() => parseArgs(["--milestone=v0.4.0", "56"]), /cannot combine/);
});

test("parseArgs rejects an empty --milestone value", () => {
  assert.throws(() => parseArgs(["--milestone="]), /--milestone requires a value/);
});

test("parseArgs rejects a non-numeric issue number", () => {
  assert.throws(() => parseArgs(["56", "abc"]), /must be a number/);
});

test("parseArgs rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("fetchIssuesByMilestone parses gh issue list's JSON array", () => {
  const ghOutput = JSON.stringify([
    { number: 61, state: "OPEN", closedByPullRequestsReferences: [] },
    { number: 60, state: "CLOSED", closedByPullRequestsReferences: [{ number: 66 }] },
  ]);
  const exec = () => ghOutput;
  assert.deepEqual(fetchIssuesByMilestone("v0.4.0", exec), [
    { number: 61, state: "OPEN", closedByPullRequestsReferences: [] },
    { number: 60, state: "CLOSED", closedByPullRequestsReferences: [{ number: 66 }] },
  ]);
});

test("fetchIssuesByMilestone surfaces gh's stderr on failure", () => {
  const exec = () => {
    const err = new Error("Command failed");
    err.stderr = "gh: authentication required\n";
    throw err;
  };
  assert.throws(() => fetchIssuesByMilestone("v0.4.0", exec), /authentication required/);
});

test("fetchIssueByNumber parses gh issue view's single JSON object", () => {
  const ghOutput = JSON.stringify({
    number: 56,
    state: "CLOSED",
    closedByPullRequestsReferences: [{ number: 62 }],
  });
  const exec = () => ghOutput;
  assert.deepEqual(fetchIssueByNumber(56, exec), {
    number: 56,
    state: "CLOSED",
    closedByPullRequestsReferences: [{ number: 62 }],
  });
});

test("fetchPrMerged returns true when the PR's state is MERGED", () => {
  const exec = () => JSON.stringify({ state: "MERGED" });
  assert.equal(fetchPrMerged(62, exec), true);
});

test("fetchPrMerged returns false for an open or closed-unmerged PR", () => {
  const execOpen = () => JSON.stringify({ state: "OPEN" });
  const execClosed = () => JSON.stringify({ state: "CLOSED" });
  assert.equal(fetchPrMerged(1, execOpen), false);
  assert.equal(fetchPrMerged(2, execClosed), false);
});

test("resolveLinkedPr returns null/false when there are no linked PRs", () => {
  assert.deepEqual(resolveLinkedPr([], () => true), { linkedPr: null, prMerged: false });
});

test("resolveLinkedPr reports the single linked PR's merged status", () => {
  assert.deepEqual(resolveLinkedPr([{ number: 62 }], () => true), { linkedPr: 62, prMerged: true });
  assert.deepEqual(resolveLinkedPr([{ number: 62 }], () => false), { linkedPr: 62, prMerged: false });
});

test("resolveLinkedPr prefers a merged PR when multiple are linked", () => {
  const isMerged = (n) => n === 63;
  assert.deepEqual(resolveLinkedPr([{ number: 62 }, { number: 63 }], isMerged), {
    linkedPr: 63,
    prMerged: true,
  });
});

test("resolveLinkedPr falls back to the first linked PR when none are merged", () => {
  assert.deepEqual(resolveLinkedPr([{ number: 62 }, { number: 63 }], () => false), {
    linkedPr: 62,
    prMerged: false,
  });
});

test("buildIssueStatus combines issue state with the resolved linked PR", () => {
  const issue = { number: 56, state: "CLOSED", closedByPullRequestsReferences: [{ number: 62 }] };
  assert.deepEqual(buildIssueStatus(issue, () => true), {
    number: 56,
    state: "CLOSED",
    linkedPr: 62,
    prMerged: true,
  });
});

test("buildIssueStatus handles an issue with no linked PR", () => {
  const issue = { number: 61, state: "OPEN", closedByPullRequestsReferences: [] };
  assert.deepEqual(buildIssueStatus(issue, () => false), {
    number: 61,
    state: "OPEN",
    linkedPr: null,
    prMerged: false,
  });
});

test("computeWaveStatus maps a list of issues in order", () => {
  const issues = [
    { number: 61, state: "OPEN", closedByPullRequestsReferences: [] },
    { number: 56, state: "CLOSED", closedByPullRequestsReferences: [{ number: 62 }] },
  ];
  const fetchPrMergedFn = (n) => n === 62;
  assert.deepEqual(computeWaveStatus(issues, fetchPrMergedFn), [
    { number: 61, state: "OPEN", linkedPr: null, prMerged: false },
    { number: 56, state: "CLOSED", linkedPr: 62, prMerged: true },
  ]);
});
