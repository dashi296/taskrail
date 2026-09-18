import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/** flow/schemas/result.schema.json と同期させること。 */
export const ResultSchema = z
  .object({
    agent: z.string().min(1),
    status: z.enum(["pass", "fail", "blocked"]),
    summary: z.string().min(1).max(2000),
    artifact: z.string().optional(),
    questions: z.array(z.string()).optional(),
    labels: z
      .object({ size: z.enum(["s", "m", "l"]).optional(), ai: z.enum(["ok", "no"]).optional() })
      .strict()
      .optional(),
    criteria: z
      .array(z.object({ text: z.string(), met: z.boolean(), evidence: z.string().optional() }).strict())
      .optional(),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(["blocker", "major", "minor"]),
            file: z.string().optional(),
            line: z.number().int().optional(),
            message: z.string(),
          })
          .strict(),
      )
      .optional(),
    pr_title: z.string().max(200).optional(),
  })
  .strict();

export type AgentResult = z.infer<typeof ResultSchema>;
export type Status = AgentResult["status"];

export type ParsedResult = { ok: true; result: AgentResult } | { ok: false; agent: string; error: string };

/**
 * 結果ファイルを読み、形式だけでなく内容の一貫性も検査する。
 * エージェントの自己申告(status)をそのまま信用せず、根拠となる項目と突き合わせる。
 */
export function readResult(path: string, expectedAgent: string): ParsedResult {
  if (!existsSync(path)) return { ok: false, agent: expectedAgent, error: `結果ファイルがありません: ${path}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, agent: expectedAgent, error: `JSONとして読めません: ${(e as Error).message}` };
  }
  const parsed = ResultSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, agent: expectedAgent, error: `形式が不正です: ${msg}` };
  }
  const r = parsed.data;
  if (r.agent !== expectedAgent) {
    return { ok: false, agent: expectedAgent, error: `agent が一致しません(期待: ${expectedAgent}、実際: ${r.agent})` };
  }
  const inconsistency = findInconsistency(r);
  if (inconsistency) return { ok: false, agent: expectedAgent, error: inconsistency };
  return { ok: true, result: r };
}

export function findInconsistency(r: AgentResult): string | null {
  if (r.status === "blocked" && !(r.questions && r.questions.length)) {
    return "status が blocked なのに questions がありません";
  }
  if (r.status === "pass" && r.criteria?.some((c) => !c.met)) {
    return "status が pass なのに、満たしていない受け入れ条件があります";
  }
  if (r.status === "pass" && r.findings?.some((f) => f.severity !== "minor")) {
    return "status が pass なのに、blocker / major の指摘があります";
  }
  if (r.agent === "verify-spec" && r.status === "pass" && !(r.criteria && r.criteria.length)) {
    return "verify-spec が pass なのに criteria がありません";
  }
  return null;
}

/** 複数エージェントの結果をまとめる。最も悪いものが全体の結果になる。 */
export function combineStatus(statuses: Status[]): Status {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("fail")) return "fail";
  return "pass";
}
