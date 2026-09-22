import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, isEnabled, loadCtx, log, moveTo, setOutputs, trustedAuthors } from "../core/context.js";
import { canTransition, currentStage, flowLabel } from "../core/flow.js";
import { runChecks } from "../core/checks.js";
import { fetchCommit, issueFromBranch } from "../core/git.js";
import { implementedBranch, parseRuns } from "../core/record.js";
import type { CiRun, Issue } from "../adapters/types.js";
import { findEntryWorkflows, listedCiWorkflows } from "./setup.js";

interface CommonOpts {
  flow?: string;
  repo?: string;
  dryRun?: boolean;
  /** CI の成功の代わりに、手元で check_commands を実行して判定する(ローカル運用)。 */
  localChecks?: boolean;
}

/**
 * Ready → In Progress の着手判断。WIP上限や依存関係は「ボード全体の今の状態」で決まるため、
 * イベントではなくスケジュール実行で全体を見て決める。
 */
export function dispatch(opts: CommonOpts): void {
  if (!isEnabled()) return log("TASKRAIL_ENABLED=false のため何もしません");
  const ctx = loadCtx(opts);
  recheckImplemented(ctx, expectedCiWorkflows(), opts.dryRun, opts.localChecks);
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
 * 1件の失敗(ブランチの削除、権限不足、API の一時的な障害)で、ほかの Issue や着手の判断を止めない。
 */
export function recheckImplemented(ctx: Ctx, expectedCi: string[], dryRun?: boolean, localChecks?: boolean): void {
  for (const stage of ctx.flow.stages.filter((s) => s.mode === "write" && s.system_next.length)) {
    const to = stage.system_next[0]!;
    for (const issue of ctx.platform.listOpenIssuesByLabel(flowLabel(ctx.flow, stage.id))) {
      if (issue.labels.includes(ctx.flow.blocked_label)) continue;
      try {
        const r = checksPassed(ctx, issue, stage.id, expectedCi, localChecks);
        if (!r.ok) continue;
        log(`#${issue.number}: ${r.branch} の検査がすべて成功しました。${stage.id} → ${to}`);
        if (!dryRun) moveTo(ctx, issue, to);
      } catch (e) {
        log(`#${issue.number}: 検査の確認に失敗しました(次回に再確認します): ${(e as Error).message}`);
      }
    }
  }
}

/**
 * 実装が済み、その結果の CI がすべて成功したか。次をすべて満たすときだけ ok。
 * 1. 直近の記録が、この列に入った後に書かれた実装の pass(差し戻しや修正依頼の直後ではない)
 * 2. 作業ブランチの先頭が、記録したコミットのまま(記録の後に誰かが push していない)
 * 3. そのコミットの検査がすべて成功している
 * 4. 監視している CI(入口ワークフローの workflow_run.workflows)が、そのコミットですべて成功している
 */
export function checksPassed(
  ctx: Ctx,
  issue: Issue,
  stageId: string,
  expectedCi: string[],
  localChecks?: boolean,
): { ok: true; branch: string } | { ok: false; why: string } {
  const label = flowLabel(ctx.flow, stageId);
  const entered = ctx.platform
    .listLabelEvents(issue.number)
    .filter((e) => e.action === "labeled" && e.label === label)
    .map((e) => e.at)
    .pop();
  const impl = implementedBranch(parseRuns(ctx.platform.listComments(issue.number), trustedAuthors(ctx.project)), stageId, entered);
  if (!impl) return { ok: false, why: "この列に入った後の実装の完了の記録がありません(実装中、または差し戻し直後)" };
  const head = ctx.platform.branchHead(impl.branch);
  if (head !== impl.sha) return { ok: false, why: `${impl.branch} の先頭が実装の記録(${impl.sha.slice(0, 7)})と違います` };
  if (localChecks) {
    // ローカル運用では、CI の完了を待たずに手元で検査する。本番(Actions)とは判定の根拠が違う。
    fetchCommit(impl.sha);
    const r = runChecks(impl.sha, ctx.project.check_commands);
    if (!r.ok) return { ok: false, why: `手元の検査: ${r.why}` };
    if (ctx.platform.branchHead(impl.branch) !== impl.sha) return { ok: false, why: `${impl.branch} に検査中の push がありました` };
    return { ok: true, branch: impl.branch };
  }
  const checks = ctx.platform.commitChecks(impl.sha);
  if (checks !== "success") return { ok: false, why: `${impl.branch} の検査が${checks === "pending" ? "完了していません" : "失敗しています"}` };
  const missing = missingCiRuns(ctx.platform.ciRuns(impl.sha), expectedCi);
  if (missing.length) return { ok: false, why: `${impl.branch} で次の CI が成功していません: ${missing.join(", ")}` };
  // 検査を問い合わせている間に push されていたら、新しいコミットは未検査なので進めない。
  if (ctx.platform.branchHead(impl.branch) !== impl.sha) return { ok: false, why: `${impl.branch} に検査中の push がありました` };
  return { ok: true, branch: impl.branch };
}

/**
 * 期待する CI のうち、最新の実行が成功していないもの(未実行を含む)。
 * PR で動いた実行(pull_request)だけを見る。同じワークフローが push でも動く場合、そちらの成功で PR 側の失敗を隠さない。
 */
export function missingCiRuns(runs: CiRun[], expected: string[]): string[] {
  return expected.filter((name) => {
    const latest = runs.filter((r) => r.name === name && r.event === "pull_request").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return !latest || latest.status !== "completed" || latest.conclusion !== "success";
  });
}

/** CIの成功、レビューの修正依頼、マージなど、PR/MR側の出来事を列の移動に反映する。 */
export function advance(opts: AdvanceOpts): void {
  if (!isEnabled()) return log("TASKRAIL_ENABLED=false のため何もしません");
  advanceIssue(loadCtx(opts), opts, expectedCiWorkflows());
}

type AdvanceOpts = CommonOpts & { branch: string; to: string; from?: string; requireChecks?: boolean; actor?: string };

/** advance の本体。移したら true。 */
export function advanceIssue(ctx: Ctx, opts: AdvanceOpts, expectedCi: string[]): boolean {
  const skip = (msg: string) => {
    log(msg);
    return false;
  };
  const number = issueFromBranch(ctx.project.branch_prefix, opts.branch);
  if (!number) return skip(`taskrail のブランチではありません: ${opts.branch}`);
  const issue = ctx.platform.getIssue(number);
  const stage = currentStage(ctx.flow, issue.labels);
  if (!stage) return skip(`#${number}: flow ラベルが1つに定まりません`);
  if (opts.from && stage.id !== opts.from) return skip(`#${number}: 現在 ${stage.id} のため対象外(期待: ${opts.from})`);
  if (stage.id === opts.to) return skip(`#${number}: すでに ${opts.to} です`);
  if (!canTransition(ctx.flow, stage.id, opts.to, "system")) {
    return skip(`#${number}: ${stage.id} → ${opts.to} は system に許可されていません`);
  }
  if (opts.actor) {
    // 修正依頼などの人間の操作をきっかけに動かすときは、その人に write 以上の権限があることを確かめる。
    const perm = ctx.platform.getPermission(opts.actor);
    if (perm !== "admin" && perm !== "write") return skip(`#${number}: @${opts.actor} には列を動かす権限(write 以上)がありません`);
  }
  if (opts.requireChecks) {
    // CI が複数あると workflow_run はそれぞれの完了で届く。すべての検査が成功した最後の1回だけで進める。
    const r = checksPassed(ctx, issue, stage.id, expectedCi, opts.localChecks);
    if (!r.ok) return skip(`#${number}: ${r.why}。${opts.to} には進めません`);
    if (r.branch !== opts.branch) return skip(`#${number}: 実装の記録のブランチ(${r.branch})とイベントのブランチ(${opts.branch})が違います`);
  }
  log(`#${number}: ${stage.id} → ${opts.to}`);
  if (!opts.dryRun) moveTo(ctx, issue, opts.to);
  return true;
}

/** 監視している CI の名前。入口ワークフロー(既定ブランチのもの)の workflow_run.workflows。なければ空(ローカル実行)。 */
function expectedCiWorkflows(cwd = process.cwd()): string[] {
  const entry = findEntryWorkflows(cwd)[0];
  return entry ? listedCiWorkflows(readFileSync(join(cwd, entry), "utf8")) : [];
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
