---
name: release
description: "対象リポジトリのバージョンリリースを実施する。CHANGELOG、package.jsonへ version 情報を反映し、release workflow を実行し、GitHub Release と Marketplace 公開を行う。 when use: x.y.z をリリース、リリースして"
argument-hint: "[x.y.z]"
---

# バージョンをリリースする

このスキルでは、CHANGELOG と package.json の version 情報を更新し、release workflow を実行して GitHub Release と Marketplace 公開を行う。
`$ARGUMENTS` はターゲットバージョン `x.y.z`（先頭に `v` は付けない）。省略した場合は手順1でマイルストーンから自動決定する。以降の手順は、`$ARGUMENTS` そのものではなく、手順1で確定した対象バージョンを使って進める。

## 責務の境界

### このスキルの責務

- CHANGELOG / `package.json` のバージョン情報更新を PR を作成して `main` にマージする。
- そのマージで自動起動する Release workflow（`.github/workflows/release.yml`）が成功したことを確認する。

### release workflow 内で行われること (このスキルの責務ではないこと)

**以下は、リポジトリの `.github/workflows/release.yml` がこのように実装されている前提の説明**であり、このスキル自身が保証するものではない。
- `vx.y.z` タグの作成
- GitHub Release の作成。
- VS Code Marketplace への公開
- 対応する `vx.y.z` マイルストーンの自動クローズ

## 手順

1. **リリース対象バージョンの決定**
  - `$ARGUMENTS` が空の場合は、進捗が 100% 完了のマイルストーンを自動選択し、そのタイトル（例: `vx.y.z`）から対象バージョンを決定する。該当なし、または複数ある場合はユーザー確認を取る。
  - `$ARGUMENTS` が空でない場合は、SemVer 形式の `x.y.z` であることを確認する。形式不正の場合はエラー終了する。
    - version の先頭に `v` が付いている場合は、`vx.y.z` から `v` を除去して `x.y.z` として扱う。
    - 確認できたら、この `x.y.z` を対象バージョンとする。
  - `$ARGUMENTS` が空でない場合は、`vx.y.z` マイルストーンが存在し、かつ進捗が 100% 完了であることを確認する。
    - 存在しない場合はエラー終了する。
    - 進捗が 100% 完了でない場合は、ユーザーに確認する — 「今回のマイルストーンから外す（次版に繰り越すなど）」か「リリースを中止する」か。ここでユーザーの判断が出るまで先に進まない。
  - **以降の手順では、ここで確定した対象バージョンを使う（`$ARGUMENTS` が空だった場合でも、この時点で具体的な `x.y.z` が確定している）。**
2. **事前確認**
  - 作業ツリーがクリーンで `origin/main` が最新であることを確認する（`git fetch origin`）
  - `CHANGELOG.md`（英語・正本）と `CHANGELOG.ja.md` の `## [Unreleased]` を読む。
    - 両方ともエントリなしなら「リリース対象なし」のため停止してユーザー確認。
    - 片方だけエントリがある場合は desync を先に解消する（この状態は手順5の `prepare-release.js` でも弾かれる）。
  - 含まれるエントリを言い直してリリース範囲を明確化する。
3. **バージョン妥当性（SemVer）確認**
  - `[Unreleased]` の内容に対して `x.y.z` が Semantic Versioning に合っているか確認する。
    - breaking change は major、新機能（`Added`）は minor、修正のみは patch。
    - 指定バージョンが内容とズレる場合は指摘して続行前に確認する。この判断はここで行う（下記スクリプトは機械的書き換えのみ）。
4. **最新 main からブランチ作成**
  - `git checkout -b release/v<x.y.z> origin/main`
5. **リリース準備**
  - このスキルに同梱の `node "${CLAUDE_PLUGIN_ROOT}/skills/release/scripts/prepare-release.js" <対象バージョン>` を実行する（`<対象バージョン>` は手順1で確定した `x.y.z`。`$ARGUMENTS` が空だった場合はマイルストーンから自動決定した値を使う。対象リポジトリの `npm run prepare-release` には依存しない）。これにより、以下の反映が行われる。
    - `CHANGELOG.md` と `CHANGELOG.ja.md` の `## [Unreleased]` が、当日ローカル日付付きの `## [x.y.z] - YYYY-MM-DD` に変更される。
    - 末尾リンク参照も更新され、`[Unreleased]` は `.../compare/vx.y.z...HEAD` に向き、新規 `[x.y.z]: .../releases/tag/vx.y.z` が追加される（リンクのホスト/オーナー/リポジトリ名は対象リポジトリの `git remote origin` から自動判定される）。
    - `package.json` の `"version"` も更新される。
    - 対象リポジトリに `package-lock.json` があれば、そのトップレベル `"version"` と `packages[""].version` も同じ値に同期される（npm install は走らせない）。存在しないリポジトリ（yarn/pnpm 等）ではこの手順はスキップされる。
  - non-zero 終了時はエラーを読んで、エラーの原因を修正し、再実行する。手動でファイルを編集してはいけない。
