import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment, Issue } from "../adapters/types.js";
import { packageRoot } from "./config.js";
import { stripMarkers } from "./record.js";

export interface PromptContext {
  agent: string;
  resultPath: string;
  issue: Issue;
  /** 人間が書いたコメント(taskrail 自身のコメントを除く)。 */
  humanComments: Comment[];
  spec: string | null;
  plan: string | null;
  feedback: string[];
  baseBranch: string | null;
}

/** その工程に必要な文脈だけを渡す。前工程の会話や、関係のない成果物は含めない。 */
const NEEDS: Record<string, { comments: boolean; spec: boolean; plan: boolean; feedback: boolean; diff: boolean }> = {
  triage: { comments: false, spec: false, plan: false, feedback: false, diff: false },
  spec: { comments: true, spec: true, plan: false, feedback: false, diff: false },
  plan: { comments: true, spec: true, plan: true, feedback: false, diff: false },
  implement: { comments: false, spec: true, plan: true, feedback: true, diff: false },
  "verify-spec": { comments: false, spec: true, plan: false, feedback: false, diff: true },
  "code-review": { comments: false, spec: false, plan: false, feedback: false, diff: true },
};

const MAX_COMMENT_CHARS = 12_000;

export function buildPrompt(ctx: PromptContext): string {
  const dir = join(packageRoot(), "flow", "prompts");
  const fill = (s: string) => s.replaceAll("{{AGENT}}", ctx.agent).replaceAll("{{RESULT_PATH}}", ctx.resultPath);
  const common = fill(readFileSync(join(dir, "_common.md"), "utf8"));
  const stage = fill(readFileSync(join(dir, `${ctx.agent}.md`), "utf8"));
  const needs = NEEDS[ctx.agent] ?? { comments: true, spec: true, plan: true, feedback: true, diff: true };

  const parts: string[] = [common, stage, "# 入力"];
  parts.push(
    tag("issue", `#${ctx.issue.number} ${ctx.issue.title}\nラベル: ${ctx.issue.labels.join(", ")}\n\n${ctx.issue.body}`),
  );
  if (needs.spec && ctx.spec) parts.push(tag("spec", ctx.spec, "承認対象の最新の仕様"));
  if (needs.plan && ctx.plan) parts.push(tag("plan", ctx.plan, "最新の計画"));
  if (needs.comments && ctx.humanComments.length) {
    const text = ctx.humanComments.map((c) => `[${c.author} ${c.createdAt}]\n${stripMarkers(c.body)}`).join("\n\n");
    parts.push(tag("comments", text.slice(-MAX_COMMENT_CHARS), "人間のコメント(質問への回答を含む)"));
  }
  if (needs.feedback && ctx.feedback.length) {
    parts.push(tag("feedback", ctx.feedback.join("\n\n---\n\n"), "差し戻しの指摘。これへの対応が最優先"));
  }
  if (needs.diff && ctx.baseBranch) {
    parts.push(tag("diff", `git diff origin/${ctx.baseBranch}...HEAD で差分を確認してください。`));
  }
  return parts.join("\n\n");
}

/** タグの中身がタグを閉じてしまわないよう、閉じタグに似た文字列を無害化する。 */
function tag(name: string, content: string, note?: string): string {
  const safe = content.replace(new RegExp(`</?${name}\\b`, "gi"), (m) => m.replace("<", "&lt;"));
  return `<${name}${note ? ` note="${note}"` : ""}>\n${safe}\n</${name}>`;
}
