import { execFileSync } from "node:child_process";
import type { Board, BoardItem, ChecksState, CiRun, Comment, Issue, LabelEvent, Permission, Platform, PullRequest } from "./types.js";

/**
 * GitHub アダプタ。`gh` CLI 経由で API を呼ぶ。
 * 依存を増やさないため octokit は使わない。GitHub Actions のランナーには gh が入っている。
 * 認証は GH_TOKEN(または gh auth login 済みの状態)に任せる。
 */
export type GhRunner = (args: string[], input?: string) => string;

export class GitHub implements Platform {
  readonly name = "github" as const;
  private readonly repo: string;
  /** gh の実行。テストでは差し替える。 */
  private readonly run: GhRunner;

  constructor(repo?: string, run: GhRunner = gh) {
    this.run = run;
    this.repo = repo ?? process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? this.detectRepo();
  }

  private detectRepo(): string {
    return this.run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  }

  private api(path: string, opts: { method?: string; body?: unknown; paginate?: boolean; jq?: string } = {}): string {
    const args = ["api", path.startsWith("/") ? path : `repos/${this.repo}/${path}`];
    if (opts.method) args.push("--method", opts.method);
    if (opts.paginate) args.push("--paginate");
    if (opts.jq) args.push("--jq", opts.jq);
    if (opts.body !== undefined) args.push("--input", "-");
    return this.run(args, opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  }

  /** --paginate + --jq '.[]' は1行1オブジェクトで返る。 */
  private list<T>(path: string, jq = ".[]"): T[] {
    const out = this.api(path, { paginate: true, jq: `${jq} | @json` });
    return out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T);
  }

  remoteIdentity(): { host: string; repo: string } {
    // GHES では GH_HOST か GITHUB_SERVER_URL でホストが変わる。
    const server = process.env.GITHUB_SERVER_URL;
    const host = process.env.GH_HOST ?? (server ? new URL(server).host : "github.com");
    return { host, repo: this.repo };
  }

  getIssue(n: number): Issue {
    return toIssue(JSON.parse(this.api(`issues/${n}`)) as RawIssue);
  }

  listComments(n: number): Comment[] {
    return this.list<RawComment>(`issues/${n}/comments?per_page=100`).map((c) => ({
      id: c.id,
      author: c.user?.login ?? "",
      body: c.body ?? "",
      createdAt: c.created_at,
    }));
  }

  addComment(n: number, body: string): void {
    this.api(`issues/${n}/comments`, { method: "POST", body: { body } });
  }

  addLabels(n: number, labels: string[]): void {
    if (labels.length) this.api(`issues/${n}/labels`, { method: "POST", body: { labels } });
  }

