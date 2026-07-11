"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, classifyChecks, isNoChecksError, waitForChecks } = require("./wait-ci.js");

test("parseArgs defaults", () => {
  assert.deepEqual(parseArgs(["42"]), { pr: "42", intervalMs: 20000, timeoutMs: 20 * 60 * 1000 });
});

test("parseArgs reads --interval-ms and --timeout-ms", () => {
  assert.deepEqual(parseArgs(["42", "--interval-ms=5000", "--timeout-ms=60000"]), {
    pr: "42",
    intervalMs: 5000,
    timeoutMs: 60000,
  });
});

test("parseArgs requires exactly one positional argument", () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(["1", "2"]), /Usage:/);
});

test("parseArgs rejects a non-numeric pr instead of letting it retry until timeout", () => {
  assert.throws(() => parseArgs(["abc"]), /<pr> must be a number/);
  assert.throws(() => parseArgs(["-5"]), /<pr> must be a number/);
});

test("parseArgs rejects --interval-ms=0", () => {
  assert.throws(() => parseArgs(["42", "--interval-ms=0"]), /--interval-ms must be a positive number/);
});

test("parseArgs rejects --timeout-ms=0", () => {
  assert.throws(() => parseArgs(["42", "--timeout-ms=0"]), /--timeout-ms must be a positive number/);
});

test("parseArgs rejects unknown flags", () => {
  assert.throws(() => parseArgs(["42", "--nope"]), /Unknown argument/);
});

test("classifyChecks reports FAILED when any check failed or was cancelled", () => {
  assert.deepEqual(
    classifyChecks([
      { name: "test", bucket: "pass" },
      { name: "lint", bucket: "fail" },
      { name: "build", bucket: "cancel" },
    ]),
    { status: "FAILED", message: "lint,build" }
  );
});

test("classifyChecks reports DONE when every check resolved successfully", () => {
  assert.deepEqual(
    classifyChecks([
      { name: "test", bucket: "pass" },
      { name: "lint", bucket: "skipping" },
    ]),
    { status: "DONE", message: "test=pass,lint=skipping" }
  );
});

test("classifyChecks reports PENDING with every check (including still-pending ones) in the message", () => {
  assert.deepEqual(
    classifyChecks([
      { name: "test", bucket: "pass" },
      { name: "lint", bucket: "pending" },
    ]),
    { status: "PENDING", message: "test=pass,lint=pending" }
  );
});

test("classifyChecks never returns an empty PENDING message, even when every check is still pending", () => {
  assert.deepEqual(
    classifyChecks([{ name: "test", bucket: "pending" }]),
    { status: "PENDING", message: "test=pending" }
  );
});

test("isNoChecksError matches gh's no-checks message", () => {
  assert.equal(isNoChecksError("no checks reported on the 'feat/x' branch"), true);
  assert.equal(isNoChecksError("gh: authentication required"), false);
});

