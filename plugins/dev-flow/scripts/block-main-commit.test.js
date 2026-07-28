"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { isGitCommitCommand } = require("./block-main-commit.js");

const SCRIPT_PATH = path.join(__dirname, "block-main-commit.js");

test("isGitCommitCommand: 単純な git commit を検出する", () => {
  assert.equal(isGitCommitCommand("git commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("git commit --amend"), true);
});

test("isGitCommitCommand: 複合コマンド内の git commit も検出する", () => {
  assert.equal(isGitCommitCommand("git add -A && git commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("cd sub && git commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("git status; git commit -m \"msg\""), true);
});

test("isGitCommitCommand: グローバルオプションを挟んでも検出する", () => {
  assert.equal(isGitCommitCommand("git -C repo commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("git -c user.name=x commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("git --work-tree /tmp/wt commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("git --git-dir /tmp/repo/.git commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("git --git-dir=/tmp/repo/.git commit -m \"msg\""), true);
});

test("isGitCommitCommand: env/command/sudo などのラッパー越しでも検出する", () => {
  assert.equal(isGitCommitCommand("env FOO=1 git commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("command git commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("sudo git commit -m \"msg\""), true);
  assert.equal(isGitCommitCommand("FOO=1 BAR=2 git commit -m \"msg\""), true);
});

test("isGitCommitCommand: commit 以外の git コマンドは検出しない", () => {
  assert.equal(isGitCommitCommand("git status"), false);
  assert.equal(isGitCommitCommand("git checkout -b feature"), false);
  assert.equal(isGitCommitCommand("git switch main"), false);
  assert.equal(isGitCommitCommand("git branch -D old-branch"), false);
  assert.equal(isGitCommitCommand("git log --grep=commit"), false);
});

test("isGitCommitCommand: git 以外のコマンドや不正な入力は検出しない", () => {
  assert.equal(isGitCommitCommand("npm test"), false);
  assert.equal(isGitCommitCommand(undefined), false);
  assert.equal(isGitCommitCommand(null), false);
  assert.equal(isGitCommitCommand(123), false);
});

test("isGitCommitCommand: heredoc本文に書かれたコミットコマンド例は検出しない", () => {
  const command = [
    "gh issue create --title \"x\" --body \"$(cat <<'EOF'",
    "## 実行したコマンド",
    "",
    "git add -A && git commit -m \"msg\"",
    "",
    "EOF",
    ")\"",
  ].join("\n");
  assert.equal(isGitCommitCommand(command), false);
});

test("isGitCommitCommand: heredocの外にある本物のgit commitは引き続き検出する", () => {
  const command = [
    "cat <<'EOF' > note.txt",
    "git commit -m \"msg\" (this is just an example)",
    "EOF",
    "git commit -m \"real commit\"",
  ].join("\n");
  assert.equal(isGitCommitCommand(command), true);
});

// --- フック全体の統合テスト: 判定先ディレクトリの解決 ---
//
// `currentBranch()` はフック自身のcwdではなく、コマンド文字列が実際に指す
// ディレクトリでブランチを判定すべき（agent-marketplace#103）。`git branch
// --show-current` はコミットが1つも無いリポジトリでも動作するため、
// `git init -b <branch>` だけの使い捨てリポジトリで十分検証できる。

function makeRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "block-main-commit-test-"));
  const result = spawnSync("git", ["init", "-q", "-b", branch], { cwd: dir });
  assert.equal(result.status, 0, `git init failed: ${result.stderr}`);
  return dir;
}

/** フックをサブプロセスとして実行し、deny時はそのJSONを、許可時はnullを返す。 */
function runHook(command, sessionCwd) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify({ tool_input: { command } }),
    cwd: sessionCwd,
    encoding: "utf8",
  });
  const stdout = result.stdout.trim();
  return stdout ? JSON.parse(stdout) : null;
}

test("フック: cd先の別リポジトリが作業ブランチなら通す", () => {
  const sessionRepo = makeRepo("main");
  const targetRepo = makeRepo("feature");
  const result = runHook(`cd ${targetRepo} && git commit -m "msg"`, sessionRepo);
  assert.equal(result, null);
});

test("フック: cd先の別リポジトリがmainならブロックする", () => {
  const sessionRepo = makeRepo("feature");
  const targetRepo = makeRepo("main");
  const result = runHook(`cd ${targetRepo} && git commit -m "msg"`, sessionRepo);
  assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny");
});

test("フック: -C付きの呼び出しでも判定先を解決する", () => {
  const sessionRepo = makeRepo("main");
  const targetFeature = makeRepo("feature");
  const targetMain = makeRepo("main");
  assert.equal(runHook(`git -C ${targetFeature} commit -m "msg"`, sessionRepo), null);
  assert.equal(
    runHook(`git -C ${targetMain} commit -m "msg"`, sessionRepo)?.hookSpecificOutput?.permissionDecision,
    "deny",
  );
});

test("フック: ディレクトリを解決できない場合は従来どおりcwdで判定する", () => {
  const sessionRepoMain = makeRepo("main");
  const sessionRepoFeature = makeRepo("feature");
  // 変数展開は解決できないので、セッション側のcwdにフォールバックする。
  assert.equal(
    runHook(`cd $SOME_UNRESOLVABLE_VAR && git commit -m "msg"`, sessionRepoMain)?.hookSpecificOutput
      ?.permissionDecision,
    "deny",
  );
  assert.equal(runHook(`cd $SOME_UNRESOLVABLE_VAR && git commit -m "msg"`, sessionRepoFeature), null);
  // 存在しないパスも同様にフォールバックする。
  assert.equal(
    runHook(`cd ${path.join(sessionRepoMain, "no-such-subdir")} && git commit -m "msg"`, sessionRepoMain)
      ?.hookSpecificOutput?.permissionDecision,
    "deny",
  );
});

test("フック: 通常のmain上での直コミットは従来どおりブロックする", () => {
  const sessionRepo = makeRepo("main");
  const result = runHook(`git commit -m "msg"`, sessionRepo);
  assert.equal(result?.hookSpecificOutput?.permissionDecision, "deny");
});

test("フック: heredoc本文のコマンド例ではブロックされない", () => {
  const sessionRepo = makeRepo("main");
  const command = [
    "gh issue create --title \"x\" --body \"$(cat <<'EOF'",
    "git commit -m \"msg\"",
    "EOF",
    ")\"",
  ].join("\n");
  assert.equal(runHook(command, sessionRepo), null);
});
