"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fetchHeadRefName,
  listWorktrees,
  removeWorktree,
  cleanupWaveWorktrees,
  fetchIssues,
} = require("./cleanup-worktrees.js");

test("fetchHeadRefName returns the branch name from gh pr view", () => {
  const exec = () => JSON.stringify({ headRefName: "feat/batch-ship-worktree-cleanup" });
  assert.equal(fetchHeadRefName(78, exec), "feat/batch-ship-worktree-cleanup");
});

test("listWorktrees extracts path/branch pairs from `git worktree list --porcelain` output", () => {
  const exec = () =>
    [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/agent-1",
      "HEAD def456",
      "branch refs/heads/feat/x",
      "",
    ].join("\n") + "\n";
  assert.deepEqual(listWorktrees(exec), [
    { path: "/repo", branch: "main" },
    { path: "/repo/.claude/worktrees/agent-1", branch: "feat/x" },
  ]);
});

test("listWorktrees leaves branch null for a detached-HEAD worktree", () => {
  const exec = () =>
    ["worktree /repo", "HEAD abc123", "branch refs/heads/main", "", "worktree /repo/detached", "HEAD def456", "detached", ""].join(
      "\n"
    ) + "\n";
  assert.deepEqual(listWorktrees(exec), [
    { path: "/repo", branch: "main" },
    { path: "/repo/detached", branch: null },
  ]);
});

test("listWorktrees handles output with no trailing blank line", () => {
  const exec = () => "worktree /repo\nHEAD abc123\nbranch refs/heads/main";
  assert.deepEqual(listWorktrees(exec), [{ path: "/repo", branch: "main" }]);
});

test("removeWorktree runs `git worktree remove` and reports removed", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  const logs = [];
  const result = removeWorktree("/repo/.claude/worktrees/agent-1", exec, (m) => logs.push(m));
  assert.equal(result, "removed");
  assert.deepEqual(calls, [["git", "worktree", "remove", "/repo/.claude/worktrees/agent-1"]]);
  assert.ok(logs.some((l) => l === "REMOVED:/repo/.claude/worktrees/agent-1"));
});

test("removeWorktree unlocks and retries when the worktree is locked", () => {
  const calls = [];
  let removeAttempts = 0;
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
      removeAttempts += 1;
      if (removeAttempts === 1) {
        const err = new Error("Command failed");
        err.stderr = "fatal: '/repo/wt' is locked\nreason: added by isolation";
        throw err;
      }
      return "";
    }
    if (cmd === "git" && args[0] === "worktree" && args[1] === "unlock") {
      return "";
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  const result = removeWorktree("/repo/wt", exec, (m) => logs.push(m));
  assert.equal(result, "removed");
  assert.deepEqual(calls, [
    ["git", "worktree", "remove", "/repo/wt"],
    ["git", "worktree", "unlock", "/repo/wt"],
    ["git", "worktree", "remove", "/repo/wt"],
  ]);
  assert.ok(logs.some((l) => l.includes("REMOVED:/repo/wt") && l.includes("unlocked first")));
});

test("removeWorktree logs FAILED and does not force-delete a dirty worktree", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const err = new Error("Command failed");
    err.stderr = "fatal: '/repo/wt' contains modified or untracked files, use --force to delete it";
    throw err;
  };
  const logs = [];
  const result = removeWorktree("/repo/wt", exec, (m) => logs.push(m));
  assert.equal(result, "failed");
  // Only the initial plain remove is attempted; --force is never used.
  assert.deepEqual(calls, [["git", "worktree", "remove", "/repo/wt"]]);
  assert.ok(logs.some((l) => l.includes("FAILED:/repo/wt")));
});

