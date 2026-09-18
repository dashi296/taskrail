# Changelog

## 0.1.0 — 未リリース

初期版。

- フロー定義(8列、7エージェント)とプロンプト
- CLI: `init` `update` `doctor` `labels sync` `validate` `metrics` `route` `apply` `dispatch` `advance` `resume`
- GitHub アダプタ(`gh` CLI 経由)、再利用ワークフロー(`route.yml`、`board.yml`)
- GitLab: インターフェースと CI 雛形のみ
- Claude Code プラグイン: `taskrail-init` `taskrail-doctor` `taskrail-issue`
- `scripts/local-run.sh`: 1工程をローカルで実行する(route → `claude -p` → apply)
- 修正: App が動かした列でエージェントが起動しない問題。route が `allowed_bots` を出力し、claude-code-action に渡す
- 修正: Verify でテストを実行できず blocked になる問題。CI の成功を根拠に判定するよう、verify-spec のプロンプトを変更
