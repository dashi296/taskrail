import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceIssue, checksPassed, dispatchWith, missingCiRuns, recheckImplemented, resumeIssue } from "../src/commands/board.js";
import { staleReason } from "../src/commands/apply.js";
import { nextStep } from "../src/commands/next.js";
import { answersFor } from "../src/core/answers.js";
import { runChecks } from "../src/core/checks.js";
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

describe("ローカル実行の進行(next)", () => {
  const step = (labels: string[], build?: (p: FakePlatform) => void) => {
    const p = new FakePlatform();
    p.addIssue(1, labels);
    build?.(p);
    return nextStep(fakeCtx(p), p.getIssue(1));
  };

  it("エージェントのいる列で、その列に入ってからの記録がなければ実行する", () => {
    expect(step(["flow::spec"])).toMatchObject({ action: "run-stage", stage: "spec" });
  });
  it("承認待ちの列(記録が pass で、列を動かすのが人間)では止まる", () => {
    expect(step(["flow::spec"], (p) => p.addComment(1, record("spec", "pass")))).toMatchObject({ action: "stop", stage: "spec" });
  });
  it("ready では着手の判定に進む", () => {
    expect(step(["flow::ready", "ai::ok"])).toMatchObject({ action: "dispatch", stage: "ready" });
  });
  it("実装が pass なら CI の確認に進む", () => {
    expect(step(["flow::doing"], (p) => p.addComment(1, record("doing", "pass", { branch: "issue-1-x", sha: SHA })))).toMatchObject({
      action: "check-ci",
      stage: "doing",
    });
  });
  it("列に入り直した後は、前の記録を見ずにもう一度実行する", () => {
    expect(
      step(["flow::doing"], (p) => {
        p.addComment(1, record("doing", "pass", { branch: "issue-1-x", sha: SHA }));
        p.removeLabel(1, "flow::doing");
        p.addLabels(1, ["flow::doing"]);
      }),
    ).toMatchObject({ action: "run-stage", stage: "doing" });
  });
  it("blocked の記録は、権限のある人の回答があればやり直す", () => {
    expect(step(["flow::inbox"], (p) => p.addComment(1, record("inbox", "blocked")))).toMatchObject({ action: "stop", stage: "inbox" });
    // 権限のない人のコメントは回答として扱わない。
    expect(
      step(["flow::inbox"], (p) => {
        p.addComment(1, record("inbox", "blocked"));
        p.addComment(1, "こう進めてください", "outsider");
      }),
    ).toMatchObject({ action: "stop", stage: "inbox" });
    expect(
      step(["flow::inbox"], (p) => {
        p.permissions.set("human", "write");
        p.addComment(1, record("inbox", "blocked"));
        p.addComment(1, "こう進めてください", "human");
      }),
    ).toMatchObject({ action: "run-stage", stage: "inbox" });
  });
  it("blocked ラベルが付いていても、回答があれば再開する(なければ止まる)", () => {
    expect(step(["flow::inbox", "blocked"], (p) => p.addComment(1, record("inbox", "blocked")))).toMatchObject({ action: "stop" });
    expect(
      step(["flow::inbox", "blocked"], (p) => {
        p.permissions.set("human", "write");
        p.addComment(1, record("inbox", "blocked"));
        p.addComment(1, "回答です", "human");
      }),
    ).toMatchObject({ action: "resume", stage: "inbox" });
  });
  it("工程がもう一度動いた後は、古い回答を渡さない", () => {
    const p = new FakePlatform();
    p.addIssue(1, ["flow::doing"]);
    p.permissions.set("human", "write");
    p.addComment(1, record("doing", "blocked"));
    p.addComment(1, "回答です", "human");
    p.addComment(1, record("doing", "pass", { branch: "issue-1-x", sha: SHA }));
    expect(answersFor(fakeCtx(p), "doing", p.listComments(1))).toEqual([]);
  });
  it("記録が fail・blocked・閉じた Issue・人間の列では止まる", () => {
    expect(step(["flow::verify"], (p) => p.addComment(1, record("verify", "fail")))).toMatchObject({ action: "stop" });
    expect(step(["flow::spec", "blocked"])).toMatchObject({ action: "stop" });
    expect(step(["flow::review"])).toMatchObject({ action: "stop", stage: "review" });
    const p = new FakePlatform();
    p.addIssue(1, ["flow::spec"]);
    expect(nextStep(fakeCtx(p), { ...p.getIssue(1), state: "closed" })).toMatchObject({ action: "stop" });
  });
  it("信頼しない投稿者の記録は見ない", () => {
    expect(step(["flow::spec"], (p) => p.addComment(1, record("spec", "pass"), "attacker"))).toMatchObject({ action: "run-stage" });
  });
});

