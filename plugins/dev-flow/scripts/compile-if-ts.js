// PostToolUse hook command: run `npm run compile` only when the edited file
// can affect TypeScript compilation. The hook matcher can only match on tool
// names, so the file-path filtering lives here: the harness passes the tool
// payload as JSON on stdin, and edits to docs/skills/config exit immediately
// instead of paying for a full tsc run.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * Whether an edited file warrants a tsc run. Only a file path that clearly
 * is not TypeScript skips the compile — a missing or malformed path
 * compiles anyway, so a payload-format change can never silently disable
 * the hook.
 */
function shouldCompile(filePath) {
  if (typeof filePath !== "string") {
    return true;
  }
  return /\.ts$/i.test(filePath.trim()) || filePath.trim() === "";
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
  const result = spawnSync("npm", ["run", "compile"], {
    stdio: "inherit",
    shell: true,
  });
  process.exit(result.status ?? 1);
}

module.exports = { shouldCompile, hasCompileScript };

if (require.main === module) {
  main();
}
