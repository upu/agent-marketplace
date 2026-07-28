# release スキル reference——ルールの背景・理由・実測談

`SKILL.md` 本文のルールが「なぜそうなっているか」をここに集約する。ルール自体（何をするか）は本文にあり、このファイルは本文のルールを疑問に思ったとき・改訂するときに読む。見出しは本文の手順番号に対応する。

## 手順2: CHANGELOG の desync を先に解消する理由

片方の言語版だけ `[Unreleased]` にエントリがある状態は、手順5の `prepare-release.js` でも不整合として弾かれる。先に解消しておかないとスクリプトが進まない。

## 手順5: prepare-release.js が行うことの詳細

- `CHANGELOG.md` と `CHANGELOG.ja.md` の `## [Unreleased]` が、当日ローカル日付付きの `## [x.y.z] - YYYY-MM-DD` に変更される。
- 末尾リンク参照も更新され、`[Unreleased]` は `.../compare/vx.y.z...HEAD` に向き、新規 `[x.y.z]: .../releases/tag/vx.y.z` が追加される（リンクのホスト/オーナー/リポジトリ名は対象リポジトリの `git remote origin` から自動判定される）。
- `package.json` の `"version"` も更新される。
- 対象リポジトリに `package-lock.json` があれば、そのトップレベル `"version"` と `packages[""].version` も同じ値に同期される（npm install は走らせない）。存在しないリポジトリ（yarn/pnpm 等）ではスキップされる。

「手動でファイルを編集してはいけない」のは、複数ファイル・リンク参照・lockfile の同期をスクリプトが一貫して保証しているため——手編集は取りこぼしや不整合の源になる。

## 手順8: PR 本文を `--body-file` で渡す理由

インラインで backtick や `$()` を使うと `gh pr *` の allowlist に合わないことがある。

## 手順9: なぜ `release` も `wait-ci.js` を使う必要があるか

`ship` の CI 待ち（手順9）は以前から `wait-ci.js` を使っていたが、`release` の CI 待ち（手順9）はagent-marketplace#83以前、素の `gh pr checks --watch --fail-fast` を単発フォアグラウンド呼び出しとして直接実行していた。この非対称は意図的な設計差ではない。共通スクリプト抽出（agent-marketplace#22）の受け入れ基準は当初から「`release` 手順10（Copilotレビュー待ち）」のみを対象にしており、`release` の**CI待ち**は最初からスコープ外だった。そのため、CIチェックが `origin/main` との `mergeable: CONFLICTING` により黙ってスキップされる問題（agent-marketplace#58、詳細は `ship` reference.md 手順9参照）に対する `wait-ci.js` 側の自動検知修正（agent-marketplace#64）も、`release` には一度も引き継がれていなかった。`release` のPRも保護ブランチ `main` へのマージが前提であり、`ship`/`batch-ship` 等の並行作業が先にマージされればコンフリクトは同様に起こり得る。発生すると、旧実装は該当チェックが二度と現れないまま単発呼び出しのタイムアウト（reference.md旧記載の例で600000ms=10分）まで無言で待ち続け、`CONFLICTING` という診断もなく単なる「タイムアウト」として処理されてしまっていた。そのため `release` 手順9も `wait-ci.js`（`CONFLICTING:` 検知を含む）に置き換えている。

## 手順12: `gh run watch` をパイプせず直接実行する理由（agent-marketplace#98）

- 旧実装は `set -o pipefail; gh run watch <run-id> --exit-status 2>&1 | tail -20` だった。`tail -20` で数秒ごとの全表再出力を抑制し、`set -o pipefail` でパイプ越しに non-zero 終了コードを保持する構成だが、どちらも POSIX シェル専用（`bash`/`zsh` 等）で Windows PowerShell では組み込みコマンドとして存在しない。
- Windows と POSIX の両方で同じ意味・同じ終了判定にするため、パイプを外し `gh run watch <run-id> --exit-status` を単発フォアグラウンドで直接実行する構成に変更した（issue #98 設計メモの案1）。出力抑制より移植性と終了コード保持を優先する——`--exit-status` の終了コードがそのままコマンドの終了コードになるため、シェルの種類に関係なく non-zero を確実に検知できる。
- バックグラウンド実行して後のターンで継ぎ足す運用は、CI 待機でツール呼び出しミスを誘発しやすいので避ける——「事後で実行されていないことに気づく」運用は再発しがち（注意事項の単発フォアグラウンド構成の根拠も同じ）。手順9は `wait-ci.js` が内部でポーリングと出力抑制を行うため、この配慮は不要。

## 手順10: wait-copilot-review.js の内部挙動と設計理由

- このリポジトリの branch ruleset は push ごとの Copilot 自動レビュー要求（`copilot_code_review`, `review_on_push: true`）を設定できるが、常時有効とは限らない——「要求されているかの判定」と「待ち」を1コマンドにまとめているのはこのため。
- スクリプトは `gh` を execFileSync 経由の引数配列で呼ぶため、`--jq` もシェルクォートも不要。`gh pr view` の `--jq` が jq 式1つしか受け付けず `--arg` 等の変数注入をサポートしない点や、`reviewRequests[].login`（依頼中は `Copilot`）と `reviews[].author.login`（提出済みは `copilot-pull-request-reviewer`）の使い分けは、スクリプト内部で処理済み。
- 短時間で空だからといって「未設定」と判断しない——非同期の反映遅延で、レビューがマージ直前に着弾した実例がある。スクリプトは pending が一度でも見えたらタイムアウトまで待ち、一度も見えないまま最初のポーリングが成功で返った場合のみ timeline を確認して `NOT_CONFIGURED:` と判断する。

## 手順10: インライン指摘の取得で `user.login` を見る理由

インラインコメント（`gh api .../pulls/<pr>/comments`）の投稿者は `user.login == "Copilot"` で、レビュー本体の `author.login`（`copilot-pull-request-reviewer`）とは別フィールド・別名義（API 実測済み）。

## 手順10: 手動での再レビュー後押しに依存しない理由

`gh api .../requested_reviewers -f 'reviewers[]=Copilot'` や `gh pr edit --add-reviewer Copilot` は、`reviewRequests` へ即反映しないケースがあるため、実行しても「これで必ず再レビューが来る」とは扱えない。fixup push 後に再レビューが来るかも一貫しない。

## 手順13: Release 作成後の失敗で「タグ削除 → re-run」が安全な理由

`verify-pat` はすでに通っており未達なのは Marketplace 公開だけ、というケースでは、GitHub Release とタグを削除して作り直しても Marketplace 側には何も反映されていない（＝重複や不整合が生じない）。逆に単純 Re-run は「Release 既存」ゲートによりジョブ全体がスキップされ、publish の再試行にならない。
