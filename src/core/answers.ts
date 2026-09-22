import type { Comment } from "../adapters/types.js";
import type { Ctx } from "./context.js";
import { trustedAuthors } from "./context.js";
import { parseRuns } from "./record.js";

/**
 * 回答として採用してよいコメント。taskrail の記録でも bot でもなく、書き込み権限のある人のものだけ。
 * Actions の resume と同じ基準にする(権限のない人の指示をエージェントに渡さない)。
 */
export function authorizedComments(ctx: Ctx, comments: Comment[]): Comment[] {
  const canWrite = new Map<string, boolean>();
  return comments.filter((c) => {
    if (parseRuns([c]).length) return false;
    if (ctx.project.bot_logins.includes(c.author)) return false;
    if (!canWrite.has(c.author)) {
      const perm = ctx.platform.getPermission(c.author);
      canWrite.set(c.author, perm === "admin" || perm === "write");
    }
    return canWrite.get(c.author)!;
  });
}

/**
 * blocked の質問への回答。直近の記録がその工程の blocked のときだけ、それより後の回答を返す。
 * 工程がもう一度動いた後(pass や差し戻し)は、その記録が直近になるため空になる。
 */
export function answersFor(ctx: Ctx, stageId: string, comments: Comment[]): Comment[] {
  const runs = parseRuns(comments, trustedAuthors(ctx.project));
  const last = runs[runs.length - 1];
  if (!last || last.stage !== stageId || last.status !== "blocked") return [];
  return authorizedComments(
    ctx,
    comments.filter((c) => Date.parse(c.createdAt) > Date.parse(last.postedAt)),
  );
}
