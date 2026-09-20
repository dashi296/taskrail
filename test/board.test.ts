import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceIssue, checksPassed, missingCiRuns, recheckImplemented } from "../src/commands/board.js";
import { staleReason } from "../src/commands/apply.js";
import { renderComment, type RunRecord } from "../src/core/record.js";
import { FakePlatform, fakeCtx } from "./fakes.js";

const SHA = "a".repeat(40);
const record = (stage: string, status: RunRecord["status"], extra: Partial<RunRecord> = {}) =>
  renderComment({
    stageTitle: stage,
    rec: { stage, status, to: null, blocked: false, version: "0", at: "", ...extra },
    reason: "r",
    errors: [],
    results: [],
  });
const run = (name: string, conclusion: string | null, status = "completed", createdAt = "2026-01-01T00:00:00Z", event = "pull_request") => ({
  name,
  event,
  status,
  conclusion,
  createdAt,
});

describe("CI 待ちのゲート(checksPassed / advance --require-checks / dispatch の再判定)", () => {
  let p: FakePlatform;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    p = new FakePlatform();
    p.addIssue(1, ["flow::doing"]);
    p.addComment(1, record("doing", "pass", { branch: "issue-1-x", sha: SHA }));
    p.heads.set("issue-1-x", SHA);
    p.checks.set(SHA, "success");
    p.runs.set(SHA, [run("CI", "success")]);
  });
  const passed = (expected = ["CI"]) => checksPassed(fakeCtx(p), p.getIssue(1), "doing", expected);

  it("実装の記録・ブランチの先頭・検査・監視している CI がすべて揃えば進める", () => {
    expect(passed()).toEqual({ ok: true, branch: "issue-1-x" });
    expect(advanceIssue(fakeCtx(p), { branch: "issue-1-x", from: "doing", to: "verify", requireChecks: true }, ["CI"])).toBe(true);
    expect(p.getIssue(1).labels).toContain("flow::verify");
  });
  it("修正依頼などで列に入り直した後は、前の実装の記録では進めない", () => {
    p.removeLabel(1, "flow::doing");
    p.addLabels(1, ["flow::doing"]);
    expect(passed()).toMatchObject({ ok: false });
  });
  it("差し戻し直後(直近の記録が検証の fail)は進めない", () => {
    p.addComment(1, record("verify", "fail"));
    expect(passed()).toMatchObject({ ok: false });
  });
  it("記録の後にブランチが更新されていれば進めない", () => {
    p.heads.set("issue-1-x", "b".repeat(40));
    expect(passed()).toMatchObject({ ok: false });
  });
  it("検査が完了していない・失敗していれば進めない", () => {
    p.checks.set(SHA, "pending");
    expect(passed()).toMatchObject({ ok: false });
    p.checks.set(SHA, "failure");
    expect(passed()).toMatchObject({ ok: false });
  });
  it("監視している CI が未実行・失敗なら、ほかの検査が成功していても進めない", () => {
    expect(passed(["CI", "Integration"])).toMatchObject({ ok: false });
    p.runs.set(SHA, [run("CI", "success"), run("Integration", "failure")]);
    expect(passed(["CI", "Integration"])).toMatchObject({ ok: false });
  });
  it("push で動いた同名の CI の成功で、PR で動いた CI の失敗を隠さない", () => {
    p.runs.set(SHA, [
      run("CI", "failure", "completed", "2026-01-01T00:00:00Z", "pull_request"),
      run("CI", "success", "completed", "2026-01-01T01:00:00Z", "push"),
    ]);
    expect(passed()).toMatchObject({ ok: false });
  });
  it("検査を問い合わせている間にブランチが更新されたら進めない", () => {
    const original = p.ciRuns.bind(p);
    p.ciRuns = (sha: string) => {
      p.heads.set("issue-1-x", "c".repeat(40));
      return original(sha);
    };
    expect(passed()).toMatchObject({ ok: false });
  });
  it("信頼しない投稿者の記録では進めない", () => {
    p.comments.set(1, []);
    p.addComment(1, record("doing", "pass", { branch: "issue-1-x", sha: SHA }), "attacker");
    expect(passed()).toMatchObject({ ok: false });
  });
  it("イベントのブランチと実装の記録のブランチが違えば進めない", () => {
    expect(advanceIssue(fakeCtx(p), { branch: "issue-1-other", from: "doing", to: "verify", requireChecks: true }, ["CI"])).toBe(false);
  });
  it("dispatch の再判定: 1件の失敗でほかの Issue の判定を止めない", () => {
    p.addIssue(2, ["flow::doing"]);
    p.addComment(2, record("doing", "pass", { branch: "issue-2-y", sha: SHA }));
    p.failingBranches.add("issue-1-x");
    p.heads.set("issue-2-y", SHA);
    recheckImplemented(fakeCtx(p), ["CI"]);
    expect(p.getIssue(1).labels).toContain("flow::doing");
    expect(p.getIssue(2).labels).toContain("flow::verify");
  });
});

describe("修正依頼で列を戻す(advance --actor)", () => {
  it("write 以上の権限がない人の修正依頼では動かさない", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const p = new FakePlatform();
    p.addIssue(3, ["flow::review"]);
    const opts = { branch: "issue-3-z", from: "review", to: "doing" };
    p.permissions.set("outsider", "read");
    expect(advanceIssue(fakeCtx(p), { ...opts, actor: "outsider" }, [])).toBe(false);
    p.permissions.set("maintainer", "write");
    expect(advanceIssue(fakeCtx(p), { ...opts, actor: "maintainer" }, [])).toBe(true);
  });
});

describe("監視している CI の判定", () => {
  it("同じ名前の実行が複数あれば最新のものを見る", () => {
    const runs = [run("CI", "failure", "completed", "2026-01-01T00:00:00Z"), run("CI", "success", "completed", "2026-01-01T01:00:00Z")];
    expect(missingCiRuns(runs, ["CI"])).toEqual([]);
    expect(missingCiRuns([run("CI", null, "in_progress")], ["CI"])).toEqual(["CI"]);
  });
});

describe("apply: 古い実行の結果を反映しない", () => {
  it("列が変わった・閉じられた・blocked のときは理由を返す", () => {
    const p = new FakePlatform();
    p.addIssue(1, ["flow::verify"]);
    const ctx = fakeCtx(p);
    expect(staleReason(ctx, p.getIssue(1), "verify")).toBeNull();
    expect(staleReason(ctx, p.getIssue(1), "doing")).toMatch(/列が verify/);
    p.addLabels(1, [ctx.flow.blocked_label]);
    expect(staleReason(ctx, p.getIssue(1), "verify")).toMatch(/blocked/);
    p.addIssue(2, ["flow::verify"]);
    expect(staleReason(ctx, { ...p.getIssue(2), state: "closed" }, "verify")).toMatch(/閉じられ/);
  });
});
