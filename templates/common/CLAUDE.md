# CLAUDE.md

> これは雛形です。1ページ程度の「地図」に保ってください。詳細は `docs/` に置き、ここからリンクします。

## コマンド

<!-- このリポジトリの実際のコマンドに書き換えてください。エージェントは完了前にこれらをすべて通します。 -->

```sh
npm ci          # セットアップ
npm run lint    # lint
npm run typecheck
npm test        # テスト
```

## 読むべき文書

- [docs/constitution.md](docs/constitution.md) — 判断に迷ったときの原則。最初に読む
- [docs/workflow.md](docs/workflow.md) — 開発フローと列の意味
- `docs/conventions/` — コーディング規約、コミット規約、テスト方針

## 構成

<!-- 主要なディレクトリと、その役割を数行で。 -->

## taskrail のもとで動くとき

- 担当は現在の1工程だけです。プロンプトファイルの指示に従い、結果を指定のパスに JSON で書き出します。
- ラベルの変更、Issue へのコメント、push、PR の作成はしません。
- `.github/`、`taskrail.yml`、`.taskrail/` は変更しません。
