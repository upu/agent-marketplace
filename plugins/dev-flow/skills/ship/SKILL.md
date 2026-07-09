---
name: ship
description: "既存のGitHub issueをこのリポジトリのGitHub Flowに沿って一気通貫で実装する——issueを読み、最新mainからブランチを切り、テストを先に書いてから実装し、PRを開き、CIが green になり、Copilotレビューを確認したらsquash-mergeする。 when use: 既存issueに取り掛かる、issue N をやって、#N に取り掛かる"
argument-hint: "[<issue番号>]"
---

# Ship Issue

既存のGitHub issueを、このリポジトリのGitHub Flowに沿ってマージ済みPRまで進める。変更は必ずブランチを切ってPR経由でmainに反映し、CIが green になってからマージする。

`$ARGUMENTS` はshipするissue番号。空の場合は `gh issue list` を実行してどのissueをshipするか確認する。

## 手順

1. **issueを読む** — `gh issue view $ARGUMENTS` を実行する。タイトルと受け入れ基準を復唱し、スコープを明確にする。issueが既にクローズ済み、またはスコープが曖昧な場合は、コーディングを始める前にユーザーに確認する。
   - **マイルストーン確認** — issueにマイルストーンが付いておらず（`gh issue view $ARGUMENTS --json milestone`）、オープンなマイルストーンがちょうど1つ存在する場合（`gh api repos/:owner/:repo/milestones?state=open --jq '.[].title'`）、そのマイルストーンにissueを割り当てる（`gh issue edit $ARGUMENTS --milestone <title>`）。複数のオープンなマイルストーンがある場合は、どれに割り当てるか（またはどれにも割り当てないか）をユーザーに確認する。
2. **最新mainからブランチを切る** — `git checkout main`、`git fetch origin && git pull` でmainを最新化し、`git checkout -b <type>/<slug>`（`feat/`・`fix/`・`docs/`・`ci/`・`refactor/` などの種別プレフィックス付き）でブランチを作成する。ファイルを触る前にこれを行い、`git branch --show-current` で新しいブランチに切り替わったことを確認してから手順3に進む。
3. **テストを先に書く** — まずこのリポジトリのテスト構成を調べる（既存の `*.test.*` / `*.spec.*` の配置・命名規則、`package.json` の `test` スクリプト、テストフレームワーク）。issueの受け入れ基準の各項目を、変更対象のソースファイルに対応する既存の命名規則に沿ったテストファイル（新規モジュールなら新規テストファイル）に、実装コードに触れる前に*意図した*挙動として翻訳する。テストを実行し、新しいテストが期待通りの理由で失敗する（挙動がまだ存在しないためred）ことを確認する。タイポのような無関係なエラーで失敗していないことも確認する。テストの実行に、コンパイルやビルドなど前提となる別コマンドが必要な場合（`out/`や`dist/`への出力を前提にテストランナーが動くなど）は先にそれを実行する。テスト対象の挙動が無い変更（純粋なdocs/CI/雑務のissue）の場合のみこの手順を省略し、その旨を明示的に述べる。
4. **実装する** — 編集対象のファイルと周辺コードを読んでから編集する。失敗しているテストを最小限の変更で通す。issueのスコープ内に変更を留める——無関係な改善点に気づいたら、このissueを広げるのではなく別issueとして提案する。周辺のコードスタイルに合わせ、コメントは最小限にする。書く場合も、コードが何をしているかではなく、なぜその実装にしたか（非自明な制約・理由）を残す——行番号への言及や、コード・テスト名が既に表している内容を繰り返すだけのコメントは避ける。
5. **CHANGELOGを更新する** — リポジトリが Keep a Changelog 形式の `CHANGELOG.md`（および翻訳版、例 `CHANGELOG.ja.md`）を採用している場合、ユーザー影響のある変更（新機能、バグ修正、挙動やデフォルトの変更、設定の追加・変更、非推奨化、ユーザーが体感するパッケージング/性能の変更）であれば、該当する全ファイルの `[Unreleased]` セクションに、Keep a Changelogの適切なグループ（Added / Changed / Deprecated / Removed / Fixed / Security）で一行追記する。見出しが無ければ作成する。複数言語版がある場合は必ず全て同じ内容で更新する——片方だけ更新すると、リリース時に `[Unreleased]` セクション間の不整合として弾かれる（`release` スキル参照）。ユーザー影響のない変更（内部リファクタ、ビルド/CI、テスト、ドキュメント、Claudeスキル等）、またはリポジトリがCHANGELOGを採用していない場合はこの手順を省略し、その旨を述べる。
6. **テスト（ゲート）** — このリポジトリのCI設定（例 `.github/workflows/*.yml` のtest/buildジョブ）を確認し、そこで実行されているコマンド列をローカルでも同じ順序で実行する（典型的には lint → compile/build → test → パッケージング検証、だがリポジトリごとに異なるので必ずCI定義を確認して合わせる。二重ビルドを避けるため、複数のステップが同じ成果物に依存するなら共有できる箇所は1回にまとめる）。全て通ること。手順3で書いたテストが今はgreenであることを確認する。redなら直す——ビルドやテストが失敗した状態でPRを開かない。
7. **コミットする** — `git status` / `git diff` で意図した変更だけがステージされていることを確認し、リポジトリの直近のコミット履歴のスタイル（言語・書式）に合わせて、末尾に `Closes #$ARGUMENTS` を付けてコミットする。
8. **プッシュ & PR** — `git push -u origin <branch>` の後、`gh pr create --base main` でPRを作成する。`.github/pull_request_template.md` が存在すればその構成に沿って本文を書き、無ければ変更内容の要約でよい。いずれも末尾に `Closes #$ARGUMENTS` を付ける。テストが通ったこと、CHANGELOGを追記した（またはN/Aである）ことを本文に反映する。
9. **CIを待つ** — 全チェックが終わるまで1回のフォアグラウンド呼び出しでブロックし、失敗時は非ゼロで終了するコマンドを、長めのタイムアウト（例 600000 ms / 10分）を付けて実行する。バックグラウンドで発火して後のターンで継ぎ足す運用はしない——CI待ちとマージは、ツール呼び出しの構文ミスでセッションが止まりやすい箇所であり、事後に「発火していないことに気づく」ことに頼らず、各手順を半端に発火できない単一の自己完結した呼び出しにする。
   - Bashツールが使える環境: `set -o pipefail; gh pr checks <pr> --watch --fail-fast 2>&1 | tail -5` （`--watch` は10秒ごとにチェック表全体を再出力し長時間のPRラッシュでコンテキストを圧迫するので `tail -5` で抑える。`set -o pipefail` で失敗チェックの非ゼロ終了をパイプ越しに保持する）。
   - PowerShellのみの環境: `gh pr checks <pr> --watch --fail-fast 2>&1 | Select-Object -Last 5; if ($LASTEXITCODE -ne 0) { throw "PR checks failed" }` （PowerShellはネイティブコマンドの終了コードをパイプ越しでも `$LASTEXITCODE` に保持するので、これで失敗を確実に検知できる）。
   - チェックが失敗したら、実行ログを確認し、直してから再度プッシュする。特定のチェック（例 `test`）が一向に一覧に現れず、無関係なチェックだけが完了する場合、そのPRは `origin/main` と `mergeable: CONFLICTING` の可能性が高い——GitHubは競合しているPRに対してそのワークフローの起動を失敗ではなく黙ってスキップすることがある。`gh pr view <pr> --json mergeable` で確認し、該当すれば最新の `origin/main` にrebaseして解消し、force-pushして再度watchする。
