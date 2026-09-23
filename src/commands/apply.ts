import { join } from "node:path";
import { packageVersion, protectedPaths } from "../core/config.js";
import type { Issue } from "../adapters/types.js";
import { type Ctx, isEnabled, loadCtx, log, moveTo, setOutputs, trustedAuthors } from "../core/context.js";
import { currentStage, decide, getStage, sizeOf } from "../core/flow.js";
import { commitCountSince, dirtyFiles, fetchCommit, git, protectedChanges, pushBranch, resolveBranch } from "../core/git.js";
import { countRework, parseRuns, renderComment, type RunRecord } from "../core/record.js";
import { type AgentResult, combineStatus, readResult } from "../core/result.js";
import { DIFF_AGENTS, RUN_DIR } from "./route.js";

export interface ApplyOptions {
  issue: string;
  stage: string;
  flow?: string;
  repo?: string;
  dryRun?: boolean;
}

/**
 * エージェントの結果を検証し、Issueへの書き込みと列の移動を行う。
 * 書き込みはすべてここに集約する。エージェント自身は Issue にもラベルにも触れない。
 */
export function apply(opts: ApplyOptions): void {
  if (!isEnabled()) return log("TASKRAIL_ENABLED=false のため何もしません");
  applyWith(loadCtx(opts), opts);
}

/** apply の本体。テストから Ctx と作業ディレクトリを与えられるように分けてある。 */
export function applyWith(ctx: Ctx, opts: ApplyOptions, cwd = process.cwd()): void {
  const stage = getStage(ctx.flow, opts.stage);
  const issue = ctx.platform.getIssue(Number(opts.issue));
  // エージェントの実行中に人間が列を戻す・閉じるなどした場合、古い実行の結果で上書きしない。
  const stale = staleReason(ctx, issue, stage.id);
  if (stale) return log(`#${issue.number}: ${stale}。この実行の結果は反映しません`);

  // 1. 結果ファイルの検証。前のエージェントが不合格なら、後続は実行されていないので読まない。
  const results: AgentResult[] = [];
  const errors: string[] = [];
  for (const agent of stage.agents) {
    const parsed = readResult(join(cwd, RUN_DIR, `result-${agent}.json`), agent);
    if (!parsed.ok) {
      errors.push(`${agent}: ${parsed.error}`);
      break;
    }
    results.push(parsed.result);
    if (parsed.result.status !== "pass") break;
  }

  // 2. 強制ルール。エージェントがルールを忘れていても、ここで止める。
  let violation: string | null = errors[0] ?? null;
  let prUrl: string | undefined;
  const status = results.length ? combineStatus(results.map((r) => r.status)) : "fail";

  // 比較の基準は API で得たリモートの SHA。git の失敗は違反として扱う(検査を素通りさせない)。
  const check = (fn: () => string | null, failure = "検査を実行できませんでした"): string | null => {
    try {
      return fn();
    } catch (e) {
      return `${failure}: ${(e as Error).message.split("\n")[0]}`;
    }
  };
  const remoteSha = (branch: string): string => {
    const sha = ctx.platform.branchHead(branch);
    if (!sha) throw new Error(`リモートのブランチ ${branch} がありません`);
    return fetchCommit(sha, cwd);
  };
  if (!violation && stage.mode === "read") {
    violation = check(() => {
      const dirty = dirtyFiles(cwd).filter((f) => !f.startsWith(".taskrail/"));
      if (dirty.length) return `読み取り専用の工程でファイルが変更されました: ${dirty.slice(0, 5).join(", ")}`;
      // コミットしてしまえば作業ツリーはきれいに見えるため、リモートにないコミットも検出する。
      const onBranch = stage.agents.some((a) => DIFF_AGENTS.has(a));
      const ref = onBranch ? resolveBranch(ctx.project.branch_prefix, issue.number, issue.title, cwd) : ctx.platform.defaultBranch();
      if (commitCountSince(remoteSha(ref), cwd) > 0) return "読み取り専用の工程でコミットが作られました";
      return null;
    });
  }
  let head: string | undefined;
  if (!violation && stage.mode === "write" && status === "pass") {
    violation = check(() => {
      const base = remoteSha(ctx.platform.defaultBranch());
      const protectedHit = protectedChanges(base, protectedPaths(ctx.project), cwd);
      const uncommitted = dirtyFiles(cwd).filter((f) => !f.startsWith(".taskrail/"));
      if (protectedHit.length) return `保護対象のファイルが変更されました: ${protectedHit.slice(0, 5).join(", ")}`;
      if (uncommitted.length) return `コミットされていない変更があります: ${uncommitted.slice(0, 5).join(", ")}`;
      if (commitCountSince(base, cwd) === 0) return "pass と報告されましたが、コミットがありません";
      return null;
    });
    if (!violation && !opts.dryRun) {
      const nowStale = staleReason(ctx, ctx.platform.getIssue(issue.number), stage.id);
      if (nowStale) return log(`#${issue.number}: ${nowStale}。この実行の結果は反映しません`);
      // push や PR の作成に失敗しても、記録を残さずに終わらせない。
      violation = check(() => {
        prUrl = publish(ctx, issue.number, issue.title, results[0]!, cwd);
        head = git(["rev-parse", "HEAD"], cwd);
        return null;
      }, "push または PR の作成に失敗しました");
    }
  }

  // 3. 次の列を決める。
  const runs = parseRuns(ctx.platform.listComments(issue.number), trustedAuthors(ctx.project));
  const decision = decide(ctx.project, {
    stage,
    status,
    violation,
    size: results.map((r) => r.labels?.size).find(Boolean) ?? sizeOf(issue.labels),
    reworkCount: stage.counts_rework ? countRework(runs, stage.id) : 0,
  });

  const rec: RunRecord = {
    stage: stage.id,
    status: violation ? "error" : status,
    to: decision.to,
    blocked: decision.addBlocked,
    version: packageVersion(),
    at: new Date().toISOString(),
    ...(prUrl && head ? { branch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd), sha: head } : {}),
  };
  // 違反があった実行の成果物は、次工程に引き継がせない。
  const shown = violation ? results.map(({ artifact: _dropped, ...r }) => r) : results;
  const body = renderComment({ stageTitle: stage.title, rec, reason: decision.reason, results: shown, errors, pullRequestUrl: prUrl });

  if (opts.dryRun) {
    console.log(body);
    return;
  }

  // 4. 書き込み。コメント → 補助ラベル → 列の移動、の順。列の移動が次のイベントを発火させる。
  const nowStale = staleReason(ctx, ctx.platform.getIssue(issue.number), stage.id);
  if (nowStale) return log(`#${issue.number}: ${nowStale}。この実行の結果は反映しません`);
  ctx.platform.addComment(issue.number, body);
  applyHintLabels(ctx, issue.number, issue.labels, violation ? [] : results);
  if (decision.addBlocked) ctx.platform.addLabels(issue.number, [ctx.flow.blocked_label]);
  if (decision.to) moveTo(ctx, ctx.platform.getIssue(issue.number), decision.to);

  log(`#${issue.number} ${stage.id}: ${rec.status} → ${decision.to ?? "(移動なし)"}${decision.addBlocked ? " [blocked]" : ""}`);
  setOutputs({ status: rec.status, to: decision.to ?? "", blocked: decision.addBlocked });
}

