# GitLab 対応(未実装)

v0.1 では、GitLab はインターフェース(`src/adapters/gitlab.ts`)と CI 雛形
(`templates/gitlab/`)だけがあります。フローのロジック(`src/core/`)はプラットフォームに依存しないため、
実装が必要なのは次の2つです。

## 1. アダプタ

`Platform` インターフェースを `glab api` で実装します。GitHub アダプタと同じ構造にします。

| メソッド | GitLab API |
| --- | --- |
| `getIssue` / `listComments` / `addComment` | `projects/:id/issues/:iid`、`.../notes` |
| `addLabels` / `removeLabel` | `PUT projects/:id/issues/:iid` の `add_labels` / `remove_labels` |
| `listOpenIssuesByLabel` | `projects/:id/issues?labels=...&state=opened` |
| `upsertLabel` | `projects/:id/labels` |
| `getPermission` | `projects/:id/members/all/:user_id` の `access_level`(50/40 → admin、30 → write) |
| `findPullRequestByBranch` / `createPullRequest` | `projects/:id/merge_requests` |
| `listReviewFeedback` | `merge_requests/:iid/discussions` の未解決スレッド |
| `listLabelEvents` | `issues/:iid/resource_label_events` |

GitLab の scoped label(`flow::*`)はサーバー側で排他になります。`moveTo()` が先に古いラベルを外しても問題ありません。

## 2. イベントのリスナー

GitLab はラベルの変更でパイプラインを直接起動できません。Webhook を受ける小さなリスナーが必要です。

```
GitLab Webhook ─▶ リスナー ─▶ パイプライントリガー API ─▶ taskrail:route / taskrail:board
(Issue / Note / MR)  (サーバーレス関数1本)      (変数: TASKRAIL_COMMAND、TASKRAIL_EVENT …)
```

リスナーの責務は、Webhook の署名(Secret Token)を検証し、イベントを次の対応でコマンドに振り分けることだけです。
判断ロジックは持たせません(それは CLI の仕事です)。

| Webhook | 条件 | コマンド |
| --- | --- | --- |
| Issue Hook | `flow::` ラベルが追加された | `route` |
| Issue Hook | 新規作成 | `route`(inbox に載せる) |
| Note Hook | Issue へのコメント | `resume` |
| Merge Request Hook | マージされた | `advance --to done` |
| Pipeline Hook | MR のパイプラインが成功 | `advance --from doing --to verify` |
| (スケジュール) | 10分ごと | `dispatch` |

`route` は GitHub のイベント形式(`action`、`label.name`、`issue.number`、`sender`)を読みます。
リスナーで GitLab のペイロードをこの形に変換するか、`route` に GitLab 形式の読み取りを追加します。後者を推奨します。

## 進め方

GitHub でプロンプトとルールを固めてから移植することを推奨します。
GitLab 側の Claude Code 連携はベータ版で、先に GitHub で得た知見をそのまま持ち込めるためです。
