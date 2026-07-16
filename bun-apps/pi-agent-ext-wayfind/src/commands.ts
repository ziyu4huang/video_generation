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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { seedPlan, syncChainState } from "./chain.js";
import { PKG_NAME } from "./constants.js";
import {
  publishWayfindActive,
  publishWayfindGrill,
  unpublishWayfindActive,
  unpublishWayfindGrill,
} from "./coordination.js";
import { buildGrillPriming } from "./grill.js";
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

      // Phase 4: delegate to the route-aware seeder. It reads CONTEXT.md
      // decisions + glossary itself, writes root task_plan.md, and refuses to
      // overwrite an in-progress plan. Replaces the old skeleton-only seed.
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
          `[${PKG_NAME}] --seed-plan: ${outcome.refused} already exists — run /plan-done --delete first to re-seed.`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(
        `[${PKG_NAME}] Seeded ${outcome.path} (${outcome.phaseCount} phase(s), source: ${outcome.source}).`,
        "info",
      );
      pi.sendUserMessage(
        `Grill ended. I seeded ${outcome.path} from ${outcome.source}. Review the phases, then run /plan-execute (planning-with-files).`,
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

  pi.registerCommand("chain-sync", {
    description:
      "Close wayfind tickets whose planning-with-files phase reported complete (ADR-0001 feedback handle). [effort]",
    handler: async (args, ctx) => {
      const sessionId = getSessionId(ctx);
      const effort = args.trim() || state.activeEffortBySession.get(sessionId);
      if (!effort) {
        ctx.ui.notify(`Usage: /chain-sync <effort>  (or run /wayfinder <destination> first)`, "warning");
        return;
      }
      const r = syncChainState(ctx.cwd, effort);
      if (r.closed.length > 0) {
        ctx.ui.notify(`[${PKG_NAME}] Closed ${r.closed.length} ticket(s): ${r.closed.join(", ")}.`, "info");
      } else {
        ctx.ui.notify(
          `[${PKG_NAME}] chain-sync: nothing to close${r.skipped.length > 0 ? ` (skipped: ${r.skipped.join(", ")})` : ""}.`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("plan-seed", {
    description:
      "Seed a task_plan.md from an effort's tickets (topo-sorted, [ticket-id] phase headers) or CONTEXT.md decisions. [effort]",
    handler: async (args, ctx) => {
      const sessionId = getSessionId(ctx);
      const effort = args.trim() || state.activeEffortBySession.get(sessionId);
      if (!effort) {
        ctx.ui.notify(`Usage: /plan-seed <effort>  (or run /wayfinder <destination> first)`, "warning");
        return;
      }
      const outcome = seedPlan(ctx.cwd, { effort });
      if (!outcome) {
        ctx.ui.notify(`[${PKG_NAME}] plan-seed: nothing to seed (no tickets, no CONTEXT.md decisions).`, "warning");
        return;
      }
      if ("refused" in outcome) {
        ctx.ui.notify(
          `[${PKG_NAME}] plan-seed: ${outcome.refused} already exists — run /plan-done --delete first to re-seed.`,
          "warning",
        );
        return;
      }
      ctx.ui.setStatus(PKG_NAME, `plan-seed: ${effort} (${outcome.source})`);
      ctx.ui.notify(
        `[${PKG_NAME}] Seeded ${outcome.path} (${outcome.phaseCount} phase(s), source: ${outcome.source}).`,
        "info",
      );
      pi.sendUserMessage(
        `Seeded ${outcome.path} from ${outcome.source}. Review the phases, then run /plan-execute (planning-with-files).`,
        { deliverAs: "steer" },
      );
    },
  });

  pi.registerCommand("to-spec", {
    description:
      "Synthesize the current conversation + codebase into a spec (PRD) at .planning/<effort>/spec.md. [effort]",
    handler: async (args, ctx) => {
      const effort = args.trim() || undefined;
      pi.sendUserMessage(
        [
          "Synthesizing a spec from the current conversation.",
          "Load the `to-spec` skill: turn what's already on the table into a spec (PRD) — no interview, just synthesis.",
          "Use the project's CONTEXT.md glossary vocabulary; respect ADRs in the area you touch.",
          effort
            ? `Write the spec to .planning/${effort}/spec.md.`
            : "Write the spec to .planning/<effort>/spec.md (or docs/specs/<slug>.md).",
          "Tell me the path when written. The natural next step is /to-tickets, then /plan-seed → /plan-execute.",
        ].join("\n"),
        { deliverAs: "steer" },
      );
      ctx.ui.setStatus(PKG_NAME, `to-spec${effort ? `: ${effort}` : ""}`);
    },
  });

  pi.registerCommand("to-tickets", {
    description:
      "Break a spec/plan/conversation into tracer-bullet tickets (unified format) under .planning/<effort>/tickets/. [effort]",
    handler: async (args, ctx) => {
      const effort = args.trim() || undefined;
      pi.sendUserMessage(
        [
          "Breaking the work into tracer-bullet tickets.",
          "Load the `to-tickets` skill: vertical slices, each declaring its blocking edges.",
          effort
            ? `Write one ticket per file under .planning/${effort}/tickets/ (NN-slug.md).`
            : "Write one ticket per file under .planning/<effort>/tickets/ (NN-slug.md).",
          "Use the UNIFIED ticket format: YAML frontmatter (type/blocking/status) + ## Question + ## What to build + ## Acceptance — the same schema wayfinder uses (parseTicketFile reads it).",
          "Then flatten the frontier into a task_plan.md with /plan-seed, and run /plan-execute (planning-with-files).",
        ].join("\n"),
        { deliverAs: "steer" },
      );
      ctx.ui.setStatus(PKG_NAME, `to-tickets${effort ? `: ${effort}` : ""}`);
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
        // Touchpoint auto-sync (ADR-0001): close completed-phase tickets before
        // claiming the next frontier ticket. Idempotent + graceful (no-op if pwf absent).
        syncChainState(ctx.cwd, effort);
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
      // Touchpoint auto-sync (ADR-0001): close any tickets whose phase just
      // completed before rendering, so the frontier reflects reality. Idempotent.
      syncChainState(ctx.cwd, effort);
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
