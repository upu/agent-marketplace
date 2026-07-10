"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const PLUGIN_ROOT_PATH_RE = /\$\{CLAUDE_PLUGIN_ROOT\}(\/[\w./-]+\.js)/g;

function listDirs(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** SKILL.md paths under plugins/<plugin>/skills/<skill>/ in `root` (mirrors skill-size-budget.test.js's collectSkillFiles). */
function collectSkillFiles(root) {
  const files = [];
  const pluginsDir = path.join(root, "plugins");
  for (const plugin of listDirs(pluginsDir)) {
    const skillsDir = path.join(pluginsDir, plugin, "skills");
    for (const skill of listDirs(skillsDir)) {
      const skillMd = path.join(skillsDir, skill, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        files.push(skillMd);
      }
    }
  }
  return files;
}

/** `${CLAUDE_PLUGIN_ROOT}/...\.js` path references in `body`, as plugin-root-relative paths (e.g. "scripts/wait-ci.js"). */
function extractPluginRootPaths(body) {
  const paths = [];
  let m;
  PLUGIN_ROOT_PATH_RE.lastIndex = 0;
  while ((m = PLUGIN_ROOT_PATH_RE.exec(body)) !== null) {
    paths.push(m[1].replace(/^\//, ""));
  }
  return paths;
}

/**
 * Violations for one SKILL.md: a `${CLAUDE_PLUGIN_ROOT}/...` script path that doesn't
 * resolve under its plugin root, or a `reference.md` mention with no such file next to it.
 */
function checkLinks(skillMdPath, body, repoRoot = REPO_ROOT) {
  const violations = [];
  const pluginRoot = path.dirname(path.dirname(path.dirname(skillMdPath)));
  for (const relPath of extractPluginRootPaths(body)) {
    const absPath = path.join(pluginRoot, relPath);
    if (!fs.existsSync(absPath)) {
      violations.push(
        `references \${CLAUDE_PLUGIN_ROOT}/${relPath}, which does not exist under ${path.relative(repoRoot, pluginRoot)}`
      );
    }
  }
  if (/reference\.md/.test(body)) {
    const referenceMdPath = path.join(path.dirname(skillMdPath), "reference.md");
    if (!fs.existsSync(referenceMdPath)) {
      violations.push(`mentions reference.md, but ${path.relative(repoRoot, referenceMdPath)} does not exist`);
    }
  }
  return violations;
}

test("extractPluginRootPaths finds every ${CLAUDE_PLUGIN_ROOT}/...\\.js reference", () => {
  const body = 'run `node "${CLAUDE_PLUGIN_ROOT}/scripts/a.js"` then `node "${CLAUDE_PLUGIN_ROOT}/skills/x/scripts/b.js"`';
  assert.deepEqual(extractPluginRootPaths(body), ["scripts/a.js", "skills/x/scripts/b.js"]);
});

test("extractPluginRootPaths returns an empty array when there is no such reference", () => {
  assert.deepEqual(extractPluginRootPaths("no script paths here"), []);
});

test("checkLinks passes when the script path and reference.md both exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-links-"));
  try {
    const skillDir = path.join(root, "plugins", "p", "skills", "s");
    fs.mkdirSync(path.join(root, "plugins", "p", "scripts"), { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(root, "plugins", "p", "scripts", "a.js"), "");
    fs.writeFileSync(path.join(skillDir, "reference.md"), "");
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const body = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/a.js" and see [reference.md](reference.md)';
    assert.deepEqual(checkLinks(skillMdPath, body, root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkLinks flags a ${CLAUDE_PLUGIN_ROOT} script path that does not exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-links-"));
  try {
    const skillDir = path.join(root, "plugins", "p", "skills", "s");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const body = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/missing.js"';
    const violations = checkLinks(skillMdPath, body, root);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /scripts\/missing\.js.*does not exist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkLinks flags a reference.md mention with no reference.md file alongside it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-links-"));
  try {
    const skillDir = path.join(root, "plugins", "p", "skills", "s");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const body = "see [reference.md](reference.md) for the why";
    const violations = checkLinks(skillMdPath, body, root);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /mentions reference\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkLinks does not flag a SKILL.md that never mentions reference.md and has no script paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-links-"));
  try {
    const skillDir = path.join(root, "plugins", "p", "skills", "s");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, "SKILL.md");
    assert.deepEqual(checkLinks(skillMdPath, "plain body with no links", root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every SKILL.md in this repository has valid script paths and reference.md links", () => {
  const files = collectSkillFiles(REPO_ROOT);
  assert.ok(files.length > 0, "plugins/*/skills/*/SKILL.md が1件も見つかりません");
  for (const file of files) {
    const violations = checkLinks(file, fs.readFileSync(file, "utf8"));
    assert.deepEqual(violations, [], `${path.relative(REPO_ROOT, file)}: ${violations.join(" / ")}`);
  }
});
