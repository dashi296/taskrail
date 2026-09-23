# Changelog

## 0.1.0 — 未リリース

初期版。

- フロー定義(8列、7エージェント)とプロンプト
- CLI: `init` `update` `doctor` `labels sync` `validate` `metrics` `route` `apply` `dispatch` `advance` `resume`
- GitHub アダプタ(`gh` CLI 経由)、再利用ワークフロー(`route.yml`、`board.yml`)
- GitLab: インターフェースと CI 雛形のみ
- Claude Code プラグイン: `taskrail-init` `taskrail-doctor` `taskrail-issue`
- `scripts/local-run.sh`: 1工程をローカルで実行する(route → `claude -p` → apply)
- `scripts/local-flow.sh`: 人間の判断が必要な位置まで工程を連続実行する。次の一手は `taskrail next` が決める
- `dispatch` / `advance` の `--local-checks`: CI の成功の代わりに、手元で `check_commands` を実行して In Progress → Verify を判定する
- `resume --issue <n>`: ローカルで blocked を再開する(回答は write 以上の人のコメントだけを読む)
- apply と route の強制ルールにテストを付けた(行カバレッジ: apply 7% → 95%、route 5% → 86%)
- エージェントの認証は `ANTHROPIC_API_KEY` と `CLAUDE_CODE_OAUTH_TOKEN`(`claude setup-token`)のどちらでもよい
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
- 強制する保護パスに、エージェントの設定(`.claude/**`、`.mcp.json`、`CLAUDE.local.md`)と CI の定義を追加。名前の変更・削除も検出する
- 記録を信頼する投稿者がいないときは、どの記録も信頼しない。ローカル実行では gh のログインユーザーの記録を信頼する
- `dispatch` が、CI 待ちの Issue の検査を再判定する。実装の記録に作業ブランチを残し、差し戻し直後は進めない
- CI の検出で `pull_request` の `types` / `branches` / `branches-ignore` を解析する。`paths` の絞り込みは注意を出す
- fork の同名ブランチの PR には反応しない
- 実行記録のマーカーをコメントの先頭に置き、先頭だけを読む。エージェント由来の文字列はすべて無害化する(**以前の形式の記録は読めません**)
- エージェントには読み取り専用の App トークンを渡し、checkout にトークンを残さない。ローカル実行では gh と git の認証を外す
- apply: 比較の基準を API の SHA にし、git の失敗を違反として扱う。hook と fsmonitor を無効にする。読み取り工程のコミットも検出する
- apply: push 先を `TASKRAIL_GIT_REMOTE`(URL)で直接指定する(claude-code-action が origin を読み取り専用トークン入りに書き換えるため)。push と PR 作成の失敗も Issue に記録する
- 読み取り工程が書き込めるのは結果ファイルの置き場所だけ
- 読み取り工程に Bash を渡さない。差分とコミットの一覧は route が `.taskrail/run/` に書き出す
- 保護パスの検査でシンボリックリンクを考慮する(リンクの変更は違反、既存リンクのリンク先の変更はリンク名でも照合)
- apply: 停止スイッチを確認する。Issue が open・列が実行時と同じ・blocked でないときだけ結果を反映する
- CI の判定は PR で動いた実行だけで行い、列を動かす前にブランチの先頭を再確認する
- CI 待ちのゲート: 実装の記録にコミットを残し、その列に入った後の記録・ブランチの先頭との一致・監視している CI の成功を確認する
- 修正依頼を出した人の write 権限を確認し、実装に渡すレビューを write 以上の人のものに絞る
- `metrics --bot-login`。信頼する投稿者がいなければ警告する
- 修正: `git status` の1行目のファイル名が1文字欠けていた
- 修正: Verify でテストを実行できず blocked になる問題。CI の成功を根拠に判定するよう、verify-spec のプロンプトを変更
