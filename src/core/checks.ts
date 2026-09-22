import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, tryGit } from "./git.js";

/**
 * 記録されたコミットの内容だけを取り出した作業ツリーで、check_commands を順に実行する。
 * 手元の作業ツリーには触れないので、未コミットの変更や別のブランチの状態が結果に混ざらない。
 * まっさらな checkout で動くコマンドを書く必要がある(例: `npm ci && npm test`)。
 *
 * 実行するのはエージェントが書いたコミットの中身(テストや package.json のスクリプト)なので、
 * エージェントを起動するときと同じように認証情報を外した環境で動かす。
 */
export function runChecks(sha: string, commands: string[], cwd = process.cwd()): { ok: boolean; why: string } {
  if (!commands.length) return { ok: false, why: "check_commands が設定されていません" };
  const dir = mkdtempSync(join(tmpdir(), "taskrail-checks-"));
  const worktree = join(dir, "w");
  try {
    git(["worktree", "add", "--detach", "--quiet", worktree, sha], cwd);
    for (const command of commands) {
      try {
        execFileSync("sh", ["-c", command], { cwd: worktree, stdio: "inherit", env: scrubbed(dir) });
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

/** 認証情報を外した環境。gh・git・ssh のいずれの認証も使えないようにする。 */
function scrubbed(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "TASKRAIL_GIT_REMOTE"]) delete env[key];
  return {
    ...env,
    GH_CONFIG_DIR: join(dir, "gh"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
  };
}
