---
name: batch-ship
description: "複数のGitHub issueを、サブエージェントへの ship 委譲で一括実装する。 when use: マイルストーンのissueを全部やって、複数issueをまとめてshipして、一括実装して、batch ship"
argument-hint: "[<マイルストーン名> または <issue番号列 例: 3 5 8>]"
---

# Batch Ship

複数のGitHub issue（目安: 5件超）を、issueごとにサブエージェントへ `ship` スキルを委譲して一括実装する。親セッションはオーケストレーション（波の計画・起動・完了確認・報告）に徹し、issue本文・コード・CIログの読解はサブエージェント側に閉じる。各ルールの背景・理由・実測談は同ディレクトリの [reference.md](reference.md) 参照。

`$ARGUMENTS` は対象のマイルストーン名（例: `v0.5.0`）またはissue番号の列。空の場合は、オープンなマイルストーン一覧（`gh api repos/:owner/:repo/milestones?state=open --jq '.[].title'`）とissue一覧（`gh issue list --limit 200 --json number,title,milestone`）を確認し、どれを対象にするかユーザーに確認する。

**このスキルを使うべきでない場合**: 対象が4件以下なら、その旨を伝えて親セッションで直列に `ship` を実行する。

## 手順

1. **対象issueを確定する** — `gh issue list --milestone "<title>" --state all --limit 200 --json number,title,state,labels,body` 等で対象issueの一覧（番号・タイトル・状態・ラベル・本文）を取得する（`--state all` と `--limit` を明示する）。マイルストーンの `description` に推奨着手順序が書かれていれば（`plan-next` スキルが書く）、それも読む。クローズ済み・スコープ不明瞭なissueが混ざっていればユーザーに確認する。
2. **自己変更系issueを洗い出し、先に明示許可を取る** — `.claude/settings.json`（permissions等）やスキル定義の `SKILL.md`（配置はリポジトリによって異なる。例: `.claude/skills/**/SKILL.md`、プラグインリポジトリなら `plugins/**/skills/**/SKILL.md`）など、エージェント自身の設定・スキルを変更するissueは、バッチ計画の時点で洗い出し、`AskUserQuestion` 等でそれぞれ個別に「このタスクを実行してよい」というユーザーの明示的な発言を得てから波に組み込む。
3. **波を計画する** — 対象issueを次の基準で波に分け、計画（各波の構成と根拠）をユーザーに提示してから起動する:
   - 1波は3〜4件まで。全件一斉起動は避ける。
   - 同一ファイルを触るissue同士は同じ波に入れない——順序依存として直列化し、片方がマージされた `main` から次をブランチさせる。
   - CHANGELOGの `[Unreleased]` に追記するユーザー向けissue（feat/fix系）は1波あたり最大1件。内部リファクタ/chore/docs系（CHANGELOG不要）は同じ波にまとめてよい。
   - issue間に依存関係（`前提: #N`、sub-issues）があれば、依存元が先の波になるように並べる。
4. **波を起動する** — 波内の各issueを `Agent` ツール（worktree分離、並列）で起動する。委任プロンプトには必ず次を含める:
   - `dev-flow:ship` スキルで issue <番号> をshipすること。
   - 「他のサブエージェントが同時に別issueをshipしている。PRが `mergeable: CONFLICTING` になったら最新の `origin/main` にrebaseして解決し、force-pushして続行する」という一文。
   - 完了時に報告すべき内容（PR番号・マージ結果・Copilotレビュー対応・残課題）。
5. **波の完了を確認してから次の波へ** — 全エージェントの完了通知を待ち、報告を鵜呑みにせず `gh issue list --milestone "<title>" --state all --limit 200` / `gh pr list --state merged --limit 200` で実際の完了状況（issueクローズ・PRマージ済みか）を確認する。失敗・未完了のissueがあれば、次の波に回すか個別にリカバリしてから、手順4に戻って次の波を起動する。
6. **停止からの再開** — セッション上限などでサブエージェントが停止した場合、"stopped"（completedではない）で通知されるか、**通知自体が来ないことがある**。再開時はまず `gh pr list` / `git worktree list` / 対象ブランチのコミット有無で実際の進捗を確認し、実際に進んでいた分はそのエージェントに追加メッセージを送って再開し（環境にそのためのツールがあれば使う。例: `SendMessage`）、進んでいなかった分だけ新規に仕切り直す（全部を機械的に作り直さない）。
7. **報告する** — マージされたPRの一覧（issue番号との対応）、波ごとの実行結果、リカバリした・持ち越したissue、残ったworktree/ローカルブランチの掃除状況を述べる。マイルストーンの全issueがクローズしたら、リリースは `release` スキルに引き継ぐ。

## 補足

- 各issueの実装フロー（ブランチ・テスト先行・PR・CI・Copilotレビュー・マージ・掃除）はサブエージェント側の `ship` スキルが担う。このスキルはその外側のオーケストレーションだけを扱い、`ship` の手順を親で重複実行しない。
- 波間の完了確認は必ずリモートの実状態（`gh`）で行う。
- リリース作業（バージョンbump・CHANGELOG確定・GitHub Release）はこのスキルの対象外。`release` スキルを使う。
