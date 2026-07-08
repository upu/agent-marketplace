// Deterministically finalizes CHANGELOG.md's and CHANGELOG.ja.md's
// [Unreleased] sections into a dated release and bumps package.json's
// version, so the `release` skill only judges SemVer and confirms scope
// instead of hand-editing these files every time. Fails with no writes to
// any of the three files if the version argument is invalid, not newer than
// the current version, or either CHANGELOG's [Unreleased] is empty.
//
// Ported from ghost-align's scripts/prepare-release.js. Unlike the original,
// this copy does not hardcode a repository URL — it derives one from the
// target repo's `git remote origin` at runtime, so it works across repos
// without editing this file.
//
// Usage: node prepare-release.js <x.y.z> [repoRoot]
//   <x.y.z>   target version (no leading "v")
//   [repoRoot] path to the target repo root (defaults to process.cwd())
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const UNRELEASED_HEADING = "## [Unreleased]";

/**
 * Pick the file's dominant line ending by counting CRLF vs. bare-LF
 * occurrences, rather than switching to CRLF the moment a single stray CRLF
 * appears in an otherwise LF file (or vice versa).
 */
function detectEol(text) {
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const bareLfCount = (text.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > bareLfCount ? "\r\n" : "\n";
}

/** Collapse CRLF/CR to LF so line-splitting is correct even if a file has stray mixed newlines. */
function normalizeToLf(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] - pb[i];
    }
  }
  return 0;
}

/** Today's date as YYYY-MM-DD in local time (matches `date +%F`, not UTC). */
function todayIso(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Normalize a `git remote` URL to an `https://host/owner/repo` form, stripping
 * a trailing `.git`, rewriting the SSH forms (the SCP-like `git@host:owner/repo`
 * as well as an explicit `ssh://[user@]host[:port]/owner/repo` URL) to HTTPS,
 * and stripping any embedded userinfo (e.g. `https://<token>@host/...`) so a
 * credential embedded in the origin URL never ends up committed into a
 * CHANGELOG link reference.
 */
function normalizeRemoteUrl(raw) {
  let url = raw.trim().replace(/\.git$/, "");

  const sshUrlMatch = /^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/.exec(url);
  if (sshUrlMatch) {
    return `https://${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  const scpMatch = /^git@([^:]+):(.+)$/.exec(url);
  if (scpMatch) {
    url = `https://${scpMatch[1]}/${scpMatch[2]}`;
  }

  url = url.replace(/^(https?:\/\/)[^@/]+@/, "$1");
  return url;
}

/** The target repo's origin URL, normalized to `https://host/owner/repo`. */
function repoUrlFromGit(cwd, exec = execSync) {
  let raw;
  try {
    raw = exec("git config --get remote.origin.url", { cwd, encoding: "utf8" });
  } catch (err) {
    throw new Error(
      "Could not determine the repository URL from `git config --get remote.origin.url`. Is this a git repository with an `origin` remote?"
    );
  }
  return normalizeRemoteUrl(raw);
}

/** The [Unreleased] section's body lines and whether any are non-blank. */
function findUnreleasedBody(changelogText, label = "CHANGELOG.md") {
  const eol = detectEol(changelogText);
  const lines = normalizeToLf(changelogText).split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === UNRELEASED_HEADING);
  if (startIdx === -1) {
    throw new Error(`Could not find "${UNRELEASED_HEADING}" heading in ${label}`);
  }
  let endIdx = lines.findIndex((l, i) => i > startIdx && /^## \[/.test(l));
  if (endIdx === -1) {
    endIdx = lines.length;
  }
  const body = lines.slice(startIdx + 1, endIdx);
  // A bare subheading (e.g. "### Added" with nothing under it) is not a real
  // entry, so it must not count toward hasEntries.
  const hasEntries = body.some((l) => {
    const trimmed = l.trim();
    return trimmed.length > 0 && !/^#{1,6}\s/.test(trimmed);
  });
  return { lines, eol, startIdx, hasEntries };
}

/**
 * Validate a release request against the current version and the state of
 * every CHANGELOG file (`changelogs` is an array of `{ label, text }`).
 * Each file must have a non-empty [Unreleased] section, so an entry added to
 * only one language is caught here. Returns an error message, or null when
 * the request is valid.
 */
function validate(version, currentVersion, changelogs) {
  if (!version || !SEMVER_RE.test(version)) {
    return `Version must be in x.y.z form (got: ${version || "(none)"})`;
  }
  if (compareSemver(version, currentVersion) <= 0) {
    return `${version} is not greater than the current version ${currentVersion}`;
  }
  for (const { label, text } of changelogs) {
    let unreleased;
    try {
      unreleased = findUnreleasedBody(text, label);
    } catch (err) {
      return err.message;
    }
    if (!unreleased.hasEntries) {
      return `The [Unreleased] section in ${label} has no entries; nothing to release`;
    }
  }
  return null;
}

/**
 * Rename `[Unreleased]` to `[version] - date`, reinsert a fresh empty
 * `[Unreleased]` above it, and update the link references at the bottom
 * (repoint `[Unreleased]` to the new compare URL, add a `[version]` link).
 */
function finalizeChangelog(changelogText, version, repoUrl, date = todayIso(), label = "CHANGELOG.md") {
  const { lines, eol, startIdx } = findUnreleasedBody(changelogText, label);
  const withHeading = [
    ...lines.slice(0, startIdx),
    UNRELEASED_HEADING,
    "",
    `## [${version}] - ${date}`,
    ...lines.slice(startIdx + 1),
  ];

  const linkRefRe = /^\[([^\]]+)\]:\s*(\S+)$/;
  const unreleasedLinkIdx = withHeading.findIndex((l) => {
    const m = linkRefRe.exec(l);
    return m !== null && m[1] === "Unreleased";
  });
  if (unreleasedLinkIdx === -1) {
    throw new Error(`Could not find the "[Unreleased]: ..." link reference at the bottom of ${label}`);
  }
  withHeading[unreleasedLinkIdx] = `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`;
  withHeading.splice(unreleasedLinkIdx + 1, 0, `[${version}]: ${repoUrl}/releases/tag/v${version}`);

  return withHeading.join(eol);
}

