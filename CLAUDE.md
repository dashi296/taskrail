# CLAUDE.md

taskrail 本体のリポジトリです。Issueボード駆動のAIエージェント開発フレームワークの、フロー定義と CLI を管理します。

## コマンド

```sh
npm ci
npm run check      # 型チェック + 単体テスト + flow.yml の整合性検査。完了前に必ず通す
npm run build
node dist/cli.js --help
```

## 読むべき文書

- [docs/design.md](docs/design.md) — 設計。変更の前に読む
- [docs/security.md](docs/security.md) — 脅威と対策。`route` / `apply` / `record` を触るときは必ず読む
- [docs/gitlab.md](docs/gitlab.md) — GitLab 対応の方針

## 構成

- `flow/` — フローの定義(データ)。プロンプトもここ
- `src/core/` — フローのロジック。プラットフォームに依存させない(`gh` や GitHub の語彙を持ち込まない)
- `src/adapters/` — プラットフォームの差を吸収する層
- `src/commands/` — サブコマンド。薄く保つ
- `templates/` — 導入先に配置するファイル。`{{TASKRAIL_OWNER}}` などは `init` が置換する

## 守ること

- **CLI の中で LLM を呼ばない。** CLI は決定的な処理だけを行う。
- **エージェントに書き込みをさせない。** Issue・ラベル・PR への書き込みは `apply` と `board` に集約する。
- **安全性に関わる変更にはテストを付ける。** 強制しているのは `commands/apply.ts` と `commands/route.ts`、判断の材料は `core/result.ts`、`core/record.ts`、`core/flow.ts`、`core/prompt.ts`。
- `flow/schemas/result.schema.json` と `src/core/result.ts` の zod スキーマは同期させる。
- 依存パッケージを増やさない(現在: commander、yaml、zod)。
- プロンプトを変えたら、過去の Issue 数件で再実行し、結果が悪化していないか確認する。
