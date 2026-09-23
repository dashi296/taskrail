import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFlow, loadFlow, loadProject, ProjectSchema } from "../src/core/config.js";
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
  it("差し戻し先のない工程(spec / doing)の fail は、列を動かさず blocked にする", () => {
    for (const id of ["inbox", "spec", "plan", "doing"]) {
      expect(decide(project, { ...base, stage: getStage(flow, id), status: "fail" })).toMatchObject({ to: null, addBlocked: true });
    }
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

describe("プロジェクト設定の解決", () => {
  const empty = () => mkdtempSync(join(tmpdir(), "taskrail-cfg-"));
  const withFile = (yaml: string) => {
    const d = empty();
    writeFileSync(join(d, "taskrail.yml"), yaml);
    return d;
  };

  it("ファイルも環境変数もなければ既定値", () => {
    const p = loadProject(empty(), {});
    expect(p.wip_limit).toBe(2);
    expect(p.bot_logins).toEqual([]);
    expect(p.check_commands).toEqual([]);
  });
  it("TASKRAIL_CONFIG(YAML)を読む", () => {
    const p = loadProject(empty(), { TASKRAIL_CONFIG: "wip_limit: 5\ncheck_commands: [npm test]" });
    expect(p.wip_limit).toBe(5);
    expect(p.check_commands).toEqual(["npm test"]);
  });
  it("taskrail.yml は TASKRAIL_CONFIG をキーごとに上書きする", () => {
    const p = loadProject(withFile("wip_limit: 1\n"), { TASKRAIL_CONFIG: "wip_limit: 5\nmax_rework: 7" });
    expect(p.wip_limit).toBe(1);
    expect(p.max_rework).toBe(7);
  });
  it("不正な設定を拒否する", () => {
    expect(() => loadProject(empty(), { TASKRAIL_CONFIG: "unknown_key: 1" })).toThrow();
    expect(() => loadProject(empty(), { TASKRAIL_CONFIG: "- a\n- b" })).toThrow(/マッピング/);
  });
  it("bot_logins が空なら TASKRAIL_BOT_LOGIN を使う", () => {
    expect(loadProject(empty(), { TASKRAIL_BOT_LOGIN: "my-taskrail[bot]" }).bot_logins).toEqual(["my-taskrail[bot]"]);
  });
  it("bot_logins が設定済みなら TASKRAIL_BOT_LOGIN で上書きしない", () => {
    const p = loadProject(withFile('bot_logins: ["other[bot]"]\n'), { TASKRAIL_BOT_LOGIN: "my-taskrail[bot]" });
    expect(p.bot_logins).toEqual(["other[bot]"]);
  });
  it("TASKRAIL_BOT_LOGIN がログイン名として不正なら拒否する(空白・区切り文字・ワイルドカード)", () => {
    for (const bad of ["a b", "x,y", "a\nrun=true", "*"]) expect(() => loadProject(empty(), { TASKRAIL_BOT_LOGIN: bad })).toThrow();
    expect(loadProject(empty(), { TASKRAIL_BOT_LOGIN: "gitlab.bot_1" }).bot_logins).toEqual(["gitlab.bot_1"]);
  });
});
