/**
 * /grill family handlers (me / docs / done / domain) plus the session-shutdown
 * cleanup. Bodies moved verbatim from commands.ts (Task 9); only the closure
 * wiring changed — the shared grill kickoff now comes from makeCommandHelpers.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { seedPlan } from "../chain.js";
import { PKG_NAME } from "../constants.js";
import { unpublishWayfindGrill } from "../coordination.js";
import type { WayfindOverlay } from "../overlay.js";
import { getSessionId, isGrillActive, type RuntimeState } from "../state.js";
import { makeCommandHelpers } from "./shared.js";

export function makeGrillHandlers(pi: ExtensionAPI, state: RuntimeState, overlay: WayfindOverlay) {
  const { startGrill } = makeCommandHelpers(pi, state);

  async function handleGrillMe(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const topic = args.trim();
    startGrill(ctx, topic, false);
    overlay.setLine("grilling", `grilling${topic ? `: ${topic}` : ""}`);
    ctx.ui.notify(
      `[${PKG_NAME}] grill-me started${topic ? ` (${topic})` : ""}. The grill is driving — don't also run /goal or /loop this session.`,
      "info",
    );
  }

  async function handleGrillDocs(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const topic = args.trim();
    startGrill(ctx, topic, true);
    overlay.setLine("grilling-docs", `grilling (docs)${topic ? `: ${topic}` : ""}`);
    ctx.ui.notify(
      [
        `[${PKG_NAME}] grill-me-with-docs started${topic ? ` (${topic})` : ""}.`,
        "Resolving terms will be written to CONTEXT.md; hard-to-reverse decisions offered as ADRs.",
        "End with /grill done (or /grill done --seed-plan to hand off to a task_plan.md seed).",
      ].join("\n"),
      "info",
    );
  }

  async function handleGrillDone(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    if (!isGrillActive(state, sessionId)) {
      ctx.ui.notify(`[${PKG_NAME}] No active grill session to end.`, "info");
      return;
    }

    const topic = state.activeGrillBySession.get(sessionId);
    state.activeGrillBySession.delete(sessionId);
    state.grillWithDocsBySession.delete(sessionId);
    overlay.setLine("done", "grill ended");

    const seed = args.includes("--seed-plan") || args.includes("seed-plan");
    if (!seed) {
      ctx.ui.notify(`[${PKG_NAME}] Grill ended.`, "info");
      return;
    }

    const outcome = seedPlan(ctx.cwd, { topic });
    if (!outcome) {
      ctx.ui.notify(
        `[${PKG_NAME}] --seed-plan: nothing to seed (no CONTEXT.md decisions, no glossary, no topic).`,
        "warning",
      );
      return;
    }
    if ("refused" in outcome) {
      ctx.ui.notify(
        `[${PKG_NAME}] --seed-plan: ${outcome.refused} already exists — delete it first to re-seed.`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `[${PKG_NAME}] Seeded ${outcome.path} (${outcome.phaseCount} phase(s), source: ${outcome.source}).`,
      "info",
    );
    pi.sendUserMessage(
      `Grill ended. I seeded ${outcome.path} from ${outcome.source}. Review the phases, then load the executing-plans (or subagent-driven-development) skill to execute the plan.`,
      { deliverAs: "steer" },
    );
  }

  async function handleGrillDomain(_args: string, _ctx: ExtensionCommandContext): Promise<void> {
    pi.sendUserMessage(
      [
        "Starting a domain-modeling session.",
        "Load the `domain-modeling` skill: actively build the project's glossary + ADRs.",
        "Challenge terms against CONTEXT.md, sharpen fuzzy language, probe edge cases, cross-reference the code.",
        "Write resolved terms to CONTEXT.md inline (glossary only — no implementation details).",
        "Offer an ADR only when a decision is hard-to-reverse + surprising-without-context + a real trade-off.",
      ].join("\n"),
      { deliverAs: "steer" },
    );
    overlay.setLine("domain-modeling", "domain modeling");
  }

  return { handleGrillMe, handleGrillDocs, handleGrillDone, handleGrillDomain };
}

/** Clear the active grill/effort for a session (called on session_shutdown in index.ts). */
export function endGrillForSession(state: RuntimeState, sessionId: string): void {
  state.activeGrillBySession.delete(sessionId);
  state.grillWithDocsBySession.delete(sessionId);
  state.activeEffortBySession.delete(sessionId);
  if (state.activeGrillBySession.size === 0 && state.activeEffortBySession.size === 0) {
    unpublishWayfindGrill();
  }
}
