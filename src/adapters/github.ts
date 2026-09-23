import { execFileSync } from "node:child_process";
import type { ChecksState, CiRun, Comment, Issue, LabelEvent, Permission, Platform, PullRequest } from "./types.js";

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
}

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
