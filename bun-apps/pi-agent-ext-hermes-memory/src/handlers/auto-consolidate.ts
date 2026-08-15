/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Consolidation runs in-process via the shared `spawnSubagent` runner
 * (sub-project ①). The child subagent is handed the parent's `memory` tool
 * through `extensionTools` bridging — the `ToolDefinition` captured from
 * `registerMemoryTool`; its `execute` closure binds the parent `MemoryStore`,
 * so the child's writes land in the parent store directly. That is the same
 * end effect as the old `pi -p` subprocess (`-e <own-extension>`) without the
 * OS-process boundary. The store is still reloaded from disk after
 * consolidation completes as a belt-and-suspenders mirror.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { spawnSubagent } from "@repo/pi-agent-ext-subagent";
import type { SpawnSubagentResult } from "@repo/pi-agent-ext-subagent";
import type { TSchema } from "typebox";
import { MemoryStore } from "../store/memory-store.js";
import { mergePlanSchema, mergePlanValidate } from "../store/merge-plan.js";
import type { ConsolidationSnapshot, MergePlan } from "../store/merge-plan.js";
import { CONSOLIDATION_PROMPT, ENTRY_DELIMITER } from "../constants.js";
import type { ConsolidationResult, MemoryConfig } from "../types.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";
type ChildLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

/**
 * Resolve the model-id the consolidator will actually use, for display in
 * progress notifications. With spawnSubagent the child resolves its model from
 * the `tier` config (or inherits the live session model when none is set); this
 * label is informational only and best-effort mirrors that resolution:
 *   1. llmModelOverride wins (it would be threaded through as `model`).
 *   2. Otherwise the child inherits the parent env and pi uses PI_MODEL
 *      (qualified by PI_PROVIDER) when no tier/model is given.
 *   3. "default" when neither is present.
 */
export function resolveConsolidatorModelLabel(config: ChildLlmConfig): string {
  const override = config.llmModelOverride?.trim();
  if (override) return override;
  const model = process.env.PI_MODEL;
  const provider = process.env.PI_PROVIDER;
  if (model) return provider ? `${provider}/${model}` : model;
  return "default";
}

/**
 * UPSP §1: fire-and-forget proactive consolidation after a write, guarded by
 * the feature flag + the existing in-flight check. Never throws, never blocks
 * the caller — the write returns BEFORE consolidation completes, and a
 * proactive failure never breaks the write path.
 *
 * The store's `maybeProactiveConsolidate` owns cooldown + pressure +
 * candidate-selection (and re-checks `proactiveConsolidateEnabled` as its own
 * invariant); this helper owns ONLY the enable + in-flight gate. Keeping that
 * gate here — instead of inside the store — is what keeps the store DB-free /
 * commit-guards-free: the store must not import the in-flight probe, so the
 * write-path hook consults it on the store's behalf.
 *
 * `inFlight` is the caller-supplied probe for "a consolidation is already
 * running" (production wires it to the canonical `PI_HERMES_CONSOLIDATING`
 * env check — see `config.ts:isConsolidatingChild`, the same probe
 * `commit-project-memory.ts` uses). Reusing that existing probe (rather than a
 * new flag) means a write that lands while a consolidation is mid-flight is a
 * cheap no-op, never a competing second consolidation.
 */
export function fireProactiveIfReady(
  store: { maybeProactiveConsolidate(target: "memory" | "user" | "failure"): Promise<unknown> },
  target: "memory" | "user" | "failure",
  opts: { enabled: boolean; inFlight: () => boolean },
): void {
  if (!opts.enabled || opts.inFlight()) return;
  void store.maybeProactiveConsolidate(target).catch(() => {
    // best-effort: a proactive failure must never break the write path
  });
}

function entriesForTarget(store: MemoryStore, target: MemoryTarget): string[] {
  if (target === "user") return store.getUserEntries();
  if (target === "failure") return store.getAllFailureEntries();
  return store.getMemoryEntries();
}

function labelForTarget(target: MemoryTarget, toolTarget: ToolMemoryTarget): string {
  if (toolTarget === "project") return "Project Memory";
  if (target === "user") return "User Profile";
  if (target === "failure") return "Failure Memory";
  return "Memory";
}

function describeConsolidationFailure(result: SpawnSubagentResult, timeoutMs: number): string {
  if (result.failure?.kind === "timedout") {
    return `Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: ${timeoutMs}ms. Consider increasing consolidationTimeoutMs if this is a manual run.`;
  }
  // Every failure variant carries a message, so the old "runner exited (code N)"
  // fallback — which existed only because `stderr` could be empty — is gone.
  return `Consolidation failed: ${result.failure?.message.slice(0, 200) ?? "unknown"}`;
}

