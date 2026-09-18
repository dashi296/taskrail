# taskrail

Issueボード駆動のAIエージェント開発フレームワーク。
タスクをレールに乗せ、ゲートを通して、ボードの左から右へ進めます。

```
Inbox → Spec → Plan → Ready → In Progress → Verify → Human Review → Done
        └─ 人間が承認 ─┘        └──── AIが自走 ────┘   └─ 人間がマージ ─┘
```

列は `flow::` ラベルで表します。列を動かすと、その列を担当するエージェントが動きます。
人間が行うのは、仕様の承認、計画の承認、AIの質問への回答、最終レビューとマージの4つだけです。

> **状態**: v0.1(初期版)。GitHub は実装済みですが、実リポジトリでの通し検証はこれからです。
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
templates/            `taskrail init` が導入先に配置するファイル
plugin/               Claude Code プラグイン(skills)
docs/                 設計・安全性・GitLab 対応の文書
```

## 導入

### 0. 一度だけ行う準備(Organization ごと)

1. このリポジトリを `<your-org>/taskrail` として作成し、`v0` タグを打つ。
2. GitHub App を作成する。
   - 権限: Contents (Read & write)、Issues (Read & write)、Pull requests (Read & write)、Metadata (Read)
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
taskrail init --owner <your-org> --ref v0
```

続けて、次を設定します。

| 種類 | 名前 | 値 |
| --- | --- | --- |
| Secret | `ANTHROPIC_API_KEY` | Anthropic の API キー |
| Secret | `TASKRAIL_APP_ID` | GitHub App の App ID |
| Secret | `TASKRAIL_APP_PRIVATE_KEY` | GitHub App の秘密鍵 |
| Variable | `TASKRAIL_ENABLED` | `true`(`false` で全体を停止) |

そのうえで:

1. `taskrail.yml` の `bot_logins` に App のログイン名(例: `my-taskrail[bot]`)を設定する。
2. `.github/workflows/taskrail.yml` の `workflow_run.workflows` を、CI ワークフローの `name` に合わせる。
3. `CLAUDE.md` と `docs/constitution.md` をこのリポジトリ向けに書き換える。
4. 既定ブランチの保護を有効にする(レビュー必須、直接 push 禁止)。
5. `taskrail labels sync` → `taskrail doctor`。

Claude Code を使っているなら、プラグインの `taskrail-init` skill が 3 を含めて対話的に進めます。

```
/plugin marketplace add <your-org>/taskrail
/plugin install taskrail@taskrail
```

## コマンド

| コマンド | 用途 | 使う人 |
| --- | --- | --- |
| `init` | 薄いワークフローと雛形を配置する | 人間 |
| `update --ref <tag>` | 参照するタグを書き換える | 人間 |
| `doctor` | 導入状態を診断する | 人間 |
| `labels sync` | ラベルを作成・更新する | 人間 |
| `validate --flow` / `--result <file>` | フロー定義、結果ファイルを検証する | 人間・CI |
| `metrics --days 30` | 滞留時間、差し戻し率、blocked 率を集計する | 人間 |
| `route` | イベントから、実行するエージェント・プロンプト・権限を決める | CI |
| `apply` | 結果を検証し、コメント・PR作成・列の移動を行う | CI |
| `dispatch` | Ready → In Progress(WIP上限と依存関係を確認) | CI(定期) |
| `advance` | CI成功・修正依頼・マージを列の移動に反映する | CI |
| `resume` | blocked の Issue を回答コメントで再開する | CI |

`route` と `apply` は手元でも試せます。

```sh
taskrail route --issue 12 --stage spec --no-checkout   # .taskrail/run/ にプロンプトが出る
taskrail apply --issue 12 --stage spec --dry-run       # 投稿されるコメントを表示(書き込まない)
```

### ローカルで1工程ずつ回す

GitHub App や `ANTHROPIC_API_KEY` がなくても、`scripts/local-run.sh` で route → エージェント → apply を手元で実行できます。
エージェントは手元の Claude Code(`claude -p`)で動き、Issue への書き込みは `gh` のログインユーザー名義で行われます。

```sh
cd <導入先リポジトリ>                                  # 作業ツリーはクリーンにしておく
/path/to/taskrail/scripts/local-run.sh 12             # Issue に付いている flow:: の列を実行
/path/to/taskrail/scripts/local-run.sh 12 spec        # 列を指定して実行
DRY_RUN=1 /path/to/taskrail/scripts/local-run.sh 12   # apply は書き込まずに表示だけ
```

- 列を動かしても次の工程は自動では起動しません。工程ごとに実行し直します。
- 人間の操作(仕様・計画の承認)はラベルを手で付け替えます。
- AIを使わない遷移はコマンドで行います。ready → doing は `taskrail dispatch`、CI 成功後の doing → verify は `taskrail advance --branch <作業ブランチ> --from doing --to verify` です。
- 導入先の Actions が誤って動かないよう、リポジトリ変数 `TASKRAIL_ENABLED` を `false` にしておきます。

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

- **実環境での通し検証が未了です。** 単体テストと CLI のドライランは通っていますが、
  GitHub Actions 上で Issue が Inbox から Done まで流れることは、まだ確認していません。
  最初は社内向けのリポジトリで、`size::s` の Issue から試してください。
- `anthropics/claude-code-action@v1` の入力名(`prompt`、`claude_args`)に依存しています。
  action 側の変更で動かなくなる可能性があるため、導入時に最新の README を確認してください。
- GitLab アダプタは未実装です([docs/gitlab.md](docs/gitlab.md))。
- 掃除エージェント(`flow/prompts/janitor.md`)はプロンプトのみで、起動の仕組みは未実装です。
- 子Issue の自動作成は未実装です。計画エージェントは分割案を出すところまでで、作成は人間が行います。
- 書き込み工程のエージェントは Bash を使えます。ランナー上の環境変数を読める可能性があるため、
  ジョブに渡す Secrets は最小限にしてください([docs/security.md](docs/security.md))。
- npm には未公開です(`"private": true`)。名前 `taskrail` は 2026-09 時点で npm に空きがありました。
