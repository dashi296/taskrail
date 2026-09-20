#!/usr/bin/env node
import { Command } from "commander";
import { apply } from "./commands/apply.js";
import { advance, dispatch, resume } from "./commands/board.js";
import { metrics } from "./commands/metrics.js";
import { route } from "./commands/route.js";
import { doctor, init, labelsSync, update, validate } from "./commands/setup.js";
import { packageVersion } from "./core/config.js";

const program = new Command();
program
  .name("taskrail")
  .description("Issueボード駆動のAIエージェント開発フレームワーク")
  .version(packageVersion());

const common = (c: Command) =>
  c.option("--flow <path>", "flow.yml のパス(省略時は同梱のもの)").option("--repo <owner/name>", "対象リポジトリ(省略時は自動判定)");

// --- 導入と保守(人間が手元で使う) ---
program
  .command("init")
  .description("このリポジトリに taskrail を導入する(既定ではリポジトリに何も置かない。--ci で CI 用のワークフローを置く)")
  .option("--platform <name>", "github | gitlab", "github")
  .requiredOption("--owner <org>", "taskrail リポジトリを置いている Organization / ユーザー名")
  .option("--ref <tag>", "参照する taskrail のタグ", "v0")
  .option("--labels", "続けてラベルも同期する")
  .option("--ci", "CI(GitHub Actions)で自動実行するための入口のワークフローを置く")
  .option("--docs", "docs/constitution.md(判断の原則)を置く。置かなければ同梱の既定の原則を使う")
  .option("--issue-template", "起票フォームを置く")
  .option("--config", "taskrail.yml を置く。置かなければ既定値とリポジトリ変数 TASKRAIL_CONFIG を使う")
  .option("--force", "既存ファイルを上書きする")
  .action(init);

program
  .command("update")
  .description("参照している taskrail のバージョン(タグ)を書き換える")
  .requiredOption("--ref <tag>", "新しいタグ")
  .option("--dry-run", "変更内容の表示のみ")
  .action(update);

common(program.command("doctor").description("導入状態を診断する").option("--offline", "GitHub への問い合わせを省く")).action(doctor);

const labels = program.command("labels").description("ラベルの管理");
common(labels.command("sync").description("flow.yml と labels.yml からラベルを作成・更新する").option("--dry-run")).action(labelsSync);

program
  .command("validate")
  .description("フロー定義、またはエージェントの結果ファイルを検証する")
  .option("--flow [path]", "flow.yml を検証する")
  .option("--result <path>", "結果ファイルを検証する")
  .option("--agent <name>", "期待するエージェント名")
  .action(validate);

common(program
  .command("metrics")
  .description("完了した Issue から運用指標を集計する")
  .option("--days <n>", "対象期間(日)", "30")
  .option("--bot-login <login>", "記録を書いた taskrail の App のログイン名(例: my-taskrail[bot])。設定になければ必須")
  .option("--json")).action(metrics);

// --- 実行(CI から呼ばれる) ---
common(program
  .command("route")
  .description("イベントから、実行するエージェント・プロンプト・権限を決める")
  .option("--event <path>", "イベントのJSON(GitHub では $GITHUB_EVENT_PATH)")
  .option("--issue <n>", "Issue番号を直接指定する")
  .option("--stage <id>", "stage を直接指定する")
  .option("--no-checkout", "作業ブランチの切り替えを行わない")).action(route);

common(program
  .command("apply")
  .description("エージェントの結果を検証し、コメント・PR/MR作成・列の移動を行う")
  .requiredOption("--issue <n>")
  .requiredOption("--stage <id>")
  .option("--dry-run", "書き込まず、投稿するコメントを表示する")).action(apply);

common(program.command("dispatch").description("Ready の Issue を、WIP上限と依存関係を見て In Progress に進める").option("--dry-run")).action(dispatch);

common(program
  .command("advance")
  .description("PR/MR 側の出来事(CI成功・修正依頼・マージ)を列の移動に反映する")
  .requiredOption("--branch <name>")
  .requiredOption("--to <stage>")
  .option("--from <stage>", "現在この stage のときだけ動かす")
  .option("--require-checks", "ブランチの先頭コミットの検査(CI)がすべて成功しているときだけ動かす")
  .option("--actor <login>", "きっかけになった人。write 以上の権限がなければ動かさない")
  .option("--dry-run")).action(advance);

common(program.command("resume").description("blocked の Issue を、回答コメントをきっかけに再開する").requiredOption("--event <path>").option("--dry-run")).action(resume);

program.parseAsync().catch((e: Error) => {
  console.error(`[taskrail] エラー: ${e.message}`);
  process.exit(1);
});
