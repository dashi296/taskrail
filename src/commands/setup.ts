import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse } from "yaml";
import { createPlatform } from "../adapters/index.js";
import { checkFlow, loadFlow, loadProject, packageRoot, packageVersion, ProjectSchema } from "../core/config.js";
import { flowLabel } from "../core/flow.js";
import { tryGit } from "../core/git.js";
import { readResult } from "../core/result.js";

const REF_PATTERN = /(\/taskrail\/\.github\/workflows\/[a-z-]+\.yml@)([\w.-]+)/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** 導入先のリポジトリに、薄いワークフローと雛形を配置する。既存ファイルは上書きしない。 */
export function init(opts: { platform: string; owner: string; ref: string; force?: boolean; labels?: boolean }): void {
  if (opts.platform !== "github" && opts.platform !== "gitlab") throw new Error("--platform は github か gitlab です");
  const root = join(packageRoot(), "templates");
  const vars: Record<string, string> = {
    "{{TASKRAIL_OWNER}}": opts.owner,
    "{{TASKRAIL_REF}}": opts.ref,
    "{{PLATFORM}}": opts.platform,
  };
  const written: string[] = [];
  const skipped: string[] = [];
  for (const src of [...walk(join(root, "common")), ...walk(join(root, opts.platform))]) {
    const rel = relative(src.startsWith(join(root, "common")) ? join(root, "common") : join(root, opts.platform), src);
    const dest = join(process.cwd(), rel);
    if (existsSync(dest) && !opts.force) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    let text = readFileSync(src, "utf8");
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(k, v);
    writeFileSync(dest, text);
    written.push(rel);
  }
  for (const f of written) console.log(`  作成  ${f}`);
  for (const f of skipped) console.log(`  既存  ${f}(上書きしません。--force で上書き)`);
  if (opts.labels) labelsSync({});
  console.log(`\n次の手順:
  1. taskrail.yml の bot_logins に、GitHub App のログイン名を設定する
  2. docs/constitution.md をこのリポジトリ向けに書き換える
  3. Secrets と変数を設定する(README の「導入」を参照)
  4. taskrail labels sync を実行する
  5. taskrail doctor で確認する`);
}

