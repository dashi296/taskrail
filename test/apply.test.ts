import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyWith } from "../src/commands/apply.js";
import { branchName } from "../src/core/git.js";
import { FakePlatform, fakeCtx } from "./fakes.js";

/** origin(bare)と作業ツリーを持つリポジトリ。apply は API の SHA を基準にするため、実物の remote が要る。 */
function repo(): { dir: string; origin: string; git: (...args: string[]) => string; sha: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "taskrail-apply-"));
  // origin は FakePlatform.repoPath() と揃える(push 先の確認が通るように)。
  const origin = join(dir, "o", "r.git");
  const work = join(dir, "work");
  mkdirSync(join(dir, "o"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: work, encoding: "utf8" }).trim();
  writeFileSync(join(work, "a.txt"), "1\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("push", "-q", "-u", "origin", "main");
  return { dir: work, origin, git, sha: () => git("rev-parse", "HEAD") };
}

const result = (agent: string, extra: Record<string, unknown> = {}) => ({
  agent,
  status: "pass",
  summary: "やりました。やりました。やりました。",
  ...extra,
});

function writeResult(dir: string, agent: string, body: unknown): void {
  mkdirSync(join(dir, ".taskrail/run"), { recursive: true });
  writeFileSync(join(dir, ".taskrail/run", `result-${agent}.json`), JSON.stringify(body));
}

