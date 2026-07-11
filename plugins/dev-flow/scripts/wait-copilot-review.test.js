"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  findSubmittedReview,
  hasPendingCopilotRequest,
  everRequestedCopilot,
  waitForCopilotReview,
} = require("./wait-copilot-review.js");

test("parseArgs defaults with only a PR number", () => {
  assert.deepEqual(parseArgs(["42"]), { pr: "42", sha: null, intervalMs: 25000, timeoutMs: 15 * 60 * 1000 });
});

test("parseArgs accepts an optional sha and overrides", () => {
  assert.deepEqual(parseArgs(["42", "abc1234", "--interval-ms=5000", "--timeout-ms=60000"]), {
    pr: "42",
    sha: "abc1234",
    intervalMs: 5000,
    timeoutMs: 60000,
  });
});

test("parseArgs rejects a non-numeric pr instead of letting it retry until timeout", () => {
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

test("parseArgs rejects --interval-ms=0", () => {
  assert.throws(() => parseArgs(["42", "--interval-ms=0"]), /--interval-ms must be a positive number/);
});

test("parseArgs rejects --timeout-ms=0", () => {
  assert.throws(() => parseArgs(["42", "--timeout-ms=0"]), /--timeout-ms must be a positive number/);
});

test("findSubmittedReview matches on author.login and commit.oid, ignoring inline-comment-style user.login", () => {
  const reviews = [
    { author: { login: "someone-else" }, commit: { oid: "sha1" }, state: "COMMENTED" },
    { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha0" }, state: "APPROVED" },
    { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "CHANGES_REQUESTED" },
  ];
  assert.equal(findSubmittedReview(reviews, "sha1"), "CHANGES_REQUESTED");
  assert.equal(findSubmittedReview(reviews, "sha-missing"), null);
});

test("findSubmittedReview returns the last matching review when several exist for the same sha", () => {
  const reviews = [
    { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "COMMENTED" },
    { author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "APPROVED" },
  ];
  assert.equal(findSubmittedReview(reviews, "sha1"), "APPROVED");
});

test("hasPendingCopilotRequest matches a user login or a team name", () => {
  assert.equal(hasPendingCopilotRequest([{ login: "Copilot" }]), true);
  assert.equal(hasPendingCopilotRequest([{ name: "copilot-team" }]), true);
  assert.equal(hasPendingCopilotRequest([{ login: "some-human" }]), false);
  assert.equal(hasPendingCopilotRequest([]), false);
});

test("everRequestedCopilot inspects requested_reviewer and requested_team on review_requested events", () => {
  assert.equal(
    everRequestedCopilot([{ event: "commented" }, { event: "review_requested", requested_reviewer: { login: "Copilot" } }]),
    true
  );
  assert.equal(
    everRequestedCopilot([{ event: "review_requested", requested_team: { name: "copilot" } }]),
    true
  );
  assert.equal(
    everRequestedCopilot([{ event: "review_requested", requested_reviewer: { login: "some-human" } }]),
    false
  );
  assert.equal(everRequestedCopilot([]), false);
});

test("waitForCopilotReview returns 0 immediately when a review already landed for this sha", () => {
  const logs = [];
  const code = waitForCopilotReview("42", "sha1", {
    intervalMs: 1,
    timeoutMs: 1000,
    fetchReviews: () => [{ author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "APPROVED" }],
    fetchReviewRequests: () => [],
    fetchEverRequested: () => {
      throw new Error("should not be called");
    },
    sleepFn: () => {
      throw new Error("should not sleep");
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, ["SUBMITTED:APPROVED"]);
});

test("waitForCopilotReview returns 0 without waiting when Copilot was never requested on this PR", () => {
  const logs = [];
  const code = waitForCopilotReview("42", "sha1", {
    intervalMs: 1,
    timeoutMs: 1000,
    fetchReviews: () => [],
    fetchReviewRequests: () => [],
    fetchEverRequested: () => false,
    sleepFn: () => {
      throw new Error("should not sleep");
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, ["NOT_CONFIGURED: no Copilot review request found for this PR"]);
});

test("waitForCopilotReview does not conclude NOT_CONFIGURED while a request is pending, even if it never gets submitted", () => {
  const logs = [];
  const sleeps = [];
  let time = 0;
  const code = waitForCopilotReview("42", "sha1", {
    intervalMs: 100,
    timeoutMs: 250,
    fetchReviews: () => [],
    fetchReviewRequests: () => [{ login: "Copilot" }],
    fetchEverRequested: () => {
      throw new Error("should not be called once a pending request is seen");
    },
    sleepFn: (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    now: () => time,
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 2);
  assert.equal(logs[0], "review requested, still awaiting submission");
  assert.equal(logs[logs.length - 1], "TIMEOUT: no Copilot review submitted within the timeout");
});

test("waitForCopilotReview caps the final sleep to the time remaining, instead of overshooting --timeout-ms by up to intervalMs", () => {
  let time = 0;
  const sleeps = [];
  waitForCopilotReview("42", "sha1", {
    intervalMs: 100,
    timeoutMs: 250,
    fetchReviews: () => [],
    fetchReviewRequests: () => [{ login: "Copilot" }],
    fetchEverRequested: () => {
      throw new Error("should not be called once a pending request is seen");
    },
    sleepFn: (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    now: () => time,
    log: () => {},
  });
  assert.deepEqual(sleeps, [100, 100, 50]);
  assert.equal(time, 250);
});

test("waitForCopilotReview polls past a pending request until the review is submitted", () => {
  const requestSequence = [[{ login: "Copilot" }], [{ login: "Copilot" }], []];
  const reviewSequence = [
    [],
    [],
    [{ author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "APPROVED" }],
  ];
  let call = 0;
  const logs = [];
  const code = waitForCopilotReview("42", "sha1", {
    intervalMs: 10,
    timeoutMs: 100000,
    fetchReviews: () => reviewSequence[call],
    fetchReviewRequests: () => requestSequence[call++],
    fetchEverRequested: () => {
      throw new Error("should not be called");
    },
    sleepFn: () => {},
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, ["review requested, still awaiting submission", "SUBMITTED:APPROVED"]);
});

test("waitForCopilotReview retries on a transient gh error instead of giving up", () => {
  let reviewCall = 0;
  const logs = [];
  const code = waitForCopilotReview("42", "sha1", {
    intervalMs: 1,
    timeoutMs: 1000,
    fetchReviews: () => {
      reviewCall++;
      if (reviewCall === 1) {
        throw new Error("gh: rate limit exceeded");
      }
      return [{ author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "sha1" }, state: "APPROVED" }];
    },
    fetchReviewRequests: () => [],
    fetchEverRequested: () => false,
    sleepFn: () => {},
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, ["ERROR (retrying): gh: rate limit exceeded", "SUBMITTED:APPROVED"]);
});

test("waitForCopilotReview retries the not-configured (timeline) check after a transient error instead of giving up on it forever", () => {
  let everCall = 0;
  const logs = [];
  const code = waitForCopilotReview("42", "sha1", {
    intervalMs: 1,
    timeoutMs: 1000,
    fetchReviews: () => [],
    fetchReviewRequests: () => [],
    fetchEverRequested: () => {
      everCall++;
      if (everCall === 1) {
        throw new Error("gh: rate limit exceeded");
      }
      return false;
    },
    sleepFn: () => {},
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.equal(everCall, 2);
  assert.deepEqual(logs, [
    "ERROR (retrying): gh: rate limit exceeded",
    "NOT_CONFIGURED: no Copilot review request found for this PR",
  ]);
});
