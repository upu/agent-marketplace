---
name: release
description: "バージョンリリースを実施し、GitHub ReleaseとMarketplace公開を行う。 when use: x.y.z をリリース、リリースして"
argument-hint: "[x.y.z]"
---

# バージョンをリリースする

CHANGELOG と package.json の version 情報を更新し、release workflow を実行して GitHub Release と Marketplace 公開を行う。各ルールの背景・理由・実測談は同ディレクトリの [reference.md](reference.md) 参照。

`$ARGUMENTS` はターゲットバージョン `x.y.z`（先頭に `v` は付けない）。省略時は手順1でマイルストーンから自動決定する。以降の手順は、`$ARGUMENTS` そのものではなく、手順1で確定した対象バージョンを使って進める。

## 責務の境界

- **このスキルの責務**: CHANGELOG / `package.json` のバージョン情報更新を PR で `main` にマージし、そのマージで自動起動する Release workflow（`.github/workflows/release.yml`）の成功を確認する。
- **workflow 側で行われること（このスキルは保証しない）**: `vx.y.z` タグの作成、GitHub Release の作成、VS Code Marketplace への公開、対応する `vx.y.z` マイルストーンの自動クローズ——いずれも**リポジトリの `release.yml` がそのように実装されている前提**の説明。

## 手順

1. **リリース対象バージョンの決定**
   - `$ARGUMENTS` が空 → 進捗が 100% 完了のマイルストーンを自動選択し、そのタイトル（例: `vx.y.z`）から対象バージョンを決定する。該当なし・複数あり → ユーザーに確認する。
   - `$ARGUMENTS` あり → SemVer 形式の `x.y.z` であることを確認する（先頭に `v` が付いていれば除去して扱う。形式不正はエラー終了）。さらに `vx.y.z` マイルストーンを確認する:
     - 存在しない → エラー終了。
     - 進捗が 100% 完了でない → 「今回のマイルストーンから外す（次版に繰り越すなど）」か「リリースを中止する」かをユーザーに確認し、判断が出るまで先に進まない。
   - 以降の手順では、ここで確定した対象バージョンを使う。
2. **事前確認**
   - 作業ツリーがクリーンで `origin/main` が最新であることを確認する（`git fetch origin`）。
   - `CHANGELOG.md`（英語・正本）と `CHANGELOG.ja.md` の `## [Unreleased]` を読む:
     - 両方ともエントリなし → 「リリース対象なし」のため停止してユーザー確認。
     - 片方だけエントリあり → desync を先に解消する。
   - 含まれるエントリを言い直してリリース範囲を明確化する。
3. **バージョン妥当性（SemVer）確認** — `[Unreleased]` の内容に対して `x.y.z` が合っているか確認する: breaking change は major、新機能（`Added`）は minor、修正のみは patch。指定バージョンが内容とズレる場合は指摘して続行前に確認する。この判断はここで行う（手順5のスクリプトは機械的書き換えのみ）。
4. **最新 main からブランチ作成** — `git checkout -b release/v<x.y.z> origin/main`
5. **リリース準備** — 同梱の `node "${CLAUDE_PLUGIN_ROOT}/skills/release/scripts/prepare-release.js" <対象バージョン>` を実行する（対象リポジトリの `npm run prepare-release` には依存しない）。CHANGELOG 両言語版の `[Unreleased]` 確定・末尾リンク参照の更新・`package.json`（あれば `package-lock.json` も）の version 同期が行われる。non-zero 終了時はエラー原因を修正して再実行する。手動でファイルを編集してはいけない。
6. **テスト（ゲート）** — `npm run compile`、`npm test`、`npm run check:package` を実行。すべて成功必須。失敗状態では PR を作成しない。
7. **コミット** — 意図した差分だけが staged されていることを確認し（`git status` / `git diff`）、リポジトリ流儀の日本語要約でコミットする（例: `release: vx.y.z`）。
8. **Push & PR 作成** — `git push -u origin release/v<x.y.z>` 後、`gh pr create --base main`。PR 本文は `--body-file` で渡す。リリース PR は常に non-draft で作成する。
9. **CI 待機** — `set -o pipefail; gh pr checks <pr> --watch --fail-fast 2>&1 | tail -5` を単発のフォアグラウンド呼び出しとして実行する（長めタイムアウト例: 600000 ms）。バックグラウンド実行して後のターンで継ぎ足す運用はしない。赤があれば修正して再 push。
10. **（要求された場合）Copilot レビュー待機** — 同梱の `node "${CLAUDE_PLUGIN_ROOT}/scripts/wait-copilot-review.js" <pr>` を実行する（sha 省略時は現 HEAD を自動使用。デフォルト 25 秒間隔・15 分タイムアウト、`--interval-ms=` `--timeout-ms=` で調整可）。単発フォアグラウンド呼び出し、または Bash が使える環境では Monitor ツールでの背景監視でよい（`timeout_ms` はスクリプトの `--timeout-ms` より少し長め）。終了コードで判定する:

    | 終了コード | 意味 | 次の行動 |
    | --- | --- | --- |
    | `0` | `SUBMITTED:<state>`（レビュー提出済み） | 下のレビュー内容判断へ |
    | `0` | `NOT_CONFIGURED:`（このリポジトリではレビュー要求なし） | 待たずに手順11へ |
    | `1` | 引数エラー、`gh`/`git` 不在などローカル前提条件エラー | 原因を直して再実行する |
    | `2` | `TIMEOUT:`（タイムアウトまでに届かず） | 非同期で後から届くことがあるため、ユーザーに伝えたうえで手順11に進んでよい |

    - `SUBMITTED:` の場合、概要（`gh pr view <pr> --json reviews`）とインライン指摘（`gh api repos/:owner/:repo/pulls/<pr>/comments --jq '.[] | select(.user.login=="Copilot") | {path,line,body}'`）を読み、判断する:
      - 実行可能な指摘 → 同一ブランチに追コミットして push し、この手順を新しい HEAD sha で再実施する。
      - 誤検知・スコープ外 → コード変更せず理由を返信する。
    - fixup push 後の再レビューは「タイムアウト内で来るかもしれない」として扱い、「必ず来る/来ない」と決め打ちしない。手動での後押し（`gh api repos/:owner/:repo/pulls/<pr>/requested_reviewers -f 'reviewers[]=Copilot'` または `gh pr edit <pr> --add-reviewer Copilot`）は試してよいが依存しない。タイムアウトでその sha に新規レビューが無ければ、対応済み指摘へ「何を変えたか」を返信して手順11へ進む。
    - 着弾したレビューの全指摘が「修正して返信」または「返信のみ」で解決されるまでは手順11へ進まない。
