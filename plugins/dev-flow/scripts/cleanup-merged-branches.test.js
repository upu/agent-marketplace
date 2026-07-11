"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  listGoneBranches,
  fetchMergeStatus,
  cleanupMergedBranches,
} = require("./cleanup-merged-branches.js");

test("listGoneBranches returns only branches whose upstream track is exactly [gone]", () => {
  const exec = () =>
    [
      "feat/a\t[gone]",
      "feat/b\t[behind 1]",
      "feat/c\t",
      "main\t",
      "feat/d\t[gone]",
    ].join("\n") + "\n";
  assert.deepEqual(listGoneBranches(exec), ["feat/a", "feat/d"]);
});

test("listGoneBranches returns an empty array when nothing is gone", () => {
  const exec = () => "main\t\nfeat/x\t[ahead 2]\n";
  assert.deepEqual(listGoneBranches(exec), []);
});

test("listGoneBranches tolerates blank lines and CRLF line endings", () => {
  const exec = () => "feat/a\t[gone]\r\n\r\nfeat/b\t\r\n";
  assert.deepEqual(listGoneBranches(exec), ["feat/a"]);
});

test("fetchMergeStatus reports merged=true when the PR state is MERGED with a mergedAt", () => {
  const exec = () => JSON.stringify({ number: 62, state: "MERGED", mergedAt: "2026-07-11T22:25:49Z" });
  const status = fetchMergeStatus("feat/ship-merge-pr-script", exec);
  assert.deepEqual(status, {
    found: true,
    number: 62,
    state: "MERGED",
    mergedAt: "2026-07-11T22:25:49Z",
    merged: true,
  });
});

test("fetchMergeStatus reports merged=false for an open PR", () => {
  const exec = () => JSON.stringify({ number: 70, state: "OPEN", mergedAt: null });
  const status = fetchMergeStatus("feat/still-open", exec);
  assert.equal(status.found, true);
  assert.equal(status.merged, false);
});

test("fetchMergeStatus reports found=false when gh finds no matching PR", () => {
  const exec = () => {
    const err = new Error("Command failed");
    err.stderr = "no pull requests found for branch \"feat/orphan\"";
    throw err;
  };
  const status = fetchMergeStatus("feat/orphan", exec);
  assert.equal(status.found, false);
  assert.match(status.reason, /no pull requests found/);
});

test("cleanupMergedBranches deletes only branches confirmed merged via mergedAt", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "for-each-ref") {
      return ["feat/merged\t[gone]", "feat/open\t[gone]", "feat/orphan\t[gone]"].join("\n") + "\n";
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      const branch = args[2];
      if (branch === "feat/merged") {
        return JSON.stringify({ number: 10, state: "MERGED", mergedAt: "2026-07-12T00:00:00Z" });
      }
      if (branch === "feat/open") {
        return JSON.stringify({ number: 11, state: "OPEN", mergedAt: null });
      }
      if (branch === "feat/orphan") {
        const err = new Error("Command failed");
        err.stderr = "no pull requests found";
        throw err;
      }
    }
    if (cmd === "git" && args[0] === "branch" && args[1] === "-D") {
      return "";
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  const result = cleanupMergedBranches({ exec, log: (m) => logs.push(m) });

  assert.deepEqual(result.deleted, ["feat/merged"]);
  assert.deepEqual(
    result.skipped.map((s) => s.branch),
    ["feat/open", "feat/orphan"]
  );
  assert.ok(calls.some((c) => c.join(" ") === "git branch -D feat/merged"));
  assert.ok(!calls.some((c) => c[0] === "git" && c[1] === "branch" && c[2] === "-D" && c[3] === "feat/open"));
  assert.ok(!calls.some((c) => c[0] === "git" && c[1] === "branch" && c[2] === "-D" && c[3] === "feat/orphan"));
  assert.ok(logs.some((l) => l.includes("DELETED:feat/merged")));
  assert.ok(logs.some((l) => l.includes("SKIP:feat/open")));
  assert.ok(logs.some((l) => l.includes("SKIP:feat/orphan")));
});

test("cleanupMergedBranches does nothing and logs a clean report when no branches are gone", () => {
  const exec = (cmd, args) => {
    if (cmd === "git" && args[0] === "for-each-ref") {
      return "main\t\n";
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  const result = cleanupMergedBranches({ exec, log: (m) => logs.push(m) });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.skipped, []);
  assert.ok(logs.some((l) => /no local branches/i.test(l)));
});

test("cleanupMergedBranches never calls branch -D for a skipped branch even if PR lookup fails midway", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "for-each-ref") {
      return "feat/broken\t[gone]\n";
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      const err = new Error("Command failed");
      err.stderr = "some transient API error";
      throw err;
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const result = cleanupMergedBranches({ exec, log: () => {} });
  assert.deepEqual(result.deleted, []);
  assert.equal(result.skipped.length, 1);
  assert.ok(!calls.some((c) => c[0] === "git" && c[1] === "branch"));
});
