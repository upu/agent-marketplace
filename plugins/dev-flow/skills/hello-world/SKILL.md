---
name: hello-world
description: "マーケットプレイス経由でこのプラグインが正しく参照・インストールされているかを確認するための動作確認用スキル。when use: agent-marketplaceの疎通確認をしたい、dev-flowプラグインが正しく読み込まれているか確認したい"
---

# Hello World（疎通確認）

このスキルは `upu/agent-marketplace` の `dev-flow` プラグインが、他リポジトリから
`/plugin marketplace add` → `/plugin install` で正しく参照・インストールできているかを
確認するためだけのスキルです。実際の開発作業は行いません。

## 手順

1. ユーザーに「dev-flowプラグイン（agent-marketplace経由）は正常に読み込まれています 🎉」と挨拶する。
2. 現在のリポジトリ名とブランチ名を `git remote get-url origin` / `git branch --show-current` で確認し、どのリポジトリからこのスキルが呼ばれたかを報告する（取得に失敗した場合は「不明」とする）。
   origin URL は生の値をそのまま出力せず、`@` より手前の userinfo（トークン等）を必ず伏せる。
   HTTPS/SSH いずれもホスト名とパス部分のみを報告する（例: `github.com/upu/Totonoe-Log.git`）。
   SSH 形式（例: `git@github.com:upu/Totonoe-Log.git`）は `github.com/upu/Totonoe-Log.git` のように `:` を `/` に正規化する。
3. 疎通確認が目的であることを伝え、本番の開発フロースキル（plan-next, ship など）は
   別途このプラグインに追加されていく予定であることを補足する。

## 補足

- このスキルは疎通確認用のプレースホルダーです。`dev-flow` に実運用スキルが揃った段階で
  削除して構いません。
