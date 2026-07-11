# 背景・理由

## なぜ `dev-flow` の `release` スキルをそのまま使わないか

`dev-flow` の `release` スキルは他リポジトリ（npm/VSCode拡張などを持つプロジェクト）向けの汎用スキルで、`prepare-release.js` はルートの `package.json` を即読み込みする実装になっている。`agent-marketplace` はClaude Codeプラグインのマーケットプレイスであり、npmパッケージでもVSCode拡張でもないため `package.json` を持たない。v0.1.0のリリース（#34）で実際にこの前提のズレが発覚し、CHANGELOG確定・version bumpを手動で行い、タグ作成・GitHub Release作成もその場で `git tag` / `gh release create` を都度組み立てるほかなかった（#35）。

`release` スキル側に「`package.json` が無い場合の分岐」を増やすことも考えられるが、このリポジトリはユーザーが保有する唯一のClaude用スキルリポジトリであるため、汎用スキル側を複雑にするより、このリポジトリ専用の薄いスキルを別に用意するほうが筋が良いと判断した。

## なぜタグ・Release作成をスキルの外（`release.yml`）に出したか

`dev-flow` の `release` スキル自体も「PRマージまでがスキルの責務、タグ作成・GitHub Release作成はマージ後のCIワークフローの責務」という分担を採用している。同じ設計をこのリポジトリにも適用した。理由は2つ:

- PRマージ後のタグ・Release作成は決定的な機械的処理（CHANGELOGから最新バージョンを読み取ってタグを打つだけ）で、Claudeが都度手で組み立てる意味がない。
- CIworkflow化しておけば、`ship`で別のPRが先にマージされて `main` が動いていても、リリースPRのマージさえ検知できれば確実に実行される。

`scripts/release-tag.js` は「`[Unreleased]` が空、かつ対象バージョンのタグがまだ無い」ときだけ実際にタグ・Releaseを作成する設計にしている。これにより、通常の機能追加PR（`[Unreleased]` にエントリが残る）のマージでは何もせず、リリースPRのマージだけをトリガーにできる。

## マイルストーン自動クローズについて

`dev-flow` の `release` スキルの手順14（マイルストーンの自動クローズ確認）と同じ考え方を踏襲した。`vX.Y.Z` マイルストーンの全issueがクローズ済みならCIが自動でクローズし、まだ未クローズのissueが残っていれば `::warning::` を出すだけでクローズしない（見かけ上整えるための強制クローズはしない）。
