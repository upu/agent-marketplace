"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  compareSemver,
  todayIso,
  normalizeRemoteUrl,
  repoUrlFromGit,
  validate,
  finalizeChangelog,
  bumpPackageJsonVersion,
  bumpPackageLockVersion,
} = require("./prepare-release.js");

const REPO_URL = "https://github.com/upu/ghost-align";

const SAMPLE_CHANGELOG = [
  "# Changelog",
  "",
  "本文.",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- 新機能を追加。",
  "",
  "## [0.7.0] - 2026-07-05",
  "",
  "### Fixed",
  "",
  "- バグを修正。",
  "",
  `[Unreleased]: ${REPO_URL}/compare/v0.7.0...HEAD`,
  `[0.7.0]: ${REPO_URL}/releases/tag/v0.7.0`,
  "",
].join("\n");

const EMPTY_UNRELEASED_CHANGELOG = SAMPLE_CHANGELOG.replace(
  "### Added\n\n- 新機能を追加。\n\n",
  ""
);

const SAMPLE_CHANGELOG_EN = SAMPLE_CHANGELOG.replace("新機能を追加", "Added a feature");

function changelogs(en, ja) {
  return [
    { label: "CHANGELOG.md", text: en },
    { label: "CHANGELOG.ja.md", text: ja },
  ];
}

test("compareSemver: 大小関係を返す", () => {
  assert.ok(compareSemver("0.8.0", "0.7.0") > 0);
  assert.equal(compareSemver("0.7.0", "0.7.0"), 0);
  assert.ok(compareSemver("0.7.0", "0.8.0") < 0);
});

test("todayIso: ローカル日付を YYYY-MM-DD で返す", () => {
  assert.equal(todayIso(new Date(2026, 6, 5)), "2026-07-05");
});

test("normalizeRemoteUrl: HTTPS の .git はそのまま拡張子だけ落とす", () => {
  assert.equal(
    normalizeRemoteUrl("https://github.com/upu/ghost-align.git"),
    "https://github.com/upu/ghost-align"
  );
});

test("normalizeRemoteUrl: SSH 形式（SCP風）を HTTPS に正規化する", () => {
  assert.equal(
    normalizeRemoteUrl("git@github.com:upu/Totonoe-Log.git"),
    "https://github.com/upu/Totonoe-Log"
  );
});

test("normalizeRemoteUrl: ssh:// 形式の URL も HTTPS に正規化する", () => {
  assert.equal(
    normalizeRemoteUrl("ssh://git@github.com/upu/ghost-align.git"),
    REPO_URL
  );
  assert.equal(
    normalizeRemoteUrl("ssh://git@github.com:22/upu/ghost-align.git"),
    REPO_URL
  );
});

test("normalizeRemoteUrl: HTTPS の userinfo（token等）を除去する", () => {
  assert.equal(
    normalizeRemoteUrl("https://ghp_dummyToken123@github.com/upu/ghost-align.git"),
    REPO_URL
  );
  assert.equal(
    normalizeRemoteUrl("https://x-access-token:ghp_dummyToken123@github.com/upu/ghost-align.git"),
    REPO_URL
  );
});

test("repoUrlFromGit: git コマンドの出力を正規化して返す", () => {
  const fakeExec = () => "git@github.com:upu/ghost-align.git\n";
  assert.equal(repoUrlFromGit("/tmp/anything", fakeExec), REPO_URL);
});

test("repoUrlFromGit: git コマンドが失敗したら分かりやすいエラーを投げる", () => {
  const fakeExec = () => {
    throw new Error("not a git repo");
  };
  assert.throws(() => repoUrlFromGit("/tmp/anything", fakeExec), /origin/);
});

test("validate: 不正なバージョン形式はエラー文字列を返す", () => {
  const both = changelogs(SAMPLE_CHANGELOG_EN, SAMPLE_CHANGELOG);
  assert.match(validate("not-a-version", "0.7.0", both) ?? "", /x\.y\.z/);
  assert.match(validate("", "0.7.0", both) ?? "", /x\.y\.z/);
  assert.match(validate("0.8", "0.7.0", both) ?? "", /x\.y\.z/);
});

test("validate: 現行バージョン以下はエラーを返す", () => {
  const both = changelogs(SAMPLE_CHANGELOG_EN, SAMPLE_CHANGELOG);
  assert.ok(validate("0.7.0", "0.7.0", both));
  assert.ok(validate("0.6.0", "0.7.0", both));
});

test("validate: [Unreleased] が空ならファイル名入りのエラーを返す", () => {
  const error = validate(
    "0.8.0",
    "0.7.0",
    changelogs(EMPTY_UNRELEASED_CHANGELOG, SAMPLE_CHANGELOG)
  );
  assert.match(error ?? "", /CHANGELOG\.md/);
});

