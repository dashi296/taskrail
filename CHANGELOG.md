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
- 導入先に置くファイルを最小限にした。`init` は既定でワークフロー1つだけを置く(`--docs` `--issue-template` `--config` で追加)
- 設定は 既定値 < リポジトリ変数 `TASKRAIL_CONFIG` < `taskrail.yml` の順に解決する。`bot_logins` は Actions では App から自動で決まる
- 設定に `check_commands` を追加。プロンプトにルール文書の一覧、コマンド、保護パスを明記し、`docs/constitution.md` がなければ同梱の既定の原則を埋め込む
- 呼び出し側のワークフローを薄くした。イベントからボード操作への振り分けは `board.yml` が行う
- `doctor`: rulesets と Organization の Secrets を認識する。設定の出どころと `workflow_run` の CI 名を検査する
- 修正: Verify でテストを実行できず blocked になる問題。CI の成功を根拠に判定するよう、verify-spec のプロンプトを変更
