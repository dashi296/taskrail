import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, isEnabled, loadCtx, log, moveTo, setOutputs, trustedAuthors } from "../core/context.js";
import { canTransition, flowLabel, stageFromLabel } from "../core/flow.js";
import { excludeTaskrailDir, git, resolveBranch, tryGit } from "../core/git.js";
import { buildPrompt, repoRules } from "../core/prompt.js";
import { latestArtifact, latestFailureFeedback, parseRuns } from "../core/record.js";

export const RUN_DIR = ".taskrail/run";
/** 作業ブランチの差分を見るエージェント(読み取り工程でも作業ブランチに切り替える)。 */
export const DIFF_AGENTS = new Set(["verify-spec", "code-review"]);

interface GhEvent {
  action?: string;
  label?: { name: string };
  issue?: { number: number };
  sender?: { login: string; type: string };
}

export interface RouteOptions {
  event?: string;
  issue?: string;
  stage?: string;
  flow?: string;
  repo?: string;
  checkout?: boolean;
}

/**
 * イベントを受け取り、「どのエージェントを、どのプロンプトと権限で動かすか」を決める。
 * ここではAIを呼ばない。決定的な処理だけを行い、結果を step output とファイルに書き出す。
 */
export function route(opts: RouteOptions): void {
  const skip = (why: string) => {
    log(`スキップ: ${why}`);
    setOutputs({ run: false, reason: why });
  };
  if (!isEnabled()) return skip("TASKRAIL_ENABLED=false(キルスイッチ)");

  const ctx = loadCtx(opts);
  const ev: GhEvent = opts.event ? (JSON.parse(readFileSync(opts.event, "utf8")) as GhEvent) : {};
  const number = opts.issue ? Number(opts.issue) : ev.issue?.number;
  if (!number) return skip("Issue番号が分かりません");

  const issue = ctx.platform.getIssue(number);
  if (issue.state !== "open") return skip("Issueが閉じています");

  // 起票直後: inbox に載せるだけ。ラベル付与のイベントで改めてこのコマンドが呼ばれる。
  if (ev.action === "opened") {
    if (!issue.labels.some((l) => l.startsWith(ctx.flow.label_prefix))) moveTo(ctx, issue, ctx.flow.stages[0]!.id);
    return skip("起票を inbox に載せました");
  }

  const labelName = opts.stage ? flowLabel(ctx.flow, opts.stage) : ev.label?.name;
  if (!labelName) return skip("対象のラベルがありません");
  const stage = stageFromLabel(ctx.flow, labelName);
  if (!stage) return skip(`flow ラベルではありません: ${labelName}`);
  if (!issue.labels.includes(labelName)) return skip("イベント後にラベルが外されています");
  if (issue.labels.includes(ctx.flow.blocked_label)) return skip("blocked のため実行しません");
  if (!stage.agents.length) return skip(`${stage.id} にはエージェントがいません`);
  if (stage.mode === "write" && !issue.labels.includes("ai::ok")) return skip("ai::ok が付いていないため実装しません");

  // 誰がこの列へ動かしたか。権限のない人やbotの操作では起動しない。
  if (ev.sender) {
    const denied = checkSender(ctx, ev.sender, issue.number, stage.id);
    if (denied) {
      ctx.platform.addLabels(issue.number, [ctx.flow.blocked_label]);
      ctx.platform.addComment(issue.number, `### ⚠️ taskrail\n\n${denied}\n\n列を正しい位置に戻し、\`${ctx.flow.blocked_label}\` を外してください。`);
      return skip(denied);
    }
  }

  // ルール文書の有無は、作業ブランチに切り替える前(既定ブランチの状態)で判定する。
  const rules = repoRules(process.cwd(), ctx.project);
  const comments = ctx.platform.listComments(issue.number);
  const trusted = trustedAuthors(ctx.project);
  const needsBranch = stage.mode === "write" || stage.agents.some((a) => DIFF_AGENTS.has(a));
  let base: string | null = null;
  let branch = "";
  let feedback: string[] = [];

  if (needsBranch) {
    base = ctx.platform.defaultBranch();
    tryGit(["fetch", "origin", "--prune"]);
    branch = resolveBranch(ctx.project.branch_prefix, issue.number, issue.title);
    if (opts.checkout !== false) checkoutBranch(branch, base, stage.mode === "write");
    if (stage.mode === "write") {
      const fromVerify = latestFailureFeedback(comments, trusted);
      const pr = ctx.platform.findPullRequestByBranch(branch);
      feedback = [...(fromVerify ? [fromVerify] : []), ...(pr ? ctx.platform.listReviewFeedback(pr.number) : [])];
    }
  }

  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  excludeTaskrailDir();

  const isTaskrailComment = (body: string) => parseRuns([{ id: 0, author: "", body, createdAt: "" }]).length > 0;
  const humanComments = comments.filter((c) => !isTaskrailComment(c.body) && !ctx.project.bot_logins.includes(c.author));

  const outputs: Record<string, string | number | boolean> = {
    run: true,
    issue: issue.number,
    stage: stage.id,
    mode: stage.mode,
    max_turns: stage.max_turns,
    branch,
    agents: stage.agents.join(","),
    allowed_bots: allowedBots(ctx.project.bot_logins),
    // 読み取り工程が書き込めるのは結果ファイルの置き場所だけ(Edit のパス指定は Write にも効く)。
    allowed_tools:
      stage.mode === "write"
        ? "Read,Glob,Grep,Edit,Write,Bash"
        : `Read,Glob,Grep,Edit(${RUN_DIR}/**),Bash(git diff:*),Bash(git log:*),Bash(git show:*)`,
  };

  stage.agents.forEach((agent, i) => {
    const resultPath = join(RUN_DIR, `result-${agent}.json`);
    const promptPath = join(RUN_DIR, `prompt-${agent}.md`);
    writeFileSync(
      promptPath,
      buildPrompt({
        agent,
        resultPath,
        issue,
        humanComments,
        spec: latestArtifact(comments, "spec", trusted),
        plan: latestArtifact(comments, "plan", trusted),
        feedback,
        baseBranch: base,
        rules,
      }),
    );
    outputs[`agent_${i + 1}`] = agent;
    outputs[`prompt_${i + 1}`] = promptPath;
    outputs[`result_${i + 1}`] = resultPath;
  });

  writeFileSync(join(RUN_DIR, "route.json"), JSON.stringify(outputs, null, 2));
  log(`#${issue.number} ${stage.id}: ${stage.agents.join(" → ")} を実行します`);
  setOutputs(outputs);
}

