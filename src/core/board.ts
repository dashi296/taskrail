import type { BoardItem, Issue } from "../adapters/types.js";
import type { Flow } from "./config.js";
import { isFlowLabel, stageFromLabel } from "./flow.js";

export interface BoardMove {
  number: number;
  /** 置く先の列(stage の title)。 */
  column: string;
  /** いまの列。ボードにない、またはどの列にもなければ null。 */
  from: string | null;
}

export interface BoardPlan {
  moves: BoardMove[];
  /** flow ラベルが複数あり、列が1つに定まらない Issue。 */
  ambiguous: number[];
}

/**
 * ラベルに合わせてボードを直すための操作を求める。ラベルが正で、ボードはその写し。
 * - ボードにある Issue と、flow ラベルの付いた open の Issue(ボードになければ追加する)を対象にする。
 * - 列が合っているものは動かさない。flow ラベルのない Issue には触らない。
 */
export function planBoard(flow: Flow, items: BoardItem[], labeled: Issue[]): BoardPlan {
  const targets = new Map<number, { labels: string[]; from: string | null }>();
  for (const i of labeled) targets.set(i.number, { labels: i.labels, from: null });
  // ボード上のアイテムを後から入れ、いまの列を持つほうを優先する。
  for (const i of items) targets.set(i.number, { labels: i.labels, from: i.column });

  const plan: BoardPlan = { moves: [], ambiguous: [] };
  for (const [number, t] of [...targets].sort((a, b) => a[0] - b[0])) {
    const flowLabels = t.labels.filter((l) => isFlowLabel(flow, l));
    if (flowLabels.length === 0) continue;
    const stage = flowLabels.length === 1 ? stageFromLabel(flow, flowLabels[0]!) : null;
    if (!stage) {
      plan.ambiguous.push(number);
      continue;
    }
    if (t.from !== stage.title) plan.moves.push({ number, column: stage.title, from: t.from });
  }
  return plan;
}
