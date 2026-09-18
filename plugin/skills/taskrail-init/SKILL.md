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

2. **利用者に確認する。** 次の2点は決めつけずに聞く。
   - taskrail リポジトリを置いている Organization 名(`--owner`)
   - 参照するタグ(`--ref`。分からなければ taskrail リポジトリの最新タグを提案する)

3. **雛形を配置する。** `taskrail init --owner <org> --ref <tag>` を実行する。
   既存ファイルは上書きされない。「既存」と表示されたファイルは、内容を確認して利用者に統合方法を提案する。

4. **リポジトリを調べて、ルール文書を書き換える。** ここがあなたの主な仕事です。
   - `CLAUDE.md` の「コマンド」を、このリポジトリの実際の lint・型チェック・テストのコマンドに直す。
     `package.json`、`Makefile`、CI 定義から読み取り、実際に実行して通ることを確認する。
   - `CLAUDE.md` の「構成」に、主要なディレクトリの役割を数行で書く。
   - `docs/constitution.md` の「このプロジェクト固有の原則」を、コードから読み取れる範囲で提案する。
     確信のないものは書かず、利用者への質問として残す。原則は利用者が決めるものです。
   - `.github/workflows/taskrail.yml` の `workflow_run.workflows` を、実在する CI ワークフローの `name` に合わせる。
   - `taskrail.yml` の `protected_paths` に、このリポジトリのマイグレーションや設定ファイルの場所を加える。

5. **ラベルを同期する。** `taskrail labels sync` を実行する。

6. **診断する。** `taskrail doctor` を実行し、✘ と ! の項目を利用者に報告する。
   Secrets、GitHub App、ブランチ保護はあなたには設定できない。必要な設定と手順を具体的に伝える。

7. **変更を PR にまとめる。** コミットやpushは、利用者に頼まれた場合だけ行う。

## 利用者に必ず伝えること

- `taskrail.yml` の `bot_logins` に GitHub App のログイン名を設定するまで、Issue 上の記録は偽装されうる。
- 既定ブランチの保護を有効にするまで、AI のトークンで直接 push できてしまう。
- 最初は 1 リポジトリ、`size::s` の Issue から始める。
