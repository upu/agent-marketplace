# ship スキル reference——ルールの背景・理由・実測談

`SKILL.md` 本文のルールが「なぜそうなっているか」をここに集約する。ルール自体（何をするか）は本文にあり、このファイルは本文のルールを疑問に思ったとき・改訂するときに読む。見出しは本文の手順番号に対応する。

## 手順5: CHANGELOG の多言語版を必ず全て同じ内容で更新する理由

片方だけ更新すると、リリース時に `[Unreleased]` セクション間の不整合として `release` スキルの検証で弾かれる。

## 手順6: CI のコマンド列をローカルで再現する際の注意

典型的には lint → compile/build → test → パッケージング検証だが、リポジトリごとに異なるので必ずCI定義を確認して合わせる。「共有できるビルドは1回にまとめてよい」のは、複数のステップが同じ成果物に依存するときの二重ビルドを避けるため。

## 手順9: wait-ci.js の内部挙動

- `gh pr checks` を内部でポーリングし、状態が変化するたびに1行標準出力する（沈黙のまま止まって進行不能になることを防ぐ設計）。
- 外部の `jq` コマンドには依存せず、`gh` の生JSON出力をNode側でパースする——開発機に `jq` 本体が入っているとは限らないため。
- `NO_CHECKS:`（CI設定なし）は2回連続で「no checks」を観測してから結論する——push直後にワークフローがまだ登録されていないだけの「見せかけの無設定」と誤認しないため。

## 手順9: チェックが現れないときに mergeable を疑う理由

GitHubは `origin/main` と競合している（`mergeable: CONFLICTING`）PRに対し、ワークフローの起動を失敗ではなく黙ってスキップすることがある。その結果、特定のチェック（例 `test`）が一覧に現れないまま、無関係なチェックだけが完了して見える。

以前はこの確認をモデルが手動で気づいて `gh pr view <pr> --json mergeable` を実行する必要があったが（agent-marketplace#58以前）、見落とされるとチェックが永遠に現れないままタイムアウトするまで気づけなかった。今は `wait-ci.js` がポーリングループの中でこの確認を自動化している——PENDINGチェックのメッセージが `STALL_LIMIT`（3）回連続で完全一致した場合、またはタイムアウト直前になった場合に `mergeable` を確認し、`CONFLICTING` なら専用の `CONFLICTING:` ログ行と終了コード `3` で終了する。毎ポーリングで確認しないのは、通常のCI変動（別チェックがpending→pendingへ変化する等）のたびに余計な `gh` 呼び出しを増やさないため。rebase自体（コンフリクト解消）はスクリプトが自動化せず、`ship` 手順9側の分担のまま残す。

## 手順10: wait-copilot-review.js の内部挙動

Copilotの自動コードレビューはリポジトリ／PRごとの設定でON/OFFが切り替わるため、「そもそもレビューが要求されているか」の判定と待ちを1コマンドにまとめている:

- まず指定shaに対する提出済みレビュー（`author.login == "copilot-pull-request-reviewer"` かつ `commit.oid == <sha>`）を確認する。shaで照合するのは、古いcommitへのレビューを新しいpushの完了と誤認しないため。
- 無ければ `reviewRequests`（`Copilot` 名義のpending）をポーリングする。
- pendingが一度も見えないまま最初のポーリングが成功で返った場合のみ、PRのtimelineで過去に一度もCopilotへのレビュー依頼が無かったかを追加確認してから `NOT_CONFIGURED:` で終了する。短時間で空だからといって即「未設定」と結論しないのは、非同期の反映遅延によりレビューがマージ直前に着弾した実例があるため——pendingが一度でも見えたらタイムアウトまで待つ。
- `gh` の呼び出しエラー（認証切れ・レート制限・一時的なAPI障害）は1回で諦めず、`ERROR (retrying):` を出力して再試行する。

## 手順10: インラインコメントの取得で `user.login` を見る理由

インラインコメント（`gh api .../pulls/<pr>/comments`）の投稿者は `user.login == "Copilot"`、レビュー本体（`gh pr view --json reviews`）の投稿者は `author.login == "copilot-pull-request-reviewer"` と、別フィールド・別名義になっている。どちらか一方の名義でもう一方をフィルタすると空になる。

## 手順10: fetch-copilot-feedback.js の内部挙動

