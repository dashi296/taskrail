import { describe, expect, it } from "vitest";
import { GitHub } from "../src/adapters/github.js";

/** gh の代わり。args を記録し、path に応じた応答を返す。一致しなければ空。 */
function fakeGh(routes: { match: RegExp; out?: string; error?: string }[]) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const path = args.join(" ");
    const hit = routes.find((r) => r.match.test(path));
    if (hit?.error) throw new Error(hit.error);
    return hit?.out ?? "";
  };
  return { run, calls };
}

const issueJson = JSON.stringify({
  number: 7,
  title: "ボタン",
  body: "本文",
  labels: [{ name: "flow::spec" }, { name: "ai::ok" }],
  state: "open",
  user: { login: "dev" },
  html_url: "https://example.test/issues/7",
});

describe("GitHub アダプタ(gh の呼び出しと解釈)", () => {
  it("Issue を取得し、ラベルを名前の配列にする", () => {
    const { run, calls } = fakeGh([{ match: /issues\/7/, out: issueJson }]);
    const issue = new GitHub("o/r", run).getIssue(7);
    expect(calls[0]).toEqual(["api", "repos/o/r/issues/7"]);
    expect(issue).toMatchObject({ number: 7, title: "ボタン", labels: ["flow::spec", "ai::ok"], state: "open" });
  });

  it("コメントは --paginate と @json で1行ずつ読む", () => {
    const lines = [
      JSON.stringify({ id: 1, user: { login: "a" }, body: "一件目", created_at: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ id: 2, user: null, body: null, created_at: "2026-01-02T00:00:00Z" }),
    ].join("\n");
    const { run, calls } = fakeGh([{ match: /issues\/7\/comments/, out: lines }]);
    const comments = new GitHub("o/r", run).listComments(7);
    expect(calls[0]).toContain("--paginate");
    expect(calls[0]).toContain(".[] | @json");
    expect(comments).toEqual([
      { id: 1, author: "a", body: "一件目", createdAt: "2026-01-01T00:00:00Z" },
      { id: 2, author: "", body: "", createdAt: "2026-01-02T00:00:00Z" },
    ]);
  });

  it("Issue の一覧から PR を除く", () => {
    const lines = [
      JSON.stringify({ number: 1, title: "t", labels: [], state: "open", user: { login: "d" }, html_url: "u" }),
      JSON.stringify({ number: 2, title: "pr", labels: [], state: "open", user: { login: "d" }, html_url: "u", pull_request: {} }),
    ].join("\n");
    const { run } = fakeGh([{ match: /issues\?state=open/, out: lines }]);
    expect(new GitHub("o/r", run).listOpenIssuesByLabel("flow::ready").map((i) => i.number)).toEqual([1]);
  });

  it("ラベルの削除は、元から無い場合(404)だけ黙って通す", () => {
    const notFound = fakeGh([{ match: /labels/, error: "gh api が失敗しました: HTTP 404 Label does not exist" }]);
    expect(() => new GitHub("o/r", notFound.run).removeLabel(7, "blocked")).not.toThrow();
    const denied = fakeGh([{ match: /labels/, error: "gh api が失敗しました: HTTP 403 Forbidden" }]);
    expect(() => new GitHub("o/r", denied.run).removeLabel(7, "blocked")).toThrow(/403/);
  });

  it("権限は maintain を write とみなし、取得に失敗したら none にする", () => {
    const perm = (out: string) => new GitHub("o/r", fakeGh([{ match: /permission/, out }]).run).getPermission("dev");
    expect(perm("admin\n")).toBe("admin");
    expect(perm("maintain\n")).toBe("write");
    expect(perm("read\n")).toBe("read");
    expect(perm("triage\n")).toBe("none");
    const failing = fakeGh([{ match: /permission/, error: "HTTP 404" }]);
    expect(new GitHub("o/r", failing.run).getPermission("dev")).toBe("none");
  });

  it("ブランチが無ければ null、ほかの失敗は投げる(検査を素通りさせない)", () => {
    const missing = fakeGh([{ match: /branches/, error: "gh api が失敗しました: HTTP 404 Branch not found" }]);
    expect(new GitHub("o/r", missing.run).branchHead("issue-1-x")).toBeNull();
    const denied = fakeGh([{ match: /branches/, error: "gh api が失敗しました: HTTP 403" }]);
    expect(() => new GitHub("o/r", denied.run).branchHead("issue-1-x")).toThrow(/403/);
    const ok = fakeGh([{ match: /branches/, out: "abc123\n" }]);
    expect(new GitHub("o/r", ok.run).branchHead("issue-1-x")).toBe("abc123");
  });

  it("CI の実行はイベントごと読み、検査は check-runs と commit status の両方を見る", () => {
    const runs = JSON.stringify({ name: "CI", event: "pull_request", status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z" });
    const { run, calls } = fakeGh([{ match: /actions\/runs/, out: runs }]);
    expect(new GitHub("o/r", run).ciRuns("a".repeat(40))).toEqual([
      { name: "CI", event: "pull_request", status: "completed", conclusion: "success", createdAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(calls[0]!.join(" ")).toContain(`actions/runs?head_sha=${"a".repeat(40)}`);

    const checks = fakeGh([
      { match: /check-runs/, out: JSON.stringify({ name: "test", status: "completed", conclusion: "success" }) },
      { match: /commits\/.*\/status/, out: JSON.stringify({ state: "success", total_count: 1 }) },
    ]);
    expect(new GitHub("o/r", checks.run).commitChecks("b".repeat(40))).toBe("success");
  });

  it("差し戻しに使うレビューは、write 以上の人の修正依頼とインラインコメントだけ", () => {
    const { run } = fakeGh([
      { match: /collaborators\/dev/, out: "write\n" },
      { match: /collaborators\/outsider/, out: "read\n" },
      {
        match: /pulls\/5\/reviews/,
        out: [
          JSON.stringify({ state: "CHANGES_REQUESTED", body: "直して", user: { login: "dev" } }),
          JSON.stringify({ state: "CHANGES_REQUESTED", body: "これも直して", user: { login: "outsider" } }),
          JSON.stringify({ state: "APPROVED", body: "よい", user: { login: "dev" } }),
        ].join("\n"),
      },
      {
        match: /pulls\/5\/comments/,
        out: [
          JSON.stringify({ path: "src/a.ts", line: 3, body: "ここも", user: { login: "dev" } }),
          JSON.stringify({ path: "src/b.ts", line: 1, body: "無視される", user: { login: "outsider" } }),
        ].join("\n"),
      },
    ]);
    expect(new GitHub("o/r", run).listReviewFeedback(5)).toEqual(["[dev] 直して", "[dev] src/a.ts:3 — ここも"]);
  });

  it("ラベルの作成は、既にあれば(422)更新に切り替える", () => {
    const { run, calls } = fakeGh([
      { match: /--method POST/, error: "gh api が失敗しました: HTTP 422 already_exists" },
      { match: /--method PATCH/, out: "{}" },
    ]);
    new GitHub("o/r", run).upsertLabel("flow::spec", "ededed", "説明");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.join(" ")).toContain("--method PATCH");
  });

  it("PR の作成と検索は、ブランチ名からオーナーつきの head で引く", () => {
    const pr = JSON.stringify({ number: 12, html_url: "https://example.test/pull/12", head: { ref: "issue-1-x" } });
    const { run, calls } = fakeGh([{ match: /pulls\?state=open/, out: pr }]);
    expect(new GitHub("o/r", run).findPullRequestByBranch("issue-1-x")).toEqual({
      number: 12,
      url: "https://example.test/pull/12",
      branch: "issue-1-x",
    });
    expect(calls[0]!.join(" ")).toContain("head=o%3Aissue-1-x");

    const created = fakeGh([{ match: /pulls/, out: pr }]);
    expect(new GitHub("o/r", created.run).createPullRequest({ head: "issue-1-x", base: "main", title: "t", body: "b" }).number).toBe(12);
    expect(created.calls[0]!.join(" ")).toContain("--method POST");
  });

  it("ラベルのイベントは labeled / unlabeled だけを時刻つきで返す", () => {
    const { run } = fakeGh([
      {
        match: /issues\/7\/events/,
        out: [
          JSON.stringify({ event: "labeled", created_at: "2026-01-01T00:00:00Z", label: { name: "flow::doing" } }),
          JSON.stringify({ event: "assigned", created_at: "2026-01-02T00:00:00Z" }),
          JSON.stringify({ event: "unlabeled", created_at: "2026-01-03T00:00:00Z", label: { name: "blocked" } }),
        ].join("\n"),
      },
    ]);
    expect(new GitHub("o/r", run).listLabelEvents(7)).toEqual([
      { label: "flow::doing", action: "labeled", at: "2026-01-01T00:00:00Z" },
      { label: "blocked", action: "unlabeled", at: "2026-01-03T00:00:00Z" },
    ]);
  });
});
