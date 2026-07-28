// PreToolUse hook command: block `git commit` while the working tree is on
// main. GitHub's ruleset already refuses the push, but committing locally
// first still forces a manual recovery (reset the commit, branch, recommit)
// that this hook exists to skip entirely.
//
// The branch check must run against the directory the commit actually lands
// in, not the hook process's own cwd (the session's working directory):
// `cd <other-repo> && git commit ...` or `git -C <other-repo> commit ...`
// point somewhere else entirely, and judging by the session's branch instead
// gives both false positives (session on main, target repo on a feature
// branch: wrongly blocked) and false negatives (session on a feature branch,
// target repo on main: wrongly allowed) — see agent-marketplace#103. When the
// target directory can't be resolved safely (shell variable/command
// expansion, or a path that doesn't exist), this falls back to the hook's own
// cwd, matching the previous behavior.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Global git options that take their value as a separate following token
// (space form, e.g. `--git-dir <dir>`); a self-contained `--git-dir=<dir>`
// needs no extra skip since it has no following token to consume.
const VALUE_TAKING_GLOBAL_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
]);

/**
 * The first non-flag token of a `git` invocation, skipping global options
 * that consume their own value.
 */
function gitSubcommand(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (VALUE_TAKING_GLOBAL_OPTIONS.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * Every value passed to a repeatable value-taking global option (e.g. every
 * `-C <dir>`) before the subcommand, in left-to-right order.
 */
function gitGlobalOptionValues(tokens, optionName) {
  const values = [];
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === optionName) {
      if (i + 1 < tokens.length) values.push(tokens[i + 1]);
      i += 2;
      continue;
    }
    if (VALUE_TAKING_GLOBAL_OPTIONS.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  return values;
}

// Leading wrappers that don't change what command actually runs: shell
// builtins/prefixes (env, command, sudo, ...) and inline `NAME=value` env
// assignments, both of which can precede `git` any number of times.
const LEADING_WRAPPER = /^(?:env|command|sudo|noglob|nocorrect)\s+/;
const LEADING_ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;

/**
 * Strip leading wrapper commands / env-var assignments so `git` invocations
 * behind `env FOO=1 git commit`, `command git commit`, `sudo git commit`
 * etc. are still recognized.
 */
function stripLeadingWrappers(segment) {
  let rest = segment;
  let stripped = true;
  while (stripped) {
    stripped = false;
    const wrapperMatch = LEADING_WRAPPER.exec(rest);
    if (wrapperMatch) {
      rest = rest.slice(wrapperMatch[0].length);
      stripped = true;
      continue;
    }
    const envMatch = LEADING_ENV_ASSIGNMENT.exec(rest);
    if (envMatch) {
      rest = rest.slice(envMatch[0].length);
      stripped = true;
    }
  }
  return rest;
}

// Matches a heredoc's opening redirect (`<<EOF`, `<<'EOF'`, `<<"EOF"`,
// `<<-EOF`, ...) so its body can be excluded before segment-splitting a
// command string. Without this, a description containing an example command
// (e.g. an issue body written via `gh issue create --body "$(cat <<'EOF'
// ... EOF)"`) gets its example lines misread as real invocations, since
// segment-splitting already treats newlines as a command separator.
const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/;

/**
 * Remove heredoc bodies (the text between a `<<[-]MARKER` redirect and the
 * line that is exactly `MARKER`) from a command string, replacing each with
 * nothing. Text before the redirect on its opening line is preserved, so a
 * real command chained before it (`git commit ... && cat <<'EOF'`) is still
 * seen. An unterminated heredoc discards everything after it, which is the
 * safe direction here: it can only hide a real command from detection, never
 * fabricate one that isn't there.
 */
function stripHeredocs(command) {
  if (typeof command !== "string" || !command.includes("<<")) {
    return command;
  }
  const lines = command.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = HEREDOC_START.exec(line);
    if (!match) {
      out.push(line);
      i += 1;
      continue;
    }
    const dashVariant = match[0].startsWith("<<-");
    const marker = match[2];
    out.push(line.slice(0, match.index));
    i += 1;
    while (i < lines.length) {
      const candidate = lines[i].replace(/\r$/, "");
      const terminator = dashVariant ? candidate.replace(/^\t+/, "") : candidate;
      i += 1;
      if (terminator === marker) {
        break;
      }
    }
  }
  return out.join("\n");
}

/**
 * The `git commit` segment of a (heredoc-stripped) compound command (&&, ||,
 * ;, |, or newline separated), or undefined if it contains none.
 */
function findCommitSegment(strippedCommand) {
  return strippedCommand
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => stripLeadingWrappers(segment.trim()))
    .find((segment) => /^git\b/.test(segment) && gitSubcommand(segment.split(/\s+/)) === "commit");
}

