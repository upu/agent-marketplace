"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  findMatchingReview,
  filterCopilotInlineComments,
  buildFeedback,
  fetchCopilotFeedback,
} = require("./fetch-copilot-feedback.js");

test("parseArgs defaults with only a PR number", () => {
  assert.deepEqual(parseArgs(["42"]), { pr: "42", sha: null });
});

test("parseArgs accepts an optional sha", () => {
  assert.deepEqual(parseArgs(["42", "abc1234"]), { pr: "42", sha: "abc1234" });
});

test("parseArgs rejects a non-numeric pr", () => {
  assert.throws(() => parseArgs(["abc"]), /<pr> must be a number/);
  assert.throws(() => parseArgs(["-5"]), /<pr> must be a number/);
});

test("parseArgs rejects a sha that doesn't look like a git commit oid", () => {
  assert.throws(() => parseArgs(["42", "not-a-sha!"]), /\[sha\] must look like a git commit sha/);
  assert.throws(() => parseArgs(["42", "abc12"]), /\[sha\] must look like a git commit sha/);
});

test("parseArgs requires 1 or 2 positional arguments", () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(["1", "2", "3"]), /Usage:/);
});

test("findMatchingReview matches on author.login and commit.oid, ignoring inline-comment-style user.login", () => {
  const reviews = [
    { author: { login: "someone-else" }, commit: { oid: "sha1" }, state: "COMMENTED", body: "not copilot" },
    { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha0" }, state: "APPROVED", body: "old sha" },
    {
      author: { login: "copilot-pull-request-reviewer" },
      commit: { oid: "sha1" },
      state: "CHANGES_REQUESTED",
      body: "please fix X",
    },
  ];
  assert.deepEqual(findMatchingReview(reviews, "sha1"), reviews[2]);
  assert.equal(findMatchingReview(reviews, "sha-missing"), null);
});

test("findMatchingReview returns the last matching review when several exist for the same sha", () => {
  const reviews = [
    { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "COMMENTED", body: "first" },
    { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "APPROVED", body: "second" },
  ];
  assert.equal(findMatchingReview(reviews, "sha1").body, "second");
});

test("filterCopilotInlineComments keeps only user.login === Copilot and maps to {path, line, body}", () => {
  const comments = [
    { path: "a.js", line: 10, body: "nit", user: { login: "Copilot" }, extra: "dropped" },
    { path: "b.js", line: 20, body: "human comment", user: { login: "some-human" } },
    { path: "c.js", line: 30, body: "another nit", user: { login: "Copilot" } },
  ];
  assert.deepEqual(filterCopilotInlineComments(comments), [
    { path: "a.js", line: 10, body: "nit" },
    { path: "c.js", line: 30, body: "another nit" },
  ]);
});

test("filterCopilotInlineComments returns an empty array when there are no Copilot comments", () => {
  assert.deepEqual(filterCopilotInlineComments([{ path: "a.js", line: 1, body: "x", user: { login: "some-human" } }]), []);
  assert.deepEqual(filterCopilotInlineComments([]), []);
});

test("buildFeedback combines the matched review's body/state with filtered inline comments", () => {
  const review = { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "COMMENTED", body: "summary text" };
  const comments = [
    { path: "a.js", line: 10, body: "nit", user: { login: "Copilot" } },
    { path: "b.js", line: 20, body: "human comment", user: { login: "some-human" } },
  ];
  assert.deepEqual(buildFeedback(review, comments), {
    summary: "summary text",
    state: "COMMENTED",
    inlineComments: [{ path: "a.js", line: 10, body: "nit" }],
  });
});

test("fetchCopilotFeedback prints the built feedback as JSON and returns 0 when a matching review exists", () => {
  const logs = [];
  const code = fetchCopilotFeedback("42", "sha1", {
    fetchReviews: () => [
      { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "APPROVED", body: "lgtm" },
    ],
    fetchInlineComments: () => [{ path: "a.js", line: 10, body: "nit", user: { login: "Copilot" } }],
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(logs[0]), {
    summary: "lgtm",
    state: "APPROVED",
    inlineComments: [{ path: "a.js", line: 10, body: "nit" }],
  });
});

test("fetchCopilotFeedback returns 1 and does not fetch inline comments when no review matches the sha", () => {
  const logs = [];
  const code = fetchCopilotFeedback("42", "sha-missing", {
    fetchReviews: () => [
      { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "APPROVED", body: "lgtm" },
    ],
    fetchInlineComments: () => {
      throw new Error("should not be called when no review matches");
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 1);
  assert.deepEqual(logs, ["NOT_FOUND: no Copilot review submitted for sha sha-missing"]);
});
