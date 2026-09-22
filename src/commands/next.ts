import type { Issue } from "../adapters/types.js";
import { type Ctx, loadCtx, log, setOutputs, trustedAuthors } from "../core/context.js";
import { currentStage, flowLabel } from "../core/flow.js";
import { parseRuns, type PostedRun } from "../core/record.js";

export interface NextStep {
  /**
   * run-stage: その列のエージェントを実行する / dispatch: ready → doing(WIP上限と依存を見る)
   * check-ci: 実装の CI を確認して doing → verify / stop: 人間の操作待ち、または終了
   */
  action: "run-stage" | "dispatch" | "check-ci" | "stop";
  stage: string | null;
  reason: string;
}

/**
 * その Issue で次に行うことを、Issue の状態だけから決める。LLM は使わない。
 * ローカル実行(scripts/local-flow.sh)はこの判断に従って工程を繰り返す。
 */
export function nextStep(ctx: Ctx, issue: Issue): NextStep {
  const stop = (reason: string, stage: string | null = null): NextStep => ({ action: "stop", stage, reason });
  if (issue.state !== "open") return stop("Issue は閉じられています");
  if (issue.labels.includes(ctx.flow.blocked_label)) {
    return stop(`${ctx.flow.blocked_label} です。質問に回答し、ラベルを外してください`);
  }
  const stage = currentStage(ctx.flow, issue.labels);
  if (!stage) return stop("flow ラベルが1つに定まりません");

  if (!stage.agents.length) {
    // dispatch が見るのは ready の列(board.ts の dispatch と同じ)。review や done は人間が動かす。
    if (stage.id === "ready") return { action: "dispatch", stage: stage.id, reason: "着手できるか判定します" };
    return stop(`${stage.title} は人間の担当です`, stage.id);
  }

  const last = lastRunInStage(ctx, issue, stage.id);
  if (!last) return { action: "run-stage", stage: stage.id, reason: `${stage.title} のエージェントを実行します` };
  if (last.status === "blocked") {
    // 質問に人間が答えていれば、その回答を入力にしてもう一度実行する(Actions の resume と同じ判断)。
    if (answeredAfter(ctx, issue, last.postedAt)) {
      return { action: "run-stage", stage: stage.id, reason: "質問への回答があるので、もう一度実行します" };
    }
    return stop(`${stage.title} の質問に回答するとやり直せます`, stage.id);
  }
  if (last.status !== "pass") return stop(`${stage.title} が ${last.status} で終わっています。内容を確認してください`, stage.id);
  if (stage.system_next.length) return { action: "check-ci", stage: stage.id, reason: "実装の CI を確認します" };
  return stop(`${stage.title} の結果を人間が承認すると次へ進みます`, stage.id);
}

/** その列に入った後に書かれた、いちばん新しい記録。列に入り直していれば、それ以前の記録は見ない。 */
function lastRunInStage(ctx: Ctx, issue: Issue, stageId: string): PostedRun | null {
  const entered = ctx.platform
    .listLabelEvents(issue.number)
    .filter((e) => e.action === "labeled" && e.label === flowLabel(ctx.flow, stageId))
    .map((e) => e.at)
    .pop();
  const runs = parseRuns(ctx.platform.listComments(issue.number), trustedAuthors(ctx.project)).filter(
    (r) => r.stage === stageId && (!entered || Date.parse(r.postedAt) > Date.parse(entered)),
  );
  return runs[runs.length - 1] ?? null;
}

/** その時刻より後に、人間(taskrail の記録でも bot でもない投稿者)のコメントがあるか。 */
function answeredAfter(ctx: Ctx, issue: Issue, at: string): boolean {
  return ctx.platform
    .listComments(issue.number)
    .some(
      (c) =>
        Date.parse(c.createdAt) > Date.parse(at) &&
        !ctx.project.bot_logins.includes(c.author) &&
        parseRuns([c]).length === 0,
    );
}

export function next(opts: { issue: string; flow?: string; repo?: string }): void {
  const ctx = loadCtx(opts);
  const step = nextStep(ctx, ctx.platform.getIssue(Number(opts.issue)));
  log(`#${opts.issue}: ${step.action}${step.stage ? `(${step.stage})` : ""} — ${step.reason}`);
  setOutputs({ action: step.action, stage: step.stage ?? "", reason: step.reason });
}
