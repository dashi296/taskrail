import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, tryGit } from "./git.js";

/**
 * 記録されたコミットの内容だけを取り出した作業ツリーで、check_commands を順に実行する。
 * 手元の作業ツリーには触れないので、未コミットの変更や別のブランチの状態が結果に混ざらない。
 * まっさらな checkout で動くコマンドを書く必要がある(例: `npm ci && npm test`)。
 */
export function runChecks(sha: string, commands: string[], cwd = process.cwd()): { ok: boolean; why: string } {
  if (!commands.length) return { ok: false, why: "check_commands が設定されていません" };
  const dir = mkdtempSync(join(tmpdir(), "taskrail-checks-"));
  const worktree = join(dir, "w");
  try {
    git(["worktree", "add", "--detach", "--quiet", worktree, sha], cwd);
    for (const command of commands) {
      try {
        execFileSync("sh", ["-c", command], { cwd: worktree, stdio: "inherit" });
      } catch {
        return { ok: false, why: `${command} が失敗しました` };
      }
    }
    return { ok: true, why: "" };
  } finally {
    tryGit(["worktree", "remove", "--force", worktree], cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}