test("waitForChecks returns 0 once no-checks is confirmed on a second consecutive poll", () => {
  const logs = [];
  const sleeps = [];
  const exec = () => {
    const err = new Error("Command failed");
    err.stderr = "no checks reported on the 'feat/x' branch";
    throw err;
  };
  const code = waitForChecks("42", {
    intervalMs: 5,
    timeoutMs: 1000,
    exec,
    sleepFn: (ms) => sleeps.push(ms),
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, [
    "no checks reported yet, confirming before concluding none are configured",
    "NO_CHECKS: nothing to wait for",
  ]);
  assert.deepEqual(sleeps, [5]);
});

test("waitForChecks does not conclude NO_CHECKS from a single poll racing the check being registered", () => {
  const responses = [
    () => {
      const err = new Error("Command failed");
      err.stderr = "no checks reported on the 'feat/x' branch";
      throw err;
    },
    () => JSON.stringify([{ name: "test", bucket: "pass" }]),
  ];
  let call = 0;
  const exec = () => responses[call++]();
  const logs = [];
  const code = waitForChecks("42", {
    intervalMs: 5,
    timeoutMs: 1000,
    exec,
    sleepFn: () => {},
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, [
    "no checks reported yet, confirming before concluding none are configured",
    "DONE:test=pass",
  ]);
});

test("waitForChecks returns 1 and logs the failed checks", () => {
  const logs = [];
  const exec = () => JSON.stringify([{ name: "test", bucket: "fail" }]);
  const code = waitForChecks("42", {
    intervalMs: 1,
    timeoutMs: 1000,
    exec,
    sleepFn: () => {
      throw new Error("should not sleep");
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 1);
  assert.deepEqual(logs, ["FAILED:test"]);
});

test("waitForChecks polls through pending states, dedupes unchanged messages, then returns 0", () => {
  const responses = [
    JSON.stringify([{ name: "test", bucket: "pending" }]),
    JSON.stringify([{ name: "test", bucket: "pending" }]),
    JSON.stringify([{ name: "test", bucket: "pass" }]),
  ];
  let call = 0;
  const exec = () => responses[call++];
  const logs = [];
  const sleeps = [];
  const code = waitForChecks("42", {
    intervalMs: 20000,
    timeoutMs: 1000000,
    exec,
    sleepFn: (ms) => sleeps.push(ms),
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.equal(call, 3);
  assert.deepEqual(logs, ["test=pending", "DONE:test=pass"]);
  assert.deepEqual(sleeps, [20000, 20000]);
});

test("waitForChecks retries on a transient gh error instead of giving up", () => {
  let call = 0;
  const exec = () => {
    call++;
    if (call === 1) {
      const err = new Error("Command failed");
      err.stderr = "gh: rate limit exceeded";
      throw err;
    }
    return JSON.stringify([{ name: "test", bucket: "pass" }]);
  };
  const logs = [];
  const code = waitForChecks("42", {
    intervalMs: 1,
    timeoutMs: 1000,
    exec,
    sleepFn: () => {},
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, ["ERROR (retrying): gh: rate limit exceeded", "DONE:test=pass"]);
});

test("waitForChecks returns 2 once the timeout elapses without resolving", () => {
  const exec = () => JSON.stringify([{ name: "test", bucket: "pending" }]);
  let time = 0;
  const logs = [];
  const code = waitForChecks("42", {
    intervalMs: 100,
    timeoutMs: 250,
    exec,
    sleepFn: (ms) => {
      time += ms;
    },
    now: () => time,
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 2);
  assert.equal(logs[logs.length - 1], "TIMEOUT: checks did not resolve within the timeout");
});

test("waitForChecks caps the final sleep to the time remaining, instead of overshooting --timeout-ms by up to intervalMs", () => {
  const exec = () => JSON.stringify([{ name: "test", bucket: "pending" }]);
  let time = 0;
  const sleeps = [];
  waitForChecks("42", {
    intervalMs: 100,
    timeoutMs: 250,
    exec,
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

test("waitForChecks reports CONFLICTING with exit code 3 once a PENDING check stalls on the same message", () => {
  const logs = [];
  // Fake clock: bounds the loop to (timeoutMs / intervalMs) iterations even
  // if stall detection is missing entirely, so a red run fails fast on the
  // TIMEOUT assertion instead of spinning until a real 1000000ms elapses.
  let time = 0;
  const exec = (cmd, args) => {
    if (args[1] === "checks") {
      // Always the same pending check, i.e. a check that never appears
      // to move — the stalled case this feature exists to detect.
      return JSON.stringify([{ name: "test", bucket: "pending" }]);
    }
    if (args[1] === "view") {
      return JSON.stringify({ mergeable: "CONFLICTING" });
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  const code = waitForChecks("42", {
    intervalMs: 10,
    timeoutMs: 1000,
    exec,
    sleepFn: (ms) => {
      time += ms;
    },
    now: () => time,
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 3);
  assert.ok(
    logs.some((l) => l.startsWith("CONFLICTING:")),
    `expected a CONFLICTING: log line, got: ${JSON.stringify(logs)}`
  );
});

test("waitForChecks does not treat a stalled PENDING check as CONFLICTING when the PR is actually mergeable, and keeps polling to DONE", () => {
  const logs = [];
  let checksCall = 0;
  let time = 0;
  const exec = (cmd, args) => {
    if (args[1] === "checks") {
      checksCall++;
      // Stalls on the same PENDING message for several polls (long enough
      // to trigger a mergeable check) before finally resolving.
      if (checksCall <= 4) {
        return JSON.stringify([{ name: "test", bucket: "pending" }]);
      }
      return JSON.stringify([{ name: "test", bucket: "pass" }]);
    }
    if (args[1] === "view") {
      return JSON.stringify({ mergeable: "MERGEABLE" });
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  const code = waitForChecks("42", {
    intervalMs: 10,
    timeoutMs: 1000,
    exec,
    sleepFn: (ms) => {
      time += ms;
    },
    now: () => time,
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.ok(!logs.some((l) => l.startsWith("CONFLICTING:")), `did not expect a CONFLICTING: log line, got: ${JSON.stringify(logs)}`);
  assert.equal(logs[logs.length - 1], "DONE:test=pass");
});

test("waitForChecks reports CONFLICTING instead of TIMEOUT when the deadline is reached and the PR is CONFLICTING", () => {
  const exec = (cmd, args, callCount = 0) => {
    if (args[1] === "checks") {
      // A different check name each poll so the message never repeats,
      // which keeps the stall-based trigger from firing — this exercises
      // the separate near-timeout trigger instead.
      return JSON.stringify([{ name: `chk-${Math.random()}`, bucket: "pending" }]);
    }
    if (args[1] === "view") {
      return JSON.stringify({ mergeable: "CONFLICTING" });
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  let time = 0;
  const logs = [];
  const code = waitForChecks("42", {
    intervalMs: 100,
    timeoutMs: 250,
    exec,
    sleepFn: (ms) => {
      time += ms;
    },
    now: () => time,
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 3);
  assert.ok(
    logs.some((l) => l.startsWith("CONFLICTING:")),
    `expected a CONFLICTING: log line, got: ${JSON.stringify(logs)}`
  );
  assert.ok(!logs.some((l) => l === "TIMEOUT: checks did not resolve within the timeout"));
});

test("waitForChecks still times out normally when the deadline is reached and the PR is not CONFLICTING", () => {
  const exec = (cmd, args) => {
    if (args[1] === "checks") {
      return JSON.stringify([{ name: `chk-${Math.random()}`, bucket: "pending" }]);
    }
    if (args[1] === "view") {
      return JSON.stringify({ mergeable: "MERGEABLE" });
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  let time = 0;
  const logs = [];
  const code = waitForChecks("42", {
    intervalMs: 100,
    timeoutMs: 250,
    exec,
    sleepFn: (ms) => {
      time += ms;
    },
    now: () => time,
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 2);
  assert.equal(logs[logs.length - 1], "TIMEOUT: checks did not resolve within the timeout");
});

test("waitForChecks never calls `gh pr view --json mergeable` when checks resolve quickly (DONE), leaving the fast path untouched", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(" "));
    return JSON.stringify([{ name: "test", bucket: "pass" }]);
  };
  const code = waitForChecks("42", {
    intervalMs: 1,
    timeoutMs: 1000,
    exec,
    sleepFn: () => {},
    log: () => {},
  });
  assert.equal(code, 0);
  assert.ok(!calls.some((c) => c.includes("--json mergeable")), `did not expect a mergeable lookup, got: ${JSON.stringify(calls)}`);
});
