import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

/** パッケージのルート(flow/ と templates/ がある場所)。dist/core/ と src/core/ のどちらから読まれても解決できる。 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "flow", "flow.yml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("taskrail のパッケージルート(flow/flow.yml)が見つかりません");
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

const StatusTarget = z.string().min(1); // stage id または "stay"

export const StageSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    title: z.string(),
    agents: z.array(z.string()).default([]),
    mode: z.enum(["read", "write"]).default("read"),
    max_turns: z.number().int().positive().default(20),
    on_result: z
      .object({ pass: StatusTarget, fail: StatusTarget, blocked: StatusTarget })
      .default({ pass: "stay", fail: "stay", blocked: "stay" }),
    auto_approve: z.object({ sizes: z.array(z.enum(["s", "m", "l"])), to: z.string() }).optional(),
    counts_rework: z.boolean().default(false),
    human_next: z.array(z.string()).default([]),
    system_next: z.array(z.string()).default([]),
  })
  .strict();

export const FlowSchema = z
  .object({
    version: z.literal(1),
    label_prefix: z.string().min(1),
    blocked_label: z.string().min(1),
    stages: z.array(StageSchema).min(2),
  })
  .strict();

export type Stage = z.infer<typeof StageSchema>;
export type Flow = z.infer<typeof FlowSchema>;

export const ProjectSchema = z
  .object({
    /** 参照している taskrail のバージョン(タグ)。`taskrail update` が書き換える。 */
    taskrail_ref: z.string().default("v0"),
    platform: z.enum(["github", "gitlab"]).default("github"),
    /** In Progress 列に同時に置ける Issue 数。 */
    wip_limit: z.number().int().positive().default(2),
    /** Verify からの差し戻しの上限。超えたら blocked にして人間へ。 */
    max_rework: z.number().int().positive().default(3),
    /** taskrail が使う GitHub App / bot のログイン名(例: "taskrail-bot[bot]")。ラベル連鎖の送信者として許可する。 */
    bot_logins: z.array(z.string()).default([]),
    /** AIの変更を禁止するパス(glob)。変更が含まれていたら blocked にする。 */
    protected_paths: z
      .array(z.string())
      .default([".github/**", ".gitlab-ci.yml", "taskrail.yml", "CODEOWNERS", "**/migrations/**", "**/.env*"]),
    /** 作業ブランチの接頭辞。ブランチ名は `<prefix><issue番号>-<slug>`。 */
    branch_prefix: z.string().default("issue-"),
    /** エージェントが完了前に通すコマンド(lint・型チェック・テスト)。空ならリポジトリの文書から判断させる。 */
    check_commands: z.array(z.string()).default([]),
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;

function readYaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"));
}

export function loadFlow(path?: string): Flow {
  const file = path ? resolve(path) : join(packageRoot(), "flow", "flow.yml");
  const flow = FlowSchema.parse(readYaml(file));
  const problems = checkFlow(flow);
  if (problems.length) throw new Error(`flow.yml が不正です:\n- ${problems.join("\n- ")}`);
  return flow;
}

/**
 * プロジェクト設定を解決する。導入先のリポジトリにファイルを置かなくても動くよう、次の順に上書きする。
 *   既定値 < 環境変数 TASKRAIL_CONFIG(YAML。リポジトリ変数から渡す) < taskrail.yml
 * bot_logins が空なら、環境変数 TASKRAIL_BOT_LOGIN(ワークフローが App から決める)を使う。
 */
export function loadProject(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Project {
  const fromEnv = env.TASKRAIL_CONFIG?.trim() ? asObject(parse(env.TASKRAIL_CONFIG), "TASKRAIL_CONFIG") : {};
  const file = join(cwd, "taskrail.yml");
  const fromFile = existsSync(file) ? asObject(readYaml(file), "taskrail.yml") : {};
  const parsed = ProjectSchema.safeParse({ ...fromEnv, ...fromFile });
  if (!parsed.success) {
    const where = projectSource(cwd, env).join(" / ") || "設定";
    const issues = parsed.error.issues.map((i) => `- ${i.path.join(".") || "(ルート)"}: ${i.message}`);
    throw new Error(`${where} が不正です:\n${issues.join("\n")}`);
  }
  const project = parsed.data;
  const bot = env.TASKRAIL_BOT_LOGIN?.trim();
  if (!project.bot_logins.length && bot) {
    if (!BOT_LOGIN.test(bot)) throw new Error(`TASKRAIL_BOT_LOGIN が GitHub のログイン名として不正です: ${bot}`);
    project.bot_logins = [bot];
  }
  return project;
}

/** GitHub App のログイン名(例: my-taskrail[bot])。 */
const BOT_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/;

/** 設定の出どころ。doctor の表示用。 */
export function projectSource(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...(existsSync(join(cwd, "taskrail.yml")) ? ["taskrail.yml"] : []),
    ...(env.TASKRAIL_CONFIG?.trim() ? ["TASKRAIL_CONFIG"] : []),
  ];
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} は YAML のマッピングで書いてください`);
  return value as Record<string, unknown>;
}

/** スキーマでは表せない整合性の検査。 */
export function checkFlow(flow: Flow): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of flow.stages) {
    if (ids.has(s.id)) problems.push(`stage id が重複: ${s.id}`);
    ids.add(s.id);
  }
  const promptsDir = join(packageRoot(), "flow", "prompts");
  for (const s of flow.stages) {
    const targets = [
      ...Object.values(s.on_result),
      ...s.human_next,
      ...s.system_next,
      ...(s.auto_approve ? [s.auto_approve.to] : []),
    ];
    for (const t of targets) {
      if (t !== "stay" && !ids.has(t)) problems.push(`${s.id}: 存在しない遷移先 "${t}"`);
    }
    for (const a of s.agents) {
      if (!existsSync(join(promptsDir, `${a}.md`))) problems.push(`${s.id}: プロンプトがありません flow/prompts/${a}.md`);
    }
    if (s.mode === "write" && s.agents.length > 1) {
      problems.push(`${s.id}: write モードの stage に複数のエージェントは置けません`);
    }
  }
  return problems;
}