6. **テスト（ゲート）**
  - `npm run compile`、`npm test`、`npm run check:package` を実行。すべて成功必須。失敗状態では PR を作成しない。
7. **コミット**
  - 意図した差分だけが staged されていることを確認（`git status` / `git diff`）し、リポジトリ流儀の日本語要約でコミットする。
    - 例: `release: vx.y.z`（または `release: CHANGELOG を x.y.z に確定し version を bump`）。
8. **Push & PR 作成**
  - `git push -u origin release/v<x.y.z>` 後、`gh pr create --base main`。
    - PR 本文は `--body-file` で渡す（インラインで backtick や `$()` を使うと `gh pr *` allowlist に合わないことがある）。
    - リリース PR は draft ではなく、常に non-draft で作成する。
9. **CI 待機**
  - `set -o pipefail; gh pr checks <pr> --watch --fail-fast 2>&1 | tail -5` を単発のフォアグラウンド呼び出しとして実行（長めタイムアウト例: 600000 ms / 10 分）。全チェック完了までブロックする。`tail -5` は `--watch` の 10 秒ごとの全表再出力を抑制し、`set -o pipefail` は失敗チェックの non-zero をパイプ越しに保持する。バックグラウンド実行して後で継ぎ足す運用は CI 待機でツール呼び出しミスを誘発しやすいので避ける。赤があれば修正して再 push。
10. **（要求された場合）Copilot レビュー待機**
  - このリポジトリの branch ruleset は push ごとの Copilot 自動レビュー要求（`copilot_code_review`, `review_on_push: true`）を設定できるが、常時有効とは限らない。同梱の `wait-copilot-review.js` を起動する: `node "${CLAUDE_PLUGIN_ROOT}/scripts/wait-copilot-review.js" <pr>`（sha 省略時は現 HEAD の `git rev-parse HEAD` を自動使用。間隔・タイムアウトは `--interval-ms=` `--timeout-ms=` で調整可、デフォルトは 25 秒間隔・15 分タイムアウト）。`gh` は execFileSync 経由で引数配列として呼ぶため `--jq` もシェルクォートも不要——`gh pr view` の `--jq` が jq 式1つしか受け付けず `--arg` 等の変数注入をサポートしない点や、`reviewRequests[].login`（依頼中は `Copilot`）と `reviews[].author.login`（提出済みは `copilot-pull-request-reviewer`）の使い分けは、いずれもスクリプト内部で処理済み。**短時間で空だから未設定と判断しない**——pending が一度でも見えたらタイムアウトまで待ち、一度も見えないまま最初のポーリングが成功で返った場合のみ timeline を確認して「未設定」と判断する。終了コードは `0`（`SUBMITTED:<state>` = 提出済み、または `NOT_CONFIGURED:` = このリポジトリではレビュー要求なし）と `2`（`TIMEOUT:` = タイムアウトまでに届かず。非同期で後から届くことがあるためユーザーに伝えた上で Merge に進んでよい）。単発フォアグラウンド呼び出し、または Bash が使える環境では Monitor ツールでの背景監視でよい（`timeout_ms` はスクリプトの `--timeout-ms` より少し長めに設定する）。
    - `SUBMITTED:` で終了したら、概要（`gh pr view <pr> --json reviews`）とインライン指摘（`gh api repos/:owner/:repo/pulls/<pr>/comments --jq '.[] | select(.user.login=="Copilot") | {path,line,body}'`）を読む。インラインは `user.login` が `Copilot` で、レビューの `author.login` とは別フィールドである点に注意（API 実測済み）。実行可能な指摘は同一ブランチに追コミットして push し、同手順を新しい HEAD sha で再実施する。
    - fixup push 後に再レビューが来るかは一貫しない。「タイムアウト内で来るかもしれない」前提で扱い、「必ず来る/来ない」と決め打ちしない。手動での後押し（`gh api repos/:owner/:repo/pulls/<pr>/requested_reviewers -f 'reviewers[]=Copilot'` または `gh pr edit <pr> --add-reviewer Copilot`）は試してよいが、`reviewRequests` へ即反映しないケースがあるため依存しない。タイムアウトでその sha に新規レビューが無ければ、対応済み指摘へ「何を変えたか」を返信して Merge へ進む。
    - 誤検知やスコープ外の指摘は、コード変更せず理由を返信する。
    - 実際に着弾したレビューの全指摘が「修正して返信」または「返信のみ」で解決されるまでは Merge へ進まない（マージ後に指摘へ気づく事故を防ぐため）。
