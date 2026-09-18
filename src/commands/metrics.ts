import type { LabelEvent } from "../adapters/types.js";
import { loadCtx, trustedAuthors } from "../core/context.js";
import { stageFromLabel } from "../core/flow.js";
import { parseRuns } from "../core/record.js";

export interface IssueMetrics {
  dwellHours: Record<string, number>;
  rework: number;
  blocked: number;
}

/** ラベルの付け外しの履歴から、列ごとの滞留時間を求める。 */
export function dwellFromEvents(events: LabelEvent[], prefix: string, endIso: string): Record<string, number> {
  const dwell: Record<string, number> = {};
  const opened = new Map<string, number>();
  const close = (label: string, at: number) => {
    const start = opened.get(label);
    if (start === undefined) return;
    const id = label.slice(prefix.length);
    dwell[id] = (dwell[id] ?? 0) + (at - start) / 3_600_000;
    opened.delete(label);
  };
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!e.label.startsWith(prefix)) continue;
    const t = Date.parse(e.at);
    if (e.action === "labeled") {
      for (const l of [...opened.keys()]) close(l, t); // 排他でない環境でも、次の列に入った時点で前の列を閉じる
      opened.set(e.label, t);
    } else close(e.label, t);
  }
  for (const l of [...opened.keys()]) close(l, Date.parse(endIso));
  return dwell;
}

export function metrics(opts: { days: string; flow?: string; repo?: string; json?: boolean }): void {
  const ctx = loadCtx(opts);
  const since = new Date(Date.now() - Number(opts.days) * 86_400_000).toISOString();
  const issues = ctx.platform
    .listClosedIssuesSince(since)
    .filter((i) => i.labels.some((l) => stageFromLabel(ctx.flow, l) !== null));

  const rows: Array<IssueMetrics & { number: number }> = issues.map((i) => {
    const runs = parseRuns(ctx.platform.listComments(i.number), trustedAuthors(ctx.project));
    return {
      number: i.number,
      dwellHours: dwellFromEvents(ctx.platform.listLabelEvents(i.number), ctx.flow.label_prefix, new Date().toISOString()),
      rework: runs.filter((r) => r.stage === "verify" && r.status === "fail").length,
      blocked: runs.filter((r) => r.blocked).length,
    };
  });

  const n = rows.length;
  const avg = (f: (r: IssueMetrics) => number) => (n ? rows.reduce((s, r) => s + f(r), 0) / n : 0);
  const summary = {
    since,
    issues: n,
    avgDwellHours: Object.fromEntries(
      ctx.flow.stages.filter((s) => s.id !== "done").map((s) => [s.id, round(avg((r) => r.dwellHours[s.id] ?? 0))]),
    ),
    reworkRate: round(n ? rows.filter((r) => r.rework > 0).length / n : 0),
    avgRework: round(avg((r) => r.rework)),
    blockedRate: round(n ? rows.filter((r) => r.blocked > 0).length / n : 0),
  };

  if (opts.json) return console.log(JSON.stringify({ summary, rows }, null, 2));
  console.log(`直近 ${opts.days} 日に完了した Issue: ${n} 件\n`);
  console.log("列ごとの平均滞留時間(時間)");
  for (const [id, h] of Object.entries(summary.avgDwellHours)) console.log(`  ${id.padEnd(8)} ${String(h).padStart(7)}`);
  console.log(`\n差し戻しが発生した割合: ${pct(summary.reworkRate)}(平均 ${summary.avgRework} 回)`);
  console.log(`blocked が発生した割合: ${pct(summary.blockedRate)}`);
}

const round = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number) => `${Math.round(x * 100)}%`;
