"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, isLinkedWorktree, mergePr } = require("./merge-pr.js");

test("parseArgs requires exactly one positional argument", () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(["1", "2"]), /Usage:/);
});

test("parseArgs rejects a non-numeric pr", () => {
  assert.throws(() => parseArgs(["abc"]), /<pr> must be a number/);
  assert.throws(() => parseArgs(["-5"]), /<pr> must be a number/);
});

test("parseArgs accepts a numeric pr", () => {
  assert.deepEqual(parseArgs(["42"]), { pr: "42" });
});

test("isLinkedWorktree returns false when git-common-dir is the literal '.git'", () => {
  const exec = () => ".git\n";
  assert.equal(isLinkedWorktree(exec), false);
});

test("isLinkedWorktree returns true when git-common-dir resolves to an absolute path", () => {
  const exec = () => "C:/Users/spitz/workspace/agent-marketplace/.git\n";
  assert.equal(isLinkedWorktree(exec), true);
});

test("mergePr on a normal tree merges with --delete-branch and does not query headRefName/mergedAt", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "rev-parse") return ".git\n";
    if (args[0] === "pr" && args[1] === "merge") return "";
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  const code = mergePr("42", { exec, log: (m) => logs.push(m) });
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ["git", "rev-parse", "--git-common-dir"],
    ["gh", "pr", "merge", "42", "--squash", "--delete-branch"],
  ]);
  assert.deepEqual(logs, ["MERGED:42 (branch deleted via --delete-branch)"]);
});

test("mergePr in a worktree merges without --delete-branch, confirms mergedAt, then deletes the remote branch explicitly", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "rev-parse") return "C:/Users/spitz/workspace/agent-marketplace/.git\n";
    if (args[0] === "pr" && args[1] === "view" && args[4] === "headRefName") {
      return JSON.stringify({ headRefName: "feat/x" });
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    if (args[0] === "pr" && args[1] === "view" && args[4] === "mergedAt") {
      return JSON.stringify({ mergedAt: "2026-07-12T00:00:00Z" });
    }
    if (args[0] === "push") return "";
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  const code = mergePr("42", { exec, log: (m) => logs.push(m) });
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ["git", "rev-parse", "--git-common-dir"],
    ["gh", "pr", "view", "42", "--json", "headRefName"],
    ["gh", "pr", "merge", "42", "--squash"],
    ["gh", "pr", "view", "42", "--json", "mergedAt"],
    ["git", "push", "origin", "--delete", "feat/x"],
  ]);
  assert.deepEqual(logs, ["MERGED:42 (worktree: mergedAt=2026-07-12T00:00:00Z, remote branch feat/x deleted)"]);
});

test("mergePr in a worktree does not run git checkout main", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "rev-parse") return "C:/Users/spitz/workspace/agent-marketplace/.git\n";
    if (args[0] === "pr" && args[1] === "view" && args[4] === "headRefName") {
      return JSON.stringify({ headRefName: "feat/x" });
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    if (args[0] === "pr" && args[1] === "view" && args[4] === "mergedAt") {
      return JSON.stringify({ mergedAt: "2026-07-12T00:00:00Z" });
    }
    if (args[0] === "push") return "";
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  mergePr("42", { exec, log: () => {} });
  assert.ok(!calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "checkout"));
});

test("mergePr in a worktree returns 1 without pushing a delete when mergedAt is not set after merge", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "rev-parse") return "C:/Users/spitz/workspace/agent-marketplace/.git\n";
    if (args[0] === "pr" && args[1] === "view" && args[4] === "headRefName") {
      return JSON.stringify({ headRefName: "feat/x" });
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    if (args[0] === "pr" && args[1] === "view" && args[4] === "mergedAt") {
      return JSON.stringify({ mergedAt: null });
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  const code = mergePr("42", { exec, log: (m) => logs.push(m) });
  assert.equal(code, 1);
  assert.ok(!calls.some(([cmd, ...args]) => cmd === "git" && args[0] === "push"));
  assert.match(logs[0], /mergedAt is not set/);
});

test("mergePr in a worktree still reports overall success when the merge landed but remote branch deletion fails", () => {
  const exec = (cmd, args) => {
    if (args[0] === "rev-parse") return "C:/Users/spitz/workspace/agent-marketplace/.git\n";
    if (args[0] === "pr" && args[1] === "view" && args[4] === "headRefName") {
      return JSON.stringify({ headRefName: "feat/x" });
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    if (args[0] === "pr" && args[1] === "view" && args[4] === "mergedAt") {
      return JSON.stringify({ mergedAt: "2026-07-12T00:00:00Z" });
    }
    if (args[0] === "push") {
      const err = new Error("Command failed");
      err.stderr = "remote ref does not exist";
      throw err;
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  const code = mergePr("42", { exec, log: (m) => logs.push(m) });
  assert.equal(code, 0);
  assert.match(logs[0], /remote branch feat\/x deletion failed/);
});

test("mergePr propagates the error when `gh pr merge` itself fails (e.g. CI not green)", () => {
  const exec = (cmd, args) => {
    if (args[0] === "rev-parse") return ".git\n";
    if (args[0] === "pr" && args[1] === "merge") {
      const err = new Error("Command failed");
      err.stderr = "Pull request #42 is not mergeable: the merge commit cannot be cleanly created.";
      throw err;
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  assert.throws(() => mergePr("42", { exec, log: () => {} }), /not mergeable/);
});