以前はこの取得を「本文は `gh pr view --json reviews`、インラインコメントは手書き `--jq` 付きの `gh api .../comments`」という2つの生 `gh` 呼び出しに分けてプロースで説明していたが（agent-marketplace#59以前）、手書きjqは過去に事故の原因になったクラスの操作(agent-marketplace#7)だった。`fetch-copilot-feedback.js <pr> [sha]` はこの2回の呼び出しを1回のスクリプト実行にまとめ、`gh` の生JSONをNode側でパースして `{ summary, state, inlineComments: [{path, line, body}] }` を返す。`wait-copilot-review.js` へ `--dump` フラグを足す案（案1）ではなく独立スクリプト（案2）にしたのは、「待つ」と「読む」の責務を分け、`merge-pr.js`/`cleanup-merged-branches.js`/`wait-ci.js` と同じ一スクリプト一責務の構成に揃えるため。sha省略時は `wait-copilot-review.js` と同じく現HEADを使う——両スクリプトが同じcommitのレビューを見ていることを保証するため。

## 手順10: 指摘の修正を1回のfixup pushに束ねる理由

fixup pushごとに再レビューが走り、新しい指摘が1件ずつ出る数珠つなぎの往復になる（実測でPRあたり3ラウンド）。これを避けるため、指摘を「その行だけの修正依頼」ではなく「このクラスの問題がdiffに存在するという信号」として扱い、push前に同種の観点でdiff全体を掃いて同類も直す。なお、fixup push後に再レビューが来るかは一貫しないことが実測で分かっている——「必ず来る/来ない」と決め打ちしないルールはこれによる。

## 手順11: merge-pr.js の内部挙動

`gh pr merge --delete-branch` はマージ後の後処理としてローカルで `git checkout main` を行い、その後にリモートブランチを削除する。linked worktree では `main` が主 worktree にチェックアウト済みのため checkout が必ず失敗し、マージ自体は GitHub 側で成功しているのにリモートブランチ削除が実行されないまま終わる。ghost-align v1.4.0 の batch-ship（2026-07-10）では、worktree 分離で並列実行したサブエージェントのほぼ全数がこの失敗に当たり、毎回 `git push origin --delete` や `gh api DELETE` での手動リカバリが必要になった。プロースの手順として維持する限りモデルが分岐を読み飛ばすたびに再発しうるため、判定・分岐・削除確認を `merge-pr.js`（agent-marketplace#56）に切り出した:

- `git rev-parse --git-common-dir` の出力が `.git`（通常ツリー）か、それ以外の絶対パス（linked worktree）かで分岐する。
- 通常ツリー: `gh pr merge <pr> --squash --delete-branch` を実行して終了する。
- worktree: マージ前に `gh pr view <pr> --json headRefName` でブランチ名を取得し（マージ後ではなく前に取得するのは、取得失敗時にブランチ名不明のままマージ済みにしないため）、`--delete-branch` なしでマージし、`gh pr view <pr> --json mergedAt` で `mergedAt` が入っていることを確認してから `git push origin --delete <branch>` を実行する。`git checkout main` は行わない。
- リモートブランチ削除（`--delete-branch` 経由・worktree の明示削除経由のいずれも）の失敗は、マージ自体が成功していればログの1行に留め、終了コードは失敗にしない——`gh pr merge --delete-branch` 自体も削除の成功を保証しない既存の前提と揃える。
- `gh pr merge` 自体が失敗する（CI未green・コンフリクト等）場合はエラーをそのまま呼び出し元に伝播させ、終了コード `1` にする。

## 手順12: ワークフローファイル変更時に実発火を確認する理由

agent-marketplace自身のv0.2.0リリース（2026-07-11）で `.github/workflows/release.yml` を新設した際、`node --test` は139件全green だったにもかかわらず、実際のリリース実行で2回連続して失敗した（agent-marketplace#48, #50）。原因はGITHUB_TOKENのデフォルト権限にMilestones APIへのアクセスが無かったこと、`actions/checkout` がリモートの全タグを必ずしもfetchしないことの2点で、どちらも `git`/`gh` 呼び出しをモックしたユニットテストでは原理的に検知できない。`push`専用トリガーなど、PR自体のCI（`pull_request` イベント）では一度も実行されないワークフローは、テストゲート（手順6）がgreenでも実運用未検証のまま完了扱いになってしまう。

## 手順13: マージ済み判定を必ずPRの `mergedAt` で行う理由

