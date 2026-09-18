import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { analyzeCiWorkflows, detectCiWorkflows, findEntryWorkflows, init, missingCiWorkflows } from "../src/commands/setup.js";

const repo = (workflows: Record<string, string> = {}) => {
  const d = mkdtempSync(join(tmpdir(), "taskrail-init-"));
  mkdirSync(join(d, ".github", "workflows"), { recursive: true });
  for (const [f, text] of Object.entries(workflows)) writeFileSync(join(d, ".github", "workflows", f), text);
  return d;
};

describe("CI ワークフローの検出", () => {
  it("pull_request で起動するワークフローの name を返す(push だけのもの、taskrail の入口は除く)", () => {
    const d = repo({
      "ci.yml": "name: CI\non: [push, pull_request]\njobs: {}\n",
      "lint.yml": "name: Lint\non:\n  pull_request:\n    branches: [main]\njobs: {}\n",
      "main-only.yml": "name: Main\non:\n  push:\n    branches: [main]\njobs: {}\n",
      "release.yml": "name: Release\non:\n  release:\n    types: [published]\njobs: {}\n",
      "entry.yaml": `name: board\non: pull_request\njobs:\n  r:\n    uses: acme/taskrail/.github/workflows/route.yml@v0\n`,
    });
    expect(detectCiWorkflows(d)).toEqual(["CI", "Lint"]);
    expect(findEntryWorkflows(d)).toEqual([".github/workflows/entry.yaml"]);
  });
  it("pull_request の条件を解析し、既定ブランチ向けの PR の作成・更新で起動しないものを除く", () => {
    const d = repo({
      "a.yml": "name: A\non:\n  pull_request:\n    branches: [release]\njobs: {}\n",
      "b.yml": "name: B\non:\n  pull_request:\n    types: [closed]\njobs: {}\n",
      "c.yml": "name: C\non:\n  pull_request:\n    branches-ignore: ['ma*']\njobs: {}\n",
      "d.yml": "name: D\non:\n  pull_request:\n    types: [opened, synchronize, labeled]\n    branches: ['**']\njobs: {}\n",
      "e.yml": "name: E\non:\n  pull_request:\n    paths: ['src/**']\njobs: {}\n",
    });
    expect(detectCiWorkflows(d, "main")).toEqual(["D", "E"]);
    const all = analyzeCiWorkflows(d, "main");
    expect(all.find((w) => w.name === "A")?.reason).toContain("release");
    expect(all.find((w) => w.name === "E")?.pathFiltered).toBe(true);
  });
  it("name がなければファイルのパスを名前にする(GitHub と同じ)", () => {
    expect(detectCiWorkflows(repo({ "test.yml": "on: pull_request\njobs: {}\n" }))).toEqual([".github/workflows/test.yml"]);
  });
  it("壊れた YAML は無視する", () => {
    expect(detectCiWorkflows(repo({ "bad.yml": "on: [\n" }))).toEqual([]);
  });
  it("呼び出し側が参照する CI のうち、実在しないものを返す", () => {
    const caller = 'on:\n  workflow_run:\n    workflows: ["CI", "Old"]\n';
    expect(missingCiWorkflows(caller, ["CI"])).toEqual(["Old"]);
    expect(missingCiWorkflows("on: push\n", ["CI"])).toHaveLength(1);
  });
});

describe("init", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
  });
  const run = (d: string, opts: Partial<Parameters<typeof init>[0]> = {}) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(d);
    init({ platform: "github", owner: "acme", ref: "v1", ...opts });
  };

  it("既定ではリポジトリに何も置かず、.taskrail/ を .git/info/exclude で除外する", () => {
    const d = repo();
    execFileSync("git", ["init", "-q"], { cwd: d });
    run(d);
    expect(existsSync(join(d, ".github/workflows/taskrail.yml"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" })).toBe("");
    expect(readFileSync(join(d, ".git/info/exclude"), "utf8").split("\n")).toContain(".taskrail/");
    run(d); // 2回実行しても重複して追記しない
    expect(readFileSync(join(d, ".git/info/exclude"), "utf8").match(/^\.taskrail\/$/gm)).toHaveLength(1);
  });
  it("--ci でワークフロー1つだけを置き、CI の名前を埋める", () => {
    const d = repo({ "ci.yml": "name: Build\non: pull_request\njobs: {}\n" });
    run(d, { ci: true });
    const wf = readFileSync(join(d, ".github/workflows/taskrail.yml"), "utf8");
    expect(wf).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(wf).toContain("acme/taskrail/.github/workflows/route.yml@v1");
    expect((parse(wf) as { on: { workflow_run: { workflows: string[] } } }).on.workflow_run.workflows).toEqual(["Build"]);
    for (const f of ["taskrail.yml", "CLAUDE.md", "docs", ".github/ISSUE_TEMPLATE"]) expect(existsSync(join(d, f))).toBe(false);
    expect(wf).toContain("startsWith(github.event.workflow_run.head_branch, 'issue-')");
  });
  it("フラグで任意のファイルを置く", () => {
    const d = repo();
    run(d, { docs: true, issueTemplate: true, config: true });
    expect(existsSync(join(d, ".github/ISSUE_TEMPLATE/task.yml"))).toBe(true);
    expect(readFileSync(join(d, "taskrail.yml"), "utf8")).toContain('taskrail_ref: "v1"');
    const constitution = readFileSync(join(d, "docs/constitution.md"), "utf8");
    expect(constitution).toContain("## このプロジェクト固有の原則");
    expect(constitution).not.toContain("既定の原則です。導入先に");
  });
  it("別名の入口(taskrail.yaml など)があれば、--force でも新しいワークフローを置かない", () => {
    const d = repo({ "taskrail.yaml": "on: issues\njobs:\n  r:\n    uses: acme/taskrail/.github/workflows/route.yml@v0\n" });
    run(d, { ci: true, force: true });
    expect(existsSync(join(d, ".github/workflows/taskrail.yml"))).toBe(false);
  });
  it("作業ブランチの接頭辞は設定に合わせる", () => {
    const d = repo({ "ci.yml": "name: CI\non: pull_request\njobs: {}\n" });
    writeFileSync(join(d, "taskrail.yml"), 'branch_prefix: "task-"\n');
    run(d, { ci: true });
    expect(readFileSync(join(d, ".github/workflows/taskrail.yml"), "utf8")).toContain("startsWith(github.event.workflow_run.head_branch, 'task-')");
  });
  it("CI が見つからなければ \"CI\" を入れる", () => {
    const d = repo();
    run(d, { ci: true });
    expect(readFileSync(join(d, ".github/workflows/taskrail.yml"), "utf8")).toContain('workflows: ["CI"]');
  });
});
