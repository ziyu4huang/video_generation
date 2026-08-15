import { loadModelTierConfig, type ModelTierConfig, resolveModelRole } from "@repo/pi-agent-ext-core-runtime";
import { Type } from "typebox";
import { type SpawnSubagentOptions, spawnSubagent } from "../spawn-subagent.js";
import type { WatchdogFinding, WatchdogL2Result } from "./types.js";

const ReviewSchema = Type.Object(
  {
    findings: Type.Array(
      Type.Object({
        severity: Type.Union([Type.Literal("blocker"), Type.Literal("concern")]),
        path: Type.Optional(Type.String()),
        line: Type.Optional(Type.Number()),
        message: Type.String(),
        suggestedFix: Type.Optional(Type.String()),
      }),
    ),
  },
  { additionalProperties: false },
);

function buildPrompt(diffText: string, taskLabel: string): string {
  return [
    "You are a read-only code reviewer (watchdog L2). Review ONLY the changeset below for the recurring SDD failures:",
    "- implementer committed only the test file (impl missing / untracked)",
    "- missed integration wiring (imports, registration, exports)",
    "- obvious correctness or type errors",
    "Use read/grep/find/ls to verify a concern against the repo if needed. Do NOT edit anything.",
    "Return findings via structured_output. severity='blocker' only if acceptance should pause; else 'concern'.",
    "If the changeset is clean, return { findings: [] }.",
    `Implementer task: ${taskLabel}`,
    "<changeset>",
    diffText,
    "</changeset>",
  ].join("\n");
}

export async function runModelReview(input: {
  cwd: string;
  diffText: string;
  taskLabel: string;
  signal?: AbortSignal;
  agent?: NonNullable<SpawnSubagentOptions["agent"]>;
  /** Test seam: defaults to loadModelTierConfig (reads ~/.pi/workflows/model-tiers.json). */
  loadConfig?: () => ModelTierConfig | null;
}): Promise<WatchdogL2Result> {
  const cfg = (input.loadConfig ?? loadModelTierConfig)();
  const reviewSpec = resolveModelRole({ capability: "review" }, cfg) ?? resolveModelRole({ tier: "big" }, cfg);
  if (!reviewSpec) return { ran: false, findings: [], note: "review-skipped: no review/big model configured" };
  try {
    const res = await spawnSubagent({
      task: buildPrompt(input.diffText, input.taskLabel),
      cwd: input.cwd,
      model: reviewSpec,
      schema: ReviewSchema,
      tools: ["read", "grep", "find", "ls"],
      externalSignal: input.signal,
      retryOnTransient: false,
      // NO watchdog param — recursion-safe (spawnSubagent has no such field anyway).
      ...(input.agent ? { agent: input.agent } : {}),
    });
    if (res.failure) return { ran: false, findings: [], note: `review-skipped: ${res.failure.message}` };
    const parsed = JSON.parse(res.output || "{}") as { findings?: Array<Record<string, unknown>> };
    const findings: WatchdogFinding[] = (parsed.findings ?? []).map((f) => ({
      severity: (f.severity === "blocker" ? "blocker" : "concern") as WatchdogFinding["severity"],
      source: "model",
      ...(typeof f.path === "string" ? { path: f.path } : {}),
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      message: String(f.message ?? ""),
      ...(typeof f.suggestedFix === "string" ? { suggestedFix: f.suggestedFix } : {}),
    }));
    return { ran: true, findings };
  } catch (e) {
    return { ran: false, findings: [], note: `review-skipped: ${(e as Error).message}` };
  }
}
