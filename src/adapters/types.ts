export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  author: string;
  url: string;
}

export interface Comment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface PullRequest {
  number: number;
  url: string;
  branch: string;
}

export interface LabelEvent {
  label: string;
  action: "labeled" | "unlabeled";
  at: string;
}

export type Permission = "admin" | "write" | "read" | "none";

/**
 * GitHub と GitLab の差を吸収する層。
 * フローのロジック(core/)はこのインターフェースだけに依存する。
 */
export interface Platform {
  readonly name: "github" | "gitlab";
  getIssue(n: number): Issue;
  listComments(n: number): Comment[];
  addComment(n: number, body: string): void;
  addLabels(n: number, labels: string[]): void;
  removeLabel(n: number, label: string): void;
  listOpenIssuesByLabel(label: string): Issue[];
  listClosedIssuesSince(sinceIso: string): Issue[];
  listLabels(): string[];
  upsertLabel(name: string, color: string, description: string): void;
  getPermission(user: string): Permission;
  defaultBranch(): string;
  findPullRequestByBranch(branch: string): PullRequest | null;
  createPullRequest(args: { head: string; base: string; title: string; body: string }): PullRequest;
  /** 人間のレビューで付いた修正依頼の本文。 */
  listReviewFeedback(pr: number): string[];
  listLabelEvents(n: number): LabelEvent[];
}
