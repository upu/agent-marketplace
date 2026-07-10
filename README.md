# agent-marketplace

upu の開発プロジェクト（[Totonoe-Log](https://github.com/upu/Totonoe-Log)、[ghost-align](https://github.com/upu/ghost-align) など）間で
共通の agent skills / plugins を共有するための Claude Code プラグインマーケットプレイスです。

## 提供プラグイン

| プラグイン | 説明 |
| --- | --- |
| [dev-flow](./plugins/dev-flow) | 開発フローを支援するスキル集（propose-improvements、plan-next、ship、batch-ship、release、retro など） |

今後、VSCode 拡張機能開発に特化した `vscode-ext-toolkit` プラグインの追加を予定しています。

## 使い方

Claude Code 上で以下を実行してください。

```
/plugin marketplace add upu/agent-marketplace
/plugin install dev-flow
```

インストールすると、プロジェクトの `settings.json` に以下のように登録されます
（マーケットプレイスの識別子は `upu-agent-marketplace` で、リポジトリ名 `agent-marketplace` とは
別管理です。他の組織のマーケットプレイスと衝突しないよう owner を含めた名前にしています）。

```json
{
  "enabledPlugins": {
    "dev-flow@upu-agent-marketplace": true
  }
}
```

インストール後、Totonoe-Log や ghost-align など任意のリポジトリで、Claude Code のプロンプトに
`x.y.z をリリースして` のように入力し `release` スキルが起動できれば、
マーケットプレイス経由での参照が正しく機能しています。現時点の `dev-flow` は、コードをレビューして改善案・新機能案をissue化する
`propose-improvements` スキル、オープンなissueから次バージョンのスコープを決めてマイルストーンを作る `plan-next` スキル、
既存のGitHub issueをPRのマージまで進める `ship` スキル、複数issueをサブエージェント委譲で一括実装する `batch-ship` スキル、バージョンリリース作業を支援する `release` スキル、リリース後のふりかえりを仕組みの改善に変える `retro` スキルを含みます。
実運用スキルは今後も随時追加予定です。

## 更新方法

`/plugin marketplace add` でマーケットプレイスを追加すると、Claude Code はプラグインの内容をローカルにキャッシュします。
このキャッシュは `main` の更新に自動追従しません。挙動が変わるスキル更新（バグ修正・新スキル追加など）を取り込むには、
利用側のリポジトリで以下を実行してください。

```
/plugin marketplace update upu-agent-marketplace
```

更新後にスキルの挙動が反映されない場合は、続けて `/reload-plugins` を実行してください。

各変更内容は [CHANGELOG.md](./CHANGELOG.md)（英語・正本）/ [CHANGELOG.ja.md](./CHANGELOG.ja.md)（日本語訳）で確認できます。
`dev-flow` プラグインの `plugin.json` にも `version` フィールドがあり、SemVer で管理しています。

なお、このリポジトリ自身のリリース作業（タグ付け・GitHub Release）はまだ自動化していません。
配布している `release` スキルは `package.json` の存在を前提にしており、npm パッケージを持たないこのリポジトリには
現状そのまま適用できないため、当面は `plugin.json` の `version` と CHANGELOG を手動で更新して管理します。

## スキル開発

このリポジトリにスキル（`SKILL.md`）を追加・変更する際は、以下の執筆規約に従ってください。

- **SKILL.md は本文・frontmatter の `description` とも日本語で書く。** オーナーが読みやすいようにするための方針です（2026-07-06 の明示依頼）。
- **トリガー用の例文（`description` 内の `when use:` 以降など）は日本語を主にしつつ、英語の代表例も残してよい。** `when use:` のような英語のラベル自体や、英語での呼び出し例が `description` に含まれるのは、この方針の例外として許容されます。

## 参考ドキュメント

- [Plugins reference](https://code.claude.com/docs/ja/plugins-reference)
- [Plugin marketplaces](https://code.claude.com/docs/ja/plugin-marketplaces)