/** Replace only the `"version"` field's value, preserving all other formatting. */
function bumpPackageJsonVersion(packageJsonText, version) {
  const versionFieldRe = /^(\s*"version":\s*")[^"]*(")/m;
  if (!versionFieldRe.test(packageJsonText)) {
    throw new Error('Could not find a "version" field in package.json');
  }
  return packageJsonText.replace(versionFieldRe, `$1${version}$2`);
}

/**
 * Find the index of the closing brace/bracket matching the opening one at
 * `openIdx`, tracking JSON string literals (and backslash escapes within
 * them) so braces that appear inside string values don't throw off the
 * depth count.
 */
function findMatchingBracket(text, openIdx) {
  const open = text[openIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Find where an object key `key` (given unescaped, e.g. `packages` or the
 * empty string) opens an object value (`{`) within `text[fromIdx, toIdx)`.
 * Scans the raw JSON text char-by-char, consuming whole string literals
 * (honoring backslash escapes) as a unit rather than testing substrings
 * against a regex — so `key` only matches an actual key position, never
 * text that happens to appear inside an unrelated string value, and a
 * candidate is confirmed only once it's followed by `:` and `{` (skipping
 * insignificant whitespace). Returns the index of that `{`, or -1.
 */
function findObjectKeyBraceIndex(text, key, fromIdx = 0, toIdx = text.length) {
  const quoted = `"${key}"`;
  let i = fromIdx;
  while (i < toIdx) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    const literalStart = i;
    i++;
    while (i < toIdx) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        i++;
        break;
      }
      i++;
    }
    if (text.slice(literalStart, i) === quoted) {
      let j = i;
      while (j < toIdx && /\s/.test(text[j])) j++;
      if (text[j] === ":") {
        j++;
        while (j < toIdx && /\s/.test(text[j])) j++;
        if (text[j] === "{") {
          return j;
        }
      }
    }
  }
  return -1;
}

/**
 * Sync package-lock.json's version fields to a newly bumped package.json
 * version, without invoking npm (so it works even without node_modules
 * installed). Rewrites only the two fields that go stale, preserving all
 * other formatting:
 *  - the top-level `"version"` (the file's first "version" field, since it
 *    precedes "packages"/"dependencies" in npm's key order — this holds for
 *    both pretty-printed and minified/single-line lockfiles, so the regex
 *    isn't anchored to line starts)
 *  - `packages[""].version`, present in lockfileVersion >= 2 lockfiles
 *    (lockfileVersion 1 has no "packages" object, so that half is a no-op)
 *
 * `packages[""]` is located by first finding the top-level "packages" key
 * (via `findObjectKeyBraceIndex`, not by assuming it's the first entry
 * under "packages" — key order isn't a JSON guarantee even though npm
 * always emits it first in practice), then searching only within that
 * object's brace-matched span for the `""` key — so a stray `"": {`
 * elsewhere in the file (or embedded in a string value) can't be mistaken
 * for the root package entry. Each object's span is found via brace
 * matching, not a regex spanning to the first "version" text, so a root
 * entry without its own "version" field can't cause the replacement to
 * overrun into a sibling package's fields. If `packages[""]` exists per a
 * real JSON parse but can't be located/updated in the text, this throws
 * rather than silently leaving the two files out of sync.
 */
