import { describe, expect, it } from "vitest";
import { checkFlow, loadFlow, ProjectSchema } from "../src/core/config.js";
import { canTransition, currentStage, decide, getStage, sizeOf, stageFromLabel } from "../src/core/flow.js";

const flow = loadFlow();
const project = ProjectSchema.parse({});
const base = { violation: null, size: null, reworkCount: 0 } as const;

describe("同梱の flow.yml", () => {
  it("整合性の検査を通る", () => {
    expect(checkFlow(flow)).toEqual([]);
  });
  it("存在しない遷移先を検出する", () => {
    const broken = structuredClone(flow);
    broken.stages[0]!.on_result.pass = "nowhere";
    expect(checkFlow(broken).join()).toContain("nowhere");
  });
});

describe("ラベルと stage", () => {
  it("flow ラベルから stage を引ける", () => {
    expect(stageFromLabel(flow, "flow::verify")?.id).toBe("verify");
    expect(stageFromLabel(flow, "bug")).toBeNull();
  });
  it("flow ラベルが複数あるときは不整合として扱う", () => {
    expect(currentStage(flow, ["flow::spec", "flow::plan"])).toBeNull();
    expect(currentStage(flow, ["flow::spec", "size::s"])?.id).toBe("spec");
  });
  it("size を読む", () => {
    expect(sizeOf(["ai::ok", "size::m"])).toBe("m");
  });
});

describe("遷移の権限", () => {
  it("仕様の承認は人間だけができる", () => {
    expect(canTransition(flow, "spec", "plan", "human")).toBe(true);
    expect(canTransition(flow, "spec", "plan", "agent")).toBe(false);
    expect(canTransition(flow, "spec", "plan", "system")).toBe(false);
  });
  it("マージ相当(review → done)をエージェントは行えない", () => {
    expect(canTransition(flow, "review", "done", "agent")).toBe(false);
  });
  it("列を飛ばせない", () => {
    expect(canTransition(flow, "inbox", "doing", "human")).toBe(false);
    expect(canTransition(flow, "ready", "review", "system")).toBe(false);
  });
});

describe("decide", () => {
  it("仕様が pass でも列は動かさない(人間の承認待ち)", () => {
    const d = decide(project, { ...base, stage: getStage(flow, "spec"), status: "pass" });
    expect(d).toMatchObject({ to: null, addBlocked: false });
  });
  it("size::s の計画は承認を省略して ready へ", () => {
    const d = decide(project, { ...base, stage: getStage(flow, "plan"), status: "pass", size: "s" });
    expect(d.to).toBe("ready");
  });
  it("size::m の計画は承認待ち", () => {
    const d = decide(project, { ...base, stage: getStage(flow, "plan"), status: "pass", size: "m" });
    expect(d.to).toBeNull();
  });
  it("verify の pass は review へ、fail は doing へ差し戻す", () => {
    const stage = getStage(flow, "verify");
    expect(decide(project, { ...base, stage, status: "pass" }).to).toBe("review");
    expect(decide(project, { ...base, stage, status: "fail" })).toMatchObject({ to: "doing", addBlocked: false });
  });
  it("差し戻しが上限に達したら blocked にして止める", () => {
    const d = decide(project, { ...base, stage: getStage(flow, "verify"), status: "fail", reworkCount: 2 });
    expect(d).toMatchObject({ to: null, addBlocked: true });
  });
  it("blocked は列を動かさず blocked ラベルを付ける", () => {
    const d = decide(project, { ...base, stage: getStage(flow, "doing"), status: "blocked" });
    expect(d).toMatchObject({ to: null, addBlocked: true });
  });
  it("ルール違反は、status が pass でも止める", () => {
    const d = decide(project, { ...base, stage: getStage(flow, "verify"), status: "pass", violation: "保護対象の変更" });
    expect(d).toMatchObject({ to: null, addBlocked: true });
  });
});
