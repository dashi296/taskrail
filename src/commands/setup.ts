import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse } from "yaml";
import { createPlatform } from "../adapters/index.js";
import { checkFlow, loadFlow, loadProject, packageRoot, packageVersion, projectSource, ProjectSchema } from "../core/config.js";
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

/** init が置くファイル(templates/ からの相対パス)。既定ではワークフローだけを置き、導入先を汚さない。 */
const TEMPLATES = {
  github: { core: ["github/.github/workflows/taskrail.yml"], issueTemplate: ["github/.github/ISSUE_TEMPLATE/task.yml"] },
  gitlab: { core: ["gitlab/.gitlab/ci/taskrail.gitlab-ci.yml"], issueTemplate: ["gitlab/.gitlab/issue_templates/task.md"] },
} as const;

export interface InitOptions {
  platform: string;
  owner: string;
  ref: string;
  force?: boolean;
  labels?: boolean;
  /** docs/constitution.md(既定の原則 + 固有の原則を書く欄)を置く。 */
  docs?: boolean;
  issueTemplate?: boolean;
  /** taskrail.yml を置く(設定を PR レビューで管理したい場合)。 */
  config?: boolean;
}

/** 導入先のリポジトリに taskrail の入口を置く。既定ではワークフロー1つだけ。既存ファイルは上書きしない。 */
export function init(opts: InitOptions): void {
  if (opts.platform !== "github" && opts.platform !== "gitlab") throw new Error("--platform は github か gitlab です");
  const cwd = process.cwd();
  const root = join(packageRoot(), "templates");
  const ci = opts.platform === "github" ? detectCiWorkflows(cwd) : [];
  const vars: Record<string, string> = {
    "{{TASKRAIL_OWNER}}": opts.owner,
    "{{TASKRAIL_REF}}": opts.ref,
    "{{PLATFORM}}": opts.platform,
    "{{CI_WORKFLOWS}}": JSON.stringify(ci.length ? ci : ["CI"]),
    "{{BRANCH_PREFIX}}": ProjectSchema.parse({}).branch_prefix,
  };
  const files: { dest: string; text: () => string }[] = [];
  const fromTemplate = (rel: string) => ({
    dest: rel.slice(rel.indexOf("/") + 1),
    text: () => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(k, v), readFileSync(join(root, rel), "utf8")),
  });
  const set = TEMPLATES[opts.platform];
  files.push(...set.core.map(fromTemplate));
  if (opts.issueTemplate) files.push(...set.issueTemplate.map(fromTemplate));
  if (opts.config) files.push(fromTemplate("common/taskrail.yml"));
  if (opts.docs) files.push({ dest: "docs/constitution.md", text: constitutionForProject });

  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const dest = join(cwd, f.dest);
    if (existsSync(dest) && !opts.force) {
      skipped.push(f.dest);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.text());
    written.push(f.dest);
  }
  for (const f of written) console.log(`  作成  ${f}`);
  for (const f of skipped) console.log(`  既存  ${f}(上書きしません。--force で上書き)`);
  if (opts.platform === "github") {
    console.log(
      ci.length
        ? `\n  CI ワークフロー: ${ci.join(", ")}(成功したら In Progress → Verify に進めます)`
        : "\n  ! CI ワークフローが見つかりません。workflow_run.workflows を \"CI\" にしました。実在する CI の name に直してください",
    );
  }
  if (opts.labels) labelsSync({});
  console.log(`\n次の手順(README の「導入」を参照):
  1. Secrets(ANTHROPIC_API_KEY、TASKRAIL_APP_ID、TASKRAIL_APP_PRIVATE_KEY)を設定する
  2. 必要なら、リポジトリ変数 TASKRAIL_CONFIG に設定を書く(check_commands、protected_paths など)
  3. taskrail labels sync を実行する
  4. taskrail doctor で確認する`);
}

/**
 * 導入先の CI ワークフローの名前。workflow_run の対象になる(pull_request か push で起動するもの)。
 * workflow_run はワークフローの name で指定する。name がなければ GitHub はファイルのパスを名前にする。
 */
