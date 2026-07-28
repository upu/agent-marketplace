// PostToolUse hook command: run `npm run compile` only when the edited file
// can affect TypeScript compilation. The hook matcher can only match on tool
// names, so the file-path filtering lives here: the harness passes the tool
// payload as JSON on stdin, and edits to docs/skills/config exit immediately
// instead of paying for a full tsc run.
//
// A failing compile is reported as advice (exit 0 plus `additionalContext`),
// not as an error. `ship` writes tests before the implementation exists, and
// `npm run compile` type-checks the whole project including those tests, so
// during that phase every edit — implementation files included — fails by
// design; blocking there buries real mistakes in expected noise. Enforcement
// stays with the skill's own gate (the CI command sequence, run locally) and
// with CI itself, leaving this hook to surface the diagnostics early.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Extensions TypeScript projects commonly compile: plain/JSX sources and the
// dual ESM/CJS module variants. `package.json` is deliberately excluded per
// issue #99's design memo (option 1) — it never changes compile *output* by
// itself, only npm scripts/deps, so including it would just add noise.
const COMPILE_RELEVANT_EXTENSIONS = /\.(ts|tsx|mts|cts)$/i;

/**
 * Last path segment, treating both `/` and `\` as separators regardless of
 * the OS this hook happens to run on. `path.basename` alone only recognizes
 * `\` on Windows, but the harness can hand this hook a Windows-style path
 * (e.g. from a payload captured on a Windows machine) while the hook itself
 * — and this repo's CI — runs on Linux, so a POSIX-only split would silently
 * treat the whole Windows path as a single (non-matching) file name.
 */
function basename(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return path.posix.basename(normalized);
}

/**
 * Whether `base` (a bare file name, no directory) is a tsconfig variant —
 * `tsconfig.json` or `tsconfig.<anything>.json` (e.g. `tsconfig.build.json`).
 * Written as prefix/suffix checks rather than a single regex so the allowlist
 * stays easy to read and can't accidentally match unrelated files that merely
 * contain "tsconfig" (e.g. `notatsconfig.json`).
 */
function isTsconfigFile(base) {
  const lower = base.toLowerCase();
  return lower === "tsconfig.json" || (lower.startsWith("tsconfig.") && lower.endsWith(".json"));
}

/**
 * Whether an edited file warrants a tsc run. A missing or malformed path
 * compiles anyway, so a payload-format change can never silently disable the
 * hook. Everything else is judged against an explicit allowlist (issue #99
 * design memo option 1) rather than excluding known-irrelevant files, so an
 * extension this hook doesn't yet know about fails safe by skipping — same
 * as before this change — instead of unexpectedly starting to compile.
 */
function shouldCompile(filePath) {
  if (typeof filePath !== "string") {
    return true;
  }
  const trimmed = filePath.trim();
  if (trimmed === "") {
    return true;
  }
  return COMPILE_RELEVANT_EXTENSIONS.test(trimmed) || isTsconfigFile(basename(trimmed));
}

/**
 * Whether `cwd` is an npm project with a `compile` script — the only case
 * this hook has anything to run. This plugin is distributed to repositories
 * that aren't npm/TypeScript projects at all, so a missing `package.json` or
 * `scripts.compile` must be a silent no-op rather than a spawn failure.
 */
function hasCompileScript(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return false;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof pkg?.scripts?.compile === "string";
  } catch {
    return false;
  }
}

/**
 * How much of the compile output to pass along. tsc can emit hundreds of
 * diagnostics from one missing export, and the whole point of this hook is to
 * be cheap — the leading errors are the ones worth reading, and the full list
 * is one `npm run compile` away.
 */
const ADVISORY_OUTPUT_MAX_CHARS = 4000;

/**
 * The hook's stdout payload for a failed compile. `additionalContext` reaches
 * the agent without the failure being framed as an error, so an expected
 * red — tests written ahead of the implementation — reads as such instead of
 * demanding a fix.
 */
function buildAdvisoryOutput(compileOutput) {
  const trimmed = String(compileOutput ?? "").trim();
  let body;
  if (trimmed === "") {
    body = "(コンパイル出力なし)";
  } else if (trimmed.length > ADVISORY_OUTPUT_MAX_CHARS) {
    body = `${trimmed.slice(0, ADVISORY_OUTPUT_MAX_CHARS)}\n…（以降を省略。全体は npm run compile で確認できます）`;
  } else {
    body = trimmed;
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [
        "npm run compile が失敗しました（助言。この編集自体は適用済みです）。",
        "テストを先に書いた直後など、実装がまだ無いために失敗しているだけなら想定どおりなので、",
        "そのまま実装を進めてください。それ以外の失敗はこの場で直すのが安上がりです。",
        "",
        body,
      ].join("\n"),
    },
  };
}

function main() {
  let filePath;
  try {
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    filePath = payload?.tool_input?.file_path;
  } catch {
    filePath = undefined;
  }

  if (!shouldCompile(filePath)) {
    process.exit(0);
  }
  if (!hasCompileScript(process.cwd())) {
    process.exit(0);
  }
  // 出力は inherit せずキャプチャする。inherit のままだと tsc の診断が
  // フックの報告に載らず、「失敗した」ことしか伝わらない。
  const result = spawnSync("npm", ["run", "compile"], {
    encoding: "utf8",
    shell: true,
  });
  if ((result.status ?? 1) === 0) {
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify(buildAdvisoryOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`))
  );
  process.exit(0);
}

module.exports = {
  shouldCompile,
  hasCompileScript,
  buildAdvisoryOutput,
  ADVISORY_OUTPUT_MAX_CHARS,
};

if (require.main === module) {
  main();
}
