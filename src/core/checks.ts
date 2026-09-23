import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutFilters, git, tryGit } from "./git.js";

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
  // checkout で走る filter が仕込まれていれば、作業ツリーを作るだけで任意のコマンドが動く。
  const filters = checkoutFilters(cwd);
  if (filters.length) return { ok: false, why: `checkout 時に実行される設定があります: ${filters.join(", ")}` };
  const dir = mkdtempSync(join(tmpdir(), "taskrail-checks-"));
  const worktree = join(dir, "w");
  try {
    // 作業ツリーを作る git 自体も、認証情報を渡さない環境で動かす(checkout が何かを実行する場合に備える)。
    git(["worktree", "add", "--detach", "--quiet", worktree, sha], cwd, scrubbed(dir));
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
 * 検査を動かす環境。渡すのは許可した変数だけにし、HOME を使い捨ての場所に向ける。
 * これは sandbox ではない。防げるのは「手元の認証情報をそのまま渡すこと」までで、
 * 任意のコードが利用者の権限で動くことは変わらない(docs/security.md の残りのリスクを参照)。
 */
function scrubbed(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...ALLOWED, ...extraAllowed()]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    // ~/.netrc、~/.ssh、~/.npmrc、クラウドの認証情報ファイルなどに届かせない。
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    GH_CONFIG_DIR: join(home, "gh"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    // 認証を尋ねる経路を塞ぐ(GIT_TERMINAL_PROMPT だけでは ASKPASS が先に呼ばれる)。
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_SSH_COMMAND: "ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
  };
}

/** 検査に渡す環境変数。ここに挙げたものだけを渡す(認証情報を取りこぼさないため)。 */
const ALLOWED = [
  "PATH",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "LOGNAME",
  "NODE_VERSION",
  "NVM_DIR",
  "NVM_BIN",
  "ASDF_DIR",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "JAVA_HOME",
  "GOROOT",
  "GOPATH",
  "CI",
];

/** 環境変数 TASKRAIL_CHECK_ENV で、渡す変数を追加できる(私有レジストリの設定など)。 */
function extraAllowed(): string[] {
  return (process.env.TASKRAIL_CHECK_ENV ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