/** この実行の結果を反映してよい状態でなければ、その理由。 */
export function staleReason(ctx: Ctx, issue: Issue, stageId: string): string | null {
  if (issue.state !== "open") return "Issue が閉じられています";
  if (issue.labels.includes(ctx.flow.blocked_label)) return `${ctx.flow.blocked_label} が付いています`;
  const current = currentStage(ctx.flow, issue.labels)?.id;
  if (current !== stageId) return `列が ${current ?? "(1つに定まらない)"} に変わっています(実行時: ${stageId})`;
  return null;
}

/** size:: / ai:: は、まだ付いていないときだけAIの提案を採用する。人間が付けたものは上書きしない。 */
function applyHintLabels(ctx: Ctx, issue: number, current: string[], results: AgentResult[]): void {
  const add: string[] = [];
  for (const r of results) {
    if (r.labels?.size && !current.some((l) => l.startsWith("size::"))) add.push(`size::${r.labels.size}`);
    if (r.labels?.ai && !current.some((l) => l.startsWith("ai::"))) add.push(`ai::${r.labels.ai}`);
  }
  if (add.length) ctx.platform.addLabels(issue, [...new Set(add)]);
}

function publish(ctx: Ctx, issue: number, title: string, result: AgentResult, cwd: string): string {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const expected = resolveBranch(ctx.project.branch_prefix, issue, title, cwd);
  if (branch !== expected) throw new Error(`作業ブランチが想定と違います(期待: ${expected}、実際: ${branch})`);
  pushBranch(branch, cwd);
  const existing = ctx.platform.findPullRequestByBranch(branch);
  if (existing) return existing.url;
  const pr = ctx.platform.createPullRequest({
    head: branch,
    base: ctx.platform.defaultBranch(),
    title: result.pr_title ?? title,
    body: `Closes #${issue}\n\n${result.summary}\n\n<sub>taskrail ${packageVersion()} が作成しました。マージは人間が行います。</sub>`,
  });
  return pr.url;
}
