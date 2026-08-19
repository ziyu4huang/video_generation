/**
 * Correction detection — detects user corrections in real-time and triggers
 * an immediate memory save instead of waiting for the next nudge interval.
 *
 * Uses a two-pass filter:
 * - Strong patterns: always trigger (high confidence)
 * - Weak patterns: only trigger if followed by a directive clause
 * - Negative patterns: suppress even if a positive pattern matched
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { roleAwareDirectCall, spawnSubagent } from "@repo/pi-agent-core-runtime";
import { MemoryStore } from "../store/memory-store.js";
import { readGrillActive } from "../grill-seam.js";
import { formatFailureMemoryContent } from "../store/memory-format.js";
import type { MemoryRepository } from "../store/repository.js";
import type { CardStore } from "../store/card-store.js";
import { mirrorMemoryAdd } from "../store/memory-card-mirror.js";
import {
  CORRECTION_SAVE_PROMPT,
  CORRECTION_STRONG_PATTERNS,
  CORRECTION_WEAK_PATTERNS,
  CORRECTION_NEGATIVE_PATTERNS,
  CORRECTION_DIRECTIVE_WORDS,
  ENTRY_DELIMITER,
} from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { getMessageText } from "../types.js";
import { runContradictionJudge } from "./contradiction-judge.js";

/**
 * Extract the directive part from a correction message.
 * E.g., "no, use pnpm instead" -> "use pnpm instead"
 */
function extractCorrectionDirective(text: string): string {
  // Remove common correction starters
  const cleaned = text
    .replace(/^(no|wrong|actually|stop|don'?t|that'?s not|I said|I told you)[,\.\s!]+/i, '')
    .replace(/^(please\s+)?/i, '')
    .trim();
  return cleaned || text;
}