11. **マージ** — `gh pr merge <pr> --squash --delete-branch` を実行し、`git checkout main && git pull` でローカル main を同期する。このマージ（`package.json` の version bump を含む）が `release.yml` のトリガーとなる。
12. **リリース結果検証** — `gh run list --workflow=release.yml -L 1` で対象 run を取得し（直前 merge が最新 main push のため通常これが対象）、`set -o pipefail; gh run watch <run-id> --exit-status 2>&1 | tail -20` を単発フォアグラウンドで実行する（長めタイムアウト例: 600000 ms）。green なら GitHub Release（副作用として `vx.y.z` タグ生成）+ `.vsix` 添付が成功し、`VSCE_PAT` があれば Marketplace 公開も実行済み。
13. **失敗時の復旧** — `gh run view <run-id> --log-failed` で失敗箇所を確認し、分岐する:
    - **Release 作成前で失敗**（compile / package / `verify-pat`）→ 原因を修正（コード問題なら通常 GitHub Flow、瞬間的要因なら再実行のみ）し、`gh run rerun <run-id> --failed`。この段階では Release 未作成なので重複生成リスクはない。
    - **Release 作成後で失敗**（現実的には Marketplace publish ステップのみ）→ 単純 Re-run は再試行にならない。次のいずれかで復旧する:
      - `npm run package` で生成される `.vsix`（出力パスは packaging 設定次第。多くの場合 `dist/<package.json の name>.vsix` や `<package.json の name>.vsix`）を確認し、`npx @vscode/vsce publish --packagePath <vsixのパス> -p <PAT>` で手動公開する。
      - `gh release delete vX.Y.Z --cleanup-tag --yes` 後に `gh run rerun <run-id> --failed`。
14. **マイルストーンのクローズ確認** — 通常は `release.yml` の "Close milestone" ステップが、リリース成功かつ全 issue クローズ済みなら `vx.y.z` を自動クローズする。未クローズのまま残った場合は run ログの `::warning::` や `gh api repos/:owner/:repo/milestones --jq '.[] | select(.title=="vx.y.z") | .state'` で検知し、内容を報告してユーザー判断を仰ぐ（見かけ上整えるための手動クローズはしない）。
15. **報告** — マージ済み PR 番号、新しい `main` の commit、Release workflow 結果（run リンク付き）、Marketplace publish の実行/スキップ、マイルストーンのクローズ有無を報告する。

## 注意事項

- `main` は保護ブランチ（直接 push / force-push / delete 不可）。常に `test` green の PR 経由で反映する。
- 1 PR = 1 リリース。リリース PR の内容は `prepare-release.js` による CHANGELOG 確定と version bump のみに限定し、無関係な変更を混ぜない。
- リリースコミット自体はユーザー向け変更ではないため、新規 `[Unreleased]` エントリは追加しない。
- `vx.y.z` タグは workflow 内の `gh release create` で生成され、手動 push しない。公開済み GitHub Release に紐づく既存タグを force 更新しない。公開後の誤りは新しい patch バージョンで取り直す。
- CI 待機（手順9）・マージ（手順11）・リリース検証（手順12）は、各ステップを単発フォアグラウンド呼び出しで構成する（`gh pr checks --watch`、`gh pr merge`、`gh run watch`）。後続ターンで再開前提の fire-and-forget を使わない。