export function detectCiWorkflows(cwd: string): string[] {
  const dir = join(cwd, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(file) || file === "taskrail.yml") continue;
    let wf: { name?: unknown; on?: unknown } | null;
    try {
      wf = parse(readFileSync(join(dir, file), "utf8")) as typeof wf;
    } catch {
      continue;
    }
    const on = wf?.on;
    const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : on && typeof on === "object" ? Object.keys(on) : [];
    if (!events.some((e) => e === "pull_request" || e === "push")) continue;
    names.push(typeof wf?.name === "string" ? wf.name : `.github/workflows/${file}`);
  }
  return names;
}

/** 呼び出し側ワークフローの workflow_run.workflows のうち、実在しない CI の名前。これが残ると doing → verify が動かない。 */
export function missingCiWorkflows(callerYaml: string, existing: string[]): string[] {
  const wf = parse(callerYaml) as { on?: { workflow_run?: { workflows?: unknown } } } | null;
  const listed = wf?.on?.workflow_run?.workflows;
  if (!Array.isArray(listed)) return ["(workflow_run.workflows がありません)"];
  return listed.map(String).filter((n) => !existing.includes(n));
}

/** --docs で置く docs/constitution.md。同梱の既定の原則に、固有の原則を書く欄を足す。 */
function constitutionForProject(): string {
  const base = readFileSync(join(packageRoot(), "flow", "constitution.md"), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return `${base.replace(/^(# .*)\n/, "$1\n\n> taskrail のエージェントが従う原則です。このファイルがあると、taskrail 同梱の既定の原則の代わりに使われます。\n> 短く保ってください。1ページを超えたら、機械的に強制できるものを linter やテストへ移します。\n")}

## このプロジェクト固有の原則

<!-- 例: 「金額は必ず整数(円)で扱う」「画面の文言は i18n ファイルにのみ書く」「公開APIの互換性は壊さない」 -->
`;
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

  // 設定は Actions と同じ解決順で検査する。リポジトリ変数 TASKRAIL_CONFIG は、環境変数になければ取得する。
  const env = { ...process.env };
  if (!env.TASKRAIL_CONFIG && !opts.offline) {
    env.TASKRAIL_CONFIG = trySh("gh", ["variable", "get", "TASKRAIL_CONFIG", ...(opts.repo ? ["-R", opts.repo] : [])]) ?? "";
  }
  let project = ProjectSchema.parse({});
  try {
    project = loadProject(cwd, env);
    const sources = projectSource(cwd, env);
    add(`設定(${sources.length ? sources.join(" > ") : "既定値"})`, true);
  } catch (e) {
    add("設定", false, (e as Error).message);
  }
  add(
    project.bot_logins.length ? `bot_logins(${project.bot_logins.join(", ")})` : "bot_logins(Actions では App から自動で決まります)",
    true,
  );

  const wf = project.platform === "github" ? ".github/workflows/taskrail.yml" : ".gitlab-ci.yml";
  add(`ワークフロー(${wf})`, existsSync(join(cwd, wf)), "taskrail init を実行してください");
  const docs = ["CLAUDE.md", "AGENTS.md", "docs/constitution.md"].filter((f) => existsSync(join(cwd, f)));
  add(`ルール文書(${docs.length ? docs.join(", ") : "なし"})`, true);
  if (!docs.includes("docs/constitution.md")) add("原則(docs/constitution.md がないため、taskrail 同梱の既定を使います)", true);
  if (existsSync(join(cwd, wf)) && project.platform === "github") {
    const text = readFileSync(join(cwd, wf), "utf8");
    const refs = [...text.matchAll(REF_PATTERN)].map((m) => m[2]);
    add(`参照バージョンの固定(${refs[0] ?? "?"})`, refs.length > 0 && !refs.includes("main") ? true : "warn", "main ではなくタグ(v1 など)を参照してください");
    const prefixes = [...text.matchAll(/startsWith\([^,]+,\s*'([^']*)'\)/g)].map((m) => m[1]);
    add(
      `作業ブランチの接頭辞(${project.branch_prefix})`,
      prefixes.every((p) => p === project.branch_prefix),
      `${wf} の startsWith(..., '${prefixes.find((p) => p !== project.branch_prefix)}') を、設定の branch_prefix に合わせてください`,
    );
    const missing = missingCiWorkflows(text, detectCiWorkflows(cwd));
    add(
      "CI ワークフローの参照(workflow_run)",
      missing.length === 0,
      `見つからない CI: ${missing.join(", ")}。${wf} の workflow_run.workflows を、実在する CI の name に直してください`,
    );
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
