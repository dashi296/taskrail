import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHub } from "../src/adapters/github.js";

/** gh の代わり。args を記録し、path に応じた応答を返す。一致しなければ空。 */
function fakeGh(routes: { match: RegExp; out?: string; error?: string }[]) {
  const calls: { args: string[]; input?: string }[] = [];
  const run = (args: string[], input?: string): string => {
    calls.push({ args, input });
    const path = args.join(" ");
    const hit = routes.find((r) => r.match.test(path));
    if (hit?.error) throw new Error(hit.error);
    return hit?.out ?? "";
  };
  return { run, calls, args: (i = 0) => calls[i]!.args, body: (i = 0) => JSON.parse(calls[i]!.input!) as Record<string, unknown> };
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
    expect(calls[0]!.args).toEqual(["api", "repos/o/r/issues/7"]);
    expect(issue).toMatchObject({ number: 7, title: "ボタン", labels: ["flow::spec", "ai::ok"], state: "open" });
  });

  it("コメントは --paginate と @json で1行ずつ読む", () => {
    const lines = [
      JSON.stringify({ id: 1, user: { login: "a" }, body: "一件目", created_at: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ id: 2, user: null, body: null, created_at: "2026-01-02T00:00:00Z" }),
    ].join("\n");
    const { run, calls } = fakeGh([{ match: /issues\/7\/comments/, out: lines }]);
    const comments = new GitHub("o/r", run).listComments(7);
    expect(calls[0]!.args).toContain("--paginate");
    expect(calls[0]!.args).toContain(".[] | @json");
    expect(comments).toEqual([
      { id: 1, author: "a", body: "一件目", createdAt: "2026-01-01T00:00:00Z" },
      { id: 2, author: "", body: "", createdAt: "2026-01-02T00:00:00Z" },
    ]);
  });

  it("Issue の一覧はラベルで絞り込む(URL エンコードも含めて)", () => {
    const { run, args } = fakeGh([{ match: /issues\?state=open/, out: "" }]);
    new GitHub("o/r", run).listOpenIssuesByLabel("flow::ready");
    expect(args()).toEqual([
      "api",
      "repos/o/r/issues?state=open&per_page=100&labels=flow%3A%3Aready",
      "--paginate",
      "--jq",
      ".[] | @json",
    ]);
  });

  it("書き込み系は本文を JSON で標準入力に渡す", () => {
    const post = fakeGh([{ match: /comments/, out: "{}" }]);
    new GitHub("o/r", post.run).addComment(7, "本文\n複数行");
    expect(post.args().join(" ")).toContain("--method POST");
    expect(post.body()).toEqual({ body: "本文\n複数行" });

    const labels = fakeGh([{ match: /labels/, out: "{}" }]);
    new GitHub("o/r", labels.run).addLabels(7, ["blocked", "flow::verify"]);
    expect(labels.body()).toEqual({ labels: ["blocked", "flow::verify"] });

    const empty = fakeGh([{ match: /labels/, out: "{}" }]);
    new GitHub("o/r", empty.run).addLabels(7, []);
    expect(empty.calls).toHaveLength(0);

    const pr = fakeGh([{ match: /pulls/, out: JSON.stringify({ number: 1, html_url: "u", head: { ref: "b" } }) }]);
    new GitHub("o/r", pr.run).createPullRequest({ head: "issue-1-x", base: "main", title: "題", body: "本文" });
    expect(pr.body()).toEqual({ head: "issue-1-x", base: "main", title: "題", body: "本文" });
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
    expect(calls[0]!.args.join(" ")).toContain(`actions/runs?head_sha=${"a".repeat(40)}`);

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
    expect(calls[1]!.args.join(" ")).toContain("--method PATCH");
    expect(JSON.parse(calls[0]!.input!)).toEqual({ name: "flow::spec", color: "ededed", description: "説明" });
    expect(JSON.parse(calls[1]!.input!)).toEqual({ new_name: "flow::spec", color: "ededed", description: "説明" });
  });

  it("PR の作成と検索は、ブランチ名からオーナーつきの head で引く", () => {
    const pr = JSON.stringify({ number: 12, html_url: "https://example.test/pull/12", head: { ref: "issue-1-x" } });
    const { run, calls } = fakeGh([{ match: /pulls\?state=open/, out: pr }]);
    expect(new GitHub("o/r", run).findPullRequestByBranch("issue-1-x")).toEqual({
      number: 12,
      url: "https://example.test/pull/12",
      branch: "issue-1-x",
    });
    expect(calls[0]!.args.join(" ")).toContain("head=o%3Aissue-1-x");

    const created = fakeGh([{ match: /pulls/, out: pr }]);
    expect(new GitHub("o/r", created.run).createPullRequest({ head: "issue-1-x", base: "main", title: "t", body: "b" }).number).toBe(12);
    expect(created.calls[0]!.args.join(" ")).toContain("--method POST");
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

describe("GitHub アダプタ(ボード = Projects)", () => {
  const BOARD = "https://github.com/users/me/projects/3";
  // ホストの照合を、実行環境(Actions の GITHUB_SERVER_URL など)に左右させない。
  beforeEach(() => {
    vi.stubEnv("GH_HOST", "github.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const page = (nodes: unknown[], next?: string) =>
    JSON.stringify({
      data: {
        owner: {
          projectV2: {
            id: "P1",
            field: { id: "F1", options: [{ id: "o-spec", name: "Spec" }, { id: "o-plan", name: "Plan" }] },
            items: { pageInfo: { hasNextPage: !!next, endCursor: next ?? "" }, nodes },
          },
        },
      },
    });
  const item = (id: string, number: number, labels: string[], column: string | null, repo = "o/r", state = "OPEN") => ({
    id,
    content: { number, state, repository: { nameWithOwner: repo }, labels: { nodes: labels.map((name) => ({ name })) } },
    fieldValueByName: column ? { name: column } : null,
  });

  it("列の名前と、このリポジトリの Issue(ラベル・開閉・列つき)を返す", () => {
    const { run, args } = fakeGh([
      {
        match: /graphql/,
        out: page([
          item("I1", 7, ["flow::spec", "ai::ok"], "Spec"),
          item("I2", 8, [], null, "o/r", "CLOSED"),
          item("I3", 9, ["flow::plan"], "Plan", "other/repo"),
          { id: "I4", content: {}, fieldValueByName: null },
          { id: "I5", content: null, fieldValueByName: null },
          null,
        ]),
      },
    ]);
    expect(new GitHub("o/r", run).readBoard(BOARD)).toEqual({
      columns: ["Spec", "Plan"],
      items: [
        { number: 7, labels: ["flow::spec", "ai::ok"], state: "open", column: "Spec" },
        { number: 8, labels: [], state: "closed", column: null },
      ],
    });
    expect(args().slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.com"]);
    expect(args()[5]).toContain("owner: user(login: $login)");
    expect(args().slice(6)).toEqual(["-f", "login=me", "-F", "number=3"]);
  });

  it("Organization のボードは organization で引く", () => {
    const { run, args } = fakeGh([{ match: /graphql/, out: page([]) }]);
    new GitHub("o/r", run).readBoard("https://github.com/orgs/acme/projects/12/views/1");
    expect(args()[5]).toContain("owner: organization(login: $login)");
    expect(args().slice(6)).toEqual(["-f", "login=acme", "-F", "number=12"]);
  });

  it("続きのページを読む", () => {
    const outs = [page([item("I1", 1, [], null)], "c1"), page([item("I2", 2, [], null)])];
    const calls: string[][] = [];
    const run = (a: string[]) => {
      calls.push(a);
      return outs[calls.length - 1]!;
    };
    expect(new GitHub("o/r", run).readBoard(BOARD).items.map((i) => i.number)).toEqual([1, 2]);
    expect(calls[1]).toContain("after=c1");
  });

  it("Projects の URL でなければ、問い合わせずに失敗する", () => {
    const { run, calls } = fakeGh([{ match: /graphql/, out: page([]) }]);
    const gh = new GitHub("o/r", run);
    for (const bad of ["", "users/me/projects/3", "https://github.com/o/r", "https://github.com/x/users/me/projects/3", "https://github.com/users/me/projects/abc"]) {
      expect(() => gh.readBoard(bad), bad).toThrow(/Projects の URL/);
    }
    expect(calls).toHaveLength(0);
  });

  it("別のホストの URL は、同じ持ち主・同じ番号でも読み書きしない", () => {
    const { run, calls } = fakeGh([{ match: /graphql/, out: page([item("I1", 7, [], null)]) }]);
    const gh = new GitHub("o/r", run);
    for (const other of ["https://ghe.example.com/users/me/projects/3", "https://github.com.evil.test/users/me/projects/3", "https://github.com:8443/users/me/projects/3"]) {
      expect(() => gh.readBoard(other), other).toThrow(/ホスト/);
      expect(() => gh.setBoardColumn(other, 7, "Spec"), other).toThrow(/ホスト/);
    }
    expect(calls).toHaveLength(0);
  });

  it("https でない URL は、問い合わせずに失敗する(原因をホストの違いと取り違えない)", () => {
    const { run, calls } = fakeGh([{ match: /graphql/, out: page([]) }]);
    expect(() => new GitHub("o/r", run).readBoard("http://github.com/users/me/projects/3")).toThrow(/https の URL/);
    expect(calls).toHaveLength(0);
  });

  it("リポジトリのホストが GHES なら、そのホストの URL だけを受け付け、そのホストに問い合わせる", () => {
    // GH_HOST の大文字小文字は問わない。
    vi.stubEnv("GH_HOST", "GHE.Example.com");
    const { run, calls } = fakeGh([{ match: /graphql/, out: page([]) }]);
    const gh = new GitHub("o/r", run);
    expect(gh.readBoard("https://ghe.example.com/orgs/acme/projects/3").items).toEqual([]);
    expect(calls[0]!.args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "ghe.example.com"]);
    expect(() => gh.readBoard(BOARD)).toThrow(/ホスト/);
    expect(calls).toHaveLength(1);
  });

  it("GH_HOST がなく GITHUB_SERVER_URL だけが GHES を指していても、検証したホストに問い合わせる", () => {
    vi.stubEnv("GH_HOST", undefined);
    vi.stubEnv("GITHUB_SERVER_URL", "https://ghe.example.com");
    const { run, calls } = fakeGh([
      { match: /updateProjectV2ItemFieldValue/, out: "{}" },
      { match: /graphql/, out: page([item("I1", 7, [], null)]) },
    ]);
    const gh = new GitHub("o/r", run);
    gh.setBoardColumn("https://ghe.example.com/users/me/projects/3", 7, "Spec");
    expect(calls.map((c) => c.args.slice(0, 4))).toEqual([
      ["api", "graphql", "--hostname", "ghe.example.com"],
      ["api", "graphql", "--hostname", "ghe.example.com"],
    ]);
    expect(() => gh.readBoard(BOARD)).toThrow(/ホスト/);
  });

  it("ボードがない、Status がないときは失敗する", () => {
    const none = fakeGh([{ match: /graphql/, out: JSON.stringify({ data: { owner: { projectV2: null } } }) }]);
    expect(() => new GitHub("o/r", none.run).readBoard(BOARD)).toThrow(/見つかりません/);
    const noField = fakeGh([
      { match: /graphql/, out: JSON.stringify({ data: { owner: { projectV2: { id: "P1", field: {}, items: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }) },
    ]);
    expect(() => new GitHub("o/r", noField.run).readBoard(BOARD)).toThrow(/Status/);
  });

  it("ボードにある Issue は、列の選択肢の ID で更新する", () => {
    const { run, calls } = fakeGh([
      { match: /updateProjectV2ItemFieldValue/, out: "{}" },
      { match: /graphql/, out: page([item("I1", 7, ["flow::plan"], "Spec")]) },
    ]);
    new GitHub("o/r", run).setBoardColumn(BOARD, 7, "Plan");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.slice(6)).toEqual(["-f", "project=P1", "-f", "item=I1", "-f", "field=F1", "-f", "option=o-plan"]);
  });

  it("ボードにない Issue は、追加してから列を設定する", () => {
    const { run, calls } = fakeGh([
      { match: /addProjectV2ItemById/, out: JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "I9" } } } }) },
      { match: /updateProjectV2ItemFieldValue/, out: "{}" },
      { match: /graphql/, out: page([]) },
      { match: /issues\/7/, out: "NODE7\n" },
    ]);
    const gh = new GitHub("o/r", run);
    gh.readBoard(BOARD);
    gh.setBoardColumn(BOARD, 7, "Spec");
    // 追加する Issue の ID も、ボードと同じホストから取る。
    expect(calls[1]!.args).toEqual(["api", "repos/o/r/issues/7", "--hostname", "github.com", "--jq", ".node_id"]);
    expect(calls[2]!.args.slice(6)).toEqual(["-f", "project=P1", "-f", "content=NODE7"]);
    expect(calls[3]!.args.slice(6)).toEqual(["-f", "project=P1", "-f", "item=I9", "-f", "field=F1", "-f", "option=o-spec"]);
  });

  it("列がボードになければ、書き込まずに失敗する(列は作らない)", () => {
    const { run, calls } = fakeGh([{ match: /graphql/, out: page([item("I1", 7, [], null)]) }]);
    expect(() => new GitHub("o/r", run).setBoardColumn(BOARD, 7, "Verify")).toThrow(/列「Verify」/);
    expect(calls).toHaveLength(1);
  });
});
