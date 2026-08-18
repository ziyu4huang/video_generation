/**
 * Background review — learning loop that auto-saves memory every N turns.
 * Ported from hermes-agent/run_agent.py (_spawn_background_review, _memory_nudge_interval).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 *
 * Default transport: in-process complete() side-channel (preserves parent LLM cache).
 * Fallback: a one-shot `spawnSubagent` reviewer bridged with the parent memory
 * tool via `extensionTools` (same end effect as the old `pi -p` subprocess that
 * loaded this extension with `-e`, without the OS-process boundary). The child's
 * memory writes land in the parent store because the bridged tool def's execute
 * closure already binds this parent `MemoryStore`.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { roleAwareDirectCall, spawnSubagent } from "@repo/pi-agent-ext-subagent";
import { COMBINED_REVIEW_PROMPT } from "../constants.js";
import { MemoryStore } from "../store/memory-store.js";
import type { CardStore } from "../store/card-store.js";
import type { MemoryConfig } from "../types.js";
import { applyRecentMessageLimit, collectMessageParts, collectSubagentOutputs } from "./message-parts.js";
import { runDirectBackgroundReview, type DirectReviewResult } from "./review-memory-ops.js";

export interface BackgroundReviewOptions {
  /** kp13 Wave B: the memory-kind mirror target — the bundle CardStore
   *  (md_id-keyed; threaded into applyReviewOperations). Wave C removed the
   *  memoryRepo option — the review path holds no repository seam anymore. */
  cardStore?: CardStore | null;
  projectName?: string | null;
  deps?: BackgroundReviewDeps;
}

export interface BackgroundReviewDeps {
  runDirectReview?: typeof runDirectBackgroundReview;
  /** Parent memory tool def bridged into the fallback spawn reviewer. */
  memoryToolDef?: ToolDefinition;
  /** Injectable spawn seam — production omits it (→ real spawnSubagent). */
  spawn?: typeof spawnSubagent;
}

export interface ReviewPromptInput {
  parts: string[];
  currentMemory: string;
  currentUser: string;
  currentProject: string | null;
}

export function buildDirectReviewUserPrompt(input: ReviewPromptInput): string {
  const sections = [
    "--- Current Memory ---",
    input.currentMemory || "(empty)",
    "",
    "--- Current User Profile ---",
    input.currentUser || "(empty)",
  ];

  if (input.currentProject !== null) {
    sections.push(
      "",
      "--- Current Project Memory ---",
      input.currentProject || "(empty)",
    );
  }

  sections.push(
    "",
    "--- Conversation to Review ---",
    input.parts.join("\n\n"),
  );

  return sections.join("\n");
}

function shouldNotifyDirect(result: DirectReviewResult): boolean {
  return result.ok && result.appliedCount > 0;
}

function shouldReportSaved(text: string | undefined): boolean {
  const output = text?.trim();
  return !!output && !output.toLowerCase().includes("nothing to save");
}

function usesDirectTransport(config: MemoryConfig): boolean {
  return (config.reviewTransport ?? "direct") === "direct";
}

async function runReviewSubagent(
  prompt: string,
  memoryToolDef: ToolDefinition,
  config: MemoryConfig,
  spawn: typeof spawnSubagent,
): Promise<{ ok: boolean; output?: string }> {
  // The child saves via the bridged memory tool (extensionTools), so it writes
  // directly to the parent store — same effect as the old -e subprocess. The
  // review prompt carries COMBINED_REVIEW_PROMPT (incl. the "Nothing to save."
  // convention that shouldReportSaved reads) plus the conversation context.
  // llmThinkingOverride has no spawnSubagent equivalent — inert under the migration.
  const modelOverride = config.llmModelOverride?.trim();
  // 2026-08-18: the fallback reviewer ran envelope-less (spawnSubagent forwards
  // only explicit budgets; role bounds live at the tool seam this direct call
  // bypasses — same gap class as zk #1654). Review = read + synthesize → recon
  // envelope for token/turn caps; the deliberate 120s wall-clock stays (it is
  // tighter than the envelope's 5min and wins). SUBAGENT_TOKEN_BUDGET_DISABLE
  // remains the global escape hatch (roleAwareDirectCall → applied:false; caps
  // and the abort-safety footer travel together).
  // Computed here — not module scope — so the env flag is read at call time.
  const d = roleAwareDirectCall("recon", prompt, `hermes-bg-review-${Date.now()}`);
  const result = await spawn({
    task: d.task,
    ...(modelOverride ? { model: modelOverride } : { tier: "small" }),
    instructions:
      "You are a memory reviewer. Use ONLY the memory tool to save notable facts as instructed. Do not read or modify files.",
    tools: ["memory"],
    extensionTools: [memoryToolDef],
    tokenBudget: d.tokenBudget,
    maxTurns: d.maxTurns,
    timeoutMs: 120000,
    retryOnTransient: true,
  });
  return { ok: !result.failure, output: result.output };
}