export async function triggerConsolidation(
  store: MemoryStore,
  target: MemoryTarget,
  memoryToolDef: ToolDefinition,
  signal?: AbortSignal,
  timeoutMs: number = 60000,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
  spawn: typeof spawnSubagent = spawnSubagent,
): Promise<ConsolidationResult> {
  const entries = entriesForTarget(store, target);
  const currentContent = entries.join(ENTRY_DELIMITER);

  const prompt = [
    CONSOLIDATION_PROMPT,
    "",
    `--- Current ${labelForTarget(target, toolTarget)} Entries ---`,
    currentContent || "(empty)",
    "",
    `Use the memory tool to consolidate. Target: '${toolTarget}'`,
  ].join("\n");

  try {
    // llmThinkingOverride has no spawnSubagent equivalent — inert under the migration.
    const modelOverride = llmConfig.llmModelOverride?.trim();
    const result = await spawn({
      task: prompt,
      // Honor llmModelOverride when set (keeps resolveConsolidatorModelLabel
      // honest); otherwise fall back to the small tier.
      ...(modelOverride ? { model: modelOverride } : { tier: "small" }),
      instructions:
        "You are a memory consolidator. Use ONLY the memory tool to merge/dedup entries as instructed. Do not read or modify any files.",
      tools: ["memory"],
      extensionTools: [memoryToolDef],
      timeoutMs,
      externalSignal: signal,
      // Consolidation runs WHILE the parent holds the cross-process fileLock on
      // the target (so the in-process child, which bypasses the lock, is the
      // sole writer). The in-process spawnSubagent classifies a timeout (signal
      // abort) as `transient` and would RETRY it — re-running the consolidator
      // for another full timeout while STILL holding the lock, starving every
      // concurrent sibling-agent writer for ~2× the timeout (perf.jsonl: 120s
      // = 60s + 60s, with 144s / 998s outliers). A timed-out merge is
      // best-effort (falls through to the vault-offload floor), so retrying
      // only re-holds the lock and re-fails. Opt OUT of transient retry.
      retryOnTransient: false,
    });
    if (!result.failure) {
      store.loadFromDisk(); // mirror today's post-child reload
      return { consolidated: true };
    }
    return {
      consolidated: false,
      error: describeConsolidationFailure(result, timeoutMs),
      terminated: result.failure.kind === "timedout",
    };
  } catch (err) {
    return { consolidated: false, error: `Consolidation failed: ${String(err).slice(0, 200)}` };
  }
}

// ─── Lock-free LLM runner (step 2: produce a plan, no writes) ───────────────
//
// `produceMergePlan` is the read+plan half of the two-step consolidation
// migration. Unlike {@link triggerConsolidation} it acquires NO lock and does
// NO file I/O: it hands the subagent a snapshot of the target store plus a
// `structured_output` schema ({@link mergePlanSchema}) and `tools: []` (READ+PLAN
// ONLY — the child gets NO memory tool, so it physically cannot write). The
// caller (step 4) takes the returned {@link MergePlan}, re-checks it against the
// live set under the cross-process lock, and applies it via `applyMergePlan`.

/**
 * Render the consolidator prompt for a snapshot.
 *
 * Layout: a preamble (role + op semantics + KEY/keep/prefer-merge rules, and the
 * snapshot identity the plan must anchor against), a one-line target+budget
 * header, then each entry as `KEY=<key> | created=<created> last=<last>\n<content>`
 * so the model can reference entries by key.
 */
function buildMergePlanPrompt(snapshot: ConsolidationSnapshot): string {
  const preamble = [
    "You are a memory consolidator. Produce a JSON merge plan that rewrites this memory back under its char budget.",
    "- Use a \"drop\" op to remove an entry, or a \"merge\" op to combine several entries into one new entry.",
    "- Reference entries ONLY by their KEY.",
    "- Entries you do NOT reference in any op are kept as-is.",
    "- When entries overlap, prefer \"merge\" over \"drop\".",
    `- The plan's \"snapshotBaseHash\" MUST be exactly: ${snapshot.snapshotBaseHash}`,
  ].join("\n");
  const header = `Target store: ${snapshot.target}. Current ${snapshot.totalChars} chars / limit ${snapshot.charLimit}.`;
  const entries = snapshot.entries
    .map((e) => `KEY=${e.key} | created=${e.created} last=${e.last}\n${e.content}`)
    .join("\n\n");
  return [preamble, "", header, "", entries].join("\n");
}

/**
 * Spawn a read+plan-only subagent that returns a validated {@link MergePlan} for
 * `snapshot`. Lock-free and side-effect-free: no file I/O, no memory tool handed
 * to the child (`tools: []`).
 *
 * On a structured-output success the payload is run through
 * {@link mergePlanValidate} and returned as `{ plan }`. On a non-zero exit, an
 * empty output, a timeout, or a thrown/rejected spawn it returns `{ error,
 * terminated }` — `terminated` mirrors a timedout failure kind so the caller can tell a
 * cancellation/timeout apart from a plain failure. `retryOnTransient` is off: a
 * timed-out plan is best-effort (the caller falls through to the existing
 * consolidation floor) and must never re-hold resources for a second attempt.
 */
