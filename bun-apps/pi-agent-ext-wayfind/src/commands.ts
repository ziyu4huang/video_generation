/**
 * Slash commands registered by pi-agent-ext-wayfind.
 *
 *   /grill me [topic]          — kick off a grilling session (interview only)
 *   /grill docs [topic]        — flagship: grilling + domain-modeling (paper trail)
 *   /grill done [--seed-plan]  — end the grill; optionally seed a task_plan.md
 *   /grill domain              — kick off the glossary + ADR discipline directly
 *
 *   /wayfind <destination>     — chart a new map, or (no args) work the next frontier ticket
 *   /wayfind status [effort]   — show the frontier + ticket counts
 *   /wayfind spec [effort]     — synthesize the conversation into a spec (was /to-spec)
 *   /wayfind tickets [effort]  — break a spec into tracer-bullet tickets (was /to-tickets)
 *   /wayfind seed [effort]     — seed a task_plan.md from tickets/decisions (was /plan-seed)
 *   /wayfind sync [effort]     — close tickets whose plan phase completed (was /chain-sync)
 *   /wayfind done [effort]     — closing ceremony: harvest the map into output/next-goal-<ts>.md
 *
 * Each subcommand's logic lives in its own private handler function, unchanged
 * from the pre-consolidation per-command registrations — only the routing
 * layer (two `pi.registerCommand` calls instead of ten) is new.
 *
 * Type-only imports keep this module cycle-free with index.ts.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { seedPlan, syncChainState } from "./chain.js";
import { PKG_NAME } from "./constants.js";
import {
  publishWayfindActive,
  publishWayfindGrill,
  unpublishWayfindActive,
  unpublishWayfindGrill,
} from "./coordination.js";
import { buildFreshnessWarning, checkFactFreshness } from "./freshness.js";
import { buildGrillPriming } from "./grill.js";
import type { WayfindOverlay } from "./overlay.js";
import { procedurePath } from "./procedures.js";
import { getSessionId, isGrillActive, type RuntimeState } from "./state.js";
import {
  chartMap,
  claimNextTicket,
  closeEffortReflection,
  effortSlug,
  renderStatus,
  statusReport,
} from "./wayfinder.js";

const WAYFIND_KEYWORDS = new Set(["status", "spec", "tickets", "seed", "sync", "done"]);

export function registerCommands(pi: ExtensionAPI, state: RuntimeState, overlay: WayfindOverlay): void {
  /** Shared kickoff: set the active-grill state, refresh the published seam, and
   *  send the priming user-message so the agent enters grilling mode. */
  function startGrill(ctx: ExtensionCommandContext, topic: string, withDocs: boolean): void {
    const sessionId = ctx.sessionManager.getSessionId();
    state.activeGrillBySession.set(sessionId, topic || "(current conversation)");
    state.grillWithDocsBySession.set(sessionId, withDocs);
    publishWayfindActive(state);
    publishWayfindGrill(state);
    const priming = buildGrillPriming(topic || undefined, withDocs);
    pi.sendUserMessage(priming, { deliverAs: "steer" });
  }

  async function handleGrillMe(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const topic = args.trim();
    startGrill(ctx, topic, false);
    overlay.setLine("grilling", `grilling${topic ? `: ${topic}` : ""}`);
    ctx.ui.notify(
      `[${PKG_NAME}] grill-me started${topic ? ` (${topic})` : ""}. The plan coordinator yields while the grill is active.`,
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
    publishWayfindActive(state);
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

  async function handleChainSync(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = args.trim() || state.activeEffortBySession.get(sessionId);
    if (!effort) {
      ctx.ui.notify(`Usage: /wayfind sync <effort>  (or run /wayfind <destination> first)`, "warning");
      return;
    }
    const r = syncChainState(ctx.cwd, effort);
    if (r.closed.length > 0) {
      ctx.ui.notify(`[${PKG_NAME}] Closed ${r.closed.length} ticket(s): ${r.closed.join(", ")}.`, "info");
    } else {
      ctx.ui.notify(
        `[${PKG_NAME}] sync: nothing to close${r.skipped.length > 0 ? ` (skipped: ${r.skipped.join(", ")})` : ""}.`,
        "info",
      );
    }
  }

  async function handleWayfindDone(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = args.trim() || state.activeEffortBySession.get(sessionId);
    if (!effort) {
      ctx.ui.notify(`Usage: /wayfind done <effort>  (or run /wayfind <destination> first)`, "warning");
      return;
    }
    const r = closeEffortReflection(ctx.cwd, effort);
    if ("refused" in r) {
      ctx.ui.notify(`[${PKG_NAME}] done: ${r.refused}`, "warning");
      return;
    }
    // Best-effort tidy (keep last N); the note is already written regardless.
    try {
      spawnSync("bash", ["scripts/tidy-next-goals.sh"], { cwd: ctx.cwd });
    } catch {
      // tidy is best-effort; ignore if bash / the script is unavailable.
    }
    overlay.setLine("done", `done: ${effort}`);
    ctx.ui.notify(
      `[${PKG_NAME}] done: wrote ${r.path} (${r.deferredPrizes.length} deferred prize(s)). Next goal: ${r.nextGoal} → present the choice via the ask_user_question tool (recommended ⭐).`,
      "info",
    );
  }

  async function handleWayfindSeed(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = args.trim() || state.activeEffortBySession.get(sessionId);
    if (!effort) {
      ctx.ui.notify(`Usage: /wayfind seed <effort>  (or run /wayfind <destination> first)`, "warning");
      return;
    }
    const outcome = seedPlan(ctx.cwd, { effort });
    if (!outcome) {
      ctx.ui.notify(`[${PKG_NAME}] seed: nothing to seed (no tickets, no CONTEXT.md decisions).`, "warning");
      return;
    }
    if ("refused" in outcome) {
      ctx.ui.notify(`[${PKG_NAME}] seed: ${outcome.refused} already exists — delete it first to re-seed.`, "warning");
      return;
    }
    overlay.setLine("seed", `seed: ${effort} (${outcome.source})`);
    ctx.ui.notify(
      `[${PKG_NAME}] Seeded ${outcome.path} (${outcome.phaseCount} phase(s), source: ${outcome.source}).`,
      "info",
    );
    pi.sendUserMessage(
      `Seeded ${outcome.path} from ${outcome.source}. Review the phases, then load the executing-plans (or subagent-driven-development) skill to execute the plan.`,
      {
        deliverAs: "steer",
      },
    );
  }

  async function handleToSpec(args: string, _ctx: ExtensionCommandContext): Promise<void> {
    const effort = args.trim() || undefined;
    pi.sendUserMessage(
      [
        "Synthesizing a spec from the current conversation.",
        "Load the `to-spec` skill: turn what's already on the table into a spec (PRD) — no interview, just synthesis.",
        "Use the project's CONTEXT.md glossary vocabulary; respect ADRs in the area you touch.",
        effort ? `Write the spec to .planning/${effort}/spec.md.` : "Write the spec to .planning/<effort>/spec.md.",
        "Tell me the path when written. The natural next step is /wayfind tickets, then /wayfind seed → executing-plans.",
      ].join("\n"),
      { deliverAs: "steer" },
    );
    overlay.setLine("to-spec", `spec${effort ? `: ${effort}` : ""}`);
  }

  async function handleToTickets(args: string, _ctx: ExtensionCommandContext): Promise<void> {
    const effort = args.trim() || undefined;
    pi.sendUserMessage(
      [
        "Breaking the work into tracer-bullet tickets.",
        "Load the `to-tickets` skill: vertical slices, each declaring its blocking edges.",
        effort
          ? `Write one ticket per file under .planning/${effort}/tickets/ (NN-slug.md).`
          : "Write one ticket per file under .planning/<effort>/tickets/ (NN-slug.md).",
        "Use the UNIFIED ticket format: YAML frontmatter (type/blocking/status) + ## Question + ## What to build + ## Acceptance — the same schema wayfinder uses (parseTicketFile reads it).",
        "Then flatten the frontier into a task_plan.md with /wayfind seed, then load the executing-plans (or subagent-driven-development) skill to execute the plan.",
      ].join("\n"),
      { deliverAs: "steer" },
    );
    overlay.setLine("to-tickets", `tickets${effort ? `: ${effort}` : ""}`);
  }

  async function handleWayfinderStatus(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = args.trim() || state.activeEffortBySession.get(sessionId);
    if (!effort) {
      ctx.ui.notify("Usage: /wayfind status <effort>  (or run /wayfind <destination> first)", "warning");
      return;
    }
    syncChainState(ctx.cwd, effort);
    const r = statusReport(ctx.cwd, effort);
    if (!r) {
      ctx.ui.notify(`No map at .planning/${effort}/map.md`, "warning");
      return;
    }
    ctx.ui.notify(renderStatus(r), "info");
  }

  async function handleWayfinderChart(destination: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const freshnessWarn = buildFreshnessWarning(checkFactFreshness(ctx.cwd));
    if (freshnessWarn) ctx.ui.notify(freshnessWarn, "warning");

    if (!destination) {
      const effort = state.activeEffortBySession.get(sessionId);
      if (!effort) {
        ctx.ui.notify(`Usage: /wayfind <destination> to chart a new map, or set an active effort first.`, "warning");
        return;
      }
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
      overlay.setActiveEffort(effort, ctx.cwd);
      publishWayfindActive(state);
      overlay.setLine("working-ticket", `${effort} — ticket ${claimed.id} ${claimed.title}`);
      pi.sendUserMessage(
        [
          `Working wayfinder ticket ${claimed.id} "${claimed.title}" on effort ${effort}.`,
          `Ticket type: ${claimed.type}. Full procedure (work-the-map — ticket types, fog graduation, closing ceremony): read ${procedurePath("wayfinder")}.`,
          `Question: ${claimed.question}`,
          "Resolve it (one ticket this session): record the answer, then close the ticket + append to the map's Decisions so far. Graduate any newly-specifiable fog into fresh tickets.",
          ...(freshnessWarn ? [freshnessWarn] : []),
        ].join("\n"),
        { deliverAs: "steer" },
      );
      return;
    }

    const effort = effortSlug(destination);
    chartMap(ctx.cwd, effort, destination);
    state.activeEffortBySession.set(sessionId, effort);
    overlay.setActiveEffort(effort, ctx.cwd);
    publishWayfindActive(state);
    overlay.setLine("charting", `charting ${effort}`);
    ctx.ui.notify(`[${PKG_NAME}] Map created at .planning/${effort}/map.md`, "info");
    pi.sendUserMessage(
      [
        `Charting a wayfinder map for: ${destination}`,
        `Full wayfinder procedure (chart-the-map mode — map body, ticket types, fog-of-war, closing ceremony): read ${procedurePath("wayfinder")}.`,
        "1. Grill to pin the destination + scope. 2. Map the frontier breadth-first — surface open decisions + first takeable steps. 3. If no fog surfaces, the journey is small enough to skip the map (tell me). 4. Otherwise create tickets under .planning/" +
          effort +
          "/tickets/ (one file each, wired with blocking edges).",
        ...(freshnessWarn ? [freshnessWarn] : []),
      ].join("\n"),
      { deliverAs: "steer" },
    );
  }

  pi.registerCommand("grill", {
    description:
      "Grilling family: 'me [topic]' (interview only), 'docs [topic]' (flagship, + CONTEXT.md/ADRs), 'done [--seed-plan]', 'domain' (glossary+ADR discipline directly)",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const remainder = rest.join(" ");
      switch (sub) {
        case "me":
          return handleGrillMe(remainder, ctx);
        case "docs":
          return handleGrillDocs(remainder, ctx);
        case "done":
          return handleGrillDone(remainder, ctx);
        case "domain":
          return handleGrillDomain(remainder, ctx);
        default:
          ctx.ui.notify("Usage: /grill me|docs|done|domain [args]", "warning");
      }
    },
  });

  pi.registerCommand("wayfind", {
    description:
      "Wayfinder family: '<destination>' (chart a map) or no args (work next ticket); 'status'/'spec'/'tickets'/'seed'/'sync'/'done' [effort]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [first, ...rest] = trimmed.split(/\s+/);
      const remainder = rest.join(" ");
      if (first && WAYFIND_KEYWORDS.has(first)) {
        switch (first) {
          case "status":
            return handleWayfinderStatus(remainder, ctx);
          case "spec":
            return handleToSpec(remainder, ctx);
          case "tickets":
            return handleToTickets(remainder, ctx);
          case "seed":
            return handleWayfindSeed(remainder, ctx);
          case "sync":
            return handleChainSync(remainder, ctx);
          case "done":
            return handleWayfindDone(remainder, ctx);
        }
      }
      return handleWayfinderChart(trimmed, ctx);
    },
  });
}

/** Clear the active grill/effort for a session (called on session_shutdown in index.ts). */
export function endGrillForSession(state: RuntimeState, sessionId: string): void {
  state.activeGrillBySession.delete(sessionId);
  state.grillWithDocsBySession.delete(sessionId);
  state.activeEffortBySession.delete(sessionId);
  publishWayfindActive(state);
  if (state.activeGrillBySession.size === 0 && state.activeEffortBySession.size === 0) {
    unpublishWayfindGrill();
    unpublishWayfindActive();
  }
}