/** 参照している taskrail のバージョン(タグ)を書き換える。プロジェクト固有のファイルには触れない。 */
export function update(opts: { ref: string; dryRun?: boolean }): void {
  const targets = [".github/workflows", ".gitlab-ci.yml", ".gitlab/ci"].map((p) => join(process.cwd(), p)).filter(existsSync);
  const files = targets.flatMap((t) => (statSync(t).isDirectory() ? walk(t) : [t])).filter((f) => /\.ya?ml$/.test(f));
  let changed = 0;
  for (const f of files) {
    const before = readFileSync(f, "utf8");
    const after = before.replace(REF_PATTERN, `$1${opts.ref}`).replace(/(taskrail_ref:\s*)["']?[\w.-]+["']?/g, `$1"${opts.ref}"`);
    if (after === before) continue;
    changed++;
    console.log(`  更新  ${relative(process.cwd(), f)}`);
    if (!opts.dryRun) writeFileSync(f, after);
  }
  const cfg = join(process.cwd(), "taskrail.yml");
  if (existsSync(cfg)) {
    const before = readFileSync(cfg, "utf8");
    const after = before.replace(/^(taskrail_ref:\s*).*$/m, `$1"${opts.ref}"`);
    if (after !== before) {
      changed++;
      console.log("  更新  taskrail.yml");
      if (!opts.dryRun) writeFileSync(cfg, after);
    }
  }
  console.log(changed ? `\n${changed} ファイルを ${opts.ref} に更新しました。差分を確認し、PR/MR として取り込んでください。` : "更新するファイルはありません。");
}

export function labelsSync(opts: { flow?: string; repo?: string; dryRun?: boolean }): void {
  const flow = loadFlow(opts.flow);
  const project = loadProject();
  const def = parse(readFileSync(join(packageRoot(), "flow", "labels.yml"), "utf8")) as {
    labels: Array<{ name: string; color: string; description: string }>;
    flow_label_color: string;
  };
  const all = [
    ...flow.stages.map((s) => ({ name: flowLabel(flow, s.id), color: def.flow_label_color, description: `taskrail: ${s.title}` })),
    ...def.labels,
  ];
  const unique = [...new Map(all.map((l) => [l.name, l])).values()];
  const platform = opts.dryRun ? null : createPlatform(project, opts.repo);
  for (const l of unique) {
    console.log(`  ${opts.dryRun ? "予定" : "同期"}  ${l.name}`);
    platform?.upsertLabel(l.name, l.color, l.description);
  }
}

interface Check {
  name: string;
  ok: boolean | "warn";
  hint?: string;
}

/** 導入状態の診断。導入が難航する原因の大半は、ファイルの配置ではなく権限と設定の不備。 */
export function doctor(opts: { flow?: string; repo?: string; offline?: boolean }): void {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean | "warn", hint?: string) => checks.push({ name, ok, hint });
  const cwd = process.cwd();

  let flow;
  try {
    flow = loadFlow(opts.flow);
    add(`フロー定義(${flow.stages.length} stages)`, true);
  } catch (e) {
    add("フロー定義", false, (e as Error).message);
  }

  const cfgPath = join(cwd, "taskrail.yml");
  let project = ProjectSchema.parse({});
  if (!existsSync(cfgPath)) add("taskrail.yml", false, "taskrail init を実行してください");
  else {
    try {
      project = loadProject(cwd);
      add("taskrail.yml", true);
      add("bot_logins の設定", project.bot_logins.length ? true : "warn", "未設定だと、Issueコメント内のマーカーを誰でも偽装できます。GitHub App のログイン名を設定してください");
    } catch (e) {
      add("taskrail.yml", false, (e as Error).message);
    }
  }

  const wf = project.platform === "github" ? ".github/workflows/taskrail.yml" : ".gitlab-ci.yml";
  add(`ワークフロー(${wf})`, existsSync(join(cwd, wf)), "taskrail init を実行してください");
  for (const f of ["CLAUDE.md", "docs/constitution.md"]) add(f, existsSync(join(cwd, f)) ? true : "warn", "エージェントが従うルール文書です");
  if (existsSync(join(cwd, wf)) && project.platform === "github") {
    const text = readFileSync(join(cwd, wf), "utf8");
    const refs = [...text.matchAll(REF_PATTERN)].map((m) => m[2]);
    add(`参照バージョンの固定(${refs[0] ?? "?"})`, refs.length > 0 && !refs.includes("main") ? true : "warn", "main ではなくタグ(v1 など)を参照してください");
  }
  add("git リポジトリ", tryGit(["rev-parse", "--git-dir"]) !== null);

  if (!opts.offline && project.platform === "github" && flow) {
    try {
      const platform = createPlatform(project, opts.repo);
      const labels = new Set(platform.listLabels());
      const missing = [...flow.stages.map((s) => flowLabel(flow, s.id)), flow.blocked_label, "ai::ok", "ai::no"].filter((l) => !labels.has(l));
      add("ラベル", missing.length === 0, `不足: ${missing.join(", ")} → taskrail labels sync`);
      const repoArgs = opts.repo ? ["-R", opts.repo] : [];
      const api = (path: string) => `repos/${opts.repo ?? "{owner}/{repo}"}/${path}`;
      const lines = (out: string | null) => (out ?? "").split("\n").filter(Boolean);
      const names = (kind: string) => new Set(lines(sh("gh", [kind, "list", ...repoArgs, "--json", "name", "--jq", ".[].name"])));
      // Organization の Secrets のうち、このリポジトリから使えるもの。個人リポジトリでは取得できない(422)ので空とみなす。
      const orgSecrets = lines(trySh("gh", ["api", api("actions/organization-secrets"), "--jq", ".secrets[].name"]));
      const secrets = new Set([...names("secret"), ...orgSecrets]);
      for (const s of ["ANTHROPIC_API_KEY", "TASKRAIL_APP_ID", "TASKRAIL_APP_PRIVATE_KEY"]) {
        add(`Secret ${s}`, secrets.has(s), "リポジトリまたは Organization の Secrets に設定してください");
      }
      const enabled = names("variable").has("TASKRAIL_ENABLED");
      add("変数 TASKRAIL_ENABLED(キルスイッチ)", enabled ? true : "warn", '未設定は有効扱いです。止めるときは "false" を設定します');
      const base = platform.defaultBranch();
      const classic = shResult("gh", ["api", api(`branches/${base}/protection`), "--jq", ".url"]);
      const rules = shResult("gh", ["api", api(`rules/branches/${base}`), "--jq", ".[].type"]);
      const prot = branchProtection({
        classic: classic.ok,
        ruleTypes: lines(rules.out),
        unavailable: [classic.err, rules.err].some((e) => /Upgrade to GitHub Pro|make this repository public/i.test(e)),
      });
      add(`ブランチ保護(${base})`, prot.ok, prot.hint);
    } catch (e) {
      add("GitHub への接続", false, (e as Error).message);
    }
  }

  const icon = (ok: Check["ok"]) => (ok === true ? "✔" : ok === "warn" ? "!" : "✘");
  for (const c of checks) console.log(`  ${icon(c.ok)} ${c.name}${c.ok === true || !c.hint ? "" : `\n      → ${c.hint}`}`);
  const failed = checks.filter((c) => c.ok === false).length;
  const warned = checks.filter((c) => c.ok === "warn").length;
  console.log(`\ntaskrail ${packageVersion()}: ${failed} 件の問題、${warned} 件の注意`);
  if (failed) process.exitCode = 1;
}

export function validate(opts: { flow?: string | boolean; result?: string; agent?: string }): void {
  if (opts.result) {
    const agent = opts.agent ?? (JSON.parse(readFileSync(opts.result, "utf8")) as { agent?: string }).agent ?? "";
    const r = readResult(opts.result, agent);
    if (!r.ok) {
      console.error(`✘ ${r.error}`);
      process.exitCode = 1;
    } else console.log(`✔ 結果ファイルは有効です(${r.result.agent}: ${r.result.status})`);
    return;
  }
  const flow = loadFlow(typeof opts.flow === "string" ? opts.flow : undefined);
  const problems = checkFlow(flow);
  if (problems.length) {
    for (const p of problems) console.error(`✘ ${p}`);
    process.exitCode = 1;
  } else console.log(`✔ フロー定義は有効です(${flow.stages.map((s) => s.id).join(" → ")})`);
}

/**
 * 既定ブランチが保護されているかの判定。classic な branch protection か、PR を必須にする ruleset のどちらかがあれば保護あり。
 * プランの制約で使えない場合も、保護がないことに変わりはないので不合格のまま、ヒントだけ変える。
 */
export function branchProtection(p: { classic: boolean; ruleTypes: string[]; unavailable: boolean }): { ok: boolean; hint: string } {
  if (p.classic || p.ruleTypes.includes("pull_request")) return { ok: true, hint: "" };
  if (p.unavailable) {
    return {
      ok: false,
      hint: "このリポジトリのプランではブランチ保護を使えません。public にするか、GitHub Pro / Team 以上が必要です",
    };
  }
  return {
    ok: false,
    hint: "AIのトークンで直接 push・マージできないよう、保護(branch protection、または PR を必須にする ruleset)を設定してください",
  };
}

function shResult(cmd: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    return { ok: true, out: sh(cmd, args), err: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: String(err.stdout ?? ""), err: String(err.stderr ?? "") };
  }
}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function trySh(cmd: string, args: string[]): string | null {
  try {
    return sh(cmd, args);
  } catch {
    return null;
  }
}