describe("apply の強制ルール", () => {
  let p: FakePlatform;
  let r: ReturnType<typeof repo>;
  const issueTitle = "ボタンを追加する";
  const lastComment = () => p.listComments(1).at(-1)!.body;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    p = new FakePlatform();
    r = repo();
    const issue = p.addIssue(1, ["flow::spec"]);
    issue.title = issueTitle;
    p.issues.set(1, { ...p.getIssue(1), title: issueTitle });
    p.heads.set("main", r.sha());
    // origin はローカルのパスなので、push 先の照合はそのパスで行う。
    p.remoteId = { host: "", repo: r.origin.replace(/^\/+/, "").replace(/\.git$/, "") };
  });

  describe("読み取り工程", () => {
    const run = () => applyWith(fakeCtx(p), { issue: "1", stage: "spec" }, r.dir);

    it("変更がなければ、結果どおりに記録する", () => {
      writeResult(r.dir, "spec", result("spec", { artifact: "## 仕様" }));
      run();
      expect(lastComment()).toContain('"status":"pass"');
      expect(lastComment()).toContain("## 仕様");
    });
    it("作業ツリーにファイルの変更があれば違反にする", () => {
      writeResult(r.dir, "spec", result("spec"));
      writeFileSync(join(r.dir, "a.txt"), "2\n");
      run();
      expect(lastComment()).toContain("読み取り専用の工程でファイルが変更されました");
      expect(lastComment()).toContain('"status":"error"');
    });
    it("コミットしてしまってもリモートと比べて検出する", () => {
      writeResult(r.dir, "spec", result("spec"));
      writeFileSync(join(r.dir, "a.txt"), "2\n");
      r.git("add", "-A");
      r.git("commit", "-qm", "こっそり");
      run();
      expect(lastComment()).toContain("読み取り専用の工程でコミットが作られました");
    });
    it("違反した実行の成果物は次工程に渡さない", () => {
      writeResult(r.dir, "spec", result("spec", { artifact: "## 偽の仕様" }));
      writeFileSync(join(r.dir, "a.txt"), "2\n");
      run();
      expect(lastComment()).not.toContain("## 偽の仕様");
    });
    it("結果ファイルがなければ不備として記録する", () => {
      run();
      expect(lastComment()).toContain("結果ファイルがありません");
      expect(lastComment()).toContain('"status":"error"');
    });
  });

  describe("検証工程(差分を読む読み取り工程)", () => {
    const branch = () => branchName("issue-", 1, issueTitle);
    const startVerify = () => {
      p.removeLabel(1, "flow::spec");
      p.addLabels(1, ["flow::verify"]);
      r.git("checkout", "-q", "-B", branch());
      writeFileSync(join(r.dir, "src.txt"), "実装\n");
      r.git("add", "src.txt");
      r.git("commit", "-qm", "実装");
      r.git("push", "-q", "-u", "origin", branch());
      p.heads.set(branch(), r.sha());
      writeResult(r.dir, "verify-spec", result("verify-spec", { criteria: [{ text: "AC1", met: true, evidence: "テストが通っている" }] }));
      writeResult(r.dir, "code-review", result("code-review"));
    };
    const run = () => applyWith(fakeCtx(p), { issue: "1", stage: "verify" }, r.dir);

    it("ブランチの先頭を検証していれば合格にする", () => {
      startVerify();
      run();
      expect(lastComment()).toContain('"status":"pass"');
      expect(p.getIssue(1).labels).toContain("flow::review");
    });
    it("検証中にブランチが更新されたら違反にする", () => {
      startVerify();
      const verifiedSha = r.sha();
      let asked = 0;
      const heads = p.heads;
      p.branchHead = (b: string) => {
        asked++;
        // 1回目(検査)は検証したコミット、2回目以降(記録を書く前の再確認)は新しいコミットを返す。
        return asked === 1 ? (heads.get(b) ?? null) : "e".repeat(40);
      };
      run();
      expect(verifiedSha).toBe(heads.get(branch()));
      expect(lastComment()).toContain("検証中に");
      expect(p.getIssue(1).labels).not.toContain("flow::review");
    });
    it("古いコミットを検証していたら違反にする(リモートに新しい push がある)", () => {
      startVerify();
      const old = r.sha();
      writeFileSync(join(r.dir, "src.txt"), "実装2\n");
      r.git("add", "src.txt");
      r.git("commit", "-qm", "追加の実装");
      r.git("push", "-q", "origin", branch());
      p.heads.set(branch(), r.sha());
      r.git("checkout", "-q", old); // 検証したのは古いコミット
      writeResult(r.dir, "verify-spec", result("verify-spec", { criteria: [{ text: "AC1", met: true, evidence: "根拠" }] }));
      writeResult(r.dir, "code-review", result("code-review"));
      run();
      expect(lastComment()).toContain("検証したコミット");
      expect(lastComment()).toContain('"status":"error"');
      expect(p.getIssue(1).labels).not.toContain("flow::review");
    });
  });

  describe("書き込み工程", () => {
    const branch = () => branchName("issue-", 1, issueTitle);
    const startWork = (files: Record<string, string>) => {
      p.removeLabel(1, "flow::spec");
      p.addLabels(1, ["flow::doing"]);
      r.git("checkout", "-q", "-B", branch());
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(join(r.dir, path, ".."), { recursive: true });
        writeFileSync(join(r.dir, path), body);
      }
      writeResult(r.dir, "implement", result("implement", { pr_title: "ボタンを追加する" }));
    };
    const commitAll = () => {
      r.git("add", "-A");
      r.git("commit", "-qm", "実装");
    };
    const run = () => applyWith(fakeCtx(p), { issue: "1", stage: "doing" }, r.dir);

    it("通常の変更なら push して PR を作り、記録にブランチと SHA を残す", () => {
      startWork({ "src/button.ts": "export const x = 1;\n" });
      commitAll();
      run();
      expect(p.createdPullRequests).toHaveLength(1);
      expect(p.createdPullRequests[0]).toMatchObject({ head: branch(), base: "main" });
      expect(lastComment()).toContain(`"branch":"${branch()}"`);
      expect(lastComment()).toContain(`"sha":"${r.sha()}"`);
      expect(execFileSync("git", ["ls-remote", "origin", branch()], { cwd: r.dir, encoding: "utf8" })).toContain(branch());
    });
    it("検査した後に HEAD が進んでも、検査したコミットだけを push する", () => {
      startWork({ "src/button.ts": "export const x = 1;\n" });
      commitAll();
      const checkedSha = r.sha();
      // 検査と push の間に、別のプロセスが保護対象を変更したコミットを積む状況を模す。
      const original = p.getIssue.bind(p);
      let calls = 0;
      p.getIssue = (n: number) => {
        if (++calls === 2) {
          mkdirSync(join(r.dir, ".github/workflows"), { recursive: true });
          writeFileSync(join(r.dir, ".github/workflows/ci.yml"), "on: push\n");
          r.git("add", ".github");
          r.git("commit", "-qm", "あとから足した");
        }
        return original(n);
      };
      run();
      expect(p.createdPullRequests).toHaveLength(1);
      expect(lastComment()).toContain(`"sha":"${checkedSha}"`);
      // リモートに渡ったのは検査したコミットだけ。
      const remote = execFileSync("git", ["ls-remote", "origin", branch()], { cwd: r.dir, encoding: "utf8" });
      expect(remote).toContain(checkedSha);
      expect(remote).not.toContain(r.sha());
    });
    it("保護対象のファイルを変更していたら push しない", () => {
      startWork({ ".github/workflows/ci.yml": "on: push\n" });
      commitAll();
      run();
      expect(lastComment()).toContain("保護対象のファイルが変更されました");
      expect(p.createdPullRequests).toHaveLength(0);
      expect(execFileSync("git", ["ls-remote", "origin", branch()], { cwd: r.dir, encoding: "utf8" })).toBe("");
    });
    it("コミットされていない変更があれば止める", () => {
      startWork({ "src/button.ts": "export const x = 1;\n" });
      commitAll();
      writeFileSync(join(r.dir, "src/button.ts"), "export const x = 2;\n");
      run();
      expect(lastComment()).toContain("コミットされていない変更があります");
      expect(p.createdPullRequests).toHaveLength(0);
    });
    it("pass と報告されてもコミットがなければ止める", () => {
      startWork({});
      run();
      expect(lastComment()).toContain("コミットがありません");
      expect(p.createdPullRequests).toHaveLength(0);
    });
    it("PR の作成に失敗しても、記録を残して止める", () => {
      startWork({ "src/button.ts": "export const x = 1;\n" });
      commitAll();
      p.failCreatePullRequest = true;
      run();
      expect(lastComment()).toContain("push または PR の作成に失敗しました");
      expect(lastComment()).toContain('"status":"error"');
    });
    it("ai::ok が付いていても、結果が fail なら push しない", () => {
      startWork({ "src/button.ts": "export const x = 1;\n" });
      commitAll();
      writeResult(r.dir, "implement", { ...result("implement"), status: "fail" });
      run();
      expect(p.createdPullRequests).toHaveLength(0);
    });
  });
});
