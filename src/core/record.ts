import type { Comment } from "../adapters/types.js";
import type { AgentResult, Status } from "./result.js";

/**
 * フローの状態はすべて Issue に置く。エージェント側には何も持たせない。
 * taskrail が書くコメントには機械可読なマーカーを埋め込み、次の工程はそれを読んで再開する。
 */
const RUN_MARK = "taskrail:run";
const ARTIFACT_MARK = "taskrail:artifact";

export interface RunRecord {
  stage: string;
  status: Status | "error";
  to: string | null;
  blocked: boolean;
  version: string;
  at: string;
}

export function runMarker(rec: RunRecord): string {
  return `<!-- ${RUN_MARK} ${JSON.stringify(rec)} -->`;
}

export function artifactMarker(kind: string): string {
  return `<!-- ${ARTIFACT_MARK} ${kind} -->`;
}

export function parseRuns(comments: Comment[], trustedAuthors?: Set<string>): RunRecord[] {
  const runs: RunRecord[] = [];
  const re = new RegExp(`<!-- ${RUN_MARK} (\\{.*?\\}) -->`);
  for (const c of comments) {
    if (trustedAuthors && !trustedAuthors.has(c.author)) continue;
    const m = re.exec(c.body);
    if (!m) continue;
    try {
      runs.push(JSON.parse(m[1]!) as RunRecord);
    } catch {
      /* 壊れたマーカーは無視する */
    }
  }
  return runs;
}

/**
 * 直近の「承認された流れ」の中での差し戻し回数。
 * spec / plan に戻った(=仕様や計画を見直した)時点でリセットする。
 */
export function countRework(runs: RunRecord[], reworkStage: string): number {
  let n = 0;
  for (const r of runs) {
    if (r.stage === "spec" || r.stage === "plan") n = 0;
    if (r.stage === reworkStage && r.status === "fail") n++;
  }
  return n;
}

/** 指定した種類の最新の成果物(仕様・計画)を取り出す。マーカーは taskrail が書いたコメントだけを信用する。 */
export function latestArtifact(comments: Comment[], kind: string, trustedAuthors?: Set<string>): string | null {
  const mark = artifactMarker(kind);
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (trustedAuthors && !trustedAuthors.has(c.author)) continue;
    const at = c.body.indexOf(mark);
    if (at >= 0) return c.body.slice(at + mark.length).split("<!-- taskrail:")[0]!.trim();
  }
  return null;
}

/** 直近の不合格の指摘(実装エージェントへの差し戻し内容)。 */
export function latestFailureFeedback(comments: Comment[], trustedAuthors?: Set<string>): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (trustedAuthors && !trustedAuthors.has(c.author)) continue;
    const runs = parseRuns([c]);
    if (!runs.length) continue;
    return runs[0]!.status === "fail" ? stripMarkers(c.body) : null;
  }
  return null;
}

export function stripMarkers(body: string): string {
  return body.replace(/<!-- taskrail:[\s\S]*?-->/g, "").trim();
}

const STATUS_ICON: Record<Status | "error", string> = { pass: "✅", fail: "↩️", blocked: "⏸️", error: "⚠️" };

export function renderComment(args: {
  stageTitle: string;
  rec: RunRecord;
  reason: string;
  results: AgentResult[];
  errors: string[];
  pullRequestUrl?: string;
}): string {
  const { stageTitle, rec, reason, results, errors, pullRequestUrl } = args;
  const lines: string[] = [];
  lines.push(`### ${STATUS_ICON[rec.status]} taskrail: ${stageTitle}`, "", `**判定**: ${reason}`);
  if (pullRequestUrl) lines.push(`**PR/MR**: ${pullRequestUrl}`);
  for (const e of errors) lines.push("", `> ⚠️ ${e}`);

  for (const r of results) {
    lines.push("", `#### ${r.agent} — ${r.status}`, "", r.summary);
    if (r.questions?.length) {
      lines.push("", "**質問**(回答をコメントすると再開します)", ...r.questions.map((q, i) => `${i + 1}. ${q}`));
    }
    if (r.criteria?.length) {
      lines.push("", "| 受け入れ条件 | 判定 | 根拠 |", "| --- | --- | --- |");
      for (const c of r.criteria) lines.push(`| ${cell(c.text)} | ${c.met ? "OK" : "**NG**"} | ${cell(c.evidence ?? "")} |`);
    }
    if (r.findings?.length) {
      lines.push("", "| 重要度 | 場所 | 指摘 |", "| --- | --- | --- |");
      for (const f of r.findings) {
        const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
        lines.push(`| ${f.severity} | ${where} | ${cell(f.message)} |`);
      }
    }
  }
  lines.push("", `<sub>taskrail ${rec.version}</sub>`, runMarker(rec));
  // 成果物はコメントの末尾に置く(latestArtifact はマーカー以降を末尾まで読む)。
  for (const r of results) {
    if (r.artifact && (r.agent === "spec" || r.agent === "plan")) {
      lines.push("", "---", "", artifactMarker(r.agent), "", r.artifact.replace(/<!--/g, "&lt;!--"));
    }
  }
  return lines.join("\n");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}
