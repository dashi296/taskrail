# taskrail

Issueボード駆動のAIエージェント開発フレームワーク。
タスクをレールに乗せ、ゲートを通して、ボードの左から右へ進めます。

```
Inbox → Spec → Plan → Ready → In Progress → Verify → Human Review → Done
        └─ 人間が承認 ─┘        └──── AIが自走 ────┘   └─ 人間がマージ ─┘
```

列は `flow::` ラベルで表します。列を動かすと、その列を担当するエージェントが動きます。
人間が行うのは、仕様の承認、計画の承認、AIの質問への回答、最終レビューとマージの4つだけです。

> **状態**: v0.1(初期版)。GitHub は実装済みで、ローカル実行での通し検証は済んでいます。GitHub Actions 上での通し検証はこれからです。
> GitLab はインターフェースと CI 雛形のみです。[既知の制約](#既知の制約と今後)を必ず読んでください。

## 考え方

| 原則 | 実装 |
| --- | --- |
| AIに列を動かさせない | エージェントは結果を JSON に書くだけ。検証・コメント・PR作成・列の移動は `taskrail apply` が行う |
| 状態は Issue に置く | 仕様・計画・実行記録は Issue コメントに保存。エージェントは毎回そこから再開する |
| 1工程1セッション | 工程ごとに新しいセッションを起動し、必要な文脈だけを渡す。会話履歴は引き継がない |
| ルールは機械で強制する | 保護パスの変更、読み取り専用工程での書き込み、根拠と矛盾する「合格」は、AIの外で拒否する |
| 迷ったら止まる | `blocked` にして質問を残す。回答コメントで自動再開 |
| 版を固定する | 導入先はタグで参照する。どの版で実行したかを Issue に記録する |

設計の詳細は [docs/design.md](docs/design.md)、安全性は [docs/security.md](docs/security.md) にあります。

## リポジトリの構成

```
flow/                 フローの定義(データ)。日々の改善の大半はここ
  flow.yml              列、エージェント、遷移、権限
  labels.yml            ラベル
  prompts/              工程ごとのプロンプト
  schemas/              エージェントの結果の JSON Schema
src/                  CLI(flow/ を読んで実行するだけの薄い実行器)
  core/                 フローのロジック。プラットフォームに依存しない
  adapters/             GitHub / GitLab の差を吸収する層
  commands/             サブコマンド
.github/workflows/    再利用ワークフロー(route.yml、board.yml)と、このリポジトリ自身の CI
templates/            `taskrail init` が導入先に配置するファイル(既定では何も置かない)
plugin/               Claude Code プラグイン(skills)
docs/                 設計・安全性・GitLab 対応の文書、利用者向けの説明(workflow.md、runbook.md)
```

## 導入

### 0. 一度だけ行う準備(Organization ごと)

1. このリポジトリを `<your-org>/taskrail` として作成し、`v0` タグを打つ。
2. GitHub App を作成する。
   - 権限: Contents (Read & write)、Issues (Read & write)、Pull requests (Read & write)、Checks (Read)、Commit statuses (Read)、Actions (Read)、Metadata (Read)
   - Checks、Commit statuses、Actions は、作業ブランチの CI がすべて成功したかを確認するために使います。
   - 導入先のリポジトリと、`taskrail` リポジトリにインストールする。
   - `GITHUB_TOKEN` で付けたラベルは次のワークフローを起動しないため、App が必須です。
3. `taskrail` リポジトリが private の場合、Settings → Actions → General → Access で、
   Organization 内のリポジトリからの再利用ワークフローの利用を許可する。

### 1. CLI を入れる

```sh
git clone git@github.com:<your-org>/taskrail.git && cd taskrail
npm ci && npm link        # taskrail コマンドが使えるようになる
```

### 2. 導入先のリポジトリで

```sh
taskrail init --owner <your-org> --ref v0          # ローカル実行だけで使う(リポジトリに何も置かない)
taskrail init --owner <your-org> --ref v0 --ci     # CI(GitHub Actions)で自動実行する
```

既定では、導入先のリポジトリにファイルを置きません。作業用の `.taskrail/` は、コミットされない `.git/info/exclude` で除外します(`.gitignore` は変更しません)。
この状態では、[ローカルで1工程ずつ回す](#ローカルで1工程ずつ回す)方法で使えます。

ラベルの変更で自動的にエージェントを動かすには、`--ci` で `.github/workflows/taskrail.yml` を置きます。GitHub Actions はリポジトリにコミットされたワークフローしか起動しないため、自動実行にはこの1ファイルが必要です。
`workflow_run` が対象にする CI の名前は、既存の CI ワークフローのうち `pull_request` で起動するものから自動で入ります。
CI が複数あっても、作業ブランチの検査がすべて成功してから Verify に進みます。外部 CI などが後から完了した場合も、定期実行(10分ごと)で拾います。

必要なものだけ追加で置けます。

| フラグ | 置くファイル | 置かない場合 |
| --- | --- | --- |
| `--ci` | `.github/workflows/taskrail.yml`(自動実行の入口) | ローカル実行専用 |
| `--docs` | `docs/constitution.md`(判断の原則) | taskrail 同梱の既定の原則([flow/constitution.md](flow/constitution.md))を使う |
| `--issue-template` | 起票フォーム | 起票の書式は自由。項目が足りなければトリアージで質問が返る |
| `--config` | `taskrail.yml`(設定) | 既定値と、リポジトリ変数 `TASKRAIL_CONFIG` を使う |

`--ci` を付けた場合は、続けて次を設定します。

| 種類 | 名前 | 値 |
| --- | --- | --- |
| Secret | `ANTHROPIC_API_KEY` | Anthropic の API キー(下の `CLAUDE_CODE_OAUTH_TOKEN` とどちらか) |
| Secret | `CLAUDE_CODE_OAUTH_TOKEN` | Claude のサブスクリプションで動かす場合。`claude setup-token` で発行する |
| Secret | `TASKRAIL_APP_ID` | GitHub App の App ID |
| Secret | `TASKRAIL_APP_PRIVATE_KEY` | GitHub App の秘密鍵 |
| Variable | `TASKRAIL_ENABLED` | `true`(`false` で全体を停止) |
| Variable | `TASKRAIL_CONFIG` | 任意。設定を YAML で書く(下記) |

そのうえで:

1. 既定ブランチの保護を有効にする(レビュー必須、直接 push 禁止)。
2. `taskrail labels sync` → `taskrail doctor`。

#### 設定

設定は、既定値 < リポジトリ変数 `TASKRAIL_CONFIG` < `taskrail.yml` の順に、キーごとに上書きされます。
既定値のままで動きます。変える場合は、たとえば次のように書きます。

```yaml
check_commands: [npm run lint, npm test]   # エージェントが完了前に通すコマンド。空なら文書や CI の定義から判断する
protected_paths: [".github/**", "taskrail.yml", "CODEOWNERS", "db/migrations/**", "**/.env*"]
wip_limit: 2
```

`protected_paths` に何を書いても、ルール文書(`**/CLAUDE.md`、`**/CLAUDE.local.md`、`**/AGENTS.md`、`docs/constitution.md`)、エージェントの設定(`.claude/**`、`.mcp.json`)、CI の定義(`.github/workflows/**`、`.github/actions/**`、`.gitlab-ci.yml`、`.gitlab/ci/**`)、`taskrail.yml` は常に保護されます。
`bot_logins`(Issue コメント内の記録を信頼する投稿者)は、Actions では GitHub App から自動で決まります。
設定をリポジトリ変数に置くと、変更は PR レビューを通りません。レビューで管理したい場合は `--config` で `taskrail.yml` を置きます。

#### ルール文書

エージェントは、導入先にある `CLAUDE.md`、`AGENTS.md`、`docs/constitution.md` を読みます。どれもなければ、README と既存のコードから慣習を読み取ります。
判断の原則(`docs/constitution.md`)がなければ、同梱の既定の原則がプロンプトに埋め込まれます。

Claude Code を使っているなら、プラグインの `taskrail-init` skill が導入を対話的に進めます。

```
/plugin marketplace add <your-org>/taskrail
/plugin install taskrail@taskrail
```

## コマンド

| コマンド | 用途 | 使う人 |
| --- | --- | --- |
| `init` | 導入する。既定ではリポジトリに何も置かない(`--ci` `--docs` `--issue-template` `--config` で追加) | 人間 |
| `update --ref <tag>` | 参照するタグを書き換える | 人間 |
| `doctor` | 導入状態を診断する | 人間 |
| `labels sync` | ラベルを作成・更新する | 人間 |
| `validate --flow` / `--result <file>` | フロー定義、結果ファイルを検証する | 人間・CI |
| `metrics --days 30 --bot-login <App>[bot]` | 滞留時間、差し戻し率、blocked 率を集計する(記録を書いた App を指定する) | 人間 |
| `route` | イベントから、実行するエージェント・プロンプト・権限を決める | CI |
| `apply` | 結果を検証し、コメント・PR作成・列の移動を行う | CI |
| `dispatch` | Ready → In Progress(WIP上限と依存関係を確認) | CI(定期) |
| `advance` | CI成功・修正依頼・マージを列の移動に反映する | CI |
| `resume` | blocked の Issue を回答コメントで再開する | CI |

`route` と `apply` は手元でも試せます。Issue 上の記録は、信頼する投稿者(`bot_logins`、または環境変数 `TASKRAIL_BOT_LOGIN` / `TASKRAIL_RECORD_AUTHOR`)のものだけを読みます。

```sh
taskrail route --issue 12 --stage spec --no-checkout   # .taskrail/run/ にプロンプトが出る
taskrail apply --issue 12 --stage spec --dry-run       # 投稿されるコメントを表示(書き込まない)
```

### ローカルで回す

`scripts/local-flow.sh` は、人間の判断が必要な位置まで工程を連続で進めます。
次に何をするかは `taskrail next`(決定的)が決め、スクリプトはそれに従うだけです。

```sh
cd <導入先リポジトリ>                                   # 作業ツリーはクリーンにしておく
/path/to/taskrail/scripts/local-flow.sh 12            # 承認待ち・blocked・完了まで進める
MAX_STEPS=5 /path/to/taskrail/scripts/local-flow.sh 12
CI_TIMEOUT=0 /path/to/taskrail/scripts/local-flow.sh 12  # CI を待たずに止める
```

止まるのは、仕様の承認、計画の承認、最終レビュー、`blocked`、着手できないとき、CI の待ち時間切れです。
承認はラベルを手で付け替え、もう一度実行すると続きから進みます。

### ローカルで1工程ずつ回す

GitHub App や `ANTHROPIC_API_KEY` がなくても、`scripts/local-run.sh` で route → エージェント → apply を手元で実行できます。
エージェントは手元の Claude Code(`claude -p`)で動き、Issue への書き込みは `gh` のログインユーザー名義で行われます。

```sh
cd <導入先リポジトリ>                                  # 作業ツリーはクリーンにしておく
/path/to/taskrail/scripts/local-run.sh 12             # Issue に付いている flow:: の列を実行
/path/to/taskrail/scripts/local-run.sh 12 spec        # 列を指定して実行
DRY_RUN=1 /path/to/taskrail/scripts/local-run.sh 12   # apply は書き込まずに表示だけ
```

- 列を動かしても次の工程は自動では起動しません。工程ごとに実行し直します(`local-flow.sh` はこれを繰り返します)。
- 人間の操作(仕様・計画の承認)はラベルを手で付け替えます。
- AIを使わない遷移はコマンドで行います。ready → doing は `taskrail dispatch`、CI 成功後の doing → verify は `taskrail advance --branch <作業ブランチ> --from doing --to verify --require-checks` です(`--require-checks` は、ブランチの検査がすべて成功していなければ進めません)。
  `local-run.sh` で書いた記録は `gh` のログインユーザー名義なので、これらのコマンドには `TASKRAIL_RECORD_AUTHOR` を与えます(与えないと記録を読まず、doing → verify に進みません)。

  ```sh
  export TASKRAIL_RECORD_AUTHOR=$(gh api user --jq .login)
  taskrail dispatch
  ```
- `--ci` でワークフローを置いている場合は、Actions が同時に動かないよう、リポジトリ変数 `TASKRAIL_ENABLED` を `false` にしておきます。

## 改善の回し方

フローの定義はデータ(`flow/`)、CLI は実行器です。日々の改善はほとんど `flow/` の変更で済みます。

1. `flow/prompts/*.md` や `flow/flow.yml` を変更して PR を出す(CI が整合性を検査します)。
2. 社内向けのリポジトリ1つだけ、`taskrail update --ref main` 相当で先行適用して様子を見る。
3. 問題がなければタグを進める。互換性のある変更は移動タグ `v0` を動かすだけで全リポジトリに届きます。
   破壊的な変更は `v1` を新設し、各リポジトリで `taskrail update --ref v1` を実行します。

プロンプトを変更するときは、過去に完了した Issue を数件選んで再実行し、結果が悪化していないことを確認してください。

## 開発

```sh
npm ci
npm run check    # 型チェック + 単体テスト + flow.yml の整合性検査
```

## 既知の制約と今後

- **GitHub Actions 上での通し検証が未了です。** ローカル実行(`scripts/local-run.sh`)では、
  Issue が Inbox から Human Review まで流れること(差し戻しを含む)を確認済みです。
  Actions 上の連鎖(App によるラベル変更 → 次の工程の起動)は、まだ確認していません。
  最初は社内向けのリポジトリで、`size::s` の Issue から試してください。
- `anthropics/claude-code-action@v1` の入力名(`prompt`、`claude_args`)に依存しています。
  action 側の変更で動かなくなる可能性があるため、導入時に最新の README を確認してください。
- GitLab アダプタは未実装です([docs/gitlab.md](docs/gitlab.md))。
- 掃除エージェント(`flow/prompts/janitor.md`)はプロンプトのみで、起動の仕組みは未実装です。
- 子Issue の自動作成は未実装です。計画エージェントは分割案を出すところまでで、作成は人間が行います。
- 書き込み工程のエージェントは Bash を使えます。ランナー上の環境変数を読める可能性があるため、
  ジョブに渡す Secrets は最小限にしてください([docs/security.md](docs/security.md))。
- npm には未公開です(`"private": true`)。名前 `taskrail` は 2026-09 時点で npm に空きがありました。
