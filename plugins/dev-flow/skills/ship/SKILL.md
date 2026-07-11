---
name: ship
description: "既存のGitHub issueをブランチ作成からPRマージまで一気通貫で実装する。 when use: 既存issueに取り掛かる、issue N をやって、#N に取り掛かる"
argument-hint: "[<issue番号>]"
---

# Ship Issue

既存のGitHub issueを、このリポジトリのGitHub Flowに沿ってマージ済みPRまで進める。変更は必ずブランチを切ってPR経由でmainに反映し、CIが green になってからマージする。各ルールの背景・理由・実測談は同ディレクトリの [reference.md](reference.md) 参照。

`$ARGUMENTS` はshipするissue番号。空なら `gh issue list` を実行してどのissueをshipするか確認する。

## 手順

1. **issueを読む** — `gh issue view $ARGUMENTS`。タイトルと受け入れ基準を復唱し、スコープを明確にする。クローズ済み、またはスコープが曖昧なら、コーディングを始める前にユーザーに確認する。
   - **マイルストーン**: issueに未設定（`gh issue view $ARGUMENTS --json milestone`）の場合——
     - オープンなマイルストーンがちょうど1つ（`gh api repos/:owner/:repo/milestones?state=open --jq '.[].title'`）→ それに割り当てる（`gh issue edit $ARGUMENTS --milestone <title>`）。
     - 複数ある → どれに割り当てるか（またはどれにも割り当てないか）をユーザーに確認する。
2. **最新mainからブランチを切る** — ファイルを触る前に行う。`git checkout main` → `git fetch origin && git pull` → `git checkout -b <type>/<slug>`（`feat/`・`fix/`・`docs/`・`ci/`・`refactor/` などの種別プレフィックス付き）。`git branch --show-current` で新しいブランチに切り替わったことを確認してから手順3へ。
3. **テストを先に書く** — テスト対象の挙動が無い変更（純粋なdocs/CI/雑務のissue）のみ省略し、省略した旨を明示的に述べる。それ以外は:
   - リポジトリのテスト構成を調べる（既存の `*.test.*` / `*.spec.*` の配置・命名規則、`package.json` の `test` スクリプト、テストフレームワーク）。
   - issueの受け入れ基準の各項目を、既存の命名規則に沿ったテストファイル（新規モジュールなら新規テストファイル）に、実装コードに触れる前に*意図した*挙動として翻訳する。
   - テスト実行に前提コマンド（コンパイル・ビルドなど。`out/`/`dist/` 出力前提のテストランナー等）が必要なら先にそれを実行する。
   - テストを実行し、期待通りの理由で失敗する（挙動がまだ存在しないためred）ことを確認する。タイポのような無関係なエラーで失敗していないことも確認する。
4. **実装する** — 編集対象のファイルと周辺コードを読んでから編集し、失敗しているテストを最小限の変更で通す。issueのスコープ内に留める——無関係な改善点に気づいたら、issueを広げず別issueとして提案する。周辺のコードスタイルに合わせ、コメントは最小限にする。書く場合も「何をしているか」ではなく「なぜその実装にしたか」（非自明な制約・理由）だけを残す。
5. **CHANGELOGを更新する** — 条件で分岐する:
   - リポジトリが Keep a Changelog 形式の `CHANGELOG.md`（および翻訳版、例 `CHANGELOG.ja.md`）を採用し、かつユーザー影響のある変更（新機能・バグ修正・挙動やデフォルトの変更・設定の追加変更・非推奨化・ユーザーが体感するパッケージング/性能変更）→ 該当する全ファイルの `[Unreleased]` セクションに、適切なグループ（Added / Changed / Deprecated / Removed / Fixed / Security）で一行追記する。見出しが無ければ作成する。複数言語版は必ず全て同じ内容で更新する。
   - ユーザー影響のない変更（内部リファクタ・ビルド/CI・テスト・ドキュメント・Claudeスキル等）、またはCHANGELOG未採用 → 省略し、その旨を述べる。
