import type { ChecksState, CiRun, Comment, Issue, LabelEvent, Permission, Platform, PullRequest } from "../src/adapters/types.js";
import { ProjectSchema, loadFlow } from "../src/core/config.js";
import type { Ctx } from "../src/core/context.js";

/** テスト用のインメモリの Platform。ボード操作をコマンド単位で検査する。 */
export class FakePlatform implements Platform {
  readonly name = "github" as const;
  issues = new Map<number, Issue>();
  comments = new Map<number, Comment[]>();
  labelEvents = new Map<number, LabelEvent[]>();
  permissions = new Map<string, Permission>();
  heads = new Map<string, string>();
  checks = new Map<string, ChecksState>();
  runs = new Map<string, CiRun[]>();
  /** 例外を投げるブランチ(API の失敗を模す)。 */
  failingBranches = new Set<string>();
  private clock = Date.parse("2026-01-01T00:00:00Z");

  /** 時刻を1分進めて返す(ラベルの付与とコメントの前後関係を表す)。 */
  tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  addIssue(number: number, labels: string[]): Issue {
    const issue: Issue = { number, title: "t", body: "", labels: [], state: "open", author: "u", url: "" };
    this.issues.set(number, issue);
    this.addLabels(number, labels);
    return issue;
  }

  /** push 先として認める先。テストの origin はローカルのパスなので、テストから差し替える。 */
  remoteId: { host: string; repo: string } = { host: "", repo: "o/r" };
  remoteIdentity(): { host: string; repo: string } {
    return this.remoteId;
  }

  getIssue(n: number): Issue {
    const i = this.issues.get(n);
    if (!i) throw new Error(`no issue ${n}`);
    return { ...i, labels: [...i.labels] };
  }
  listComments(n: number): Comment[] {
    return this.comments.get(n) ?? [];
  }
  addComment(n: number, body: string, author = "app[bot]"): void {
    const list = this.comments.get(n) ?? [];
    list.push({ id: list.length + 1, author, body, createdAt: this.tick() });
    this.comments.set(n, list);
  }
  addLabels(n: number, labels: string[]): void {
    const i = this.issues.get(n)!;
    for (const l of labels) {
      if (!i.labels.includes(l)) i.labels.push(l);
      this.labelEvents.set(n, [...(this.labelEvents.get(n) ?? []), { label: l, action: "labeled", at: this.tick() }]);
    }
  }
  removeLabel(n: number, label: string): void {
    const i = this.issues.get(n)!;
    i.labels = i.labels.filter((l) => l !== label);
    this.labelEvents.set(n, [...(this.labelEvents.get(n) ?? []), { label, action: "unlabeled", at: this.tick() }]);
  }
  listOpenIssuesByLabel(label: string): Issue[] {
    return [...this.issues.values()].filter((i) => i.state === "open" && i.labels.includes(label)).map((i) => this.getIssue(i.number));
  }
  listLabelEvents(n: number): LabelEvent[] {
    return this.labelEvents.get(n) ?? [];
  }
  getPermission(user: string): Permission {
    return this.permissions.get(user) ?? "none";
  }
  branchHead(branch: string): string | null {
    if (this.failingBranches.has(branch)) throw new Error("gh api が失敗しました: HTTP 403");
    return this.heads.get(branch) ?? null;
  }
  commitChecks(sha: string): ChecksState {
    return this.checks.get(sha) ?? "pending";
  }
  ciRuns(sha: string): CiRun[] {
    return this.runs.get(sha) ?? [];
  }
  defaultBranch(): string {
    return "main";
  }

  listClosedIssuesSince(): Issue[] {
    return [];
  }
  listLabels(): string[] {
    return [];
  }
  upsertLabel(): void {}
  /** 作成された PR(検証用)。 */
  createdPullRequests: { head: string; base: string; title: string; body: string }[] = [];
  /** true なら PR の作成が失敗する(API の失敗を模す)。 */
  failCreatePullRequest = false;
  findPullRequestByBranch(): PullRequest | null {
    return null;
  }
  createPullRequest(args: { head: string; base: string; title: string; body: string }): PullRequest {
    if (this.failCreatePullRequest) throw new Error("gh pr create が失敗しました: HTTP 422");
    this.createdPullRequests.push(args);
    return { number: 100 + this.createdPullRequests.length, branch: args.head, url: `https://example.test/pull/${this.createdPullRequests.length}` };
  }
  listReviewFeedback(): string[] {
    return [];
  }
}

export function fakeCtx(platform: FakePlatform, project: Partial<ReturnType<typeof ProjectSchema.parse>> = {}): Ctx {
  return { flow: loadFlow(), project: { ...ProjectSchema.parse({}), bot_logins: ["app[bot]"], ...project }, platform };
}
