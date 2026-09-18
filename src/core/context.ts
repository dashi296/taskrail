import { appendFileSync } from "node:fs";
import { createPlatform, type Platform } from "../adapters/index.js";
import type { Issue } from "../adapters/types.js";
import { type Flow, type Project, loadFlow, loadProject } from "./config.js";
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

export function trustedAuthors(project: Project): Set<string> | undefined {
  return project.bot_logins.length ? new Set(project.bot_logins) : undefined;
}

export function log(msg: string): void {
  console.error(`[taskrail] ${msg}`);
}
