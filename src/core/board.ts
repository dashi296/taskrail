import type { BoardItem, Issue } from "../adapters/types.js";
import type { Flow } from "./config.js";
import { currentStage, isFlowLabel } from "./flow.js";

export interface BoardMove {
  number: number;
  /** 置く先の列(stage の title)。 */
  column: string;
  /** いまの列。ボードにない、またはどの列にもなければ null。 */
  from: string | null;
}

export interface BoardPlan {
  moves: BoardMove[];
  /** flow ラベルから列が1つに定まらない Issue(複数ある、未定義の列を指している)。 */
  unresolved: number[];
}

/**
 * ラベルに合わせてボードを直すための操作を求める。ラベルが正で、ボードはその写し。
 * - open の Issue のうち、ボードにあるものと、flow ラベルの付いたもの(ボードになければ追加する)を対象にする。
 * - 列が合っているものは動かさない。flow ラベルのない Issue と、閉じた Issue には触らない
 *   (閉じた後のカードの置き場所は、ボード側の自動化や人間に任せる)。
 * - 列の判定は route などと同じ currentStage で行う。
 */
export function planBoard(flow: Flow, items: BoardItem[], labeled: Issue[]): BoardPlan {
  const targets = new Map<number, { labels: string[]; state: "open" | "closed"; from: string | null }>();
  for (const i of labeled) targets.set(i.number, { labels: i.labels, state: i.state, from: null });
  // ボード上のアイテムを後から入れ、いまの列を持つほうを優先する。
  for (const i of items) targets.set(i.number, { labels: i.labels, state: i.state, from: i.column });

  const plan: BoardPlan = { moves: [], unresolved: [] };
  for (const [number, t] of [...targets].sort((a, b) => a[0] - b[0])) {
    if (t.state !== "open" || !t.labels.some((l) => isFlowLabel(flow, l))) continue;
    const stage = currentStage(flow, t.labels);
    if (!stage) {
      plan.unresolved.push(number);
      continue;
    }
    if (t.from !== stage.title) plan.moves.push({ number, column: stage.title, from: t.from });
  }
  return plan;
}