squashマージではローカルブランチの先端コミットが `origin/main` の履歴に含まれない。そのため `git branch --merged origin/main` ではマージ済みブランチが列挙されず、コミット差分ベースの判定はマージ済みでも空にならず誤判定になる——マージ方式によって挙動が変わるので、判定は必ずPRのマージ状態で行う。また upstream の `gone` はリモートブランチが削除済みであることを示すだけで、マージ済みを保証しない。

## 手順13: worktree実行時にチェックアウト中ブランチをSKIPする理由

手順11（`merge-pr.js`）はlinked worktreeでは意図的に `git checkout main` を行わない（`main` は主worktreeが使用中で必ず失敗するため）。そのためworktreeはマージ対象だったブランチにチェックアウトしたまま残る。一方、そのブランチのリモート側はworktree分岐の `git push origin --delete <branch>` で既に削除済みなので、手順13冒頭の `git fetch --prune origin` により、このworktreeが今まさにチェックアウトしているブランチのupstreamも `[gone]` になる——マージ未確認のブランチと見分けがつかない形で削除候補に混入する。

`git branch -D` はチェックアウト中のブランチ（別worktreeで使用中の場合を含む）を構造的に拒否する（`error: cannot delete branch '...' used by worktree at '...'`）。以前はこれを「予期しないエラー」として `cleanup-merged-branches.js` 全体が終了コード1で落ちていた（agent-marketplace#80で実機再現）。

修正は `git worktree list --porcelain` から現在チェックアウト中の全ブランチ（主worktree・全linked worktree）を収集し、PRのマージ状態を確認する*前*に削除候補から差し引く方式（`listCheckedOutBranches`）。`merge-pr.js` の `isLinkedWorktree`（`git rev-parse --git-common-dir` で構造的事実を見る）と同じ流儀で、「今自分がworktreeかどうか」を判定するのではなく「gitが実際に削除を拒否する状態か」を直接見ている——現在のworktreeが `git worktree list` に自分自身を含むため、通常ツリー実行時は除外対象が実質増えない（`main` 等、そもそも `[gone]` にならないブランチしか該当しない）。除外されたブランチは `SKIP:<branch> - checked out in a worktree` としてログに残り、実削除はそのworktree自体が撤去されて使用中でなくなった後の掃除サイクルに委ねる（issue #78のスコープ）。

## 手順14: ユーザー操作感に影響する変更で手動確認を提案する理由

このスキルはマージまで自動で進むため、自動テストとCIがgreenでも、操作感（新しいUI・コマンドの使い勝手・出力の見た目・対話フロー）は人間が一度も触らないままリリースに進むことがあり得る。操作感の良し悪しはテストが原理的にカバーしない領域なので、報告時に手動確認を明示的に提案する。

「試し方」と「OKの基準」をセットで必須にしているのは、手順だけ提案してもユーザー側は何をもって成功と判断すればよいか分からず、確認がスキップされがちになるため。前提条件（プラグイン更新・セッション再読み込み等）を含めるのは、変更直後の環境では新しい挙動がまだ反映されていないことがあり、「試したが変わっていない」という誤った失敗判定を防ぐため。

## 補足: 待ちの手順でMonitor背景監視／単一フォアグラウンド呼び出しを使い分ける理由

CI待ち・Copilotレビュー待ち・マージは、ツール呼び出しの構文ミスでセッションが止まりやすい箇所。フォアグラウンドの単一呼び出しを既定とするのは、後のターンでの継ぎ足しを前提にしたバックグラウンド発火は、その継ぎ足しを忘れた時点で進行不能になるため。

サブエージェント実行で背景監視を禁止するのは実測に基づく: ghost-align v1.4.0 の batch-ship（2026-07-10）で、CI待ちをバックグラウンド化してターンを終えたサブエージェントが2体、「CI待ちの通知を待ちます」と報告したまま停止扱いになった。停止したエージェントには完了通知が届いても作業は再開されず、親セッションが実状態をポーリングして `SendMessage` で再指示するリカバリが毎回必要になった。委任プロンプトに「CI待ちで打ち切らない」と書くだけでは防げなかったため、スキル本文の手順として固定している。

対話セッション本体に限ってMonitor背景監視を許すのは、Monitorは状態変化・完了時に自動で通知が届く設計なので、「発火し忘れる」「後のターンで継ぎ足すのを忘れる」事故が起きないため（ただし監視スクリプトは成功・失敗どちらの終端状態も拾うこと。沈黙のまま止まると進行不能になる）。
