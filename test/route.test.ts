import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeWith } from "../src/commands/route.js";
import { FakePlatform, fakeCtx } from "./fakes.js";

function repo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "taskrail-route-"));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: work, encoding: "utf8" }).trim();
  writeFileSync(join(work, "a.txt"), "1\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("push", "-q", "-u", "origin", "main");
  return { dir: work, git };
}

describe("route が決めること", () => {
  let p: FakePlatform;
  let r: ReturnType<typeof repo>;
  // step output(スキップ時は route.json を書かないため、こちらで受ける)。
  const outputs = (): Record<string, string> =>
    Object.fromEntries(
      readFileSync(join(r.dir, "outputs.txt"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  const run = (stage: string, sender?: { login: string; type: string }, event?: object) => {
    const path = join(r.dir, "event.json");
    writeFileSync(path, JSON.stringify({ sender, ...event }));
    writeFileSync(join(r.dir, "outputs.txt"), "");
    process.env.GITHUB_OUTPUT = join(r.dir, "outputs.txt");
    try {
      routeWith(fakeCtx(p), { issue: "1", stage, event: path, checkout: false }, r.dir);
    } finally {
      delete process.env.GITHUB_OUTPUT;
    }
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    p = new FakePlatform();
    r = repo();
    p.addIssue(1, ["flow::spec"]);
  });

  it("読み取り工程には Bash を渡さない(書ける場所は結果ファイルの置き場所だけ)", () => {
    run("spec");
    expect(outputs().run).toBe("true");
    expect(outputs().allowed_tools).toBe("Read,Glob,Grep,Edit(.taskrail/run/**)");
    expect(existsSync(join(r.dir, ".taskrail/run/prompt-spec.md"))).toBe(true);
  });

  it("書き込み工程は ai::ok がなければ起動しない", () => {
    p.removeLabel(1, "flow::spec");
    p.addLabels(1, ["flow::doing"]);
    run("doing");
    expect(outputs().run).toBe("false");
    expect(outputs().reason).toContain("ai::ok");
  });

  it("ai::ok があれば書き込み工程を起動し、Bash を渡す", () => {
    p.removeLabel(1, "flow::spec");
    p.addLabels(1, ["flow::doing", "ai::ok"]);
    run("doing");
    expect(outputs().run).toBe("true");
    expect(outputs().allowed_tools).toContain("Bash");
    expect(outputs().branch).toBe("issue-1-t");
  });

  it("blocked が付いていれば起動しない", () => {
    p.addLabels(1, ["blocked"]);
    run("spec");
    expect(outputs().run).toBe("false");
    expect(outputs().reason).toContain("blocked");
  });

  it("権限のない人がラベルを動かしたら起動せず、blocked にして知らせる", () => {
    run("spec", { login: "outsider", type: "User" });
    expect(outputs().run).toBe("false");
    expect(p.getIssue(1).labels).toContain("blocked");
    expect(p.listComments(1).at(-1)!.body).toContain("権限");
  });

  it("許可していない bot がラベルを動かしたら起動しない", () => {
    run("spec", { login: "dependabot[bot]", type: "Bot" });
    expect(outputs().run).toBe("false");
    expect(p.listComments(1).at(-1)!.body).toContain("bot");
  });

  it("write 権限のある人なら起動する", () => {
    p.permissions.set("dev", "write");
    run("spec", { login: "dev", type: "User" });
    expect(outputs().run).toBe("true");
  });

  it("人間に許可されていない遷移(inbox → doing)では起動しない", () => {
    p.removeLabel(1, "flow::spec");
    p.addLabels(1, ["flow::inbox", "ai::ok"]);
    p.addLabels(1, ["flow::doing"]);
    p.removeLabel(1, "flow::inbox");
    p.permissions.set("dev", "write");
    run("doing", { login: "dev", type: "User" });
    expect(outputs().run).toBe("false");
    expect(outputs().reason).toContain("許可されていない遷移");
  });

  it("検証工程には差分とコミットの一覧をファイルで渡す", () => {
    p.removeLabel(1, "flow::spec");
    p.addLabels(1, ["flow::verify"]);
    run("verify");
    expect(outputs().run).toBe("true");
    expect(existsSync(join(r.dir, ".taskrail/run/diff.patch"))).toBe(true);
    expect(existsSync(join(r.dir, ".taskrail/run/commits.txt"))).toBe(true);
    expect(readFileSync(join(r.dir, ".taskrail/run/prompt-code-review.md"), "utf8")).toContain(".taskrail/run/diff.patch");
  });

  it("イベント後にラベルが外されていれば起動しない", () => {
    p.removeLabel(1, "flow::spec");
    run("spec");
    expect(outputs().run).toBe("false");
    expect(outputs().reason).toContain("ラベルが外されています");
  });
});