10. **Copilotレビューが有効か判定してから待つ** — Copilotの自動コードレビューはリポジトリ／PRごとの設定でON/OFFが切り替わるため、まず「そもそもレビューがリクエストされているか」を確認してから待つかどうかを決める。ポーリングを始める前に必ず1回、次を判定する（現HEADの `sha` を先に取得し、以降のポーリングでもこの `sha` を使い回す——古いcommitのレビューを新pushの完了と誤認しないため。新しいpush後は改めて `sha` を取り直す）:
    - `gh pr view <pr> --json reviewRequests,reviews` で、`reviewRequests` に `Copilot`（レビュー依頼中。`login` または `name` が `Copilot` ないし `copilot-pull-request-reviewer`）があるか、`reviews` に `author.login == "copilot-pull-request-reviewer"` かつ `commit.oid == <sha>` のレビューが既にあるか（`done`）を見る。
    - 両方とも無い場合のみ、念のため `gh api repos/:owner/:repo/issues/<pr>/timeline --paginate` で `event == "review_requested"` かつレビュワーがCopilot関連のイベントが過去に無いかも確認する（このPRでCopilotレビューが一度も設定されていないことの追加根拠にする）。
    - **`pending` も `done` も `timeline` の根拠も全て無い** → このPRではCopilotレビューが要求されていない（自動レビュー設定がOFF、またはCopilotがreviewerから外されている）。待たずにこのステップを省略し、その旨を報告に含める。
    - **`done` が既にある（`pending` は無い）** → レビューは完了済み。待たずにそのまま次のレビュー内容判断に進む。
    - **`pending` がある（レビュー中）** → 単一のフォアグラウンド呼び出しで、20〜30秒間隔・合計10〜15分程度のuntil-loopとしてポーリングする（バックグラウンド発火や後のターンでの再開はしない）。**短時間（数回のポーリング）で両方空だったからといって「未設定」と判断しない** ——非同期の反映遅延で、レビューがマージ直後に着弾した実例がある。全期間を通して両方空のときのみ「この commit では Copilot レビュー適用なし」と結論しMergeへ進む。タイムアウトに達してもレビューが確認できない場合は、その旨をユーザーに伝えた上でマージに進んで良い（レビューは非同期でも後から届く）。
    - Copilotのレビューが手に入ったら（上記いずれの分岐でも）本文（`gh pr view <pr> --json reviews`）とインラインコメント（`gh api repos/:owner/:repo/pulls/<pr>/comments --jq '.[] | select(.user.login=="Copilot") | {path,line,body}'` — インラインコメントの `user.login` と、レビュー本体の `author.login`（`copilot-pull-request-reviewer`）は別フィールドである点に注意）を読み、次のいずれかを判断する:
      - 単なる提案・nit・スタイルの指摘のみ、またはスコープ外・誤検知 → 内容をユーザーに一言報告し、返信（コード変更なし）してマージへ進む（必要なら別issueとしてフォローアップを提案する）。
      - 実際のバグ・見落とし・スコープ内の問題を指摘している → 追加コミットで修正し、手順6（テストのゲート）をやり直し、`git push` して手順9（CI待ち）からやり直す。
    - fixup push後に再レビューが来るかは一貫しない。「タイムアウト内で来るかもしれない」前提で扱い、「必ず来る/来ない」と決め打ちしない。実際に着弾したレビューの全指摘が「修正して返信」または「返信のみ」で解決されるまではMergeへ進まない（マージ後に指摘へ気づく事故を防ぐため）。