test("validate: ja 側だけ [Unreleased] が空でもエラーを返す（desync 検出）", () => {
  const error = validate(
    "0.8.0",
    "0.7.0",
    changelogs(SAMPLE_CHANGELOG_EN, EMPTY_UNRELEASED_CHANGELOG)
  );
  assert.match(error ?? "", /CHANGELOG\.ja\.md/);
});

test("validate: 両ファイルにエントリがあれば null を返す", () => {
  assert.equal(
    validate("0.8.0", "0.7.0", changelogs(SAMPLE_CHANGELOG_EN, SAMPLE_CHANGELOG)),
    null
  );
});

test("validate: 見出し（### Added）だけで実エントリが無ければ空扱いでエラーを返す", () => {
  const headingOnly = SAMPLE_CHANGELOG_EN.replace("- Added a feature。\n\n", "");
  const error = validate("0.8.0", "0.7.0", changelogs(headingOnly, SAMPLE_CHANGELOG));
  assert.match(error ?? "", /CHANGELOG\.md/);
});

test("finalizeChangelog: 見出しの確定・空の Unreleased の再挿入・リンク参照の更新", () => {
  const result = finalizeChangelog(SAMPLE_CHANGELOG, "0.8.0", REPO_URL, "2026-07-10");
  const lines = result.split("\n");
  const newUnreleasedIdx = lines.indexOf("## [Unreleased]");

  assert.notEqual(newUnreleasedIdx, -1);
  assert.equal(lines[newUnreleasedIdx + 1], "");
  assert.equal(lines[newUnreleasedIdx + 2], "## [0.8.0] - 2026-07-10");
  assert.ok(result.includes("- 新機能を追加。"));
  assert.ok(result.includes(`[Unreleased]: ${REPO_URL}/compare/v0.8.0...HEAD`));
  assert.ok(result.includes(`[0.8.0]: ${REPO_URL}/releases/tag/v0.8.0`));
  assert.ok(result.includes(`[0.7.0]: ${REPO_URL}/releases/tag/v0.7.0`));
});

test("finalizeChangelog: CRLF の入力は CRLF のまま書き戻す", () => {
  const crlf = SAMPLE_CHANGELOG.replace(/\n/g, "\r\n");
  const result = finalizeChangelog(crlf, "0.8.0", REPO_URL, "2026-07-10");
  const bareLfCount = (result.match(/(?<!\r)\n/g) ?? []).length;
  assert.equal(bareLfCount, 0);
  assert.ok(result.includes("\r\n"));
});

test("finalizeChangelog: 大部分が CRLF で一部だけ LF という混在入力でも見出しを正しく認識する", () => {
  // 実運用で踏んだ壊れ方の再現: ファイル全体は CRLF だが、挿入された一部だけ LF になっている。
  // これを CRLF 前提で split すると見出し行が後続行と結合され、見出しを見失う。
  const crlfBase = SAMPLE_CHANGELOG.replace(/\n/g, "\r\n");
  const mixed = crlfBase.replace(
    "## [Unreleased]\r\n\r\n### Added\r\n\r\n- 新機能を追加。\r\n\r\n",
    "## [Unreleased]\n\n### Added\n\n- 新機能を追加。\n\n"
  );
  const result = finalizeChangelog(mixed, "0.8.0", REPO_URL, "2026-07-10");
  // result はこの入力全体の支配的な改行（CRLF）で結合されるため、行の厳密一致ではなく部分一致で見る。
  assert.ok(result.includes("## [0.8.0] - 2026-07-10"));
  assert.ok(result.includes("- 新機能を追加。"));
});

test("finalizeChangelog: 大部分が LF で一部だけ CRLF が混入していても LF のまま書き戻す（多数派判定）", () => {
  // 逆方向の混在: ベースは LF だが、どこか1行だけ CRLF が紛れ込んだケース。
  // 「CRLF が1つでもあれば全体 CRLF」という判定だと、この1行だけで出力全体が CRLF に化けてしまう。
  const mixed = SAMPLE_CHANGELOG.replace("- 新機能を追加。\n", "- 新機能を追加。\r\n");
  const result = finalizeChangelog(mixed, "0.8.0", REPO_URL, "2026-07-10");
  const crlfCount = (result.match(/\r\n/g) ?? []).length;
  assert.equal(crlfCount, 0);
  assert.ok(result.includes("## [0.8.0] - 2026-07-10"));
});

test("finalizeChangelog: Unreleased 見出しが無ければ例外を投げる", () => {
  assert.throws(() => finalizeChangelog("# Changelog\n", "0.8.0", REPO_URL, "2026-07-10"));
});

test("finalizeChangelog: label 指定時は例外メッセージにそのファイル名が入る", () => {
  assert.throws(
    () => finalizeChangelog("# Changelog\n", "0.8.0", REPO_URL, "2026-07-10", "CHANGELOG.ja.md"),
    /CHANGELOG\.ja\.md/
  );
});

