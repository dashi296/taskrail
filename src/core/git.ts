import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * git を実行する。作業ツリーはエージェントが触った後のものなので、リポジトリに仕込まれた hook や fsmonitor が
 * taskrail の git 操作で実行されないよう、常に無効にする。
 */
export function git(args: string[], cwd = process.cwd()): string {
  return gitRaw(args, cwd).trim();
}

/** 出力を加工せずに返す(先頭の空白や NUL 区切りに意味がある出力用)。 */
function gitRaw(args: string[], cwd: string): string {
  const hardened = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
  return execFileSync("git", hardened, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function tryGit(args: string[], cwd = process.cwd()): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "task";
}

export function branchName(prefix: string, issue: number, title: string): string {
  return `${prefix}${issue}-${slugify(title)}`;
}

/** タイトルが後から変わってもブランチを見失わないよう、既存のリモートブランチを番号で探す。 */
export function resolveBranch(prefix: string, issue: number, title: string, cwd = process.cwd()): string {
  const out = tryGit(["branch", "-r", "--list", `origin/${prefix}${issue}-*`], cwd) ?? "";
  const existing = out
    .split("\n")
    .map((l) => l.trim().replace(/^origin\//, ""))
    .filter((b) => b && issueFromBranch(prefix, b) === issue);
  return existing[0] ?? branchName(prefix, issue, title);
}

export function issueFromBranch(prefix: string, branch: string): number | null {
  if (!branch.startsWith(prefix)) return null;
  const m = /^(\d+)(-|$)/.exec(branch.slice(prefix.length));
  return m ? Number(m[1]) : null;
}

/**
 * taskrail のローカル用ディレクトリ(.taskrail/)をコミット対象から外す。
 * 導入先のファイルを増やさないよう .gitignore は変更せず、コミットされない .git/info/exclude に書く。
 * git worktree でも正しい場所に書けるよう、パスは git に尋ねる。
 */
export function excludeTaskrailDir(): boolean {
  const rel = tryGit(["rev-parse", "--git-path", "info/exclude"]);
  if (!rel) return false;
  const file = resolve(rel);
  const line = ".taskrail/";
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").includes(line)) return true;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${current.endsWith("\n") || !current ? "" : "\n"}${line}\n`);
  return true;
}

/** 未コミットの変更(追跡外ファイルを含む)。git が失敗したら例外(検査を素通りさせない)。 */
export function dirtyFiles(cwd = process.cwd()): string[] {
  // -z: 各項目は "XY path" を NUL で区切る。名前の変更・コピーは直後に元のパスが続くので、それも含める。
  const parts = gitRaw(["status", "--porcelain", "-z", "--untracked-files=all"], cwd).split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") files.push(parts[++i] ?? "");
  }
  return files.filter(Boolean);
}

/**
 * base から HEAD までに変更されたファイル。git が失敗したら例外(検査を素通りさせない)。
 * --no-renames: 名前の変更を「削除 + 追加」として両方のパスを出す。保護対象を移動・改名して検査を逃れるのを防ぐ。
 */
export function changedFilesSince(base: string, cwd = process.cwd()): string[] {
  const out = git(["diff", "--no-ext-diff", "--name-only", "--no-renames", `${base}...HEAD`], cwd);
  return out.split("\n").filter((l) => l.trim());
}

/** base に含まれない HEAD のコミット数。git が失敗したら例外。 */
export function commitCountSince(base: string, cwd = process.cwd()): number {
  return Number(git(["rev-list", "--count", `${base}..HEAD`], cwd));
}

/**
 * リモートのブランチの先頭(プラットフォームの API で得た SHA)を取得し、その SHA を返す。
 * ローカルの origin/* はエージェントが書き換えられるため、比較の基準には使わない。
 */
export function fetchCommit(sha: string, cwd = process.cwd()): string {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`コミットの SHA が不正です: ${sha}`);
  git(["fetch", "--no-tags", "--quiet", "origin", sha], cwd);
  return sha;
}

/** 最小限の glob(`**`、`*`)。依存を増やさないための自前実装。 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else re += /[.+^${}()|[\]\\?]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

export function matchProtected(files: string[], globs: string[]): string[] {
  const res = globs.map(globToRegExp);
  return files.filter((f) => res.some((r) => r.test(f)));
}
