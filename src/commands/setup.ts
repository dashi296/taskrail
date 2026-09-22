import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse } from "yaml";
import { createPlatform } from "../adapters/index.js";
import { checkFlow, loadFlow, loadProject, packageRoot, packageVersion, projectSource, ProjectSchema } from "../core/config.js";
import { flowLabel } from "../core/flow.js";
import { excludeTaskrailDir, globToRegExp, tryGit } from "../core/git.js";
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
  /** CI(GitHub Actions など)で自動実行するための入口を置く。置かなければローカル実行専用。 */
  ci?: boolean;
  /** docs/constitution.md(既定の原則 + 固有の原則を書く欄)を置く。 */
  docs?: boolean;
  issueTemplate?: boolean;
  /** taskrail.yml を置く(設定を PR レビューで管理したい場合)。 */
  config?: boolean;
}

/**
 * 導入先のリポジトリに taskrail を導入する。既定ではリポジトリに何も置かない(ローカル実行専用)。
 * CI で自動実行するときだけ --ci で入口のワークフローを置く。既存ファイルは上書きしない。
 */
export function init(opts: InitOptions): void {
  if (opts.platform !== "github" && opts.platform !== "gitlab") throw new Error("--platform は github か gitlab です");
  const cwd = process.cwd();
  const root = join(packageRoot(), "templates");
  const ci = opts.ci && opts.platform === "github" ? detectCiWorkflows(cwd) : [];
  const vars: Record<string, string> = {
    "{{TASKRAIL_OWNER}}": opts.owner,
    "{{TASKRAIL_REF}}": opts.ref,
    "{{PLATFORM}}": opts.platform,
    "{{CI_WORKFLOWS}}": JSON.stringify(ci.length ? ci : ["CI"]),
    "{{BRANCH_PREFIX}}": branchPrefixFor(cwd),
  };
  const files: { dest: string; text: () => string }[] = [];
  const fromTemplate = (rel: string) => ({
    dest: rel.slice(rel.indexOf("/") + 1),
    text: () => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(k, v), readFileSync(join(root, rel), "utf8")),
  });
  const set = TEMPLATES[opts.platform];
  // 別名の入口が既にあれば、二重に起動しないよう新しく置かない(--force でも同じ)。
  const otherEntries = opts.platform === "github" ? findEntryWorkflows(cwd).filter((f) => !set.core.some((c) => c.endsWith(f))) : [];
  if (opts.ci && otherEntries.length) {
    console.log(`  既存  ${otherEntries.join(", ")}(taskrail の入口です。二重に起動しないよう新しいワークフローは置きません)`);
  } else if (opts.ci) files.push(...set.core.map(fromTemplate));
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
  if (!files.length && !otherEntries.length) console.log("  リポジトリに置くファイルはありません(ローカル実行専用)");
  if (excludeTaskrailDir()) console.log("  除外  .taskrail/(.git/info/exclude に追記。.gitignore は変更しません)");
  if (opts.ci && opts.platform === "github" && !otherEntries.length) {
    for (const w of analyzeCiWorkflows(cwd, localDefaultBranch()).filter((x) => !x.runsOnPr || x.pathFiltered)) {
      const why = w.runsOnPr ? "paths で絞り込まれていて、変更したファイルによっては起動しないため" : w.reason;
      console.log(`  - ${w.name} は対象にしません(${why})`);
    }
    console.log(
      ci.length
        ? `\n  CI ワークフロー: ${ci.join(", ")}(成功したら In Progress → Verify に進めます)`
        : "\n  ! pull_request で起動する CI ワークフローが見つかりません。workflow_run.workflows を \"CI\" にしました。実在する CI の name に直してください",
    );
  }
  if (opts.labels) labelsSync({});
  console.log(
    opts.ci
      ? `\n次の手順(README の「導入」を参照):
  1. Secrets(ANTHROPIC_API_KEY または CLAUDE_CODE_OAUTH_TOKEN、TASKRAIL_APP_ID、TASKRAIL_APP_PRIVATE_KEY)を設定する
  2. 必要なら、リポジトリ変数 TASKRAIL_CONFIG に設定を書く(check_commands、protected_paths など)
  3. taskrail labels sync を実行する
  4. taskrail doctor で確認する`
      : `\n次の手順(README の「ローカルで1工程ずつ回す」を参照):
  1. taskrail labels sync を実行する
  2. Issue に flow::inbox を付け、scripts/local-run.sh <issue番号> で1工程ずつ実行する
  CI で自動実行するときは、taskrail init --ci でワークフローを追加します。`,
  );
}