test("finalizeChangelog: ja の本文でも同じ確定処理がそのまま適用できる", () => {
  const result = finalizeChangelog(SAMPLE_CHANGELOG, "0.8.0", REPO_URL, "2026-07-10", "CHANGELOG.ja.md");
  assert.ok(result.includes("## [0.8.0] - 2026-07-10"));
  assert.ok(result.includes("- 新機能を追加。"));
  assert.ok(result.includes(`[Unreleased]: ${REPO_URL}/compare/v0.8.0...HEAD`));
});

test("bumpPackageJsonVersion: version フィールドだけを書き換える", () => {
  const pkg = '{\n  "name": "ghost-align",\n  "version": "0.7.0",\n  "other": "x"\n}\n';
  const result = bumpPackageJsonVersion(pkg, "0.8.0");
  assert.ok(result.includes('"version": "0.8.0"'));
  assert.ok(result.includes('"name": "ghost-align"'));
  assert.ok(result.includes('"other": "x"'));
  assert.equal(JSON.parse(result).version, "0.8.0");
});

test("bumpPackageJsonVersion: version フィールドが無ければ例外を投げる", () => {
  assert.throws(() => bumpPackageJsonVersion('{\n  "name": "x"\n}\n', "0.8.0"));
});

test("bumpPackageLockVersion: lockfileVersion 2 系ではトップレベルと packages[\"\"] の両方を書き換える", () => {
  const lock = [
    "{",
    '  "name": "ghost-align",',
    '  "version": "1.1.0",',
    '  "lockfileVersion": 2,',
    '  "requires": true,',
    '  "packages": {',
    '    "": {',
    '      "name": "ghost-align",',
    '      "version": "1.1.0",',
    '      "license": "MIT",',
    '      "dependencies": {',
    '        "foo": "^1.0.0"',
    "      }",
    "    },",
    '    "node_modules/foo": {',
    '      "version": "1.0.0"',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

  const result = bumpPackageLockVersion(lock, "1.2.0");
  const parsed = JSON.parse(result);
  assert.equal(parsed.version, "1.2.0");
  assert.equal(parsed.packages[""].version, "1.2.0");
  // 依存パッケージ自身のバージョンは対象外
  assert.equal(parsed.packages["node_modules/foo"].version, "1.0.0");
});

test("bumpPackageLockVersion: packages[\"\"] が先頭キーでなくても書き換える（キー順に依存しない）", () => {
  const lock = [
    "{",
    '  "name": "ghost-align",',
    '  "version": "1.1.0",',
    '  "lockfileVersion": 2,',
    '  "requires": true,',
    '  "packages": {',
    '    "node_modules/foo": {',
    '      "version": "1.0.0"',
    "    },",
    '    "": {',
    '      "name": "ghost-align",',
    '      "version": "1.1.0"',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

  const result = bumpPackageLockVersion(lock, "1.2.0");
  const parsed = JSON.parse(result);
  assert.equal(parsed.version, "1.2.0");
  assert.equal(parsed.packages[""].version, "1.2.0");
  assert.equal(parsed.packages["node_modules/foo"].version, "1.0.0");
});

test("bumpPackageLockVersion: packages[\"\"] に version フィールドが無ければ、隣の依存の version を誤爆せず例外を投げる", () => {
  const lock = [
    "{",
    '  "name": "ghost-align",',
    '  "version": "1.1.0",',
    '  "lockfileVersion": 2,',
    '  "requires": true,',
    '  "packages": {',
    '    "": {',
    '      "name": "ghost-align"',
    "    },",
    '    "node_modules/foo": {',
    '      "version": "1.0.0"',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

  assert.throws(() => bumpPackageLockVersion(lock, "1.2.0"), /packages\[""\]\.version/);
});

test("bumpPackageLockVersion: packages はあるが \"\" キーが無ければ例外を投げる（サイレントスキップしない）", () => {
  const lock = [
    "{",
    '  "name": "ghost-align",',
    '  "version": "1.1.0",',
    '  "lockfileVersion": 2,',
    '  "requires": true,',
    '  "packages": {',
    '    "node_modules/foo": {',
    '      "version": "1.0.0"',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

  assert.throws(() => bumpPackageLockVersion(lock, "1.2.0"), /packages\[""\]/);
});

test("bumpPackageLockVersion: lockfileVersion 1 系（packages が無い）ではトップレベルだけ書き換える", () => {
  const lock = [
    "{",
    '  "name": "ghost-align",',
    '  "version": "1.1.0",',
    '  "lockfileVersion": 1,',
    '  "requires": true,',
    '  "dependencies": {',
    '    "foo": {',
    '      "version": "1.0.0"',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");

  const result = bumpPackageLockVersion(lock, "1.2.0");
  const parsed = JSON.parse(result);
  assert.equal(parsed.version, "1.2.0");
  assert.equal(parsed.dependencies.foo.version, "1.0.0");
});

test("bumpPackageLockVersion: トップレベルの version フィールドが無ければ例外を投げる", () => {
  assert.throws(() => bumpPackageLockVersion('{\n  "name": "x"\n}\n', "1.2.0"));
});