  removeLabel(n: number, label: string): void {
    try {
      this.api(`issues/${n}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
    } catch (e) {
      if (!/404|Label does not exist/i.test(String(e))) throw e;
    }
  }

  listOpenIssuesByLabel(label: string): Issue[] {
    return this.list<RawIssue>(`issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`)
      .filter((i) => !i.pull_request)
      .map(toIssue);
  }

  listClosedIssuesSince(sinceIso: string): Issue[] {
    return this.list<RawIssue>(`issues?state=closed&per_page=100&since=${encodeURIComponent(sinceIso)}`)
      .filter((i) => !i.pull_request)
      .map(toIssue);
  }

  listLabels(): string[] {
    return this.list<{ name: string }>("labels?per_page=100").map((l) => l.name);
  }

  upsertLabel(name: string, color: string, description: string): void {
    const body = { name, color, description: description.slice(0, 100) };
    try {
      this.api("labels", { method: "POST", body });
    } catch (e) {
      if (!/already_exists|422/i.test(String(e))) throw e;
      this.api(`labels/${encodeURIComponent(name)}`, { method: "PATCH", body: { new_name: name, color, description: body.description } });
    }
  }

  getPermission(user: string): Permission {
    try {
      const p = this.api(`collaborators/${encodeURIComponent(user)}/permission`, { jq: ".permission" }).trim();
      if (p === "admin" || p === "write" || p === "read") return p;
      if (p === "maintain") return "write";
      return "none";
    } catch {
      return "none";
    }
  }

  defaultBranch(): string {
    return this.api(`/repos/${this.repo}`, { jq: ".default_branch" }).trim();
  }

  findPullRequestByBranch(branch: string): PullRequest | null {
    const owner = this.repo.split("/")[0];
    const prs = this.list<RawPr>(`pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    const pr = prs[0];
    return pr ? { number: pr.number, url: pr.html_url, branch: pr.head.ref } : null;
  }

  createPullRequest(args: { head: string; base: string; title: string; body: string }): PullRequest {
    const pr = JSON.parse(this.api("pulls", { method: "POST", body: args })) as RawPr;
    return { number: pr.number, url: pr.html_url, branch: pr.head.ref };
  }

  listReviewFeedback(pr: number): string[] {
    // 実装エージェントへの指示になるため、write 以上の権限を持つ人のものだけを渡す。
    const perms = new Map<string, boolean>();
    const canWrite = (login: string | undefined) => {
      if (!login) return false;
      if (!perms.has(login)) perms.set(login, ["admin", "write"].includes(this.getPermission(login)));
      return perms.get(login)!;
    };
    const reviews = this.list<{ state: string; body: string | null; user: { login: string } | null }>(
      `pulls/${pr}/reviews?per_page=100`,
    )
      .filter((r) => r.state === "CHANGES_REQUESTED" && r.body && canWrite(r.user?.login))
      .map((r) => `[${r.user!.login}] ${r.body}`);
    const inline = this.list<{ path: string; line: number | null; body: string; user: { login: string } | null }>(
      `pulls/${pr}/comments?per_page=100`,
    )
      .filter((c) => canWrite(c.user?.login))
      .map((c) => `[${c.user!.login}] ${c.path}${c.line ? `:${c.line}` : ""} — ${c.body}`);
    return [...reviews, ...inline];
  }

  listLabelEvents(n: number): LabelEvent[] {
    return this.list<{ event: string; created_at: string; label?: { name: string } }>(
      `issues/${n}/events?per_page=100`,
    )
      .filter((e) => (e.event === "labeled" || e.event === "unlabeled") && e.label)
      .map((e) => ({ label: e.label!.name, action: e.event as "labeled" | "unlabeled", at: e.created_at }));
  }

  branchHead(branch: string): string | null {
    try {
      return this.api(`branches/${encodeURIComponent(branch)}`, { jq: ".commit.sha" }).trim() || null;
    } catch (e) {
      if (/404|Branch not found/i.test(String(e))) return null;
      throw e;
    }
  }

  commitChecks(sha: string): ChecksState {
    const runs = this.list<RawCheckRun>(`commits/${sha}/check-runs?per_page=100`, ".check_runs[]");
    const status = JSON.parse(this.api(`commits/${sha}/status`, { jq: "{state, total_count}" })) as RawCombinedStatus;
    return summarizeChecks(runs, status);
  }

  ciRuns(sha: string): CiRun[] {
    return this.list<{ name: string; event: string; status: string; conclusion: string | null; created_at: string }>(
      `actions/runs?head_sha=${sha}&per_page=100`,
      ".workflow_runs[]",
    ).map((r) => ({ name: r.name, event: r.event, status: r.status, conclusion: r.conclusion, createdAt: r.created_at }));
  }

  /** readBoard で読み込んだボード(Projects)。setBoardColumn が ID の対応に使う。 */
  private readonly boards = new Map<string, BoardMeta>();

  /** host は問い合わせ先。gh の既定のホスト(認証の状態や環境変数で変わる)に任せず、検証したホストを明示する。 */
  private graphql<T>(host: string, query: string, vars: Record<string, string | number>): T {
    const args = ["api", "graphql", "--hostname", host, "-f", `query=${query}`];
    // 数値は -F で型つきに、文字列は -f でそのまま渡す(-F は @ で始まる値をファイルとして読むため)。
    for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
    return (JSON.parse(this.run(args)) as { data: T }).data;
  }

  readBoard(board: string): Board {
    // 別のホストの URL を、同じ持ち主・同じ番号の別のボードとして読み書きしない。
    // リポジトリのホストと一致する URL だけを受け付け、問い合わせ先もそのホストに固定する。
    const host = this.remoteIdentity().host.toLowerCase();
    let url: URL | null = null;
    try {
      url = new URL(board);
    } catch {
      // 下でまとめて扱う
    }
    const m = url && /^\/(users|orgs)\/([^/]+)\/projects\/(\d+)(?:\/|$)/.exec(url.pathname);
    if (!url || !m) throw new Error(`board は Projects の URL で指定してください(例: https://${host}/users/me/projects/1): ${board}`);
    if (url.protocol !== "https:") throw new Error(`board は https の URL で指定してください: ${board}`);
    if (url.host !== host) throw new Error(`board のホストが、このリポジトリのホスト(${host})と違います: ${board}`);
    const query = BOARD_QUERY.replace("OWNER", m[1] === "orgs" ? "organization" : "user");
    const meta: BoardMeta = { host, projectId: "", fieldId: "", options: new Map(), items: new Map() };
    const items: BoardItem[] = [];
    for (let after: string | undefined; ; ) {
      const vars = { login: m[2]!, number: Number(m[3]), ...(after ? { after } : {}) };
      const project = this.graphql<{ owner: { projectV2: RawProject | null } | null }>(host, query, vars).owner?.projectV2;
      if (!project) throw new Error(`ボードが見つかりません: ${board}`);
      if (!project.field?.id) throw new Error(`ボードに Status フィールド(単一選択)がありません: ${board}`);
      meta.projectId = project.id;
      meta.fieldId = project.field.id;
      for (const o of project.field.options ?? []) meta.options.set(o.name, o.id);
      for (const n of project.items.nodes) {
        // 下書きや PR、ほかのリポジトリの Issue、読めないアイテム(null)は対象外。
        const c = n?.content;
        if (!n || typeof c?.number !== "number" || c.repository?.nameWithOwner.toLowerCase() !== this.repo.toLowerCase()) continue;
        meta.items.set(c.number, n.id);
        items.push({
          number: c.number,
          labels: (c.labels?.nodes ?? []).map((l) => l.name),
          state: c.state === "OPEN" ? "open" : "closed",
          column: n.fieldValueByName?.name ?? null,
        });
      }
      if (!project.items.pageInfo.hasNextPage) break;
      after = project.items.pageInfo.endCursor;
    }
    this.boards.set(board, meta);
    return { columns: [...meta.options.keys()], items };
  }

  setBoardColumn(board: string, issue: number, column: string): void {
    if (!this.boards.has(board)) this.readBoard(board);
    const meta = this.boards.get(board)!;
    const option = meta.options.get(column);
    if (!option) throw new Error(`ボードに列「${column}」がありません。Status の選択肢に追加してください`);
    let item = meta.items.get(issue);
    if (!item) {
      const content = this.api(`issues/${issue}`, { jq: ".node_id" }).trim();
      item = this.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
        meta.host,
        "mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: {projectId: $project, contentId: $content}) { item { id } } }",
        { project: meta.projectId, content },
      ).addProjectV2ItemById.item.id;
      meta.items.set(issue, item);
    }
    this.graphql(
      meta.host,
      "mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {singleSelectOptionId: $option}}) { projectV2Item { id } } }",
      { project: meta.projectId, item, field: meta.fieldId, option },
    );
  }
}

interface BoardMeta {
  host: string;
  projectId: string;
  fieldId: string;
  /** 列の名前 → 選択肢の ID。 */
  options: Map<string, string>;
  /** Issue 番号 → アイテムの ID。 */
  items: Map<number, string>;
}
interface RawProject {
  id: string;
  field: { id?: string; options?: { id: string; name: string }[] } | null;
  items: {
    pageInfo: { hasNextPage: boolean; endCursor: string };
    nodes: ({
      id: string;
      content: { number?: number; state?: string; repository?: { nameWithOwner: string }; labels?: { nodes: { name: string }[] } } | null;
      fieldValueByName: { name?: string } | null;
    } | null)[];
  };
}

/** Projects のアイテムと Status の選択肢。OWNER は user か organization に置き換える。 */
const BOARD_QUERY = `query($login: String!, $number: Int!, $after: String) {
  owner: OWNER(login: $login) {
    projectV2(number: $number) {
      id
      field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content { ... on Issue { number state repository { nameWithOwner } labels(first: 100) { nodes { name } } } }
          fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`;

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}
interface RawCombinedStatus {
  state: string;
  total_count: number;
}