export function setupBackgroundReview(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: MemoryConfig,
  options: BackgroundReviewOptions = {},
): void {
  const cardStore = options.cardStore ?? null;
  const projectName = options.projectName ?? null;
  const runDirectReview = options.deps?.runDirectReview ?? runDirectBackgroundReview;
  const memoryToolDef = options.deps?.memoryToolDef;
  const spawn = options.deps?.spawn ?? spawnSubagent;

  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
  let userTurnCount = 0;
  let reviewInProgress = false;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") {
      userTurnCount++;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    turnsSinceReview++;

    if (!config.reviewEnabled) return;
    if (reviewInProgress) return;

    try {
      const msg = event.message;
      if (msg?.role === "assistant") {
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && block.type === "toolCall") {
              toolCallsSinceReview++;
            }
          }
        }
      }
    } catch {
      // If we can't count tool calls, fall back to turn-based only
    }

    const turnThresholdMet = turnsSinceReview >= config.nudgeInterval;
    const toolCallThresholdMet = toolCallsSinceReview >= config.nudgeToolCalls;

    if (!turnThresholdMet && !toolCallThresholdMet) return;
    if (userTurnCount < 3) return;

    turnsSinceReview = 0;
    toolCallsSinceReview = 0;
    reviewInProgress = true;

    let parts: string[];
    try {
      const entries = ctx.sessionManager.getBranch();
      const convoParts = collectMessageParts(entries);
      if (convoParts.length < 4) {
        reviewInProgress = false;
        return;
      }
      // Subagent outputs are appended after the recent-message window: they are
      // high-signal findings that should always be reviewed, without displacing
      // recent conversation and without broadening getMessageText (shared by
      // session-flush / correction-detector). Captured via the dedicated path.
      const subagentParts = collectSubagentOutputs(entries);
      parts = [...applyRecentMessageLimit(convoParts, config.reviewRecentMessages), ...subagentParts];
    } catch {
      reviewInProgress = false;
      return;
    }
    const promptInput: ReviewPromptInput = {
      parts,
      currentMemory: store.getMemoryEntries().join("\n§\n"),
      currentUser: store.getUserEntries().join("\n§\n"),
      currentProject: projectStore ? projectStore.getMemoryEntries().join("\n§\n") : null,
    };

    const directPrompt = buildDirectReviewUserPrompt(promptInput);
    // The spawn task carries COMBINED_REVIEW_PROMPT (the reviewer guidance incl.
    // the "Nothing to save." convention) plus the same context sections the
    // direct path reviews. buildSubprocessReviewPrompt was removed: the task is
    // the review prompt assembled directly from the shared context builder.
    const reviewTask = [COMBINED_REVIEW_PROMPT, "", directPrompt].join("\n");

    const finishReview = () => {
      reviewInProgress = false;
    };

    const notifyIfSaved = (saved: boolean) => {
      if (saved) {
        ctx.ui.notify("💾 Memory auto-reviewed and updated", "info");
      }
    };

    const runReview = async (): Promise<void> => {
      if (usesDirectTransport(config)) {
        const directResult = await runDirectReview(
          ctx as Pick<ExtensionContext, "model" | "modelRegistry">,
          store,
          projectStore,
          { userPrompt: directPrompt, config, timeoutMs: 120000 },
          projectName,
          cardStore,
        );

        if (directResult.ok) {
          notifyIfSaved(shouldNotifyDirect(directResult));
          return;
        }

        if (directResult.fallbackReason === "empty") {
          return;
        }
      }

      // Fallback: spawn a one-shot reviewer subagent bridged with the parent
      // memory tool. Production always threads memoryToolDef (captured from
      // registerMemoryTool in src/index.ts); the guard is defensive only.
      if (!memoryToolDef) return;
      const reviewResult = await runReviewSubagent(reviewTask, memoryToolDef, config, spawn);
      if (reviewResult.ok) {
        notifyIfSaved(shouldReportSaved(reviewResult.output));
      }
    };

    runReview()
      .catch(() => {
        // Best-effort only
      })
      .finally(finishReview);
  });
}