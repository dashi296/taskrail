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
  /** 実装工程が PR を出したときの作業ブランチ。CI の結果で次の列へ進めるときに使う。 */
  branch?: string;
  /** そのときの作業ブランチの先頭コミット。CI の結果がこのコミットのものかを確かめる。 */
  sha?: string;
}

/** Issue から読み取った実行記録。postedAt はコメントの投稿時刻(サーバの時刻)。 */
export type PostedRun = RunRecord & { postedAt: string };

/**
 * 直近の記録が「stageId の工程が pass し、作業ブランチを残した」もので、かつ enteredAt(その列に入った時刻)より
 * 後に書かれたものなら、そのブランチとコミットを返す。
 * 差し戻し直後(直近が検証の fail)や、修正依頼などで列に戻った直後(記録が列に入る前のもの)は null。
 * 古いコミットの検査結果で先へ進めないための確認。
 */
export function implementedBranch(runs: PostedRun[], stageId: string, enteredAt?: string): { branch: string; sha: string } | null {
  const last = runs[runs.length - 1];
  if (!last || last.stage !== stageId || last.status !== "pass" || !last.branch || !last.sha) return null;
  if (enteredAt && Date.parse(last.postedAt) <= Date.parse(enteredAt)) return null;
  return { branch: last.branch, sha: last.sha };
}

export function runMarker(rec: RunRecord): string {
  return `<!-- ${RUN_MARK} ${JSON.stringify(rec)} -->`;
}

export function artifactMarker(kind: string): string {
  return `<!-- ${ARTIFACT_MARK} ${kind} -->`;
}

/**
 * 実行記録を読む。マーカーはコメントの先頭にあるものだけを採用する。
 * エージェントが書いた文字列(要約など)はすべてマーカーより後ろに置かれるため、そこに偽のマーカーを仕込んでも読まれない。
 */
export function parseRuns(comments: Comment[], trustedAuthors?: Set<string>): PostedRun[] {
  const runs: PostedRun[] = [];
  const re = new RegExp(`^<!-- ${RUN_MARK} (\\{[^\\n]*?\\}) -->`);
  for (const c of comments) {
    if (trustedAuthors && !trustedAuthors.has(c.author)) continue;
    const m = re.exec(c.body.trimStart());
    if (!m) continue;
    try {
      runs.push({ ...(JSON.parse(m[1]!) as RunRecord), postedAt: c.createdAt });
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
    // 実行記録のコメントでなければ読まない。成果物はコメントの末尾にあり、中身は無害化済みなので、最後の一致が本物。
    if (!parseRuns([c]).length) continue;
    const at = c.body.lastIndexOf(mark);
    if (at >= 0) return c.body.slice(at + mark.length).trim();
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
  // 実行記録のマーカーは先頭に置く(parseRuns は先頭だけを読む)。以降のエージェント由来の文字列はすべて無害化する。
  const lines: string[] = [runMarker(rec)];
  lines.push(`### ${STATUS_ICON[rec.status]} taskrail: ${stageTitle}`, "", `**判定**: ${safe(reason)}`);
  if (pullRequestUrl) lines.push(`**PR/MR**: ${pullRequestUrl}`);
  for (const e of errors) lines.push("", `> ⚠️ ${safe(e)}`);

  for (const r of results) {
    lines.push("", `#### ${safe(r.agent)} — ${r.status}`, "", safe(r.summary));
    if (r.questions?.length) {
      lines.push("", "**質問**(回答をコメントすると再開します)", ...r.questions.map((q, i) => `${i + 1}. ${safe(q)}`));
    }
    if (r.criteria?.length) {
      lines.push("", "| 受け入れ条件 | 判定 | 根拠 |", "| --- | --- | --- |");
      for (const c of r.criteria) lines.push(`| ${cell(c.text)} | ${c.met ? "OK" : "**NG**"} | ${cell(c.evidence ?? "")} |`);
    }
    if (r.findings?.length) {
      lines.push("", "| 重要度 | 場所 | 指摘 |", "| --- | --- | --- |");
      for (const f of r.findings) {
        const where = f.file ? `\`${safe(f.file).replace(/[`|\r\n]/g, "")}${f.line ? `:${f.line}` : ""}\`` : "";
        lines.push(`| ${f.severity} | ${where} | ${cell(f.message)} |`);
      }
    }
  }
  lines.push("", `<sub>taskrail ${rec.version}</sub>`);
  // 成果物はコメントの末尾に置く(latestArtifact は最後のマーカー以降を末尾まで読む)。
  for (const r of results) {
    if (r.artifact && (r.agent === "spec" || r.agent === "plan")) {
      lines.push("", "---", "", artifactMarker(r.agent), "", safe(r.artifact));
    }
  }
  return lines.join("\n");
}

/** エージェント由来の文字列から、HTML コメント(マーカー)の開始を無害化する。 */
function safe(s: string): string {
  return s.replace(/<!--/g, "&lt;!--");
}

function cell(s: string): string {
  return safe(s).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}