function compileCorrectionPatterns(
  configured: string[] | undefined,
  defaults: RegExp[],
): RegExp[] {
  if (configured === undefined) return defaults;

  const patterns: RegExp[] = [];
  for (const source of configured) {
    try {
      patterns.push(new RegExp(source, "i"));
    } catch {
      // Ignore invalid configured regex entries; valid entries still apply.
    }
  }
  return patterns;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDirectiveWord(remainder: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const source = words.map(escapeRegexLiteral).join("|");
  return new RegExp(`\\b(${source})\\b`, "i").test(remainder);
}

/**
 * Check if a user message is a correction using the two-pass filter.
 * Returns true if the message should trigger an immediate save.
 */
type CorrectionPatternConfig = Pick<MemoryConfig,
  "correctionStrongPatterns" |
  "correctionWeakPatterns" |
  "correctionNegativePatterns" |
  "correctionDirectiveWords"
>;

export function isCorrection(text: string, config?: CorrectionPatternConfig): boolean {
  const negativePatterns = compileCorrectionPatterns(
    config?.correctionNegativePatterns,
    CORRECTION_NEGATIVE_PATTERNS,
  );
  const strongPatterns = compileCorrectionPatterns(
    config?.correctionStrongPatterns,
    CORRECTION_STRONG_PATTERNS,
  );
  const weakPatterns = compileCorrectionPatterns(
    config?.correctionWeakPatterns,
    CORRECTION_WEAK_PATTERNS,
  );
  const directiveWords = config?.correctionDirectiveWords ?? CORRECTION_DIRECTIVE_WORDS;

  // Check negative patterns first — suppress even if positive matches
  for (const pattern of negativePatterns) {
    if (pattern.test(text)) return false;
  }

  // Check strong patterns — always trigger
  for (const pattern of strongPatterns) {
    if (pattern.test(text)) return true;
  }

  // Check weak patterns — only trigger if followed by a directive clause
  for (const pattern of weakPatterns) {
    if (pattern.test(text)) {
      // Look for a directive after the weak pattern match
      // Directive = a verb or "the/that/this" in the remainder of the text
      const match = pattern.exec(text);
      if (match && match.index === 0) {
        const remainder = text.slice(match[0].length).trim();
        // Simple heuristic: remainder contains something directive-ish
        if (hasDirectiveWord(remainder, directiveWords)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function setupCorrectionDetector(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: MemoryConfig,
  memoryRepo: MemoryRepository | null = null,
  projectName?: string | null,
  memoryToolDef?: ToolDefinition,
  spawn: typeof spawnSubagent = spawnSubagent,
  runJudge: typeof runContradictionJudge = runContradictionJudge,
  // kp13 Wave B: the failure-mirror target — the bundle CardStore
  // (md_id-keyed upsert; dedup rides upsertCard's registered
  // MemoryDedupStrategy). memoryRepo stays for lineage (supersedeMemory) and
  // the auto-supersede candidate pool (searchMemories — reads, not the
  // retired sync mirror).
  cardStore: CardStore | null = null,
): void {
  if (!config.correctionDetection) return;

  let pendingCorrection = false;
  let turnsSinceLastCorrection = 3; // Start at threshold so first correction can fire immediately
  let correctionInProgress = false;

  // Flag on message_end (user role)
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "user") return;
    const text = getMessageText(event.message);
    if (!text) return;
    if (isCorrection(text, config)) {
      pendingCorrection = true;
    }
  });

  // Trigger on turn_end (we need full context: user correction + what agent said)
  pi.on("turn_end", async (event, ctx) => {
    // Yield to grill_decision during an active grill: the grill tool is the
    // sole writer for grill-time corrections (richer context, gated writes),
    // so the generic detector must not double-capture. Drop the pending flag so
    // a correction captured during the grill is not deferred and later written
    // by this generic path (which would double-capture). Grill-only seam (the
    // process-global boolean conflates grill + wayfinder, but scope is grills).
    if (readGrillActive(ctx.sessionManager?.getSessionId?.())) {
      pendingCorrection = false;
      return;
    }

    // Rate limit: max 1 correction save per 3 turns. Checked BEFORE consuming
    // pendingCorrection and advanced every turn, so a correction that arrives
    // inside the window is DEFERRED to a later turn rather than silently
    // dropped (previously the flag was cleared first and the correction lost).
    if (turnsSinceLastCorrection < 3) {
      turnsSinceLastCorrection++;
      return;
    }
    if (correctionInProgress) return;
    if (!pendingCorrection) return;

    pendingCorrection = false;
    turnsSinceLastCorrection = 0;
    correctionInProgress = true;

    try {
      // Build conversation snapshot
      const entries = ctx.sessionManager.getBranch();
      const parts: string[] = [];

      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        const text = getMessageText(msg);
        if (!text) continue;
        const prefix = msg.role === "user" ? "[USER]" : "[ASSISTANT]";
        parts.push(`${prefix}: ${text}`);
      }

      // Only include last few exchanges (correction context is recent)
      const recentParts = parts.slice(-6);

      const currentMemory = store.getMemoryEntries().join(ENTRY_DELIMITER);
      const currentUser = store.getUserEntries().join(ENTRY_DELIMITER);
      const currentProject = projectStore ? projectStore.getMemoryEntries().join(ENTRY_DELIMITER) : null;

      const prompt = [
        CORRECTION_SAVE_PROMPT,
        "",
        "--- Current Memory ---",
        currentMemory || "(empty)",
        "",
        "--- Current User Profile ---",
        currentUser || "(empty)",
      ];

      if (currentProject !== null) {
        prompt.push(
          "",
          "--- Current Project Memory ---",
          currentProject || "(empty)",
        );
      }

      prompt.push(
        "",
        "--- Recent Conversation ---",
        recentParts.join("\n\n"),
      );

      if (!memoryToolDef) return;
      // llmThinkingOverride has no spawnSubagent equivalent — inert under the migration.
      const modelOverride = config.llmModelOverride?.trim();
      // 2026-08-18 envelope closure (#1652/#1654/#1655 companion): direct
      // spawnSubagent calls bypass the tool-seam role bounds — same gap
      // class. roleAwareDirectCall carries the caps and the abort-safety
      // footer together; the tighter local timeoutMs wins over the envelope
      // wall. SUBAGENT_TOKEN_BUDGET_DISABLE escape hatch honored (computed at
      // call time). Computed here — not module scope — so the env flag is
      // read at call time.
      const d = roleAwareDirectCall("recon", prompt.join("\n"), `hermes-correction-detector-${Date.now()}`);
      const result = await spawn({
        task: d.task,
        ...(modelOverride ? { model: modelOverride } : { tier: "small" }),
        instructions: "Use ONLY the memory tool to save the correction as instructed. Do not read or modify files.",
        tools: ["memory"],
        extensionTools: [memoryToolDef],
        tokenBudget: d.tokenBudget,
        maxTurns: d.maxTurns,
        timeoutMs: 30000,
        externalSignal: ctx.signal,
        retryOnTransient: true,
      });
      if (!result.failure && result.output) {
        const output = result.output.trim();
        if (output && !output.toLowerCase().includes("nothing to save")) {
          ctx.ui.notify("🔧 Correction detected — memory updated", "info");
        }
      }

      // Also save as a failure memory for learning
      try {
        const lastUserMsg = recentParts.find(p => p.startsWith("[USER]"));
        const correctionText = lastUserMsg ? lastUserMsg.replace(/^\[USER\]:\s*/, "") : "";
        if (correctionText) {
          const directive = extractCorrectionDirective(correctionText);
          const failureReason = "User corrected the agent";
          const scopedProjectName = projectStore ? projectName?.trim() || null : null;
          const addResult = await store.addFailure(directive, {
            category: "correction",
            failureReason,
            project: scopedProjectName ?? undefined,
          });

          if (addResult.success && cardStore) {
            try {
              // kp13 Wave B: mirror through the card-store (md_id-keyed upsert;
              // dedup rides the registered MemoryDedupStrategy). The legacy
              // content-keyed syncMemoryEntry mirror is retired on this path.
              await mirrorMemoryAdd(cardStore, "failure", {
                mdId: addResult.added_md_id,
                content: formatFailureMemoryContent(directive, {
                  category: "correction",
                  failureReason,
                  project: scopedProjectName,
                }),
              });
              // Lineage keys on numeric row ids — resolve the mirrored row's id
              // by md_id (content fallback covers the dedup-skipped insert).
              const correctionContent = formatFailureMemoryContent(directive, {
                category: "correction",
                failureReason,
                project: scopedProjectName,
              });
              let correctionEntryId: number | undefined;
              if (memoryRepo) {
                const rows = await memoryRepo.getMemories({
                  target: "failure",
                  project: scopedProjectName ?? null,
                });
                const row = addResult.added_md_id
                  ? rows.find((m) => m.mdId === addResult.added_md_id)
                  : undefined;
                correctionEntryId = row?.id ?? rows.find((m) => m.content === correctionContent)?.id;
              }

              // Auto-supersede (Plan 5a — judge-gated, opt-in). Fetch a
              // decoupled candidate pool via searchMemories(directive) (NOT the
              // recall-set — full entries, active-filtered), ask the judge for
              // the single contradicted candidate, and flip it onto the
              // correction entry's lineage. Fully best-effort: any throw (judge
              // unavailable, parse-fail, repo error) is swallowed so the
              // session never crashes. The candidates guard prevents
              // superseding an id the judge hallucinated outside the pool.
              // Self is filtered out of the candidate pool BEFORE judging to
              // prevent self-supersede (correction entry id embedding in its own
              // content makes it match FTS5).
              if (config.autoSupersede === true && correctionEntryId !== undefined && memoryRepo) {
                try {
                  const candidates = (await memoryRepo.searchMemories(directive, {
                    project: scopedProjectName ?? undefined,
                    limit: 6,
                  })).filter((c) => c.id !== correctionEntryId);
                  if (candidates.length > 0) {
                    const verdict = await runJudge(
                      ctx as unknown as Parameters<typeof runContradictionJudge>[0],
                      { correctionText: directive, candidates, config, signal: ctx.signal, timeoutMs: 30000 },
                    );
                    if (verdict.contradictedId != null && candidates.some((c) => c.id === verdict.contradictedId)) {
                      await memoryRepo.supersedeMemory(verdict.contradictedId, correctionEntryId);
                      try {
                        ctx.ui?.notify?.(
                          `Auto-superseded memory #${verdict.contradictedId} (corrected by #${correctionEntryId}).`,
                          "info",
                        );
                      } catch {
                        // best-effort — notify must not block supersession
                      }
                    }
                  }
                } catch {
                  // best-effort — auto-supersede must never block the session
                }
              }
            } catch {
              // Best-effort — searchable sync should not block correction capture
            }
          }
        }
      } catch {
        // Best-effort — don't block the session
      }
    } catch {
      // Best-effort — don't block the session
    } finally {
      correctionInProgress = false;
    }
  });
}
