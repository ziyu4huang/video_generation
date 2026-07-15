/**
 * Slash commands registered by pi-agent-ext-wayfind.
 *
 *   /grill-me [topic]            — kick off a grilling session (interview only)
 *   /grill-me-with-docs [topic]  — flagship: grilling + domain-modeling (paper trail)
 *   /grill-done [--seed-plan]    — end the grill; optionally seed a task_plan.md
 *   /domain-modeling             — kick off the glossary + ADR discipline directly
 *
 * Type-only imports keep this module cycle-free with index.ts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PKG_NAME } from "./constants.js";
import { publishWayfindActive, unpublishWayfindActive, publishWayfindGrill, unpublishWayfindGrill } from "./coordination.js";
import { buildGrillPriming, buildPlanSeed, parseGlossary } from "./grill.js";
import { getSessionId, isGrillActive, type RuntimeState } from "./state.js";
import { chartMap, claimNextTicket, renderStatus, slugify, statusReport } from "./wayfinder.js";

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
  /** Shared kickoff: set the active-grill state, refresh the published seam, and
   *  send the priming user-message so the agent enters grilling mode. */
  function startGrill(
    ctx: { cwd: string; sessionManager: { getSessionId: () => string } },
    topic: string,
    withDocs: boolean,
  ): void {
    const sessionId = ctx.sessionManager.getSessionId();
    state.activeGrillBySession.set(sessionId, topic || "(current conversation)");
    state.grillWithDocsBySession.set(sessionId, withDocs);
    // Refresh the published seam so planning-with-files sees the live value.
    publishWayfindActive(state);
    publishWayfindGrill(state);
    const priming = buildGrillPriming(topic || undefined, withDocs);
    pi.sendUserMessage(priming, { deliverAs: "steer" });
  }

  pi.registerCommand("grill-me", {
    description: "Kick off a relentless one-question-at-a-time grilling interview",
    handler: async (args, ctx) => {
      const topic = args.trim();
      startGrill(ctx, topic, false);
      ctx.ui.setStatus(PKG_NAME, `grill-me active${topic ? `: ${topic}` : ""}`);
      ctx.ui.notify(
        `[${PKG_NAME}] grill-me started${topic ? ` (${topic})` : ""}. planning-with-files will yield while the grill is active.`,
        "info",
      );
    },
  });

  pi.registerCommand("grill-me-with-docs", {
    description:
      "Flagship: grilling interview that also writes CONTEXT.md glossary + ADRs as it goes, then can seed a task_plan.md",
    handler: async (args, ctx) => {
      const topic = args.trim();
      startGrill(ctx, topic, true);
      ctx.ui.setStatus(PKG_NAME, `grill-me-with-docs active${topic ? `: ${topic}` : ""}`);
      ctx.ui.notify(
        [
          `[${PKG_NAME}] grill-me-with-docs started${topic ? ` (${topic})` : ""}.`,
          "Resolving terms will be written to CONTEXT.md; hard-to-reverse decisions offered as ADRs.",
          "End with /grill-done (or /grill-done --seed-plan to hand off to planning-with-files).",
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("grill-done", {
    description:
      "End the active grill session. --seed-plan writes a task_plan.md seed from the resolved decisions + glossary.",
    handler: async (args, ctx) => {
      const sessionId = getSessionId(ctx);
      if (!isGrillActive(state, sessionId)) {
        ctx.ui.notify(`[${PKG_NAME}] No active grill session to end.`, "info");
        return;
      }

      const withDocs = state.grillWithDocsBySession.get(sessionId) ?? false;
      const topic = state.activeGrillBySession.get(sessionId);
      // Clear state + refresh the seam (so planning-with-files resumes).
      state.activeGrillBySession.delete(sessionId);
      state.grillWithDocsBySession.delete(sessionId);
      publishWayfindActive(state);
      ctx.ui.setStatus(PKG_NAME, "grill ended");

      const seed = args.includes("--seed-plan") || args.includes("seed-plan");
      if (!seed) {
        ctx.ui.notify(`[${PKG_NAME}] Grill ended.`, "info");
        return;
      }

      // --seed-plan: read CONTEXT.md glossary (only the with-docs variant writes
      // one), build a task_plan.md seed, write it, and ask the agent to expand it.
      let glossary: { term: string; definition: string }[] = [];
      if (withDocs) {
        const contextPath = join(ctx.cwd, "CONTEXT.md");
        if (existsSync(contextPath)) glossary = parseGlossary(readFileSync(contextPath, "utf-8"));
      }
      const planSeed = buildPlanSeed([], glossary, topic);
      if (!planSeed) {
        ctx.ui.notify(`[${PKG_NAME}] --seed-plan: nothing to seed (no glossary, no topic).`, "warning");
        return;
      }
      const seedPath = join(ctx.cwd, "task_plan.md");
      writeFileSync(seedPath, planSeed, "utf-8");
      ctx.ui.notify(`[${PKG_NAME}] Seeded ${seedPath} (${glossary.length} glossary terms).`, "info");
      // Delegate decision-expansion to the agent (it has the conversation context).
      pi.sendUserMessage(
        [
          "Grill ended. I seeded task_plan.md from the grill + CONTEXT.md glossary.",
          "Expand the plan: one phase per resolved decision from our conversation. Keep the glossary section. Then stop — I'll run /plan-execute.",
        ].join("\n"),
        { deliverAs: "steer" },
      );
    },
  });

  pi.registerCommand("domain-modeling", {
    description: "Kick off the glossary (CONTEXT.md) + ADR discipline directly, without the grilling interview",
    handler: async (_args, ctx) => {
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
      ctx.ui.setStatus(PKG_NAME, "domain-modeling active");
    },
  });

  pi.registerCommand("wayfinder", {
    description:
      "Chart a huge effort as a local-markdown map of decision tickets (.planning/<effort>/), or work the next frontier ticket if a map exists.",
    handler: async (args, ctx) => {
      const sessionId = getSessionId(ctx);
      const destination = args.trim();

      // No args + an active effort for this session → work the next frontier ticket.
      const activeEffort = state.activeEffortBySession.get(sessionId);
      if (!destination) {
        const effort = activeEffort;
        if (!effort) {
          ctx.ui.notify(
            `Usage: /wayfinder <destination> to chart a new map, or set an active effort first.`,
            "warning",
          );
          return;
        }
        const claimed = claimNextTicket(ctx.cwd, effort, sessionId);
        if (!claimed) {
          const r = statusReport(ctx.cwd, effort);
          ctx.ui.notify(
            r
              ? `${renderStatus(r)}\nNo unclaimed frontier ticket — chart more or resolve claimed ones.`
              : `No map at .planning/${effort}/`,
            "info",
          );
          return;
        }
        state.activeEffortBySession.set(sessionId, effort);
        publishWayfindActive(state);
        ctx.ui.setStatus(PKG_NAME, `wayfinder: ${effort} — ticket ${claimed.id} ${claimed.title}`);
        pi.sendUserMessage(
          [
            `Working wayfinder ticket ${claimed.id} "${claimed.title}" on effort ${effort}.`,
            `Load the \`wayfinder\` skill. Ticket type: ${claimed.type}.`,
            `Question: ${claimed.question}`,
            "Resolve it (one ticket this session): record the answer, then close the ticket + append to the map's Decisions so far. Graduate any newly-specifiable fog into fresh tickets.",
          ].join("\n"),
          { deliverAs: "steer" },
        );
        return;
      }

      // Args → chart a new map.
      const effort = slugify(destination);
      chartMap(ctx.cwd, effort, destination);
      state.activeEffortBySession.set(sessionId, effort);
      publishWayfindActive(state);
      ctx.ui.setStatus(PKG_NAME, `wayfinder: charting ${effort}`);
      ctx.ui.notify(`[${PKG_NAME}] Map created at .planning/${effort}/map.md`, "info");
      pi.sendUserMessage(
        [
          `Charting a wayfinder map for: ${destination}`,
          "Load the `wayfinder` skill (chart-the-map mode).",
          "1. Grill to pin the destination + scope. 2. Map the frontier breadth-first — surface open decisions + first takeable steps. 3. If no fog surfaces, the journey is small enough to skip the map (tell me). 4. Otherwise create tickets under .planning/" +
            effort +
            "/tickets/ (one file each, wired with blocking edges).",
        ].join("\n"),
        { deliverAs: "steer" },
      );
    },
  });

  pi.registerCommand("wayfinder-status", {
    description: "Show the frontier + ticket counts for a wayfinder effort (defaults to the session's active effort).",
    handler: async (args, ctx) => {
      const sessionId = getSessionId(ctx);
      const effort = args.trim() || state.activeEffortBySession.get(sessionId);
      if (!effort) {
        ctx.ui.notify("Usage: /wayfinder-status <effort>  (or run /wayfinder <destination> first)", "warning");
        return;
      }
      const r = statusReport(ctx.cwd, effort);
      if (!r) {
        ctx.ui.notify(`No map at .planning/${effort}/map.md`, "warning");
        return;
      }
      ctx.ui.notify(renderStatus(r), "info");
    },
  });
}

/** Clear the active grill/effort for a session (called on session_shutdown in index.ts). */
export function endGrillForSession(state: RuntimeState, sessionId: string): void {
  state.activeGrillBySession.delete(sessionId);
  state.grillWithDocsBySession.delete(sessionId);
  state.activeEffortBySession.delete(sessionId);
  publishWayfindActive(state); // refresh; if no sessions remain, the seam reads false
  // If nothing is active anymore, unpublish so globalThis is clean.
  if (state.activeGrillBySession.size === 0 && state.activeEffortBySession.size === 0) {
    unpublishWayfindGrill();
    unpublishWayfindActive();
  }
}
