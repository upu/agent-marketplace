---
name: repo-release
description: "このリポジトリ（agent-marketplace）自身をリリースする——CHANGELOG確定・plugin.jsonのversion bump・PR〜マージまで。タグ作成/GitHub Release作成/マイルストーンクローズはマージ後にrelease.ymlが自動で行う。 when use: このリポジトリをリリースして、agent-marketplaceをリリース"
argument-hint: "[対象バージョン x.y.z（省略時はオープンなマイルストーンから推定）]"
---

# このリポジトリをリリースする

`agent-marketplace` 自身のバージョン（`plugins/dev-flow/.claude-plugin/plugin.json` の `version`）をリリースする。`dev-flow` が配布する `release` スキルは `package.json` の存在を前提にしており、このリポジトリには使えない——このスキルはそれに代わる、このリポジトリ専用の手順。タグ作成・GitHub Release作成・マイルストーンクローズは、このスキルがマージするPRをトリガーに `.github/workflows/release.yml`（`scripts/release-tag.js`）が自動で行う。このスキルの責務はそこまでの準備（CHANGELOG確定・version bump・PRマージ）に限る。背景は[reference.md](reference.md)参照。

`$ARGUMENTS` は対象バージョン（`x.y.z`、`v`なし）。省略時はオープンなマイルストーン（`gh api repos/:owner/:repo/milestones?state=open --jq '.[].title'`）のタイトルから推定し、ユーザーに確認する。

## 手順

1. **対象バージョンを確定する** — `$ARGUMENTS` があればSemVer形式（`x.y.z`）であることを確認する。マイルストーン `vX.Y.Z` が存在し、全issueクローズ済み（進捗100%）であることを確認する——未達なら理由を報告し、続行可否をユーザーに確認する。
2. **事前確認** — `git status` で作業ツリーがクリーンであることを確認し `git fetch origin`。`CHANGELOG.md` と `CHANGELOG.ja.md` の `[Unreleased]` を読み、両方にエントリがあることを確認する——片方だけ空なら先にdesyncを解消する。
3. **最新mainからブランチを作成する** — `git checkout main && git pull` → `git checkout -b release/vX.Y.Z`。
4. **CHANGELOG確定 + version bump** — `CHANGELOG.md`・`CHANGELOG.ja.md` の `## [Unreleased]` 見出しの直後に `## [X.Y.Z] - <今日の日付>` 見出しを追加し（`[Unreleased]` 見出し自体は空のまま残す）、末尾のリンク参照を更新する（`[Unreleased]: .../compare/vX.Y.Z...HEAD`、新規 `[X.Y.Z]: .../releases/tag/vX.Y.Z`）。`plugins/dev-flow/.claude-plugin/plugin.json` の `version` を `X.Y.Z` に書き換える。手動編集でよい（このリポジトリには `prepare-release.js` が使える `package.json` が無い）。
5. **テスト（ゲート）** — `node --test` を実行し全green確認する（`tests/plugin-manifest.test.js` がversion/CHANGELOGの整合性も検証する）。
6. **コミット・PR** — 意図した差分のみをステージし、`release: vX.Y.Z` のようなコミットメッセージでコミットする。`git push -u origin release/vX.Y.Z` → `gh pr create --base main`。
7. **CIを待つ** — `gh pr checks <pr> --watch --fail-fast`（このリポジトリ専用スキルなので `dev-flow` の `${CLAUDE_PLUGIN_ROOT}` スクリプトは使わず直接呼ぶ）。赤があれば修正して再push。
8. **Copilotレビュー** — `gh pr view <pr> --json reviewRequests,reviews` を確認する。要求されていれば内容を読んでから進む（このリポジトリでは通常設定されていない）。
9. **マージする** — `gh pr merge <pr> --squash --delete-branch` → `git checkout main && git pull`。このマージが `release.yml` のトリガーとなる。
10. **リリース結果を確認する** — `gh run list --workflow=release.yml -L 1` で起動したrunを取得し、`gh run watch <run-id> --exit-status` で完了を待つ。ログの `RELEASED:` / `SKIP:` / `MILESTONE_CLOSED:` / `MILESTONE_NOT_FOUND:` / `::warning::MILESTONE_OPEN:` を確認する。
11. **報告する** — マージ済みPR番号、作成された `vX.Y.Z` タグ・GitHub Releaseへのリンク、マイルストーンのクローズ有無を述べる。

## 補足

- 対象は `plugins/dev-flow/.claude-plugin/plugin.json` の `version` のみ。他リポジトリ（npm/VSCode拡張などpackage.jsonを持つプロジェクト）のリリースは `dev-flow` の `release` スキルを使う。
- `main` への直接pushはしない。必ずブランチを切ってPR経由で反映する。