export async function produceMergePlan(
  snapshot: ConsolidationSnapshot,
  opts: {
    timeoutMs: number;
    signal?: AbortSignal;
    modelOverride?: string;
    /** Injectable for tests; defaults to the real {@link spawnSubagent}. */
    spawn?: typeof spawnSubagent;
  },
): Promise<{ plan: MergePlan } | { error: string; terminated?: boolean }> {
  const spawn = opts.spawn ?? spawnSubagent;
  const task = buildMergePlanPrompt(snapshot);
  try {
    const modelOverride = opts.modelOverride?.trim();
    const result = await spawn({
      task,
      instructions:
        "You are a memory consolidator. Return ONLY the JSON merge plan via the structured_output tool. You have no memory or file tools; do not attempt any writes.",
      // Mirror triggerConsolidation: honor an explicit model override, else
      // fall back to the small tier.
      ...(modelOverride ? { model: modelOverride } : { tier: "small" }),
      // READ+PLAN ONLY — the child is handed NO memory tool, so it cannot write.
      tools: [],
      schema: mergePlanSchema as unknown as TSchema,
      retryOnTransient: false,
      timeoutMs: opts.timeoutMs,
      externalSignal: opts.signal,
    });

    if (result.failure) {
      return { error: result.failure.message.slice(0, 200), terminated: result.failure.kind === "timedout" };
    }
    if (!result.output) {
      return { error: "no structured output", terminated: false };
    }

    // spawnSubagent JSON-stringifies the validated structured_output object into
    // `result.output` (see spawn-subagent.ts); recover the object, then re-run
    // our own semantic validation before handing it to the caller.
    const parsed: unknown = JSON.parse(result.output);
    mergePlanValidate(parsed);
    return { plan: parsed };
  } catch (err) {
    return { error: `produceMergePlan failed: ${String(err).slice(0, 200)}` };
  }
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  memoryToolDef: ToolDefinition,
  timeoutMs: number = 60000,
  projectStore: MemoryStore | null = null,
  projectName?: string | null,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
  heartbeatMs: number = 15000,
  spawn: typeof spawnSubagent = spawnSubagent,
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, ctx) => {
      const manualTimeoutMs = Math.max(timeoutMs, 180000);
      const results: string[] = [];
      const targets: Array<{
        label: string;
        store: MemoryStore;
        target: MemoryTarget;
        toolTarget: ToolMemoryTarget;
      }> = [
        { label: "memory", store, target: "memory", toolTarget: "memory" },
        { label: "user", store, target: "user", toolTarget: "user" },
        { label: "failure", store, target: "failure", toolTarget: "failure" },
      ];

      if (projectStore) {
        targets.push({
          label: projectName ? `project:${projectName}` : "project",
          store: projectStore,
          target: "memory",
          toolTarget: "project",
        });
      }

      const modelLabel = resolveConsolidatorModelLabel(llmConfig);
      try {
        ctx.ui.notify(
          `🔄 Starting memory consolidation for ${targets.length} target${targets.length === 1 ? "" : "s"} · model ${modelLabel}...`,
          "info",
        );
      } catch {
        // Best-effort only. If the command context is already stale, continue
        // with the consolidation work rather than failing before it starts.
      }

      for (let idx = 0; idx < targets.length; idx++) {
        const item = targets[idx];
        const entries = entriesForTarget(item.store, item.target);

        if (entries.length === 0) {
          results.push(`${item.label}: (empty, nothing to consolidate)`);
          continue;
        }

        // Per-note streaming is infeasible here: each target consolidates via a
        // single opaque subagent run that only returns on completion. Surface
        // the best feasible signal instead — which target we're on out of the
        // total, plus the magnitude (entry count) of the current work.
        const noteCount = `${entries.length} note${entries.length === 1 ? "" : "s"}`;
        const progressLabel = `${item.label} (${idx + 1}/${targets.length}) · ${noteCount} · ${modelLabel}`;

        try {
          ctx.ui.notify(
            `⏳ Consolidating ${progressLabel}...`,
            "info",
          );
        } catch {
          // Best-effort progress feedback only.
        }

        const t0 = Date.now();
        const beat = setInterval(() => {
          try {
            ctx.ui.notify(`⏳ Consolidating ${progressLabel}… ${Math.round((Date.now() - t0) / 1000)}s elapsed`, "info");
          } catch {
            // Stale ctx (session reload mid-consolidation) — best-effort only.
          }
        }, heartbeatMs);
        let result: ConsolidationResult;
        try {
          result = await triggerConsolidation(
            item.store,
            item.target,
            memoryToolDef,
            ctx.signal,
            manualTimeoutMs,
            item.toolTarget,
            llmConfig,
            spawn,
          );
        } finally {
          clearInterval(beat);
        }

        if (result.consolidated) {
          await item.store.loadFromDisk();
          results.push(`${item.label}: ✅ consolidated`);
        } else {
          results.push(`${item.label}: ❌ ${result.error}`);
        }
      }

      const summary = `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`;

      try {
        ctx.ui.notify(summary, "info");
      } catch {
        // Child consolidation can indirectly trigger a runtime reload/session
        // replacement. If that happens, the original command ctx is stale by
        // the time we reach the final summary, so the command should exit
        // quietly instead of surfacing a stale-ctx error.
      }
    },
  });
}