11. **マージ** — `gh pr merge <pr> --squash --delete-branch` を実行し、`git checkout main && git pull` でローカル main を同期する。このマージ（`package.json` の version bump を含む）が `.github/workflows/release.yml` のトリガーとなる。
12. **リリース結果検証** — 自動起動 run の成功を確認する。`gh run list --workflow=release.yml -L 1` で対象 run を取得（直前 merge が最新 main push のため通常これが対象）。続いて `set -o pipefail; gh run watch <run-id> --exit-status 2>&1 | tail -20` を単発フォアグラウンドで実行（長めタイムアウト例: 600000 ms）。`tail` は進捗再出力を抑制し、`--exit-status` + `pipefail` で失敗時 non-zero を保持。green なら GitHub Release（副作用として `vx.y.z` タグ生成）+ `.vsix` 添付が成功し、`VSCE_PAT` があれば Marketplace 公開も実行済み。
13. **失敗時の復旧** — 12 が red の場合は `gh run view <run-id> --log-failed` で失敗箇所を確認。復旧方法は失敗箇所で分岐する。
    - **Release 作成前で失敗**（compile / package / `verify-pat`）: 原因を修正（コード問題なら通常 GitHub Flow、瞬間的要因なら再実行のみ）し、`gh run rerun <run-id> --failed`。この段階は未作成なので重複生成リスクはない。
    - **Release 作成後で失敗**（現実的には Marketplace publish ステップのみ）: 単純 Re-run では「Release 既存」ゲートによりジョブ全体がスキップされ、publish 再試行にならない。`npm run package` で生成される `.vsix`（出力パスはリポジトリの packaging 設定次第。多くの場合 `dist/<package.json の name>.vsix` や `<package.json の name>.vsix`）を確認し、`npx @vscode/vsce publish --packagePath <vsixのパス> -p <PAT>` で手動公開するか、`gh release delete vX.Y.Z --cleanup-tag --yes` 後に `gh run rerun <run-id> --failed`。後者が安全なのは、`verify-pat` はすでに通っており未達なのは Marketplace 公開だけというケースでは、GitHub Release とタグを削除して作り直しても Marketplace 側には何も反映されていない（＝重複や不整合が生じない）ため。
14. **マイルストーンのクローズ確認** — `release.yml` の "Close milestone" ステップは、リリース成功かつ全 issue クローズ済みなら `vx.y.z` を自動クローズする。手順1で未クローズ issue への対応（除外 or リリース中止）を済ませているため、通常はここで問題なく閉じる。進行中に issue が新たに追加されるなどして未クローズのまま残った場合は run ログの `::warning::` や `gh api repos/:owner/:repo/milestones --jq '.[] | select(.title=="vx.y.z") | .state'` で検知し、内容を報告してユーザー判断を仰ぐ（見かけ上整えるための手動クローズはしない）。
15. **報告** — マージ済み PR 番号、新しい `main` の commit、Release workflow 結果（run リンク付き）、Marketplace publish の実行/スキップ、マイルストーンのクローズ有無を報告する。

## 注意事項

- `main` は保護ブランチ（直接 push / force-push / delete 不可）。常に `test` green の PR 経由で反映する。
- 1 PR = 1 リリース。リリース PR には無関係な変更を混ぜない。内容は `prepare-release.js` による CHANGELOG 確定と version bump のみに限定する。
- リリースコミット自体はユーザー向け変更ではないため、新規 `[Unreleased]` エントリは追加しない。リリース済みセクションを作るためのコミットである。
- `vx.y.z` タグは workflow 内の `gh release create` で生成され、手動 push しない。公開済み GitHub Release に紐づく既存タグを force 更新しない。公開後の誤りは新しい patch バージョンで取り直す。
- CI 待機、マージ、リリース検証はツール呼び出し構文ミスで停止しやすい。事後で「実行されていないこと」に気づく運用は再発しがちなので、半端実行が起きないよう各ステップを単発フォアグラウンド呼び出しで構成する（`gh pr checks --watch`、`gh pr merge`、`gh run watch`）。後続ターンで再開前提の fire-and-forget を使わない。