6. **テスト（ゲート）** — このリポジトリのCI設定（例 `.github/workflows/*.yml` のtest/buildジョブ）を確認し、そこで実行されているコマンド列をローカルでも同じ順序で実行し、全て通す（共有できるビルドは1回にまとめてよい）。手順3で書いたテストが今はgreenであることを確認する。redなら直す——ビルドやテストが失敗した状態でPRを開かない。
7. **コミットする** — `git status` / `git diff` で意図した変更だけがステージされていることを確認し、直近のコミット履歴のスタイル（言語・書式）に合わせて、末尾に `Closes #$ARGUMENTS` を付けてコミットする。
8. **プッシュ & PR** — `git push -u origin <branch>` → `gh pr create --base main`。`.github/pull_request_template.md` があればその構成に沿って本文を書き、無ければ変更内容の要約でよい。いずれも末尾に `Closes #$ARGUMENTS` を付け、テストが通ったこと・CHANGELOGを追記した（またはN/Aである）ことを本文に反映する。
9. **CIを待つ** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/wait-ci.js" <pr>` を実行する（`<pr>` は手順8のPR番号。デフォルト20秒間隔・20分タイムアウト、`--interval-ms=` `--timeout-ms=` で調整可）。状態が変化するたびに1行出力する。終了コードで判定する:

   | 終了コード | 意味 | 次の行動 |
   | --- | --- | --- |
   | `0` | 全チェック通過、または `NO_CHECKS:`（このリポジトリにCI設定が無い） | 手順10へ |
   | `1` | `FAILED:`（チェック失敗）、引数エラー、`gh` 不在 | 失敗ログを確認して修正 → push → 手順9をやり直す |
   | `2` | `TIMEOUT:` | 状況を確認し、`--timeout-ms=` を延ばして再実行するかユーザーに報告する |

   - 特定のチェック（例 `test`）が一向に一覧に現れず、無関係なチェックだけが完了する → `gh pr view <pr> --json mergeable` を確認し、`CONFLICTING` なら最新の `origin/main` にrebaseして解消し、force-pushして再度待つ。
10. **Copilotレビューを待つ** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/wait-copilot-review.js" <pr>` を実行する（デフォルト25秒間隔・15分タイムアウト、`--interval-ms=` `--timeout-ms=` で調整可。sha省略時は現HEADを自動使用する——新しいpushの後は改めて実行すれば新HEADを見る）。終了コードで判定する:

    | 終了コード | 意味 | 次の行動 |
    | --- | --- | --- |
    | `0` | `SUBMITTED:<state>`（レビュー提出済み) | 下のレビュー内容判断へ |
    | `0` | `NOT_CONFIGURED:`（このPRではCopilotレビューが要求されていない） | 待たずに手順11へ |
    | `1` | 引数エラー、`gh`/`git` 不在などローカル前提条件エラー | 原因を直して再実行する |
    | `2` | `TIMEOUT:`（提出されなかった） | その旨をユーザーに伝えたうえでマージに進んでよい（レビューは後から届くことがある） |

    - `SUBMITTED:` の場合、本文（`gh pr view <pr> --json reviews`）とインラインコメント（`gh api repos/:owner/:repo/pulls/<pr>/comments --jq '.[] | select(.user.login=="Copilot") | {path,line,body}'`）を読み、判断する:
      - 提案・nit・スタイルの指摘のみ、またはスコープ外・誤検知 → 内容をユーザーに一言報告し、返信（コード変更なし）してマージへ進む。必要なら別issueとしてフォローアップを提案する。
      - 実際のバグ・見落とし・スコープ内の問題 → push前に同種の観点でdiff全体を掃き、見つけた同類も直して1回のfixup pushに束ねる。手順6（ゲート）をやり直し、pushして手順9からやり直す。
    - fixup push後の再レビューは「タイムアウト内で来るかもしれない」として扱い、「必ず来る/来ない」と決め打ちしない。着弾したレビューの全指摘が「修正して返信」または「返信のみ」で解決されるまではマージへ進まない。
