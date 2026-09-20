---
name: taskrail-init
description: リポジトリに taskrail(Issueボード駆動のAI開発フロー)を導入する。「taskrail を導入して」「このリポジトリを taskrail に対応させて」「AI開発フローをセットアップして」と言われたときに使う。
---

# taskrail の導入

決定的な作業は `taskrail` CLI に任せ、あなたは判断が必要な部分(ルール文書をこのリポジトリ向けに書くこと)を担当します。
ファイルの配置やラベルの作成を、CLI を使わずに手で行わないでください。

## 手順

1. **前提を確認する。** `taskrail --version` と `gh auth status` を実行する。
   どちらかが失敗したら、導入方法を案内して止まる。推測で先へ進まない。

2. **利用者に確認する。** 次の3点は決めつけずに聞く。
   - CI(GitHub Actions)で自動実行するか、ローカル実行だけで使うか(`--ci`)
   - taskrail リポジトリを置いている Organization 名(`--owner`)
   - 参照するタグ(`--ref`。分からなければ taskrail リポジトリの最新タグを提案する)

3. **導入する。** `taskrail init --owner <org> --ref <tag>`(自動実行するなら `--ci` を付ける)を実行する。
   既定ではリポジトリに何も置きません。`--ci` のときだけ `.github/workflows/taskrail.yml` が置かれます。
   導入先を汚さないことが既定の方針なので、ほかのファイルは利用者が望んだときだけ置く(`--docs`、`--issue-template`、`--config`)。
   「CI ワークフローが見つかりません」と出たら、実在する CI の `name` を利用者に確認して直す。

4. **リポジトリを調べて、設定を提案する。** ここがあなたの主な仕事です。
   - `check_commands`: `package.json`、`Makefile`、CI 定義から lint・型チェック・テストのコマンドを読み取り、
     実際に実行して通ることを確認してから提案する。
   - `protected_paths`: 既定(`.github/**`、`taskrail.yml`、`CODEOWNERS`、`**/migrations/**`、`**/.env*`)に、
     このリポジトリのマイグレーションや設定ファイルの場所を足す。
   - 提案した設定は、利用者に置き場所を選んでもらう。リポジトリ変数 `TASKRAIL_CONFIG`(ファイルを増やさない)か、
     `taskrail.yml`(`--config`。変更を PR レビューで管理できる)。
   - プロジェクト固有の原則があるか、利用者に聞く。あれば `--docs` で `docs/constitution.md` を置き、
     「このプロジェクト固有の原則」に書く。確信のないものは書かず、質問として残す。原則は利用者が決めるものです。
   - 既存の `CLAUDE.md` / `AGENTS.md` は書き換えない。エージェントはあれば読みます。

5. **ラベルを同期する。** `taskrail labels sync` を実行する。

6. **診断する。** `taskrail doctor` を実行し、✘ と ! の項目を利用者に報告する。
   Secrets、GitHub App、ブランチ保護はあなたには設定できない。必要な設定と手順を具体的に伝える。

7. **変更を PR にまとめる。** コミットやpushは、利用者に頼まれた場合だけ行う。

## 利用者に必ず伝えること

- Issue 上の記録を信頼する投稿者は、Actions では GitHub App(自動で決まる)、ローカル実行では gh のログインユーザー。
- ローカル実行では、エージェントが手元の端末で動く。外部の人が書き込める Issue は、Actions で扱う。
- 設定を `TASKRAIL_CONFIG` に置くと、変更が PR レビューを通らない。
- 既定ブランチの保護を有効にするまで、AI のトークンで直接 push できてしまう。
- 最初は 1 リポジトリ、`size::s` の Issue から始める。
