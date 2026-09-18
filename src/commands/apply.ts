import { packageVersion, protectedPaths } from "../core/config.js";
import { type Ctx, loadCtx, log, moveTo, setOutputs, trustedAuthors } from "../core/context.js";
import { decide, getStage, sizeOf } from "../core/flow.js";
import { changedFilesSince, commitCountSince, dirtyFiles, git, matchProtected, resolveBranch } from "../core/git.js";
import { countRework, parseRuns, renderComment, type RunRecord } from "../core/record.js";
import { type AgentResult, combineStatus, readResult } from "../core/result.js";
import { RUN_DIR } from "./route.js";

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
  const ctx = loadCtx(opts);
  const stage = getStage(ctx.flow, opts.stage);
  const issue = ctx.platform.getIssue(Number(opts.issue));

  // 1. 結果ファイルの検証。前のエージェントが不合格なら、後続は実行されていないので読まない。
  const results: AgentResult[] = [];
  const errors: string[] = [];
  for (const agent of stage.agents) {
    const parsed = readResult(`${RUN_DIR}/result-${agent}.json`, agent);
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

  if (!violation && stage.mode === "read") {
    const dirty = dirtyFiles().filter((f) => !f.startsWith(".taskrail/"));
    if (dirty.length) violation = `読み取り専用の工程でファイルが変更されました: ${dirty.slice(0, 5).join(", ")}`;
  }
  if (!violation && stage.mode === "write" && status === "pass") {
    const base = `origin/${ctx.platform.defaultBranch()}`;
    const protectedHit = matchProtected(changedFilesSince(base), protectedPaths(ctx.project));
    const uncommitted = dirtyFiles().filter((f) => !f.startsWith(".taskrail/"));
    if (protectedHit.length) violation = `保護対象のファイルが変更されました: ${protectedHit.slice(0, 5).join(", ")}`;
    else if (uncommitted.length) violation = `コミットされていない変更があります: ${uncommitted.slice(0, 5).join(", ")}`;
    else if (commitCountSince(base) === 0) violation = "pass と報告されましたが、コミットがありません";
    else if (!opts.dryRun) prUrl = publish(ctx, issue.number, issue.title, results[0]!);
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
  };
  // 違反があった実行の成果物は、次工程に引き継がせない。
  const shown = violation ? results.map(({ artifact: _dropped, ...r }) => r) : results;
  const body = renderComment({ stageTitle: stage.title, rec, reason: decision.reason, results: shown, errors, pullRequestUrl: prUrl });

  if (opts.dryRun) {
    console.log(body);
    return;
  }

  // 4. 書き込み。コメント → 補助ラベル → 列の移動、の順。列の移動が次のイベントを発火させる。
  ctx.platform.addComment(issue.number, body);
  applyHintLabels(ctx, issue.number, issue.labels, violation ? [] : results);
  if (decision.addBlocked) ctx.platform.addLabels(issue.number, [ctx.flow.blocked_label]);
  if (decision.to) moveTo(ctx, ctx.platform.getIssue(issue.number), decision.to);

  log(`#${issue.number} ${stage.id}: ${rec.status} → ${decision.to ?? "(移動なし)"}${decision.addBlocked ? " [blocked]" : ""}`);
  setOutputs({ status: rec.status, to: decision.to ?? "", blocked: decision.addBlocked });
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

function publish(ctx: Ctx, issue: number, title: string, result: AgentResult): string {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const expected = resolveBranch(ctx.project.branch_prefix, issue, title);
  if (branch !== expected) throw new Error(`作業ブランチが想定と違います(期待: ${expected}、実際: ${branch})`);
  git(["push", "--set-upstream", "origin", branch]);
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
