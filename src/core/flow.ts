import type { Flow, Project, Stage } from "./config.js";
import type { Status } from "./result.js";

export type Actor = "agent" | "human" | "system";

export function flowLabel(flow: Flow, stageId: string): string {
  return `${flow.label_prefix}${stageId}`;
}

export function isFlowLabel(flow: Flow, label: string): boolean {
  return label.startsWith(flow.label_prefix);
}

export function getStage(flow: Flow, id: string): Stage {
  const s = flow.stages.find((x) => x.id === id);
  if (!s) throw new Error(`未定義の stage: ${id}`);
  return s;
}

export function stageFromLabel(flow: Flow, label: string): Stage | null {
  if (!isFlowLabel(flow, label)) return null;
  return flow.stages.find((s) => s.id === label.slice(flow.label_prefix.length)) ?? null;
}

/** Issueのラベルから現在の stage を求める。flow:: ラベルが0個または複数なら不整合として null。 */
export function currentStage(flow: Flow, labels: string[]): Stage | null {
  const found = labels.map((l) => stageFromLabel(flow, l)).filter((s): s is Stage => s !== null);
  return found.length === 1 ? found[0]! : null;
}

export function sizeOf(labels: string[]): "s" | "m" | "l" | null {
  for (const l of labels) {
    const m = /^size::([sml])$/.exec(l);
    if (m) return m[1] as "s" | "m" | "l";
  }
  return null;
}

/** その遷移が、その主体に許可されているか。許可されていない遷移は実行しない。 */
export function canTransition(flow: Flow, from: string, to: string, actor: Actor): boolean {
  const s = getStage(flow, from);
  if (actor === "human") return s.human_next.includes(to);
  if (actor === "system") return s.system_next.includes(to);
  const agentTargets = [...Object.values(s.on_result), ...(s.auto_approve ? [s.auto_approve.to] : [])];
  return agentTargets.includes(to);
}

export interface Decision {
  /** 遷移先の stage id。動かさないときは null。 */
  to: string | null;
  addBlocked: boolean;
  reason: string;
}

export interface DecideInput {
  stage: Stage;
  status: Status;
  /** 結果ファイルの欠落・不正、または強制ルール違反があったか。 */
  violation: string | null;
  size: "s" | "m" | "l" | null;
  /** これまでの差し戻し回数(今回を含まない)。 */
  reworkCount: number;
}

/**
 * エージェントの結果から、次の列を決定的に決める。
 * エージェント自身には列を動かさせない。ここが唯一の判断箇所。
 */
export function decide(project: Project, input: DecideInput): Decision {
  const { stage, status, violation, size, reworkCount } = input;

  if (violation) {
    return { to: null, addBlocked: true, reason: `ルール違反または結果の不備のため停止: ${violation}` };
  }
  if (status === "blocked") {
    return { to: null, addBlocked: true, reason: "エージェントが質問を残して停止しました" };
  }
  if (status === "fail") {
    const target = stage.on_result.fail;
    if (stage.counts_rework && reworkCount + 1 >= project.max_rework) {
      return {
        to: null,
        addBlocked: true,
        reason: `差し戻しが上限(${project.max_rework}回)に達しました。仕様か計画の見直しが必要です`,
      };
    }
    if (target === "stay") return { to: null, addBlocked: true, reason: "工程が失敗しました。人間の確認が必要です" };
    return { to: target, addBlocked: false, reason: `不合格のため ${target} へ差し戻します(${reworkCount + 1}回目)` };
  }
  // pass
  if (stage.auto_approve && size && stage.auto_approve.sizes.includes(size)) {
    return {
      to: stage.auto_approve.to,
      addBlocked: false,
      reason: `size::${size} のため承認を省略して ${stage.auto_approve.to} へ進めます`,
    };
  }
  const target = stage.on_result.pass;
  if (target === "stay") {
    const wait = stage.mode === "write" ? "CIの成功を待ちます" : "人間の承認を待ちます";
    return { to: null, addBlocked: false, reason: `合格。${wait}` };
  }
  return { to: target, addBlocked: false, reason: `合格のため ${target} へ進めます` };
}
