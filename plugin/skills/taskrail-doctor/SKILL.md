---
name: taskrail-doctor
description: taskrail が期待どおりに動かない原因を調べる。「taskrail が動かない」「ラベルを変えてもエージェントが起動しない」「Issue が止まったまま」「差し戻しが続く」と言われたときに使う。
---

# taskrail の診断

症状から原因を推測する前に、事実を集めます。

## 手順

1. `taskrail doctor` を実行する。✘ があれば、まずそれを直す。多くの不具合は設定の不備が原因です。

2. 特定の Issue の話なら、状態を確認する。
   - `gh issue view <n> --json labels,comments` で、`flow::` ラベルが1つだけか、`blocked` が付いていないかを見る。
   - 最後の taskrail コメント(`taskrail:run` を含むコメント)の「判定」を読む。止まった理由はそこに書いてある。

3. ワークフローの実行を確認する。
   - `gh run list --workflow taskrail.yml --limit 10`
   - 実行がない → イベントが届いていない。ラベルを付けたのが `GITHUB_TOKEN` なら、次のワークフローは起動しない。
   - 実行がある → `gh run view <id> --log` で `[taskrail] スキップ:` の行を探す。理由が書いてある。

4. 原因を分類して報告する。

| 分類 | 例 | 直す場所 |
| --- | --- | --- |
| 設定 | Secrets、App の権限、ブランチ保護、`bot_logins` | リポジトリ設定、変数 `TASKRAIL_CONFIG`、`taskrail.yml`(あれば) |
| Issue の質 | 受け入れ条件が曖昧で差し戻しが続く | Issue を `flow::spec` に戻して書き直す |
| ルールの不足 | 同じ指摘が繰り返される | このリポジトリの linter・テスト・`docs/` |
| プロンプト・フロー | 工程の指示自体が不適切 | taskrail 本体のリポジトリ |

## してはいけないこと

- 列を進めるために、ラベルを手で飛ばすこと(例: `verify` を飛ばして `review` へ)。
- `blocked` の原因を確認せずに外すこと。
- 利用者の確認なしに `TASKRAIL_ENABLED` を変更すること。