test("removeWorktree logs FAILED when unlock-then-retry also fails", () => {
  const exec = (cmd, args) => {
    if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
      const err = new Error("Command failed");
      err.stderr = "fatal: '/repo/wt' is locked";
      throw err;
    }
    if (cmd === "git" && args[0] === "worktree" && args[1] === "unlock") {
      const err = new Error("Command failed");
      err.stderr = "fatal: not a working tree";
      throw err;
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const logs = [];
  const result = removeWorktree("/repo/wt", exec, (m) => logs.push(m));
  assert.equal(result, "failed");
  assert.ok(logs.some((l) => l.includes("FAILED:/repo/wt")));
});

function makeIssuesExec({ worktreeList, prMerged = {}, headRef = {} }) {
  return (cmd, args) => {
    if (cmd === "git" && args[0] === "worktree" && args[1] === "list") {
      return worktreeList;
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      const pr = args[2];
      const field = args[4]; // --json <field>
      if (field === "state") {
        return JSON.stringify({ state: prMerged[pr] ? "MERGED" : "OPEN" });
      }
      if (field === "headRefName") {
        return JSON.stringify({ headRefName: headRef[pr] });
      }
    }
    if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
      return "";
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
}

test("cleanupWaveWorktrees removes the worktree for a confirmed-merged issue's PR branch", () => {
  const worktreeList =
    ["worktree /repo", "HEAD abc", "branch refs/heads/main", "", "worktree /repo/.claude/worktrees/agent-1", "HEAD def", "branch refs/heads/feat/x", ""].join(
      "\n"
    ) + "\n";
  const exec = makeIssuesExec({
    worktreeList,
    prMerged: { 78: true },
    headRef: { 78: "feat/x" },
  });
  const issues = [{ number: 40, closedByPullRequestsReferences: [{ number: 78 }] }];
  const logs = [];
  const result = cleanupWaveWorktrees(issues, { exec, log: (m) => logs.push(m) });
  assert.deepEqual(result.removed, [{ number: 40, path: "/repo/.claude/worktrees/agent-1" }]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.failed, []);
  assert.ok(logs.some((l) => l.includes("REMOVED:/repo/.claude/worktrees/agent-1")));
});

test("cleanupWaveWorktrees skips an issue whose PR is not confirmed merged, without touching any worktree", () => {
  const worktreeList = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n";
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "worktree" && args[1] === "list") return worktreeList;
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view" && args[4] === "state") {
      return JSON.stringify({ state: "OPEN" });
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const issues = [{ number: 41, closedByPullRequestsReferences: [{ number: 79 }] }];
  const logs = [];
  const result = cleanupWaveWorktrees(issues, { exec, log: (m) => logs.push(m) });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped, [{ number: 41, reason: "not confirmed merged" }]);
  assert.ok(!calls.some((c) => c[0] === "git" && c[1] === "worktree" && c[2] === "remove"));
  assert.ok(logs.some((l) => l.includes("SKIP:#41") && l.includes("not confirmed merged")));
});

test("cleanupWaveWorktrees skips (not fails) a merged issue whose worktree is already gone", () => {
  const worktreeList = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n";
  const exec = makeIssuesExec({
    worktreeList,
    prMerged: { 80: true },
    headRef: { 80: "feat/already-cleaned" },
  });
  const issues = [{ number: 42, closedByPullRequestsReferences: [{ number: 80 }] }];
  const logs = [];
  const result = cleanupWaveWorktrees(issues, { exec, log: (m) => logs.push(m) });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].number, 42);
  assert.match(result.skipped[0].reason, /no worktree found/);
});

test("cleanupWaveWorktrees continues past a removal failure instead of stopping the wave", () => {
  const worktreeList =
    [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/agent-1",
      "HEAD d1",
      "branch refs/heads/feat/dirty",
      "",
      "worktree /repo/.claude/worktrees/agent-2",
      "HEAD d2",
      "branch refs/heads/feat/clean",
      "",
    ].join("\n") + "\n";
  const exec = (cmd, args) => {
    if (cmd === "git" && args[0] === "worktree" && args[1] === "list") return worktreeList;
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view" && args[4] === "state") {
      return JSON.stringify({ state: "MERGED" });
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view" && args[4] === "headRefName") {
      const pr = args[2];
      return JSON.stringify({ headRefName: pr === "90" ? "feat/dirty" : "feat/clean" });
    }
    if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
      const path = args[2];
      if (path === "/repo/.claude/worktrees/agent-1") {
        const err = new Error("Command failed");
        err.stderr = "fatal: contains modified or untracked files, use --force to delete it";
        throw err;
      }
      return "";
    }
    throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
  };
  const issues = [
    { number: 90, closedByPullRequestsReferences: [{ number: 90 }] },
    { number: 91, closedByPullRequestsReferences: [{ number: 91 }] },
  ];
  const logs = [];
  const result = cleanupWaveWorktrees(issues, { exec, log: (m) => logs.push(m) });
  assert.deepEqual(result.failed, [{ number: 90, path: "/repo/.claude/worktrees/agent-1" }]);
  assert.deepEqual(result.removed, [{ number: 91, path: "/repo/.claude/worktrees/agent-2" }]);
  assert.ok(logs.some((l) => l.includes("FAILED:/repo/.claude/worktrees/agent-1")));
  assert.ok(logs.some((l) => l.includes("REMOVED:/repo/.claude/worktrees/agent-2")));
});

test("fetchIssues fetches by milestone when given one", () => {
  const exec = () => JSON.stringify([{ number: 1, state: "CLOSED", closedByPullRequestsReferences: [] }]);
  const issues = fetchIssues({ milestone: "v0.6.0", issueNumbers: null }, exec);
  assert.deepEqual(issues, [{ number: 1, state: "CLOSED", closedByPullRequestsReferences: [] }]);
});

test("fetchIssues fetches each issue number individually when no milestone is given", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args[2]);
    return JSON.stringify({ number: Number(args[2]), state: "CLOSED", closedByPullRequestsReferences: [] });
  };
  const issues = fetchIssues({ milestone: null, issueNumbers: [78, 79] }, exec);
  assert.deepEqual(calls, ["78", "79"]);
  assert.deepEqual(issues.map((i) => i.number), [78, 79]);
});
