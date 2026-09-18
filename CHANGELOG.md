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
- 導入先に置くファイルを最小限にした。`init` は既定でリポジトリに何も置かない(ローカル実行専用)。`--ci` で自動実行の入口のワークフローを、`--docs` `--issue-template` `--config` で任意のファイルを置く
- `.taskrail/` はコミットされない `.git/info/exclude` で除外する(`.gitignore` は変更しない)
- 設定は 既定値 < リポジトリ変数 `TASKRAIL_CONFIG` < `taskrail.yml` の順に解決する。`bot_logins` は Actions では App から自動で決まる
- 設定に `check_commands` を追加。プロンプトにルール文書の一覧、コマンド、保護パスを明記し、`docs/constitution.md` がなければ同梱の既定の原則を埋め込む
- 呼び出し側のワークフローを薄くした。イベントからボード操作への振り分けは `board.yml` が行う
- `doctor`: rulesets と Organization の Secrets を認識する。設定の出どころと `workflow_run` の CI 名を検査する
- ルール文書(`CLAUDE.md`、`AGENTS.md`、`docs/constitution.md`)と `taskrail.yml` を、設定では外せない保護パスにした
- CI が複数あるとき、ブランチの検査がすべて成功してから Verify に進める(`advance --require-checks`)
- `init --ci`: `pull_request` で起動する CI だけを検出する。別名の入口ワークフローがあれば二重に置かない
- `doctor`: ブランチ保護で、レビュー必須(承認1件以上)と App のバイパスを確認する。入口ワークフローが複数あれば検出する
- 修正: Verify でテストを実行できず blocked になる問題。CI の成功を根拠に判定するよう、verify-spec のプロンプトを変更
