import { appendFileSync } from "node:fs";
import { createPlatform, type Platform } from "../adapters/index.js";
import type { Issue } from "../adapters/types.js";
import { type Flow, type Project, isLogin, loadFlow, loadProject } from "./config.js";
import { flowLabel, isFlowLabel } from "./flow.js";

export interface Ctx {
  flow: Flow;
  project: Project;
  platform: Platform;
}

export function loadCtx(opts: { flow?: string; repo?: string } = {}): Ctx {
  const flow = loadFlow(opts.flow);
  const project = loadProject();
  return { flow, project, platform: createPlatform(project, opts.repo) };
}

/** 全体を止めるスイッチ。リポジトリ変数 TASKRAIL_ENABLED が "false" なら何もしない。 */
export function isEnabled(): boolean {
  return (process.env.TASKRAIL_ENABLED ?? "true").toLowerCase() !== "false";
}

/** GitHub Actions の step output。ローカル実行時は標準出力に出す。 */
export function setOutputs(values: Record<string, string | number | boolean>): void {
  const file = process.env.GITHUB_OUTPUT;
  for (const [k, v] of Object.entries(values)) {
    if (file) appendFileSync(file, `${k}=${String(v)}\n`);
    else console.log(`${k}=${String(v)}`);
  }
}

/** flow:: ラベルを1つだけにして列を移す。GitHub にはラベルの排他制御がないため、ここで保証する。 */
export function moveTo(ctx: Ctx, issue: Issue, stageId: string): void {
  const target = flowLabel(ctx.flow, stageId);
  for (const l of issue.labels) {
    if (isFlowLabel(ctx.flow, l) && l !== target) ctx.platform.removeLabel(issue.number, l);
  }
  // 付け直しでイベントを発火させたい場合があるため、既にあっても一度外す。
  if (issue.labels.includes(target)) ctx.platform.removeLabel(issue.number, target);
  ctx.platform.addLabels(issue.number, [target]);
}

/**
 * Issue コメント内の記録(実行記録・仕様・計画)を信頼する投稿者。
 * taskrail の bot に加え、ローカル実行では記録を書く本人(TASKRAIL_RECORD_AUTHOR)。
 * 誰もいなければ空集合を返し、どの記録も信頼しない(投稿者を検査しない状態にはしない)。
 */
export function trustedAuthors(project: Project, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const author = env.TASKRAIL_RECORD_AUTHOR?.trim();
  if (author && !isLogin(author)) throw new Error(`TASKRAIL_RECORD_AUTHOR がログイン名として不正です: ${author}`);
  const trusted = new Set([...project.bot_logins, ...(author ? [author] : [])]);
  if (!trusted.size && !warnedNoTrusted) {
    warnedNoTrusted = true;
    log("警告: 記録を信頼する投稿者がいません(bot_logins、TASKRAIL_BOT_LOGIN、TASKRAIL_RECORD_AUTHOR が未設定)。Issue 上の記録は読みません");
  }
  return trusted;
}
let warnedNoTrusted = false;

export function log(msg: string): void {
  console.error(`[taskrail] ${msg}`);
}