/**
 * Whether a shell command string contains a `git commit` invocation, in any
 * segment of a compound command (&&, ||, ;, |, or newline separated),
 * excluding anything inside a heredoc body.
 */
function isGitCommitCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  return findCommitSegment(stripHeredocs(command)) !== undefined;
}

/** Strip one layer of matching surrounding quotes, if present. */
function stripQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

// A directory string containing shell variable/command expansion (`$FOO`,
// `` `cmd` ``) can't be resolved without actually running a shell, which this
// hook deliberately doesn't do — the issue's acceptance criteria call for
// falling back to cwd in that case rather than guessing.
function isResolvableDir(dir) {
  return typeof dir === "string" && dir.length > 0 && !/[$`]/.test(dir);
}

function expandHome(dir) {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return os.homedir() + dir.slice(1);
  return dir;
}

/** The directory named by a compound command's leading `cd <dir>` segment, if any. */
function extractLeadingCdDir(strippedCommand) {
  const [first] = strippedCommand.split(/&&|\|\||[;|\n]/);
  const match = /^cd\s+(.+)$/.exec(first.trim());
  return match ? stripQuotes(match[1]) : undefined;
}

/**
 * Resolve the directory a `git commit` invocation actually targets: a
 * leading `cd <dir>` segment, then the commit invocation's own `-C <dir>`
 * global option(s) applied on top (each `-C` is relative to the previous one,
 * matching git's own semantics). Returns undefined - "fall back to the
 * hook's own cwd" - when the command doesn't redirect at all, or redirects
 * somewhere that can't be resolved safely (unexpandable, or nonexistent on
 * disk).
 */
function resolveCommitCwd(strippedCommand, commitSegment) {
  let dir;

  const leadingCdDir = extractLeadingCdDir(strippedCommand);
  if (leadingCdDir !== undefined) {
    if (!isResolvableDir(leadingCdDir)) {
      return undefined;
    }
    dir = path.resolve(process.cwd(), expandHome(leadingCdDir));
  }

  for (const rawDir of gitGlobalOptionValues(commitSegment.split(/\s+/), "-C")) {
    const dashCDir = stripQuotes(rawDir);
    if (!isResolvableDir(dashCDir)) {
      return undefined;
    }
    dir = path.resolve(dir ?? process.cwd(), expandHome(dashCDir));
  }

  if (dir === undefined) {
    return undefined;
  }
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

function currentBranch(cwd) {
  const options = { encoding: "utf8" };
  if (cwd !== undefined) {
    options.cwd = cwd;
  }
  const result = spawnSync("git", ["branch", "--show-current"], options);
  return (result.stdout || "").trim();
}

function main() {
  let command;
  try {
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    command = payload?.tool_input?.command;
  } catch {
    command = undefined;
  }

  if (typeof command !== "string") {
    process.exit(0);
  }

  const strippedCommand = stripHeredocs(command);
  const commitSegment = findCommitSegment(strippedCommand);
  if (!commitSegment) {
    process.exit(0);
  }

  const targetCwd = resolveCommitCwd(strippedCommand, commitSegment);
  if (currentBranch(targetCwd) !== "main") {
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      systemMessage: "main ブランチ上での git commit をブロックしました。",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "main ブランチに直接コミットしようとしています。作業ブランチを作成してからコミットしてください（例: git checkout -b <branch-name>）。push 自体は GitHub 側の ruleset で防がれていますが、ローカルでの無駄なコミット・手戻りを避けるための安全ガードです。",
      },
    }),
  );
  process.exit(0);
}

module.exports = { isGitCommitCommand };

if (require.main === module) {
  main();
}
