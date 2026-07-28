"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  findMatchingReview,
  findMatchingReviewId,
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

test("findMatchingReviewId maps a commit sha to the REST numeric review id, ignoring non-Copilot reviewers", () => {
  const restReviews = [
    { id: 111, user: { login: "someone-else" }, commit_id: "sha1" },
    { id: 222, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "sha0" },
    { id: 333, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "sha1" },
  ];
  assert.equal(findMatchingReviewId(restReviews, "sha1"), 333);
  assert.equal(findMatchingReviewId(restReviews, "sha-missing"), null);
});

test("findMatchingReviewId returns the last matching id when several exist for the same sha", () => {
  const restReviews = [
    { id: 111, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "sha1" },
    { id: 222, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "sha1" },
  ];
  assert.equal(findMatchingReviewId(restReviews, "sha1"), 222);
});

test("filterCopilotInlineComments keeps only Copilot comments belonging to the target review id", () => {
  const comments = [
    { path: "a.js", line: 10, body: "nit", user: { login: "Copilot" }, pull_request_review_id: 222, extra: "dropped" },
    { path: "b.js", line: 20, body: "human comment", user: { login: "some-human" }, pull_request_review_id: 222 },
    { path: "c.js", line: 30, body: "another nit", user: { login: "Copilot" }, pull_request_review_id: 222 },
    { path: "d.js", line: 40, body: "stale nit from an earlier review", user: { login: "Copilot" }, pull_request_review_id: 111 },
  ];
  assert.deepEqual(filterCopilotInlineComments(comments, 222), [
    { path: "a.js", line: 10, body: "nit" },
    { path: "c.js", line: 30, body: "another nit" },
  ]);
});

test("filterCopilotInlineComments returns an empty array when there are no Copilot comments for the target review id", () => {
  assert.deepEqual(
    filterCopilotInlineComments([{ path: "a.js", line: 1, body: "x", user: { login: "some-human" }, pull_request_review_id: 1 }], 1),
    []
  );
  assert.deepEqual(filterCopilotInlineComments([], 1), []);
});

test("filterCopilotInlineComments drops all comments when the latest review introduced no new ones, even if earlier reviews left comments behind", () => {
  // Regression for agent-marketplace#96 / real-world PR #5: the latest review
  // body says "no new comments" (reviewId 333) but the PR still carries 4
  // Copilot inline comments left over from reviews 111/222 on older commits.
  const comments = [
    { path: "a.js", line: 10, body: "old 1", user: { login: "Copilot" }, pull_request_review_id: 111 },
    { path: "b.js", line: 20, body: "old 2", user: { login: "Copilot" }, pull_request_review_id: 222 },
    { path: "c.js", line: 30, body: "old 3", user: { login: "Copilot" }, pull_request_review_id: 222 },
    { path: "d.js", line: 40, body: "old 4", user: { login: "Copilot" }, pull_request_review_id: 222 },
  ];
  assert.deepEqual(filterCopilotInlineComments(comments, 333), []);
});

test("buildFeedback combines the matched review's body/state with inline comments filtered by review id", () => {
  const review = { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "COMMENTED", body: "summary text" };
  const comments = [
    { path: "a.js", line: 10, body: "nit", user: { login: "Copilot" }, pull_request_review_id: 333 },
    { path: "b.js", line: 20, body: "human comment", user: { login: "some-human" }, pull_request_review_id: 333 },
    { path: "stale.js", line: 5, body: "stale nit", user: { login: "Copilot" }, pull_request_review_id: 111 },
  ];
  assert.deepEqual(buildFeedback(review, comments, 333), {
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
    fetchReviewsRest: () => [{ id: 333, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "sha1" }],
    fetchInlineComments: () => [{ path: "a.js", line: 10, body: "nit", user: { login: "Copilot" }, pull_request_review_id: 333 }],
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
    fetchReviewsRest: () => {
      throw new Error("should not be called when no review matches");
    },
    fetchInlineComments: () => {
      throw new Error("should not be called when no review matches");
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 1);
  assert.deepEqual(logs, ["NOT_FOUND: no Copilot review submitted for sha sha-missing"]);
});

test("fetchCopilotFeedback returns only the target review's inline comments, dropping stale comments from earlier reviews on the same PR", () => {
  // End-to-end regression mirroring PR #5: three Copilot reviews exist on the
  // PR, the latest (sha3) added no new comments, but 4 stale inline comments
  // from the earlier two reviews (sha1/sha2) are still present on the PR.
  const logs = [];
  const code = fetchCopilotFeedback("5", "sha3", {
    fetchReviews: () => [
      { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "COMMENTED", body: "review 1" },
      { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha2" }, state: "COMMENTED", body: "review 2" },
      { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha3" }, state: "COMMENTED", body: "no new comments" },
    ],
    fetchReviewsRest: () => [
      { id: 111, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "sha1" },
      { id: 222, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "sha2" },
      { id: 333, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "sha3" },
    ],
    fetchInlineComments: () => [
      { path: "a.js", line: 1, body: "stale 1", user: { login: "Copilot" }, pull_request_review_id: 111 },
      { path: "b.js", line: 2, body: "stale 2", user: { login: "Copilot" }, pull_request_review_id: 222 },
      { path: "c.js", line: 3, body: "stale 3", user: { login: "Copilot" }, pull_request_review_id: 222 },
      { path: "d.js", line: 4, body: "stale 4", user: { login: "Copilot" }, pull_request_review_id: 222 },
    ],
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(logs[0]), {
    summary: "no new comments",
    state: "COMMENTED",
    inlineComments: [],
  });
});

test("fetchCopilotFeedback falls back to an empty inlineComments array (without erroring) when the REST review id can't be mapped", () => {
  const logs = [];
  const code = fetchCopilotFeedback("42", "sha1", {
    fetchReviews: () => [
      { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "APPROVED", body: "lgtm" },
    ],
    fetchReviewsRest: () => [],
    fetchInlineComments: () => {
      throw new Error("should not be called when the REST review id can't be resolved");
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(logs[0]), {
    summary: "lgtm",
    state: "APPROVED",
    inlineComments: [],
  });
});
