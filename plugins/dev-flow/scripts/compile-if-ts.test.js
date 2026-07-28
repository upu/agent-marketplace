"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  shouldCompile,
  hasCompileScript,
  buildAdvisoryOutput,
  ADVISORY_OUTPUT_MAX_CHARS,
} = require("./compile-if-ts.js");

test("shouldCompile: .ts ファイルでは compile する", () => {
  assert.equal(shouldCompile("C:\\repo\\src\\extension.ts"), true);
  assert.equal(shouldCompile("src/finders.ts"), true);
  assert.equal(shouldCompile("src/test/suite/extension.test.ts"), true);
});

test("shouldCompile: .tsx・.mts・.cts でも compile する", () => {
  assert.equal(shouldCompile("src/App.tsx"), true);
  assert.equal(shouldCompile("C:\\repo\\src\\Widget.tsx"), true);
  assert.equal(shouldCompile("src/esm-entry.mts"), true);
  assert.equal(shouldCompile("src/cjs-entry.cts"), true);
});

test("shouldCompile: tsconfig.json / tsconfig.*.json でも compile する", () => {
  assert.equal(shouldCompile("tsconfig.json"), true);
  assert.equal(shouldCompile("tsconfig.build.json"), true);
  assert.equal(shouldCompile("packages/app/tsconfig.test.json"), true);
  assert.equal(shouldCompile("C:\\repo\\tsconfig.json"), true);
});

test("shouldCompile: TypeScript と無関係なファイルでは compile しない", () => {
  assert.equal(shouldCompile("CHANGELOG.md"), false);
  assert.equal(shouldCompile("README.ja.md"), false);
  assert.equal(shouldCompile(".claude\\skills\\ship\\SKILL.md"), false);
  assert.equal(shouldCompile("package.json"), false);
  assert.equal(shouldCompile("scripts/prepare-release.js"), false);
  assert.equal(shouldCompile("jsconfig.json"), false);
  assert.equal(shouldCompile("src/notatsconfig.json"), false);
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

test("buildAdvisoryOutput: PostToolUse の additionalContext として診断本文を届ける", () => {
  const output = buildAdvisoryOutput("src/a.ts(1,1): error TS2304: Cannot find name 'foo'.");

  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(output.hookSpecificOutput.additionalContext, /error TS2304/);
});

test("buildAdvisoryOutput: テスト先行の red が想定どおりである旨を添える", () => {
  // 失敗そのものではなく「進めてよいか」を判断できる情報を届けるのが目的。
  const output = buildAdvisoryOutput("error TS2305");

  assert.match(output.hookSpecificOutput.additionalContext, /テストを先に書いた直後/);
});

test("buildAdvisoryOutput: 長すぎる出力は切り詰め、切り詰めた旨を残す", () => {
  const long = "e".repeat(ADVISORY_OUTPUT_MAX_CHARS + 500);

  const { additionalContext } = buildAdvisoryOutput(long).hookSpecificOutput;

  assert.ok(additionalContext.includes("e".repeat(100)));
  assert.ok(additionalContext.length < long.length);
  assert.match(additionalContext, /以降を省略/);
});

test("buildAdvisoryOutput: 出力が空でも additionalContext を組み立てる", () => {
  for (const empty of ["", "   \n ", undefined]) {
    const { additionalContext } = buildAdvisoryOutput(empty).hookSpecificOutput;
    assert.match(additionalContext, /コンパイル出力なし/);
  }
});

test("buildAdvisoryOutput: JSON としてそのまま標準出力へ書ける", () => {
  const serialized = JSON.stringify(buildAdvisoryOutput("error TS1005"));

  assert.deepEqual(JSON.parse(serialized), buildAdvisoryOutput("error TS1005"));
});