11. **マージする** — マージまで進めるのがこのスキルのデフォルトであり、マージ前の事前確認は不要（明示の `/ship` 指示ではなく会話から始めたshipでも同様）。
    - ユーザーが「マージ前で止めて」等を明示していた → `gh pr merge` を実行せず停止して状態を報告し、以降の手順に進まない。
    - 停止指定が無い → `gh pr merge <pr> --squash --delete-branch` を実行し（リモートブランチが必ず消える前提は置かない）、`git checkout main && git pull` でローカルの `main` を同期する。
    - **git worktree 内で実行している場合**（`main` が別の worktree でチェックアウトされている——サブエージェントの worktree 分離実行が典型。`git rev-parse --git-common-dir` が `.git` 以外を返すことで判定できる）→ `--delete-branch` を付けずに `gh pr merge <pr> --squash` でマージし、`gh pr view <pr> --json mergedAt` でマージ済みを確認してから `git push origin --delete <branch>` でリモートブランチを明示削除する。`git checkout main` は実行しない（別 worktree が使用中のため必ず失敗する）。ローカルブランチと worktree 自体の掃除は親セッション側に委ねる。
12. **ローカルブランチを掃除する** — `git fetch --prune origin` → `git branch -vv` で upstream が `[origin/<branch>: gone]` のローカルブランチを探す → 対応するPRの `gh pr view <番号または対応するブランチ名> --json mergedAt --jq '.mergedAt'` に値が入っている（=マージ済み）ことを確認してから `git branch -D <branch>` で削除する。`git branch --merged origin/main` やコミット差分ベースのマージ済み判定は使わない（squashマージで誤判定する）。
13. **報告する** — マージされたPR番号、`Closes #N` によりissueが自動クローズされたこと、新しい `main` のコミット、Copilotレビューの結果（あれば）、掃除したローカルブランチを述べる。

## 補足

- `main` へは直接pushせず、必ずブランチを切ってPR経由で反映する。
- 1 issue = 1 PR。実装途中でスコープが膨らんだら、別issue/別PRに分割する。
- このスキルは既に存在するissueが対象。issue化されていない新規の作業を説明されたら、まず `gh issue create` を提案してからshipする。
- 手順9・10の待ちは、単一の自己完結したフォアグラウンド呼び出しでブロックするのが既定（Bashのタイムアウトはスクリプトの `--timeout-ms` より少し長めに取る）。**サブエージェントとして実行されている場合（worktree 分離実行が典型）は必ずこの既定に従う**——ターンを終えて完了通知を待つ運用（バックグラウンド発火・Monitor背景監視）は、ターン終了がエージェントの停止として扱われ、CI完了の通知が来ても作業が再開されるとは限らない。対話セッション本体で、かつMonitorツールが使える環境に限り、背景監視（`timeout_ms` はスクリプトの `--timeout-ms` より少し長め、`persistent` はfalse）を使ってよい。手順11の `gh pr merge` はいずれの環境でも単一のフォアグラウンド呼び出しのまま変更しない。
- 変更がローカル `main` に乗ってしまったことに気づいた場合（`git branch --show-current` / `git status -sb` で確認）、`main` に一切pushせずに復旧する:
  - 未コミット → `git checkout -b <branch>` で変更ごと新しいブランチへ移す。
  - コミット済み → `git branch <branch>` でそのコミットにブランチを立て、`git reset --hard origin/main` でローカル `main` を復元し、`git checkout <branch>` で作業を続ける。
- リリース作業（バージョンbump・CHANGELOG確定・GitHub Release）はこのスキルの対象外。`release` スキルを使う。
