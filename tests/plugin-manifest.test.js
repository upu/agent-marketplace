"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Validate marketplace.json: valid JSON, and every `plugins[].source` resolves to an existing directory relative to `root`. */
function validateMarketplace(raw, root) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return [`marketplace.json is not valid JSON: ${err.message}`];
  }
  const violations = [];
  const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
  for (const plugin of plugins) {
    if (!plugin.source) {
      violations.push(`plugin "${plugin.name || "?"}" has no "source" field`);
      continue;
    }
    const sourcePath = path.join(root, plugin.source);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      violations.push(`plugin "${plugin.name || "?"}"'s source "${plugin.source}" does not exist`);
    }
  }
  return violations;
}

/** Validate a plugin.json: valid JSON, has "name" + SemVer "version". Returns violations and the parsed version (or null). */
function validatePluginJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { violations: [`plugin.json is not valid JSON: ${err.message}`], version: null };
  }
  const violations = [];
  if (!parsed.name) {
    violations.push('plugin.json is missing a "name" field');
  }
  if (!parsed.version) {
    violations.push('plugin.json is missing a "version" field');
  } else if (!SEMVER_RE.test(parsed.version)) {
    violations.push(`plugin.json's "version" is not SemVer x.y.z (got: ${parsed.version})`);
  }
  return { violations, version: parsed.version || null };
}

/** Violations where a Codex plugin.json's name/version differ from its Claude counterpart. */
function pluginManifestSyncViolations(claudeRaw, codexRaw) {
  let claude;
  let codex;
  try {
    claude = JSON.parse(claudeRaw);
  } catch (err) {
    return [`Claude plugin.json is not valid JSON: ${err.message}`];
  }
  try {
    codex = JSON.parse(codexRaw);
  } catch (err) {
    return [`Codex plugin.json is not valid JSON: ${err.message}`];
  }
  const violations = [];
  if (claude.name !== codex.name) {
    violations.push(`"name" differs (Claude: ${claude.name}, Codex: ${codex.name})`);
  }
  if (claude.version !== codex.version) {
    violations.push(`"version" differs (Claude: ${claude.version}, Codex: ${codex.version})`);
  }
  return violations;
}

/** Violations where two marketplace.json files list different plugins (name/source pairs, in order). */
function marketplaceSyncViolations(claudeRaw, codexRaw) {
  let claude;
  let codex;
  try {
    claude = JSON.parse(claudeRaw);
  } catch (err) {
    return [`Claude marketplace.json is not valid JSON: ${err.message}`];
  }
  try {
    codex = JSON.parse(codexRaw);
  } catch (err) {
    return [`Codex marketplace.json is not valid JSON: ${err.message}`];
  }
  const pluginList = (parsed) =>
    JSON.stringify((Array.isArray(parsed.plugins) ? parsed.plugins : []).map((p) => ({ name: p.name, source: p.source })));
  const claudeList = pluginList(claude);
  const codexList = pluginList(codex);
  if (claudeList !== codexList) {
    return [`plugin lists differ (Claude: ${claudeList}, Codex: ${codexList})`];
  }
  return [];
}

/** Whether CHANGELOG's [Unreleased] section (up to the next "## [" heading) has any real entries. */
function isUnreleasedEmpty(changelogText) {
  const lines = changelogText.replace(/\r\n/g, "\n").split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === "## [Unreleased]");
  if (startIdx === -1) {
    return true;
  }
  let endIdx = lines.findIndex((l, i) => i > startIdx && /^## \[/.test(l));
  if (endIdx === -1) {
    endIdx = lines.length;
  }
  const body = lines.slice(startIdx + 1, endIdx);
  return !body.some((l) => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !/^#{1,6}\s/.test(trimmed);
  });
}

/** The most recently released version, from CHANGELOG's first "## [x.y.z] - date" heading, or null if none exists yet. */
function latestReleasedVersion(changelogText) {
  const lines = changelogText.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const m = /^## \[(\d+\.\d+\.\d+)\]/.exec(line.trim());
    if (m) {
      return m[1];
    }
  }
  return null;
}

test("validateMarketplace passes when every plugin source directory exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
  try {
    fs.mkdirSync(path.join(root, "plugins", "foo"), { recursive: true });
    const raw = JSON.stringify({ plugins: [{ name: "foo", source: "./plugins/foo" }] });
    assert.deepEqual(validateMarketplace(raw, root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateMarketplace flags a source path that does not exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
  try {
    const raw = JSON.stringify({ plugins: [{ name: "foo", source: "./plugins/missing" }] });
    const violations = validateMarketplace(raw, root);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /does not exist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateMarketplace flags invalid JSON", () => {
  const violations = validateMarketplace("{ not json", os.tmpdir());
  assert.equal(violations.length, 1);
  assert.match(violations[0], /not valid JSON/);
});

test("validatePluginJson passes a well-formed manifest", () => {
  const result = validatePluginJson(JSON.stringify({ name: "dev-flow", version: "0.1.0" }));
  assert.deepEqual(result.violations, []);
  assert.equal(result.version, "0.1.0");
});

test("validatePluginJson flags a missing version field", () => {
  const result = validatePluginJson(JSON.stringify({ name: "dev-flow" }));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /missing a "version"/);
});

test("validatePluginJson flags a non-SemVer version", () => {
  const result = validatePluginJson(JSON.stringify({ name: "dev-flow", version: "v1" }));
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /not SemVer/);
});

test("validatePluginJson flags invalid JSON", () => {
  const result = validatePluginJson("{ not json");
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /not valid JSON/);
});

