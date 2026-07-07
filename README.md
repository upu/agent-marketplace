# agent-marketplace

upu の開発プロジェクト（[Totonoe-Log](https://github.com/upu/Totonoe-Log)、[ghost-align](https://github.com/upu/ghost-align) など）間で
共通の agent skills / plugins を共有するための Claude Code プラグインマーケットプレイスです。

## 提供プラグイン

| プラグイン | 説明 |
| --- | --- |
| [dev-flow](./plugins/dev-flow) | 開発フローを支援するスキル集（plan-next, ship など） |

今後、VSCode 拡張機能開発に特化した `vscode-ext-toolkit` プラグインの追加を予定しています。

## 使い方

Claude Code 上で以下を実行してください。

```
/plugin marketplace add upu/agent-marketplace
/plugin install dev-flow
```

## 参考ドキュメント

- [Plugins reference](https://code.claude.com/docs/ja/plugins-reference)
- [Plugin marketplaces](https://code.claude.com/docs/ja/plugin-marketplaces)