describe("手元の check_commands による判定(--local-checks)", () => {
  const repo = () => {
    const d = mkdtempSync(join(tmpdir(), "taskrail-checks-"));
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: d, encoding: "utf8" });
    g("init", "-q", "-b", "main");
    writeFileSync(join(d, "a"), "1\n");
    g("add", "-A");
    g("commit", "-qm", "base");
    return { d, sha: g("rev-parse", "HEAD").trim() };
  };

  it("すべて成功すれば ok、1つでも失敗すれば理由を返す", () => {
    const { d, sha } = repo();
    expect(runChecks(sha, ["test -f a"], d)).toMatchObject({ ok: true });
    expect(runChecks(sha, ["test -f a", "test -f none"], d)).toMatchObject({ ok: false, why: "test -f none が失敗しました" });
  });
  it("checkout で実行される filter が仕込まれていたら検査しない", () => {
    const { d, sha } = repo();
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: d, encoding: "utf8" });
    const leak = join(d, "leak");
    writeFileSync(join(d, ".gitattributes"), "a filter=x\n");
    g("add", "-A");
    g("commit", "-qm", "filter");
    g("config", "filter.x.smudge", `sh -c 'echo $GH_TOKEN > ${leak}; cat'`);
    const head = g("rev-parse", "HEAD").trim();
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "s3cret";
    try {
      expect(runChecks(head, ["true"], d)).toMatchObject({ ok: false, why: expect.stringContaining("checkout 時に実行される設定") });
      expect(existsSync(leak)).toBe(false);
      // include で読み込んだ設定も対象にする。
      g("config", "--unset", "filter.x.smudge");
      const extra = join(d, "extra.cfg");
      writeFileSync(extra, `[filter "x"]\n\tsmudge = sh -c 'echo $GH_TOKEN > ${leak}; cat'\n`);
      g("config", "include.path", extra);
      expect(runChecks(head, ["true"], d)).toMatchObject({ ok: false });
      expect(existsSync(leak)).toBe(false);
      // 利用者自身のグローバル設定(git-lfs など)は検査を止めない。
      g("config", "--unset", "include.path");
      expect(runChecks(head, ["true"], d)).toMatchObject({ ok: true });
      void sha;
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });
  it("check_commands が空なら進めない", () => {
    const { d, sha } = repo();
    expect(runChecks(sha, [], d)).toMatchObject({ ok: false });
  });
  it("許可した変数だけを渡す(名前で拾えない認証経路も落とす)", () => {
    const { d, sha } = repo();
    const saved = { ...process.env };
    const extra = {
      NPM_TOKEN: "npm1",
      AWS_SECRET_ACCESS_KEY: "aws1",
      MY_API_KEY: "k1",
      // 名前に TOKEN も KEY も含まないが、認証に使える経路。
      GIT_ASKPASS: "/tmp/askpass.sh",
      SSH_ASKPASS: "/tmp/askpass.sh",
      PGPASSFILE: "/tmp/pgpass",
      NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
      HTTPS_PROXY: "https://user:password@proxy.example",
      DOCKER_CONFIG: "/tmp/docker",
    };
    Object.assign(process.env, extra);
    try {
      const names = Object.keys(extra).filter((k) => k !== "GIT_ASKPASS" && k !== "SSH_ASKPASS");
      expect(runChecks(sha, names.map((n) => `test -z "$${n}"`), d)).toMatchObject({ ok: true });
      // 認証を尋ねる経路は、値を引き継がず無効化する。
      expect(runChecks(sha, ['test "$GIT_ASKPASS" = /bin/false', 'test "$SSH_ASKPASS" = /bin/false'], d)).toMatchObject({ ok: true });
      // HOME は使い捨ての場所に向ける(~/.netrc、~/.ssh、~/.npmrc に届かせない)。
      expect(runChecks(sha, [`test "$HOME" != "${saved.HOME}"`, 'test ! -e "$HOME/.ssh"', 'test ! -e "$HOME/.netrc"'], d)).toMatchObject({
        ok: true,
      });
      // PATH は渡す(渡さないとコマンドが見つからない)。
      expect(runChecks(sha, ['test -n "$PATH"'], d)).toMatchObject({ ok: true });
    } finally {
      for (const k of Object.keys(extra)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
  it("TASKRAIL_CHECK_ENV に挙げた変数は渡す", () => {
    const { d, sha } = repo();
    const saved = { ...process.env };
    Object.assign(process.env, { MY_REGISTRY: "https://registry.example", TASKRAIL_CHECK_ENV: "MY_REGISTRY" });
    try {
      expect(runChecks(sha, ['test "$MY_REGISTRY" = https://registry.example'], d)).toMatchObject({ ok: true });
    } finally {
      for (const k of ["MY_REGISTRY", "TASKRAIL_CHECK_ENV"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
  it("認証情報を外した環境で実行する(エージェントが書いたコードを動かすため)", () => {
    const { d, sha } = repo();
    const saved = { ...process.env };
    Object.assign(process.env, {
      GH_TOKEN: "t1",
      GITHUB_TOKEN: "t2",
      GH_ENTERPRISE_TOKEN: "t3",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      TASKRAIL_GIT_REMOTE: "https://github.com/o/r.git",
    });
    try {
      const assertions = [
        'test -z "$GH_TOKEN"',
        'test -z "$GITHUB_TOKEN"',
        'test -z "$GH_ENTERPRISE_TOKEN"',
        'test -z "$SSH_AUTH_SOCK"',
        'test -z "$TASKRAIL_GIT_REMOTE"',
        'test -z "$(git config --get-all credential.helper)"',
        'case "$GIT_SSH_COMMAND" in *IdentitiesOnly=yes*IdentityFile=/dev/null*) ;; *) exit 1;; esac',
      ];
      expect(runChecks(sha, assertions, d)).toMatchObject({ ok: true });
    } finally {
      for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "TASKRAIL_GIT_REMOTE"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
  it("手元の作業ツリーの変更は判定に混ざらない(記録したコミットの内容で実行する)", () => {
    const { d, sha } = repo();
    writeFileSync(join(d, "b"), "2\n");
    expect(runChecks(sha, ["test ! -f b"], d)).toMatchObject({ ok: true });
  });
});

describe("--local-checks の分岐", () => {
  let p: FakePlatform;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    p = new FakePlatform();
    p.addIssue(1, ["flow::doing"]);
    p.addComment(1, record("doing", "pass", { branch: "issue-1-x", sha: SHA }));
    p.heads.set("issue-1-x", SHA);
    p.checks.set(SHA, "failure"); // GitHub 側は失敗・未実行でも、手元の検査だけで判定する
  });
  const passed = (local: (sha: string, cmds: string[]) => { ok: boolean; why: string }) =>
    checksPassed(fakeCtx(p), p.getIssue(1), "doing", ["CI"], true, local);

  it("手元の検査が成功すれば、GitHub 側の検査を見ずに進める", () => {
    expect(passed(() => ({ ok: true, why: "" }))).toEqual({ ok: true, branch: "issue-1-x" });
  });
  it("手元の検査が失敗すれば進めない", () => {
    expect(passed(() => ({ ok: false, why: "npm test が失敗しました" }))).toMatchObject({ ok: false });
  });
  it("検査中に push されていれば進めない", () => {
    expect(
      passed(() => {
        p.heads.set("issue-1-x", "d".repeat(40));
        return { ok: true, why: "" };
      }),
    ).toMatchObject({ ok: false });
  });
  it("指定しなければ、これまでどおり GitHub 側の検査で判定する", () => {
    expect(checksPassed(fakeCtx(p), p.getIssue(1), "doing", ["CI"])).toMatchObject({ ok: false });
  });
});

describe("resume --issue(ローカル実行)", () => {
  it("権限のある人の回答があれば blocked を外して列を付け直す", () => {
    const p = new FakePlatform();
    p.addIssue(1, ["flow::spec", "blocked"]);
    p.addComment(1, record("spec", "blocked"));
    resumeIssue(fakeCtx(p), 1);
    expect(p.getIssue(1).labels).toContain("blocked");
    p.permissions.set("human", "write");
    p.addComment(1, "回答です", "human");
    resumeIssue(fakeCtx(p), 1);
    expect(p.getIssue(1).labels).not.toContain("blocked");
    expect(p.getIssue(1).labels).toContain("flow::spec");
  });
});

describe("dispatch の着手条件", () => {
  const ready = (n: number, labels: string[], body = "") => {
    p.addIssue(n, ["flow::ready", ...labels]);
    p.issues.set(n, { ...p.getIssue(n), body });
  };
  let p: FakePlatform;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    p = new FakePlatform();
  });
  const stage = (n: number) => p.getIssue(n).labels.find((l) => l.startsWith("flow::"));

  it("ai::ok があり、blocked でなく、依存が閉じている Issue だけを、番号順に WIP の空きだけ着手する", () => {
    p.addIssue(10, ["flow::doing"]); // WIP 1件
    ready(5, ["ai::ok"]);
    ready(6, ["ai::ok", "blocked"]);
    ready(7, ["ai::no"]);
    ready(8, ["ai::ok"], "Depends on #99");
    p.addIssue(99, ["flow::doing"]); // 依存先が未完了
    ready(9, ["ai::ok"]);
    dispatchWith(fakeCtx(p, { wip_limit: 3 }));
    // 空きは 3 - (doing 2件) = 1。番号の小さい #5 だけが着手される。
    expect(stage(5)).toBe("flow::doing");
    expect(stage(6)).toBe("flow::ready");
    expect(stage(7)).toBe("flow::ready");
    expect(stage(8)).toBe("flow::ready");
    expect(stage(9)).toBe("flow::ready");
  });

  it("同じ Issue が doing と verify の両方に見えても、WIP は1件として数える", () => {
    const issue = p.addIssue(10, ["flow::doing"]);
    issue.labels.push("flow::verify"); // API の反映遅れを模す
    ready(5, ["ai::ok"]);
    dispatchWith(fakeCtx(p, { wip_limit: 2 }));
    expect(stage(5)).toBe("flow::doing");
  });

  it("WIP が上限なら着手しない", () => {
    p.addIssue(10, ["flow::doing"]);
    p.addIssue(11, ["flow::verify"]);
    ready(5, ["ai::ok"]);
    dispatchWith(fakeCtx(p, { wip_limit: 2 }));
    expect(stage(5)).toBe("flow::ready");
  });

  it("依存先が閉じていれば着手する", () => {
    ready(5, ["ai::ok"], "依存: #99");
    const dep = p.addIssue(99, []);
    p.issues.set(99, { ...dep, state: "closed" });
    dispatchWith(fakeCtx(p, { wip_limit: 2 }));
    expect(stage(5)).toBe("flow::doing");
  });
});

describe("advance は停止中・完了済みの Issue を動かさない", () => {
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
  const advance = () => advanceIssue(fakeCtx(p), { branch: "issue-1-x", from: "doing", to: "verify", requireChecks: true }, ["CI"]);

  it("blocked なら動かさない", () => {
    p.addLabels(1, ["blocked"]);
    expect(advance()).toBe(false);
    expect(p.getIssue(1).labels).toContain("flow::doing");
  });
  it("閉じた Issue なら動かさない", () => {
    p.issues.set(1, { ...p.getIssue(1), state: "closed" });
    expect(advance()).toBe(false);
    expect(p.getIssue(1).labels).toContain("flow::doing");
  });
  it("判定中に閉じられたら動かさない", () => {
    const original = p.ciRuns.bind(p);
    p.ciRuns = (sha: string) => {
      p.issues.set(1, { ...p.getIssue(1), state: "closed" });
      return original(sha);
    };
    expect(advance()).toBe(false);
    expect(p.getIssue(1).labels).toContain("flow::doing");
  });
  it("判定中に blocked が付いたら動かさない", () => {
    const original = p.ciRuns.bind(p);
    p.ciRuns = (sha: string) => {
      p.addLabels(1, ["blocked"]);
      return original(sha);
    };
    expect(advance()).toBe(false);
    expect(p.getIssue(1).labels).not.toContain("flow::verify");
  });
  it("open で blocked でなければ動かす", () => {
    expect(advance()).toBe(true);
    expect(p.getIssue(1).labels).toContain("flow::verify");
  });
});
