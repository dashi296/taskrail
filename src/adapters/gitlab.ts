import type { Comment, Issue, LabelEvent, Permission, Platform, PullRequest } from "./types.js";

/**
 * GitLab アダプタ(未実装の雛形)。
 *
 * 実装方針:
 * - `glab api` 経由で呼ぶ(GitHub アダプタの `gh api` と同じ構造)。プロジェクトは CI_PROJECT_ID から取る。
 * - Issue は iid を番号として扱う。PullRequest は Merge Request に対応させる。
 * - scoped label(`flow::*`)は GitLab 側で排他になるため、removeLabel は冪等に成功させればよい。
 * - listLabelEvents は `issues/:iid/resource_label_events` を使う。
 * - getPermission は `members/all/:user_id` の access_level を
 *   50/40 → admin、30 → write、20/10 → read に対応させる。
 *
 * GitLab はラベル変更でパイプラインを直接起動できないため、Webhook を受けて
 * パイプライントリガー API を呼ぶリスナーが別途必要。docs/gitlab.md を参照。
 */
export class GitLab implements Platform {
  readonly name = "gitlab" as const;

  private todo(method: string): never {
    throw new Error(`GitLab アダプタの ${method} は未実装です。docs/gitlab.md を参照してください`);
  }

  getIssue(_n: number): Issue { return this.todo("getIssue"); }
  listComments(_n: number): Comment[] { return this.todo("listComments"); }
  addComment(_n: number, _body: string): void { this.todo("addComment"); }
  addLabels(_n: number, _labels: string[]): void { this.todo("addLabels"); }
  removeLabel(_n: number, _label: string): void { this.todo("removeLabel"); }
  listOpenIssuesByLabel(_label: string): Issue[] { return this.todo("listOpenIssuesByLabel"); }
  listClosedIssuesSince(_sinceIso: string): Issue[] { return this.todo("listClosedIssuesSince"); }
  listLabels(): string[] { return this.todo("listLabels"); }
  upsertLabel(_name: string, _color: string, _description: string): void { this.todo("upsertLabel"); }
  getPermission(_user: string): Permission { return this.todo("getPermission"); }
  defaultBranch(): string { return this.todo("defaultBranch"); }
  findPullRequestByBranch(_branch: string): PullRequest | null { return this.todo("findPullRequestByBranch"); }
  createPullRequest(_args: { head: string; base: string; title: string; body: string }): PullRequest {
    return this.todo("createPullRequest");
  }
  listReviewFeedback(_pr: number): string[] { return this.todo("listReviewFeedback"); }
  listLabelEvents(_n: number): LabelEvent[] { return this.todo("listLabelEvents"); }
}