/**
 * 既にある taskrail の入口ワークフロー(taskrail の再利用ワークフローを参照しているもの)。
 * ファイル名(taskrail.yml / taskrail.yaml / 別名)に依らず、中身で判定する。
 */
export function findEntryWorkflows(cwd: string): string[] {
  const dir = join(cwd, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((f) => /\.ya?ml$/.test(f) && new RegExp(REF_PATTERN.source).test(readFileSync(join(dir, f), "utf8")))
    .map((f) => `.github/workflows/${f}`);
}

/** CI ワークフローが、taskrail の作業ブランチの PR で起動するか。 */
export interface CiWorkflow {
  /** workflow_run で指定する名前。name がなければ GitHub はファイルのパスを名前にする。 */
  name: string;
  /** 既定ブランチ向けの PR の作成(opened)と更新(synchronize)の両方で起動する。 */
  runsOnPr: boolean;
  /** paths / paths-ignore で絞り込まれている(変更したファイルによっては起動しない)。 */
  pathFiltered: boolean;
  /** runsOnPr が false の理由。 */
  reason?: string;
}

/** 導入先の CI ワークフロー(taskrail の入口を除く)を解析する。base は既定ブランチ。 */
export function analyzeCiWorkflows(cwd: string, base: string): CiWorkflow[] {
  const dir = join(cwd, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const entries = new Set(findEntryWorkflows(cwd));
  const result: CiWorkflow[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(file) || entries.has(`.github/workflows/${file}`)) continue;
    let wf: { name?: unknown; on?: unknown } | null;
    try {
      wf = parse(readFileSync(join(dir, file), "utf8")) as typeof wf;
    } catch {
      continue;
    }
    const name = typeof wf?.name === "string" ? wf.name : `.github/workflows/${file}`;
    result.push({ name, ...pullRequestTrigger(wf?.on, base) });
  }
  return result;
}

/**
 * workflow_run の対象にする CI の名前。作業ブランチの PR で確実に動くものだけを選ぶ
 * (push は branches で既定ブランチに絞られていることが多く、作業ブランチでは動かないことがある)。
 */
export function detectCiWorkflows(cwd: string, base = localDefaultBranch()): string[] {
  return analyzeCiWorkflows(cwd, base)
    // paths で絞り込まれた CI は、変更したファイルによっては起動せず、すべての CI の成功を待つゲートが進まなくなる
    .filter((w) => w.runsOnPr && !w.pathFiltered)
    .map((w) => w.name);
}

function pullRequestTrigger(on: unknown, base: string): Omit<CiWorkflow, "name"> {
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : on && typeof on === "object" ? Object.keys(on) : [];
  if (!events.includes("pull_request")) return { runsOnPr: false, pathFiltered: false, reason: "pull_request で起動しません" };
  const cfg = on && typeof on === "object" && !Array.isArray(on) ? (on as Record<string, unknown>).pull_request : null;
  if (!cfg || typeof cfg !== "object") return { runsOnPr: true, pathFiltered: false };
  const c = cfg as Record<string, unknown>;
  const list = (v: unknown) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.map(String) : null);
  const pathFiltered = c.paths !== undefined || c["paths-ignore"] !== undefined;
  const types = list(c.types);
  if (types && !(types.includes("opened") && types.includes("synchronize"))) {
    return { runsOnPr: false, pathFiltered, reason: `types(${types.join(", ")})に opened と synchronize の両方が含まれていません` };
  }
  const matches = (globs: string[]) => globs.some((g) => globToRegExp(g).test(base));
  const negated = [...(list(c.branches) ?? []), ...(list(c["branches-ignore"]) ?? [])].filter((g) => g.startsWith("!"));
  if (negated.length) {
    // GitHub の否定パターンは順序に依存する。正しく解釈できないものは自動では選ばない。
    return { runsOnPr: false, pathFiltered, reason: `否定パターン(${negated.join(", ")})を含むため、起動するかを判定できません` };
  }
  const branches = list(c.branches);
  if (branches && !matches(branches)) return { runsOnPr: false, pathFiltered, reason: `branches(${branches.join(", ")})が ${base} を含みません` };
  const ignored = list(c["branches-ignore"]);
  if (ignored && matches(ignored)) return { runsOnPr: false, pathFiltered, reason: `branches-ignore が ${base} を除外しています` };
  return { runsOnPr: true, pathFiltered };
}

