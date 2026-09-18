import { readFileSync } from "node:fs";
import { type Ctx, isEnabled, loadCtx, log, moveTo, setOutputs, trustedAuthors } from "../core/context.js";
import { canTransition, currentStage, flowLabel } from "../core/flow.js";
import { issueFromBranch } from "../core/git.js";
import { implementedBranch, parseRuns } from "../core/record.js";
import type { Issue } from "../adapters/types.js";

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
  recheckImplemented(ctx, opts.dryRun);
  const doing = ctx.platform.listOpenIssuesByLabel(flowLabel(ctx.flow, "doing"));
  const verify = ctx.platform.listOpenIssuesByLabel(flowLabel(ctx.flow, "verify"));
  // 列を移した直後は API の一覧への反映が遅れ、同じ Issue が両方の列に出ることがあるため、番号で重複を除く。
  const wip = new Set([...doing, ...verify].map((i) => i.number)).size;
  let slots = ctx.project.wip_limit - wip;
  log(`WIP: ${wip}/${ctx.project.wip_limit}`);

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

/**
 * 実装が済んで CI 待ちの Issue を再判定する。CI の完了イベント(workflow_run)は taskrail が監視する CI の分しか届かず、
 * 外部 CI などが後から完了した場合に取りこぼすため、定期実行でも確認する。
 */
function recheckImplemented(ctx: Ctx, dryRun?: boolean): void {
  for (const stage of ctx.flow.stages.filter((s) => s.mode === "write" && s.system_next.length)) {
    const to = stage.system_next[0]!;
    for (const issue of ctx.platform.listOpenIssuesByLabel(flowLabel(ctx.flow, stage.id))) {
      if (issue.labels.includes(ctx.flow.blocked_label)) continue;
      const branch = checksPassedBranch(ctx, issue, stage.id);
      if (!branch.ok) continue;
      log(`#${issue.number}: ${branch.name} の検査がすべて成功しました。${stage.id} → ${to}`);
      if (!dryRun) moveTo(ctx, issue, to);
    }
  }
}

/** 直近の記録が実装の pass で、その作業ブランチの検査がすべて成功しているか。 */
function checksPassedBranch(ctx: Ctx, issue: Issue, stageId: string): { ok: true; name: string } | { ok: false; why: string } {
  const branch = implementedBranch(parseRuns(ctx.platform.listComments(issue.number), trustedAuthors(ctx.project)), stageId);
  if (!branch) return { ok: false, why: "直近の記録が実装の完了ではありません(実装中、または差し戻し直後)" };
  const checks = ctx.platform.branchChecks(branch);
  if (checks !== "success") return { ok: false, why: `${branch} の検査が${checks === "pending" ? "完了していません" : "失敗しています"}` };
  return { ok: true, name: branch };
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
    // 差し戻し直後に古いコミットの結果で進まないよう、直近の記録が実装の完了であることも確かめる。
    const r = checksPassedBranch(ctx, issue, stage.id);
    if (!r.ok) return log(`#${number}: ${r.why}。${opts.to} には進めません`);
    if (r.name !== opts.branch) return log(`#${number}: 実装の記録のブランチ(${r.name})とイベントのブランチ(${opts.branch})が違います`);
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