test("pluginManifestSyncViolations passes when name and version match", () => {
  const claude = JSON.stringify({ name: "dev-flow", version: "0.4.0" });
  const codex = JSON.stringify({ name: "dev-flow", version: "0.4.0" });
  assert.deepEqual(pluginManifestSyncViolations(claude, codex), []);
});

test("pluginManifestSyncViolations flags a version mismatch", () => {
  const claude = JSON.stringify({ name: "dev-flow", version: "0.4.0" });
  const codex = JSON.stringify({ name: "dev-flow", version: "0.3.0" });
  const violations = pluginManifestSyncViolations(claude, codex);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /"version" differs/);
});

test("pluginManifestSyncViolations flags a name mismatch", () => {
  const claude = JSON.stringify({ name: "dev-flow", version: "0.4.0" });
  const codex = JSON.stringify({ name: "dev-flo", version: "0.4.0" });
  const violations = pluginManifestSyncViolations(claude, codex);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /"name" differs/);
});

test("pluginManifestSyncViolations flags invalid JSON on either side", () => {
  const valid = JSON.stringify({ name: "dev-flow", version: "0.4.0" });
  assert.match(pluginManifestSyncViolations("{ not json", valid)[0], /Claude plugin\.json is not valid JSON/);
  assert.match(pluginManifestSyncViolations(valid, "{ not json")[0], /Codex plugin\.json is not valid JSON/);
});

test("marketplaceSyncViolations passes when both list the same plugins", () => {
  const claude = JSON.stringify({ name: "a", plugins: [{ name: "foo", source: "./plugins/foo" }] });
  const codex = JSON.stringify({ name: "b", plugins: [{ name: "foo", source: "./plugins/foo" }] });
  assert.deepEqual(marketplaceSyncViolations(claude, codex), []);
});

test("marketplaceSyncViolations flags differing plugin lists", () => {
  const claude = JSON.stringify({ plugins: [{ name: "foo", source: "./plugins/foo" }] });
  const codex = JSON.stringify({ plugins: [{ name: "foo", source: "./plugins/bar" }] });
  const violations = marketplaceSyncViolations(claude, codex);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /plugin lists differ/);
});

test("marketplaceSyncViolations flags invalid JSON on either side", () => {
  const valid = JSON.stringify({ plugins: [] });
  assert.match(marketplaceSyncViolations("{ not json", valid)[0], /Claude marketplace\.json is not valid JSON/);
  assert.match(marketplaceSyncViolations(valid, "{ not json")[0], /Codex marketplace\.json is not valid JSON/);
});

test("isUnreleasedEmpty is true when [Unreleased] has no entries", () => {
  assert.equal(isUnreleasedEmpty("## [Unreleased]\n\n## [0.1.0] - 2026-07-11\n"), true);
});

test("isUnreleasedEmpty is false when [Unreleased] has entries", () => {
  assert.equal(
    isUnreleasedEmpty("## [Unreleased]\n\n### Added\n\n- something\n\n## [0.1.0] - 2026-07-11\n"),
    false
  );
});

test("latestReleasedVersion finds the first ## [x.y.z] heading", () => {
  assert.equal(
    latestReleasedVersion("## [Unreleased]\n\n## [0.2.0] - 2026-08-01\n\n## [0.1.0] - 2026-07-11\n"),
    "0.2.0"
  );
});

test("latestReleasedVersion returns null when there is no released version yet", () => {
  assert.equal(latestReleasedVersion("## [Unreleased]\n"), null);
});

test("marketplace.json in this repository is valid and every plugin source exists", () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8");
  assert.deepEqual(validateMarketplace(raw, REPO_ROOT), []);
});

test("Codex marketplace.json exists, is valid, and lists the same plugins as the Claude one", () => {
  const codexRaw = fs.readFileSync(path.join(REPO_ROOT, ".agents", "plugins", "marketplace.json"), "utf8");
  assert.deepEqual(validateMarketplace(codexRaw, REPO_ROOT), []);

  const claudeRaw = fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8");
  assert.deepEqual(marketplaceSyncViolations(claudeRaw, codexRaw), []);
});

for (const pluginName of ["dev-flow", "vscode-ext"]) {
  test(`${pluginName}'s Codex plugin.json exists, is valid, and is in sync with the Claude one`, () => {
    const codexRaw = fs.readFileSync(
      path.join(REPO_ROOT, "plugins", pluginName, ".codex-plugin", "plugin.json"),
      "utf8"
    );
    assert.deepEqual(validatePluginJson(codexRaw).violations, []);

    const claudeRaw = fs.readFileSync(
      path.join(REPO_ROOT, "plugins", pluginName, ".claude-plugin", "plugin.json"),
      "utf8"
    );
    assert.deepEqual(pluginManifestSyncViolations(claudeRaw, codexRaw), []);
  });
}

test("dev-flow's plugin.json is valid and its version is in sync with CHANGELOG.md", () => {
  const pluginJsonPath = path.join(REPO_ROOT, "plugins", "dev-flow", ".claude-plugin", "plugin.json");
  const raw = fs.readFileSync(pluginJsonPath, "utf8");
  const { violations, version } = validatePluginJson(raw);
  assert.deepEqual(violations, []);

  const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  if (isUnreleasedEmpty(changelog)) {
    assert.equal(version, latestReleasedVersion(changelog));
  }
});