/** 既定ブランチの名前(ネットワークに問い合わせない)。origin/HEAD がなければ main とみなす。 */
function localDefaultBranch(): string {
  return tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "") ?? "main";
}

/** 呼び出し側ワークフローの workflow_run.workflows。 */
export function listedCiWorkflows(callerYaml: string): string[] {
  const wf = parse(callerYaml) as { on?: { workflow_run?: { workflows?: unknown } } } | null;
  const listed = wf?.on?.workflow_run?.workflows;
  return Array.isArray(listed) ? listed.map(String) : [];
}

/** 呼び出し側ワークフローの workflow_run.workflows のうち、実在しない CI の名前。これが残ると doing → verify が動かない。 */
export function missingCiWorkflows(callerYaml: string, existing: string[]): string[] {
  const listed = listedCiWorkflows(callerYaml);
  if (!listed.length) return ["(workflow_run.workflows がありません)"];
  return listed.filter((n) => !existing.includes(n));
}

/** 呼び出し側ワークフローに埋め込む作業ブランチの接頭辞。設定(taskrail.yml / TASKRAIL_CONFIG)があればそれに合わせる。 */
function branchPrefixFor(cwd: string): string {
  try {
    return loadProject(cwd).branch_prefix;
  } catch {
    return ProjectSchema.parse({}).branch_prefix;
  }
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
    project.bot_logins.length
      ? `bot_logins(${project.bot_logins.join(", ")})`
      : "bot_logins(Actions では App から自動で決まります。ローカル実行では gh のログインユーザーの記録だけを信頼します)",
    true,
  );

  const entries = project.platform === "github" ? findEntryWorkflows(cwd) : [];
  const wf = entries[0] ?? (project.platform === "github" ? ".github/workflows/taskrail.yml" : ".gitlab/ci/taskrail.gitlab-ci.yml");
  // ワークフローがなければローカル実行専用。CI 用の検査(Secrets、キルスイッチ、参照バージョン、CI 名)は行わない。
  const ci = existsSync(join(cwd, wf));
  if (entries.length > 1) add("taskrail の入口ワークフロー", false, `複数あります(${entries.join(", ")})。二重に起動するので1つにしてください`);
  add(ci ? `CI での自動実行(${wf})` : "CI での自動実行: なし(ローカル実行専用。使うときは taskrail init --ci)", true);
  const docs = ["CLAUDE.md", "AGENTS.md", "docs/constitution.md"].filter((f) => existsSync(join(cwd, f)));
  add(`ルール文書(${docs.length ? docs.join(", ") : "なし"})`, true);
  if (!docs.includes("docs/constitution.md")) add("原則(docs/constitution.md がないため、taskrail 同梱の既定を使います)", true);
  if (ci && project.platform === "github") {
    const text = readFileSync(join(cwd, wf), "utf8");
    const refs = [...text.matchAll(REF_PATTERN)].map((m) => m[2]);
    add(`参照バージョンの固定(${refs[0] ?? "?"})`, refs.length > 0 && !refs.includes("main") ? true : "warn", "main ではなくタグ(v1 など)を参照してください");
    const prefixes = [...text.matchAll(/startsWith\([^,]+,\s*'([^']*)'\)/g)].map((m) => m[1]);
    add(
      `作業ブランチの接頭辞(${project.branch_prefix})`,
      prefixes.every((p) => p === project.branch_prefix),
      `${wf} の startsWith(..., '${prefixes.find((p) => p !== project.branch_prefix)}') を、設定の branch_prefix に合わせてください`,
    );
    const workflows = analyzeCiWorkflows(cwd, localDefaultBranch());
    const missing = missingCiWorkflows(text, workflows.map((w) => w.name));
    add(
      "CI ワークフローの参照(workflow_run)",
      missing.length === 0,
      `見つからない CI: ${missing.join(", ")}。${wf} の workflow_run.workflows を、実在する CI の name に直してください`,
    );
    const listed = listedCiWorkflows(text);
    for (const w of workflows.filter((x) => listed.includes(x.name))) {
      if (!w.runsOnPr) add(`CI「${w.name}」`, "warn", `作業ブランチの PR で起動しない可能性があります(${w.reason})。起動しないと Verify に進みません`);
      else if (w.pathFiltered) add(`CI「${w.name}」`, "warn", "paths で絞り込まれています。変更したファイルによっては起動せず、Verify に進みません");
    }
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
      if (ci) {
        // Organization の Secrets のうち、このリポジトリから使えるもの。個人リポジトリでは取得できない(422)ので空とみなす。
        const orgSecrets = lines(trySh("gh", ["api", api("actions/organization-secrets"), "--jq", ".secrets[].name"]));
        const secrets = new Set([...names("secret"), ...orgSecrets]);
        add(
          "Secret ANTHROPIC_API_KEY または CLAUDE_CODE_OAUTH_TOKEN",
          secrets.has("ANTHROPIC_API_KEY") || secrets.has("CLAUDE_CODE_OAUTH_TOKEN"),
          "エージェントの認証をどちらかで設定してください(API キー、または claude setup-token で発行する OAuth トークン)",
        );
        for (const s of ["TASKRAIL_APP_ID", "TASKRAIL_APP_PRIVATE_KEY"]) {
          add(`Secret ${s}`, secrets.has(s), "リポジトリまたは Organization の Secrets に設定してください");
        }
        const enabled = names("variable").has("TASKRAIL_ENABLED");
        add("変数 TASKRAIL_ENABLED(キルスイッチ)", enabled ? true : "warn", '未設定は有効扱いです。止めるときは "false" を設定します');
      }
      const base = platform.defaultBranch();
      const classic = shResult("gh", ["api", api(`branches/${base}/protection`)]);
      const rules = shResult("gh", ["api", api(`rules/branches/${base}`)]);
      const prot = branchProtection(
        protectionFacts(classic, rules, (id) => trySh("gh", ["api", api(`rulesets/${id}`)])),
        project.bot_logins,
      );
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

/** ブランチ保護の設定のうち、判定に使うもの(GitHub の API 応答から取り出す)。 */
export interface ProtectionFacts {
  /** classic な branch protection。なければ null。 */
  classic: { approvals: number; bypassApps: string[] } | null;
  /** 既定ブランチに適用される ruleset のルール。 */
  rules: { type: string; approvals: number }[];
  /** ruleset のバイパス対象のうち、GitHub App(Integration)の ID。 */
  rulesetBypassApps: number[];
  /** バイパス設定を確認できなかった ruleset の ID(権限不足では bypass_actors が返らない)。 */
  rulesetBypassUnknown: number[];
  /** プランの制約でブランチ保護を使えない。 */
  unavailable: boolean;
}

/**
 * 既定ブランチが「レビュー必須・直接 push 禁止」で保護されているかの判定(docs/security.md)。
 * PR を必須にし、承認が1件以上必要なことを求める。App がバイパスできる設定は、taskrail の App かどうかを
 * 判別できないため注意として示す(taskrail の App が入っていれば、AI のトークンでレビューを迂回できる)。
 */
export function branchProtection(p: ProtectionFacts, botLogins: string[] = []): { ok: boolean | "warn"; hint: string } {
  const reviewed = (p.classic !== null && p.classic.approvals >= 1) || p.rules.some((r) => r.type === "pull_request" && r.approvals >= 1);
  if (!reviewed) {
    if (p.unavailable) {
      return { ok: false, hint: "このリポジトリのプランではブランチ保護を使えません。public にするか、GitHub Pro / Team 以上が必要です" };
    }
    const partial = p.classic !== null || p.rules.some((r) => r.type === "pull_request");
    return {
      ok: false,
      hint: partial
        ? "保護はありますが、PR のレビュー(承認1件以上)が必須になっていません。レビューを必須にしてください"
        : "AIのトークンで直接 push・マージできないよう、PR とレビュー(承認1件以上)を必須にする保護(branch protection または ruleset)を設定してください",
    };
  }
  const slugs = botLogins.map((b) => b.replace(/\[bot\]$/, ""));
  const bypassing = p.classic?.bypassApps ?? [];
  if (bypassing.some((a) => slugs.includes(a))) {
    return { ok: false, hint: `taskrail の App(${bypassing.filter((a) => slugs.includes(a)).join(", ")})がレビューをバイパスできます。バイパスの対象から外してください` };
  }
  if (p.rulesetBypassUnknown.length) {
    return {
      ok: "warn",
      hint: `ruleset(ID ${p.rulesetBypassUnknown.join(", ")})のバイパス設定を確認できません。ruleset の管理権限を持つ人が doctor を実行するか、taskrail の App がバイパス対象に含まれていないことを確認してください`,
    };
  }
  if (bypassing.length || p.rulesetBypassApps.length) {
    const who = [...bypassing, ...p.rulesetBypassApps.map((id) => `App ID ${id}`)].join(", ");
    return { ok: "warn", hint: `レビューをバイパスできる App があります(${who})。taskrail の App が含まれていないか確認してください` };
  }
  return { ok: true, hint: "" };
}

/** GitHub の API 応答から、判定に使う事実を取り出す。 */
export function protectionFacts(
  classic: { ok: boolean; out: string; err: string },
  rules: { ok: boolean; out: string; err: string },
  getRuleset: (id: number) => string | null,
): ProtectionFacts {
  const json = <T>(text: string, fallback: T): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  };
  type Classic = {
    required_pull_request_reviews?: {
      required_approving_review_count?: number;
      bypass_pull_request_allowances?: { apps?: { slug: string }[] };
    };
  };
  const c = classic.ok ? json<Classic>(classic.out, {}) : null;
  const ruleList = rules.ok
    ? json<{ type: string; ruleset_id?: number; parameters?: { required_approving_review_count?: number } }[]>(rules.out, [])
    : [];
  const rulesetIds = [...new Set(ruleList.map((r) => r.ruleset_id).filter((id): id is number => typeof id === "number"))];
  const unknown: number[] = [];
  const bypass = rulesetIds.flatMap((id) => {
    const r = json<{ bypass_actors?: { actor_id: number | null; actor_type: string }[] }>(getRuleset(id) ?? "", {});
    if (!Array.isArray(r.bypass_actors)) {
      unknown.push(id);
      return [];
    }
    return r.bypass_actors.filter((a) => a.actor_type === "Integration" && a.actor_id !== null).map((a) => a.actor_id as number);
  });
  return {
    classic: c
      ? {
          approvals: c.required_pull_request_reviews ? (c.required_pull_request_reviews.required_approving_review_count ?? 0) : -1,
          bypassApps: (c.required_pull_request_reviews?.bypass_pull_request_allowances?.apps ?? []).map((a) => a.slug),
        }
      : null,
    rules: ruleList.map((r) => ({ type: r.type, approvals: r.parameters?.required_approving_review_count ?? 0 })),
    rulesetBypassApps: [...new Set(bypass)],
    rulesetBypassUnknown: unknown,
    unavailable: [classic.err, rules.err].some((e) => /Upgrade to GitHub Pro|make this repository public/i.test(e)),
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
