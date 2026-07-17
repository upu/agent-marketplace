# 変更履歴

このプロジェクトの注目すべき変更はすべてこのファイルに記録します。

フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に基づき、
このプロジェクトは [セマンティックバージョニング](https://semver.org/lang/ja/spec/v2.0.0.html) に従います。

## [Unreleased]

### Changed

- `batch-ship` 手順5（波の完了確認をしてから次の波へ進む判断）が、issueのマージが確認できた時点でその波が使ったworktreeを新しい `cleanup-worktrees.js` スクリプトで明示的に削除するようになった。従来の手順7は残ったworktreeを最終報告で「述べる」だけだった。`Agent` ツールの `isolation: "worktree"` はサブエージェントが変更を加えなかった場合のみ自動クリーンアップされ、`ship` は必ずコミットするため、波を起動するたびにworktreeディレクトリが際限なく残っていた。スクリプトはオーケストレーターが各 `Agent` 呼び出しの結果からパスを手で追跡する方式ではなく、マージ確認済みissueのPRのheadブランチ（`gh pr view --json headRefName`）を `git worktree list --porcelain` の構造的な状態と突き合わせる方式を採る。削除失敗（worktreeがロックされたまま・未追跡ファイルが残っているなど）はログに残してスキップするのみで、強制削除やエラー停止はしない——1件の削除失敗が波全体の掃除を止めない。手順7の報告内容も、掃除の状況を述べるだけでなく、実際に行った掃除の結果を報告する内容に更新した。

### Fixed

- `ship` 手順13の `cleanup-merged-branches.js` が、linked worktree実行時に `git branch -D` の未捕捉エラーで失敗する不具合を修正した。`merge-pr.js` のworktree分岐がマージ済みPRのリモートブランチを既に削除しているため、手順13冒頭の `git fetch --prune origin` の時点で、そのworktree自身がチェックアウト中のブランチのupstreamも `[gone]` になり、マージ未確認のブランチと区別できないまま削除候補に混入していた。`git worktree list --porcelain` から全worktreeのチェックアウト中ブランチを収集し、削除候補から事前に除外するようにし、該当ブランチは `git branch -D` を試みず `SKIP:<branch> - checked out in a worktree` として報告するようにした。通常ツリー実行時の挙動に変更はない。
- `release-evidence.js` の `mergedPRs`/`ciHistory` の日付範囲クエリが、前回リリース自身のPRやCI runを結果に混入させていた不具合を修正した。GitHub の `merged:`/`--created` の範囲指定は両端を含む仕様のため、前タグのコミット日時をそのまま下限に使うと、そのちょうど同じ瞬間に発生したもの——典型的には前回の `release: vX.Y.Z` PR自身——も一致してしまっていた。一方 `commits`（`git log <前タグ>..<対象タグ>`）は既にそれを除外していた。下限を「そのコミット日時の1秒後」（`exclusiveLowerBoundISO`）に変更し、`commits` と同じ「前タグを除外し対象タグまでを含む」境界に統一した。
- `release` 手順9（CI待ち）が、素の `gh pr checks <pr> --watch --fail-fast` の単発フォアグラウンド呼び出しではなく、`ship` 手順9と同じ `wait-ci.js` スクリプトを使うようになった。共通スクリプト抽出（agent-marketplace#22）の受け入れ基準が当初から `release` 手順10（Copilotレビュー待ち）のみを対象にしており、`release` のCI待ちは一度もスコープに入っていなかったため、`wait-ci.js` の `CONFLICTING` 自動検知（agent-marketplace#64。チェックが黙ってスキップされる問題agent-marketplace#58の修正）が `release` には引き継がれていなかった——並行する `ship`/`batch-ship` のマージで `release` のPRが `origin/main` とコンフリクトしても、`CONFLICTING:` の診断なしに単なるタイムアウトとして無言で待ち続けていた。SKILL.mdには `ship` 手順9と同じ終了コード表とCONFLICTING時の対処（`origin/main` へrebase→force-push→再実行）を明記した。

## [0.5.0] - 2026-07-17

### Added

- Codex CLI対応: 各プラグインに `.codex-plugin/plugin.json` を、リポジトリルートに `.agents/plugins/marketplace.json` を追加した。Claude Code向けマニフェストと同一内容（name/version/プラグイン一覧の同期をテストで検証）で管理し、`codex plugin marketplace add upu/agent-marketplace` で同じプラグインを導入できるようにする。READMEにCodex導入手順を追記。

### Changed

- `ship` の最終報告で、ユーザーの操作感に影響する変更（新しいUI・新コマンド/オプション・操作手順や入出力の見た目の変更・対話フローの変更）の場合に、人間による手動確認を提案するようになった。提案には具体的な試し方（プラグイン更新・セッション再読み込み等の前提条件込み）と明示的なOKの基準——何がどう見えれば/動けば成功か——を必ずセットで含める。自動テストとCIがgreenでも操作感はカバーできず、マージまで自動で進むフローでは人間が一度も触らないままリリースされ得るため。`batch-ship` は同じ要件をサブエージェントの報告に含めさせ、親の最終報告の末尾に「人間による確認推奨」一覧として集約する。

## [0.4.0] - 2026-07-15

### Changed

- `ship`/`release` のPRマージを、`gh pr merge --delete-branch` の分岐をプロースで説明する方式から、新しい `merge-pr.js` スクリプト呼び出しに変更した。スクリプト自身が現在の作業ツリーが linked worktree か（`git rev-parse --git-common-dir` が `.git` 以外を返すか）を判定し、通常ツリーなら `--delete-branch` 付きでマージ、worktree なら `--delete-branch` なしでマージ後 `mergedAt` を確認してから `git push origin --delete <branch>` でリモートブランチを明示削除する（`git checkout main` は実行しない——worktree では必ず失敗するため）。worktree分離実行したサブエージェントが繰り返しこの分岐を読み飛ばし `--delete-branch` を誤用して手動リカバリが必要になっていた事故の再発を防ぐ。
- `ship` 手順13（ローカルブランチ掃除）を、`git branch -vv` の出力を読んで `[origin/<branch>: gone]` を探し各PRの `mergedAt` を手動で突き合わせるプロースから、新しい `cleanup-merged-branches.js` スクリプト呼び出しに変更した。`git for-each-ref` の構造化された `%(upstream:track)` フィールドでupstreamが `gone` のローカルブランチを列挙し、ブランチごとに `gh pr view <branch> --json number,state,mergedAt` でマージ状態を確認してから（`git branch --merged` はsquashマージを誤判定するため使わない）マージ済みのものだけ `git branch -D` で削除し、未確認のブランチは削除せず報告する。
- `wait-ci.js` が `gh pr view <pr> --json mergeable` の確認を自身で行うようになった。従来は `ship` 手順9の脚注としてモデルが手動で気づいて実行する必要があった。PENDINGチェックのメッセージが複数回連続で変化しない場合、またはタイムアウト直前になった場合にmergeable状態を確認し、`CONFLICTING` であれば専用の `CONFLICTING:` ログ行と新しい終了コード `3` で待機を終了する（`origin/main` へのrebase自体は引き続き呼び出し側が行う）。通常のマージ可能なPRには影響しない——DONE/FAILEDの高速パスではmergeable確認は行われない。
- `ship` 手順10・`release` 手順10が、提出済みCopilotレビューの本文とインラインコメントを、片方が手書き `--jq` だった2つの生 `gh` 呼び出しのプロースから、新しい `fetch-copilot-feedback.js <pr> [sha]` スクリプト1回の呼び出しに変更された。手書きjqは過去に事故の原因になったクラスの操作(agent-marketplace#7)。スクリプトは `gh` を `execFileSync` の引数配列経由で呼び（jqに依存しない）、`{ summary, state, inlineComments: [{path, line, body}] }` を出力する。`wait-copilot-review.js` に `--dump` フラグを足す案ではなく独立スクリプトにしたのは、「待つ」と「読む」の責務を分けるため。
- `retro` 手順1（実際に起きたことの再構成）が、CHANGELOG節・マイルストーンissue一覧・コミットログ・マージ済みPR一覧・CI再実行/失敗履歴を集める5つの個別の手打ち `gh`/`git` 呼び出しから、新しい `release-evidence.js <version>` スクリプト1回の呼び出しに変更された。リリース対象期間はgitタグから導出する（`git tag --sort=-creatordate` で対象タグとその1つ前のタグを特定）。CI履歴は `main` に限定せず全ブランチを対象に `gh run list --created <期間>` で取得し、失敗または再実行（`attempt > 1`）したものだけに絞り込む——retroが気にする摩擦のほとんどはPRブランチ上で起きるため。`CHANGELOG.md` が無い、またはバージョン見出しが無い場合は `changelog` が `null` になるだけでスクリプト全体は失敗せず、CHANGELOG未採用のリポジトリでも他のデータソースは通常通り取得できる。
- `batch-ship` 手順5（波の完了確認をしてから次の波へ進む判断）が、`gh issue list --milestone ... --state all` と `gh pr list --state merged --limit 200` を別々に実行しモデルが2つの生JSONを突き合わせるプロースから、新しい `wave-status.js <issue番号...>|--milestone=<title>` スクリプト1回の呼び出しに変更された。issue数が多いマイルストーンほどこの突き合わせ自体の負荷が増していた。スクリプトは各issueの `closedByPullRequestsReferences`（`gh issue view` だけでなく `gh issue list` での一括取得でも取得できることをgh 2.86.0で確認済み）を、リンクされたPRごとの `gh pr view --json state` 確認（リンク済み＝マージ済みとは限らないため）と突き合わせ、issueごとに `{ number, state, linkedPr, prMerged }` を出力する。

## [0.3.0] - 2026-07-11

### Changed

- `ship` が、`pull_request` でカバーされないトリガーを持つ `.github/workflows/*.yml` を新設・変更したPRをマージした後、そのワークフローの実際の初回実行（`push`専用トリガー等）が成功することを確認するようになった。PR自体のCIではそのワークフローが一度も実行されないため、従来は実運用未検証のまま完了報告されうる状態だった。

## [0.2.0] - 2026-07-11

### Added

- upu/ghost-align のローカル運用から `dev-flow` に2つのhookを移植: `block-main-commit`（`PreToolUse`/`Bash`）は `main` ブランチ上での `git commit` を、ラッパーコマンド（`env`/`sudo`/`command`）や複合コマンド（`&&`/`;`/`|`）越しも含めて拒否する。`compile-if-ts`（`PostToolUse`/`Edit|Write`）は `.ts` ファイル編集後に `npm run compile` を実行する。`compile-if-ts` は `package.json` が無い、または `scripts.compile` が定義されていないリポジトリでは何もしないため、本リポジトリのような非npmプロジェクトでもプラグインを安全に有効化できる。
- upu/ghost-align のローカルスキルを汎用化して移植した `test-and-package` スキルを含む新規プラグイン `vscode-ext` を追加。compile → test → `check:package` によるパッケージ内容allowlist検証のゲートを通り、両方green のときだけ `.vsix` をビルドする。`dev-flow` は言語・エコシステム非依存のスキル集として維持する方針のため、vsce前提のこのスキルは `dev-flow` に分岐を増やさず別プラグインとした。対象リポジトリに前提の `compile`/`test`/`check:package`/`package` npm scriptsが無い場合はその旨を報告して中断する。

### Fixed

- `wait-ci.js`・`wait-copilot-review.js` が `--interval-ms=0`・`--timeout-ms=0` を弾くようになった。従来はsleep無しでポーリングし続けGitHub APIを叩き続けたり、1回もポーリングせずに即タイムアウト扱いになっていた。

## [0.1.0] - 2026-07-11

### Added

- `dev-flow` プラグインの `plugin.json` に `version` フィールドを追加し、SemVer で管理を開始。
- Keep a Changelog 形式の `CHANGELOG.md` / `CHANGELOG.ja.md` を追加し、スキルの挙動変更を利用側が追えるようにした。

### Changed

- `ship` のCI待ちと、`ship`・`release` のCopilotレビュー待ちを、モデルが長いbash/jqループを書き写す方式から、同梱のNodeスクリプト（`wait-ci.js`・`wait-copilot-review.js`）を起動する方式に変更し、引用符・jqエスケープの誤りが起きやすかった箇所を解消（`release` 自体のCI待ちは引き続き `gh pr checks --watch` を使用）。
- `ship` スキル本文を「短い命令文＋条件→動作の明示的な分岐（箇条書き・終了コード表）」に書き換え、背景・理由・実測談を必要時のみ読まれる `reference.md` に分離——挙動ルールを欠落させずに、起動のたびにロードされるコンテキストを削減（起票時22,204字 → 5,936字）。
- 残り5スキル——`release`・`plan-next`・`retro`・`batch-ship`・`propose-improvements` にも同じ書き換えを適用: 本文をルール中心の命令文＋明示的な分岐に圧縮し、背景・理由・実測談を各スキルの `reference.md` に分離（release 8,094 → 5,917字、plan-next 5,252 → 4,417字、retro 4,724 → 4,166字、batch-ship 3,811 → 2,941字、propose-improvements 2,460 → 2,220字）。
- 全6スキルのfrontmatter `description` を「一行の目的＋when use トリガー例文」に短縮し、全セッションで常時ロードされるスキル一覧のコンテキストを半減（合計1,112字 → 554字）。

### Docs

- README に、スキル更新を取り込むための `/plugin marketplace update upu-agent-marketplace` の実行手順を明文化。
- README のスキル執筆規約を拡張: SKILL.md 本文は「短い命令文＋構造化された分岐（箇条書き・表）」で書き、why・実測談は各スキルの `reference.md` に分離して本文から一行で誘導する方針を明文化。

[Unreleased]: https://github.com/upu/agent-marketplace/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.5.0
[0.4.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.4.0
[0.3.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.3.0
[0.2.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.2.0
[0.1.0]: https://github.com/upu/agent-marketplace/releases/tag/v0.1.0
