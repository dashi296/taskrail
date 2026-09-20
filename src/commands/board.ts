import { readFileSync } from "node:fs";
import { isEnabled, loadCtx, log, moveTo, setOutputs } from "../core/context.js";
import { canTransition, currentStage, flowLabel } from "../core/flow.js";
import { issueFromBranch } from "../core/git.js";

interface CommonOpts {
  flow?: string;
  repo?: string;
  dryRun?: boolean;
}

/**
 * Ready → In Progress の着手判断。WIP上限や依存関係は「ボード全体の今の状態」で決まるため、
 * イベントではなくスケジュール実行で全体を見て決める。
 */
export function dispatch(opts: CommonOpts): void {
  if (!isEnabled()) return log("TASKRAIL_ENABLED=false のため何もしません");
  const ctx = loadCtx(opts);
  const doing = ctx.platform.listOpenIssuesByLabel(flowLabel(ctx.flow, "doing"));
  const verify = ctx.platform.listOpenIssuesByLabel(flowLabel(ctx.flow, "verify"));
  let slots = ctx.project.wip_limit - doing.length - verify.length;
  log(`WIP: ${doing.length + verify.length}/${ctx.project.wip_limit}`);

  const ready = ctx.platform
    .listOpenIssuesByLabel(flowLabel(ctx.flow, "ready"))
    .filter((i) => i.labels.includes("ai::ok") && !i.labels.includes(ctx.flow.blocked_label))
    .sort((a, b) => a.number - b.number);

  const started: number[] = [];
  for (const issue of ready) {
    if (slots <= 0) break;
    const open = dependencies(issue.body).filter((n) => ctx.platform.getIssue(n).state === "open");
    if (open.length) {
      log(`#${issue.number}: 依存 ${open.map((n) => `#${n}`).join(", ")} が未完了のため見送ります`);
      continue;
    }
    log(`#${issue.number} に着手します`);
    if (!opts.dryRun) moveTo(ctx, issue, "doing");
    started.push(issue.number);
    slots--;
  }
  setOutputs({ started: started.join(",") });
}

/** Issue本文の "Depends on #12" / "依存: #12, #13" を拾う。 */
export function dependencies(body: string): number[] {
  const nums = new Set<number>();
  for (const line of body.split("\n")) {
    if (!/^\s*(?:[-*]\s*)?(?:depends on|blocked by|依存)/i.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) nums.add(Number(m[1]));
  }
  return [...nums];
}

/** CIの成功、レビューの修正依頼、マージなど、PR/MR側の出来事を列の移動に反映する。 */
export function advance(opts: CommonOpts & { branch: string; to: string; from?: string; requireChecks?: boolean }): void {
  if (!isEnabled()) return log("TASKRAIL_ENABLED=false のため何もしません");
  const ctx = loadCtx(opts);
  const number = issueFromBranch(ctx.project.branch_prefix, opts.branch);
  if (!number) return log(`taskrail のブランチではありません: ${opts.branch}`);
  const issue = ctx.platform.getIssue(number);
  const stage = currentStage(ctx.flow, issue.labels);
  if (!stage) return log(`#${number}: flow ラベルが1つに定まりません`);
  if (opts.from && stage.id !== opts.from) return log(`#${number}: 現在 ${stage.id} のため対象外(期待: ${opts.from})`);
  if (stage.id === opts.to) return log(`#${number}: すでに ${opts.to} です`);
  if (!canTransition(ctx.flow, stage.id, opts.to, "system")) {
    return log(`#${number}: ${stage.id} → ${opts.to} は system に許可されていません`);
  }
  if (opts.requireChecks) {
    // CI が複数あると workflow_run はそれぞれの完了で届く。すべての検査が成功した最後の1回だけで進める。
    const checks = ctx.platform.branchChecks(opts.branch);
    if (checks !== "success") return log(`#${number}: ${opts.branch} の検査が ${checks === "pending" ? "完了していません" : "失敗しています"}。${opts.to} には進めません`);
  }
  log(`#${number}: ${stage.id} → ${opts.to}`);
  if (!opts.dryRun) moveTo(ctx, issue, opts.to);
}

/** blocked のIssueに、権限のある人が回答コメントを書いたら再開する。 */
export function resume(opts: CommonOpts & { event: string }): void {
  if (!isEnabled()) return log("TASKRAIL_ENABLED=false のため何もしません");
  const ctx = loadCtx(opts);
  const ev = JSON.parse(readFileSync(opts.event, "utf8")) as {
    issue?: { number: number; pull_request?: unknown };
    comment?: { user: { login: string; type: string } };
  };
  if (!ev.issue || ev.issue.pull_request || !ev.comment) return log("Issueコメントのイベントではありません");
  const author = ev.comment.user;
  if (author.type === "Bot" || ctx.project.bot_logins.includes(author.login)) return log("botのコメントでは再開しません");

  const issue = ctx.platform.getIssue(ev.issue.number);
  if (!issue.labels.includes(ctx.flow.blocked_label)) return log("blocked ではありません");
  const perm = ctx.platform.getPermission(author.login);
  if (perm !== "admin" && perm !== "write") return log(`@${author.login} には再開する権限がありません`);
  const stage = currentStage(ctx.flow, issue.labels);
  if (!stage) return log("flow ラベルが1つに定まりません");

  log(`#${issue.number}: @${author.login} の回答で ${stage.id} を再開します`);
  if (opts.dryRun) return;
  ctx.platform.removeLabel(issue.number, ctx.flow.blocked_label);
  // 同じ列のラベルを付け直すと labeled イベントが発火し、その工程がもう一度走る。
  moveTo(ctx, ctx.platform.getIssue(issue.number), stage.id);
}