/**
 * check runs(GitHub Actions など)と commit status(外部 CI)をまとめて判定する。
 * 検査が1つもなければ成功とはみなさない。
 */
export function summarizeChecks(runs: RawCheckRun[], status: RawCombinedStatus): ChecksState {
  if (runs.some((r) => r.status !== "completed")) return "pending";
  if (runs.some((r) => !["success", "neutral", "skipped"].includes(r.conclusion ?? ""))) return "failure";
  if (status.total_count > 0 && status.state !== "success") return status.state === "pending" ? "pending" : "failure";
  if (runs.length === 0 && status.total_count === 0) return "pending";
  return "success";
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: { login: string } | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}
interface RawComment {
  id: number;
  body: string | null;
  created_at: string;
  user: { login: string } | null;
}
interface RawPr {
  number: number;
  html_url: string;
  head: { ref: string };
}

function toIssue(i: RawIssue): Issue {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
    state: i.state,
    author: i.user?.login ?? "",
    url: i.html_url,
  };
}

function gh(args: string[], input?: string): string {
  try {
    return execFileSync("gh", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string; code?: string };
    if (err.code === "ENOENT") throw new Error("gh コマンドが見つかりません。GitHub CLI をインストールしてください");
    throw new Error(`gh ${args.slice(0, 2).join(" ")} が失敗しました: ${(err.stderr || err.stdout || err.message).trim()}`);
  }
}
