# 変更履歴

このプロジェクトの注目すべき変更はすべてこのファイルに記録します。

フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に基づき、
このプロジェクトは [セマンティックバージョニング](https://semver.org/lang/ja/spec/v2.0.0.html) に従います。

## [Unreleased]

### Added

- `dev-flow` プラグインの `plugin.json` に `version` フィールドを追加し、SemVer で管理を開始。
- Keep a Changelog 形式の `CHANGELOG.md` / `CHANGELOG.ja.md` を追加し、スキルの挙動変更を利用側が追えるようにした。

### Changed

- `ship` のCI待ちと、`ship`・`release` のCopilotレビュー待ちを、モデルが長いbash/jqループを書き写す方式から、同梱のNodeスクリプト（`wait-ci.js`・`wait-copilot-review.js`）を起動する方式に変更し、引用符・jqエスケープの誤りが起きやすかった箇所を解消（`release` 自体のCI待ちは引き続き `gh pr checks --watch` を使用）。

### Docs

- README に、スキル更新を取り込むための `/plugin marketplace update upu-agent-marketplace` の実行手順を明文化。

[Unreleased]: https://github.com/upu/agent-marketplace/compare/bd3a70fe000928f67ae7eb15caea25f8729211b0...HEAD
