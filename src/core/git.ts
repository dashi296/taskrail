import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function git(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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

/** 未コミットの変更(追跡外ファイルを含む)。 */
export function dirtyFiles(cwd = process.cwd()): string[] {
  const out = tryGit(["status", "--porcelain"], cwd) ?? "";
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim());
}

export function changedFilesSince(base: string, cwd = process.cwd()): string[] {
  const out = tryGit(["diff", "--name-only", `${base}...HEAD`], cwd) ?? "";
  return out.split("\n").filter((l) => l.trim());
}

export function commitCountSince(base: string, cwd = process.cwd()): number {
  return Number(tryGit(["rev-list", "--count", `${base}..HEAD`], cwd) ?? "0");
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
