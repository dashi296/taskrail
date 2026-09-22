import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment, Issue } from "../adapters/types.js";
import { packageRoot, protectedPaths } from "./config.js";
import { stripMarkers } from "./record.js";

export interface PromptContext {
  agent: string;
  resultPath: string;
  issue: Issue;
  /** 人間が書いたコメント(taskrail 自身のコメントを除く)。 */
  humanComments: Comment[];
  /** blocked の質問への回答(直近の blocked の記録より後の人間のコメント)。どの工程にも渡す。 */
  answers?: Comment[];
  spec: string | null;
  plan: string | null;
  feedback: string[];
  baseBranch: string | null;
  /** 読み取り工程向けに書き出した差分とコミットの一覧(読み取り工程は git を実行できない)。 */
  diffFiles?: { patch: string; log: string } | null;
  rules: RepoRules;
}

/** 導入先リポジトリのルール。導入先にファイルがなくても、エージェントが判断できるだけの情報を渡す。 */
export interface RepoRules {
  /** 導入先にあるルール文書(リポジトリのルートからの相対パス)。 */
  docs: string[];
  /** 導入先に docs/constitution.md がないときに埋め込む既定の原則。あるときは null。 */
  defaultConstitution: string | null;
  checkCommands: string[];
  protectedPaths: string[];
}

const RULE_DOCS = ["CLAUDE.md", "AGENTS.md", "docs/constitution.md"];

export function repoRules(cwd: string, project: { check_commands: string[]; protected_paths: string[] }): RepoRules {
  const docs = RULE_DOCS.filter((f) => existsSync(join(cwd, f)));
  return {
    docs,
    defaultConstitution: docs.includes("docs/constitution.md") ? null : readFileSync(join(packageRoot(), "flow", "constitution.md"), "utf8"),
    checkCommands: project.check_commands,
    protectedPaths: protectedPaths(project),
  };
}

/** 既定の原則を「## 原則(既定)」の下に収める。表題と人間向けの注記(引用)を除き、見出しを1段下げる。 */
function embedConstitution(text: string): string {
  return text
    .split("\n")
    .filter((l, i) => !(i === 0 && l.startsWith("# ")) && !l.startsWith(">"))
    .map((l) => (l.startsWith("#") ? `#${l}` : l))
    .join("\n")
    .trim();
}

/** プロンプトの一部として渡す(タグで囲む入力とは違い、taskrail が決めた信頼できる内容)。 */
function renderRules(r: RepoRules): string {
  const list = (xs: string[]) => xs.map((x) => `- \`${x}\``).join("\n");
  const parts = ["# このリポジトリのルール"];
  parts.push(
    r.docs.length
      ? `次のルール文書を読み、従ってください。\n\n${list(r.docs)}`
      : "このリポジトリにはルール文書(`CLAUDE.md`、`AGENTS.md`、`docs/constitution.md`)がありません。README と既存のコードから慣習を読み取ってください。",
  );
  parts.push(
    r.checkCommands.length
      ? `## 完了前に通すコマンド\n\n\`\`\`sh\n${r.checkCommands.join("\n")}\n\`\`\``
      : "## 完了前に通すコマンド\n\n指定はありません。ルール文書、README、`package.json` などのビルド定義、CI の定義から、lint・型チェック・テストのコマンドを判断してください。実行したコマンドは `summary` に書きます。",
  );
  parts.push(`## 変更してはいけないパス(protected_paths)\n\n${list(r.protectedPaths)}`);
  if (r.defaultConstitution) {
    parts.push(`## 原則(既定)\n\n\`docs/constitution.md\` がないため、次の既定の原則に従います。\n\n${embedConstitution(r.defaultConstitution)}`);
  }
  return parts.join("\n\n");
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

  const parts: string[] = [common, stage, renderRules(ctx.rules), "# 入力"];
  parts.push(
    tag("issue", `#${ctx.issue.number} ${ctx.issue.title}\nラベル: ${ctx.issue.labels.join(", ")}\n\n${ctx.issue.body}`),
  );
  if (needs.spec && ctx.spec) parts.push(tag("spec", ctx.spec, "承認対象の最新の仕様"));
  if (needs.plan && ctx.plan) parts.push(tag("plan", ctx.plan, "最新の計画"));
  if (needs.comments && ctx.humanComments.length) {
    const text = ctx.humanComments.map((c) => `[${c.author} ${c.createdAt}]\n${stripMarkers(c.body)}`).join("\n\n");
    parts.push(tag("comments", text.slice(-MAX_COMMENT_CHARS), "人間のコメント(質問への回答を含む)"));
  }
  // コメント全体を渡していない工程でも、質問への回答だけは渡す(渡さないと blocked から再開できない)。
  if (!needs.comments && ctx.answers?.length) {
    const text = ctx.answers.map((c) => `[${c.author} ${c.createdAt}]\n${stripMarkers(c.body)}`).join("\n\n");
    parts.push(tag("answers", text.slice(-MAX_COMMENT_CHARS), "前回の blocked の質問への回答"));
  }
  if (needs.feedback && ctx.feedback.length) {
    parts.push(tag("feedback", ctx.feedback.join("\n\n---\n\n"), "差し戻しの指摘。これへの対応が最優先"));
  }
  if (needs.diff && ctx.baseBranch) {
    parts.push(
      tag(
        "diff",
        ctx.diffFiles
          ? `ベースブランチ(origin/${ctx.baseBranch})との差分は ${ctx.diffFiles.patch}、コミットの一覧は ${ctx.diffFiles.log} にあります。Read で読んでください。`
          : `git diff origin/${ctx.baseBranch}...HEAD で差分を確認してください。`,
      ),
    );
  }
  return parts.join("\n\n");
}

/** タグの中身がタグを閉じてしまわないよう、閉じタグに似た文字列を無害化する。 */
function tag(name: string, content: string, note?: string): string {
  const safe = content.replace(new RegExp(`</?${name}\\b`, "gi"), (m) => m.replace("<", "&lt;"));
  return `<${name}${note ? ` note="${note}"` : ""}>\n${safe}\n</${name}>`;
}