11. **マージする** — `gh pr merge <pr> --squash --delete-branch` を実行する。`--delete-branch` はリモートの作業ブランチ削除を試みるが、権限や状況によっては失敗することもあるため、必ず消える前提は置かない。その後 `git checkout main && git pull` でローカルの `main` を同期する。
12. **ローカルブランチを掃除する** — 過去のshipで作られたローカルブランチが、共有のメインチェックアウトに残り続けやすい。マージ後、`git fetch --prune origin` を実行する（squashマージだとローカルブランチの先端コミットが `origin/main` の履歴に含まれないため `git branch --merged origin/main` では列挙されない点に注意——マージ方式によって挙動が変わる）。掃除の起点には `git branch -vv` で upstream が `[origin/<branch>: gone]` になっているローカルブランチ（＝リモート側のブランチが削除済み）を探す。ただし `gone` は削除済みを示すだけでマージ済みを保証しないため、削除前に対応するPRが `gh pr view <番号または対応するブランチ名> --json mergedAt --jq '.mergedAt'` で `mergedAt` が入っている＝merged済みであることを確認してから `git branch -D <branch>` で削除する（squashマージではブランチのコミットSHAが `origin/main` の履歴に入らないため、コミット差分ベースの判定はマージ済みでも空にならず誤判定になる——判定は必ずPRのマージ状態で行う）。
13. **報告する** — マージされたPR番号、`Closes #N` によりissueが自動クローズされたこと、新しい `main` のコミット、Copilotレビューの結果（あれば）、掃除したローカルブランチを述べる。

## 補足

- `main` へは直接pushせず、必ずブランチを切ってPR経由で反映する。
- 1 issue = 1 PR。実装途中でスコープが膨らんだら、別issue/別PRに分割する。
- このスキルは既に存在するissueが対象。ユーザーがissue化されていない新規の作業内容を説明してきた場合は、まず `gh issue create` を提案してからshipする。
- CI待ち・Copilotレビュー待ち・マージの手順は、ツール呼び出しの構文ミスでセッションが止まりやすい箇所。事後に「発火していないことに気づく」ことに頼らず、各手順を半端に発火できない構造にする——手順9のCI待ち、手順10のポーリングループ、手順11の `gh pr merge` は、それぞれ1つの自己完結したフォアグラウンド呼び出しにし、後のターンで再開することを前提にしたバックグラウンド発火はしない。
- 手順2を飛ばして変更がローカル `main` に乗ってしまったことに気づいた場合（`git branch --show-current` や `git status -sb` で確認できる）、`main` に一切pushせずに復旧する: まだコミットしていなければ `git checkout -b <branch>` で変更ごと新しいブランチへ移せる。既にコミット済みなら `git branch <branch>` でそのコミットにブランチを立て、`git reset --hard origin/main` でローカル `main` を復元し、`git checkout <branch>` で作業を続ける。
- リリース作業（バージョンbump・CHANGELOG確定・GitHub Release）はこのスキルの対象外。`release` スキルを使う。
