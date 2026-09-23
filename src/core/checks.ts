import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

/**
 * 検査を動かす環境。認証情報になりうる変数を落とし、HOME を使い捨ての場所に向ける。
 * これは sandbox ではない。防げるのは「手元の認証情報をそのまま渡すこと」までで、
 * 任意のコードが利用者の権限で動くことは変わらない(docs/security.md の残りのリスクを参照)。
 */
function scrubbed(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRETISH.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    // ~/.netrc、~/.ssh、~/.npmrc、クラウドの認証情報ファイルなどに届かせない。
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GH_CONFIG_DIR: join(home, "gh"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_SSH_COMMAND: "ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
  };
}

/** 認証情報になりうる環境変数(名前で判断する)。 */
const SECRETISH = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|APIKEY|API_KEY|AUTH|SSH_AUTH_SOCK|NETRC|TASKRAIL_GIT_REMOTE/i;