/**
 * claude-code-action の allowed_bots に渡す値。ラベル連鎖は taskrail の App が起こすため、
 * これがないと action は bot 起点のイベントを拒否する。GitHub のログイン名として不正な値は捨てる
 * (step output への改行の混入を防ぐ)。空なら bot からの起動を一切許可しない。
 */
export function allowedBots(logins: string[]): string {
  return logins.filter((l) => /^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/.test(l)).join(",");
}

function checkSender(ctx: Ctx, sender: { login: string; type: string }, issue: number, to: string): string | null {
  const isBot = ctx.project.bot_logins.includes(sender.login);
  if (!isBot) {
    if (sender.type === "Bot") return `許可されていない bot(${sender.login})がラベルを変更しました。`;
    const perm = ctx.platform.getPermission(sender.login);
    if (perm !== "admin" && perm !== "write") return `@${sender.login} にはフローを動かす権限(write 以上)がありません。`;
  }
  // 直前の列からの遷移が、その主体に許可されているかを確認する。
  const events = ctx.platform
    .listLabelEvents(issue)
    .filter((e) => e.action === "labeled" && e.label.startsWith(ctx.flow.label_prefix));
  const prev = events.length >= 2 ? stageFromLabel(ctx.flow, events[events.length - 2]!.label) : null;
  if (!prev || prev.id === to) return null;
  const ok = isBot
    ? canTransition(ctx.flow, prev.id, to, "agent") || canTransition(ctx.flow, prev.id, to, "system")
    : canTransition(ctx.flow, prev.id, to, "human");
  return ok ? null : `${prev.id} → ${to} は、${isBot ? "taskrail" : "人間"}に許可されていない遷移です。`;
}

function checkoutBranch(branch: string, base: string, createIfMissing: boolean): void {
  if (tryGit(["rev-parse", "--verify", `origin/${branch}`]) !== null) {
    git(["checkout", "-B", branch, `origin/${branch}`]);
  } else if (createIfMissing) {
    git(["checkout", "-B", branch, `origin/${base}`]);
  } else {
    throw new Error(`検証対象のブランチ origin/${branch} がありません`);
  }
}
