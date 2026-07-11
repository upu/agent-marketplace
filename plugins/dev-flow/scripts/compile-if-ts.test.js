"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { shouldCompile, hasCompileScript } = require("./compile-if-ts.js");

test("shouldCompile: .ts ファイルでは compile する", () => {
  assert.equal(shouldCompile("C:\\repo\\src\\extension.ts"), true);
  assert.equal(shouldCompile("src/finders.ts"), true);
  assert.equal(shouldCompile("src/test/suite/extension.test.ts"), true);
});

test("shouldCompile: TypeScript と無関係なファイルでは compile しない", () => {
  assert.equal(shouldCompile("CHANGELOG.md"), false);
  assert.equal(shouldCompile("README.ja.md"), false);
  assert.equal(shouldCompile(".claude\\skills\\ship\\SKILL.md"), false);
  assert.equal(shouldCompile("package.json"), false);
  assert.equal(shouldCompile("scripts/prepare-release.js"), false);
});

test("shouldCompile: file_path が取れないときは安全側に倒して compile する", () => {
  assert.equal(shouldCompile(undefined), true);
  assert.equal(shouldCompile(null), true);
  assert.equal(shouldCompile(123), true);
});

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compile-if-ts-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("hasCompileScript: package.json が無いリポジトリでは false", () => {
  withTempDir((dir) => {
    assert.equal(hasCompileScript(dir), false);
  });
});

test("hasCompileScript: package.json はあるが compile スクリプトが無ければ false", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    assert.equal(hasCompileScript(dir), false);
  });
});

test("hasCompileScript: scripts フィールド自体が無ければ false", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "no-scripts" }));
    assert.equal(hasCompileScript(dir), false);
  });
});

test("hasCompileScript: compile スクリプトが定義されていれば true", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { compile: "tsc" } }));
    assert.equal(hasCompileScript(dir), true);
  });
});

test("hasCompileScript: package.json が不正なJSONなら false", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
    assert.equal(hasCompileScript(dir), false);
  });
});

test("hasCompileScript: このリポジトリ自身は package.json を持たない npm プロジェクト外なので false", () => {
  const repoRoot = path.join(__dirname, "..", "..", "..");
  assert.equal(hasCompileScript(repoRoot), false);
});
