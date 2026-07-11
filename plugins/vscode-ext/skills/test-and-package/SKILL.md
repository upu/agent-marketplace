---
name: test-and-package
description: "テスト→パッケージ内容のallowlist検証→green のときだけ .vsix をビルドする、VS Code拡張向けゲート付きビルド手順。 when use: 拡張をテストしてパッケージしたい、動作確認用のvsixが欲しい、/test-and-package"
argument-hint: "[install]"
---

# Test and Package

VS Code拡張を compile → test → パッケージ内容検証のゲートを通してから `.vsix` を作る。壊れたパッケージを配らないための手順。

`$ARGUMENTS` に `install` が渡された場合は、パッケージ後に `npm run package:install` でローカルのVS Codeにもインストールする。

## 手順

1. **前提を確認する** — リポジトリの `package.json` に `scripts.compile` / `scripts.test` / `scripts["check:package"]` / `scripts.package` が揃っているか確認する。`package.json` 自体が無い、またはいずれか欠けている場合は、欠けているスクリプト名を報告してここで中断する（このスキルはVS Code拡張構成のリポジトリのみが対象）。
2. **Compile** — `npm run compile` を実行する。失敗したら中断して報告する。
3. **Test** — `npm test` を実行する（VS Code拡張のテストランナー経由でVS Codeを起動するため時間がかかる。想定内）。結果のサマリを提示する。
4. **ゲート** — テストが1つでも失敗したら、ここで停止しパッケージしない。失敗したテストを報告する。
5. **パッケージ内容を検証する** — `npm run check:package` を実行する。`vsce` がバンドルする内容をリポジトリ側の allowlist と突き合わせ、意図しないファイル混入や必要ファイルの欠落を配布前に検出する。CIと同じゲートなので、ここを通れば CI が承認する内容と一致する。失敗したら停止して報告する——誤った内容のパッケージを配布しない。原因が `.vscodeignore` 側にあれば直し、意図した変更ならリポジトリ側の検証スクリプトの許可リストを更新する。
6. **パッケージ** — テストと内容検証の両方が通ったときだけ `npm run package` を実行し `.vsix` を生成する（出力パスは各リポジトリの `package` スクリプトの定義に従う）。`$ARGUMENTS` に `install` が含まれる場合は代わりに `npm run package:install` を実行し、生成した `.vsix` をローカルのVS Codeにもインストールする。
7. **報告する** — テスト結果、内容検証の結果、生成した `.vsix` のパスを述べる。

## 補足

- テストまたは内容検証が通らない限り、パッケージ・インストールは絶対に行わない。
- 対象リポジトリがVS Code拡張構成（`compile`/`test`/`check:package`/`package` の npm scripts）を持たない場合はこのスキルの対象外。手順1で中断し、その旨をユーザーに伝える。
