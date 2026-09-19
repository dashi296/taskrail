import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

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
  return execFileSync("git", hardened, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
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

/**
 * base から HEAD までの変更のうち、保護対象に触れるもの。git が失敗したら例外。
 * ファイル名の照合だけでは、シンボリックリンクで保護対象を差し替えられるため、リンクも見る。
 * - シンボリックリンクの追加・変更・削除は、それ自体を保護対象への変更とみなす。
 * - 既存のリンクのリンク先が変更されたら、リンクの名前でも照合する(CLAUDE.md -> docs/rules.md など)。
 * - ディレクトリそのもの(`.claude`)も、`.claude/**` に一致するとみなす。
 */
export function protectedChanges(base: string, globs: string[], cwd = process.cwd()): string[] {
  const isProtected = (p: string) => matchProtected([p, `${p}/_`], globs).length > 0;
  const hits = new Set<string>();
  const changed: string[] = [];
  // --raw -z: ":旧モード 新モード 旧SHA 新SHA 状態" と パス が NUL で交互に並ぶ(--no-renames なのでパスは1つ)。
  const raw = gitRaw(["diff", "--no-ext-diff", "--raw", "-z", "--no-renames", "--no-abbrev", `${base}...HEAD`], cwd).split("\0");
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const meta = raw[i]!;
    const path = raw[i + 1]!;
    if (!meta.startsWith(":")) break;
    const [oldMode, newMode] = meta.slice(1).split(" ");
    changed.push(path);
    if (oldMode === SYMLINK || newMode === SYMLINK) hits.add(`${path}(シンボリックリンク)`);
    else if (isProtected(path)) hits.add(path);
  }
  for (const link of symlinks("HEAD", cwd)) {
    for (const f of changed) {
      if (f !== link.target && !f.startsWith(`${link.target}/`)) continue;
      const alias = link.path + f.slice(link.target.length);
      if (isProtected(alias)) hits.add(`${f}(${alias} のリンク先)`);
    }
  }
  return [...hits];
}

const SYMLINK = "120000";

/** rev に含まれるシンボリックリンクと、リポジトリ内でのリンク先。リポジトリの外を指すものは除く。 */
function symlinks(rev: string, cwd: string): { path: string; target: string }[] {
  const links: { path: string; target: string }[] = [];
  for (const entry of gitRaw(["ls-tree", "-r", "-z", "--full-tree", rev], cwd).split("\0")) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (!m || m[1] !== SYMLINK) continue;
    const target = posix.normalize(posix.join(posix.dirname(m[3]!), gitRaw(["cat-file", "blob", m[2]!], cwd)));
    if (!posix.isAbsolute(target) && !target.startsWith("../") && target !== "..") links.push({ path: m[3]!, target: target.replace(/\/$/, "") });
  }
  return links;
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
  git(["fetch", "--no-tags", "--quiet", remote(), sha], cwd);
  return sha;
}

/** ブランチをリモートへ push する。 */
export function pushBranch(branch: string, cwd = process.cwd()): void {
  git(["push", remote(), `HEAD:refs/heads/${branch}`], cwd);
}

/**
 * apply が push / fetch に使うリモート。CI では TASKRAIL_GIT_REMOTE に URL を与える。
 * claude-code-action は origin の URL をエージェント用の(読み取り専用の)トークン入りに書き換えるため、
 * origin のままだと認証がそちらに負け、push が拒否される。URL を直接渡せば、認証は credential.helper から得る。
 */
export function remote(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TASKRAIL_GIT_REMOTE?.trim();
  if (!url) return "origin";
  if (!/^https:\/\/[^\s@/]+\/[^\s@]+$/.test(url)) throw new Error(`TASKRAIL_GIT_REMOTE が不正です(認証情報を含まない https の URL を指定してください): ${url}`);
  return url;
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