function bumpPackageLockVersion(packageLockText, version) {
  const topLevelVersionRe = /("version"\s*:\s*")[^"]*(")/;
  if (!topLevelVersionRe.test(packageLockText)) {
    throw new Error('Could not find a top-level "version" field in package-lock.json');
  }
  let result = packageLockText.replace(topLevelVersionRe, `$1${version}$2`);

  const parsed = JSON.parse(packageLockText);
  if (parsed.packages) {
    if (!Object.prototype.hasOwnProperty.call(parsed.packages, "")) {
      throw new Error('Could not find packages[""] in package-lock.json to sync its version');
    }

    const packagesOpenIdx = findObjectKeyBraceIndex(result, "packages");
    const packagesCloseIdx =
      packagesOpenIdx === -1 ? -1 : findMatchingBracket(result, packagesOpenIdx);
    const rootOpenIdx =
      packagesCloseIdx === -1
        ? -1
        : findObjectKeyBraceIndex(result, "", packagesOpenIdx, packagesCloseIdx);
    const rootCloseIdx = rootOpenIdx === -1 ? -1 : findMatchingBracket(result, rootOpenIdx);
    if (rootOpenIdx === -1 || rootCloseIdx === -1) {
      throw new Error('Could not find packages[""] in package-lock.json to sync its version');
    }

    const rootObjectText = result.slice(rootOpenIdx, rootCloseIdx + 1);
    const versionFieldRe = /("version"\s*:\s*")[^"]*(")/;
    if (!versionFieldRe.test(rootObjectText)) {
      throw new Error('Could not find packages[""].version in package-lock.json to sync');
    }
    const newRootObjectText = rootObjectText.replace(versionFieldRe, `$1${version}$2`);
    result = result.slice(0, rootOpenIdx) + newRootObjectText + result.slice(rootCloseIdx + 1);
  }

  return result;
}

function main() {
  const version = process.argv[2];
  const root = path.resolve(process.argv[3] || process.cwd());
  const packageJsonPath = path.join(root, "package.json");
  const packageLockPath = path.join(root, "package-lock.json");
  const changelogLabels = ["CHANGELOG.md", "CHANGELOG.ja.md"];

  const packageJsonText = fs.readFileSync(packageJsonPath, "utf8");
  const currentVersion = JSON.parse(packageJsonText).version;
  const packageLockText = fs.existsSync(packageLockPath)
    ? fs.readFileSync(packageLockPath, "utf8")
    : null;
  const changelogs = changelogLabels.map((label) => ({
    label,
    path: path.join(root, label),
    text: fs.readFileSync(path.join(root, label), "utf8"),
  }));

  const error = validate(version, currentVersion, changelogs);
  if (error) {
    console.error(`::error::${error}`);
    process.exit(1);
  }

  let repoUrl;
  try {
    repoUrl = repoUrlFromGit(root);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  // Compute every new file content before writing any, so a failure in any
  // transform leaves all files untouched.
  const date = todayIso();
  let newChangelogs;
  let newPackageJson;
  let newPackageLock = null;
  try {
    newChangelogs = changelogs.map((c) => finalizeChangelog(c.text, version, repoUrl, date, c.label));
    newPackageJson = bumpPackageJsonVersion(packageJsonText, version);
    if (packageLockText !== null) {
      newPackageLock = bumpPackageLockVersion(packageLockText, version);
    }
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  changelogs.forEach((c, i) => fs.writeFileSync(c.path, newChangelogs[i]));
  fs.writeFileSync(packageJsonPath, newPackageJson);
  if (newPackageLock !== null) {
    fs.writeFileSync(packageLockPath, newPackageLock);
  }
  console.log(
    `Prepared release ${version} (from ${currentVersion}): ${changelogLabels.join(" and ")} finalized, package.json bumped${
      newPackageLock !== null ? ", package-lock.json synced" : ""
    }.`
  );
}

module.exports = {
  compareSemver,
  todayIso,
  normalizeRemoteUrl,
  repoUrlFromGit,
  validate,
  finalizeChangelog,
  bumpPackageJsonVersion,
  bumpPackageLockVersion,
};

if (require.main === module) {
  main();
}
