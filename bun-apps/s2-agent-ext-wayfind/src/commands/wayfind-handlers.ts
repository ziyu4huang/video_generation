/**
 * /wayfind family handlers (chart, status, spec, tickets, seed, sync, done,
 * validate, statusbar, help). Bodies moved verbatim from commands.ts (Task 9);
 * only the closure wiring changed — effort resolution comes from
 * makeCommandHelpers and the shared keyword tables from keywords.ts.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { seedPlan, syncChainState } from "../chain.js";
import { PKG_NAME } from "../constants.js";
import { adoptMostRecentActiveEffort } from "../effort-query.js";
import { renderStatus, renderValidate } from "../effort-render.js";
import { effortStatus, validateEffort } from "../effort-tool.js";
import { buildFreshnessWarning, checkFactFreshness } from "../freshness.js";
import { readEffortMeta } from "../lifecycle.js";
import type { WayfindOverlay } from "../overlay.js";
import { procedurePath } from "../procedures.js";
import { writeWayfindStatusBar } from "../settings.js";
import { getSessionId, type RuntimeState } from "../state.js";
import { tidyNextGoals } from "../tidy-next-goals.js";
import { chartMap, claimNextTicket, closeEffortReflection, effortSlug } from "../wayfinder.js";
import { renderWayfindHelp } from "./help.js";
import { PLACEHOLDER_DESTINATIONS } from "./keywords.js";
import { makeCommandHelpers } from "./shared.js";

export function makeWayfindHandlers(pi: ExtensionAPI, state: RuntimeState, overlay: WayfindOverlay) {
  const { resolveEffortOrWarn } = makeCommandHelpers(pi, state);

  async function handleChainSync(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = resolveEffortOrWarn(args, ctx, sessionId);
    if (!effort) return;
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
    const effort = resolveEffortOrWarn(args, ctx, sessionId);
    if (!effort) return;
    const r = await closeEffortReflection(ctx.cwd, effort);
    if ("refused" in r) {
      ctx.ui.notify(`[${PKG_NAME}] done: ${r.refused}`, "warning");
      return;
    }
    // Best-effort tidy (keep last N); the note is already written regardless.
    try {
      tidyNextGoals(ctx.cwd);
    } catch {
      // tidy is best-effort; ignore if output/ is unavailable.
    }
    // The closing ceremony succeeded — clear the overlay's active effort so the
    // opt-in idle line stops rendering this completed effort (auto-hide). The
    // toggle itself stays on, so the NEXT effort surfaces automatically once
    // it's set active. The transient `done` line below takes precedence this
    // turn; once turn_end clears it, the (now empty) idle branch renders [].
    overlay.setActiveEffort(undefined, undefined);
    overlay.setLine("done", `done: ${effort}`);
    const filedNote = r.filedTo ? ` · filed to ${r.filedTo}` : r.fileError ? ` · filing failed: ${r.fileError}` : "";
    ctx.ui.notify(
      `[${PKG_NAME}] done: wrote ${r.path} (${r.deferredPrizes.length} deferred prize(s))${filedNote}. Next goal: ${r.nextGoal} → present the choice via the ask_user_question tool (recommended ⭐).`,
      "info",
    );
  }

  async function handleWayfindSeed(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = resolveEffortOrWarn(args, ctx, sessionId);
    if (!effort) return;
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

  async function handleWayfindValidate(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = resolveEffortOrWarn(args, ctx, sessionId);
    if (!effort) return;
    ctx.ui.notify(renderValidate(validateEffort(ctx.cwd, effort)), "info");
  }

  async function handleWayfinderStatus(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = resolveEffortOrWarn(args, ctx, sessionId);
    if (!effort) return;
    syncChainState(ctx.cwd, effort);
    const r = effortStatus(ctx.cwd, effort);
    if (!r.ok) {
      ctx.ui.notify(`No map at .planning/${effort}/map.md`, "warning");
      return;
    }
    ctx.ui.notify(renderStatus(r), "info");
    // Notify-only by design — never auto-steer from status. But leave the user
    // a resume breadcrumb derived from the report's own counts: open tickets
    // remain → bare /wayfind claims the next one; frontier clear → chart next.
    ctx.ui.notify(
      r.open > 0
        ? "Resume: /wayfind  (claims the next ticket)"
        : "All done — chart the next effort: /wayfind <destination>",
      "info",
    );
  }

  /** `/wayfind statusbar [on|off]` — toggle the opt-in persistent effort status
   *  bar. No arg → toggles. Persisted in ~/.pi/agent/settings.json under
   *  `wayfindStatusBar` (default off). When enabling and an effort is active,
   *  push it onto the overlay so the line renders immediately this turn. */
  async function handleWayfindStatusbar(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const trimmed = args.trim();
    let next: boolean;
    if (trimmed === "on") next = true;
    else if (trimmed === "off") next = false;
    else next = !overlay.isStatusBarEnabled();

    const activeEffort = state.activeEffortBySession.get(sessionId);
    // If enabling and an effort is already active, push it so the idle line
    // renders this very turn (not just on the next refresh).
    if (next && activeEffort) overlay.setActiveEffort(activeEffort, ctx.cwd);
    overlay.setStatusBarEnabled(next);
    writeWayfindStatusBar(next);

    if (next) {
      if (activeEffort) {
        const status = readEffortMeta(ctx.cwd, activeEffort)?.status ?? "(no manifest)";
        ctx.ui.notify(`🧭 status bar on — showing ${activeEffort} · ${status}`, "info");
      } else {
        ctx.ui.notify("🧭 status bar on — start an effort with /wayfind <destination> to see it here", "info");
      }
    } else {
      ctx.ui.notify("🧭 status bar off", "info");
    }
  }

  /** `/wayfind help` (alias: `usage`) — notify the full usage overview:
   *  subcommand table + efforts on disk + next steps. Takes no effort arg. */
  function handleWayfindHelp(_args: string, ctx: ExtensionCommandContext): void {
    const sessionId = getSessionId(ctx);
    ctx.ui.notify(renderWayfindHelp(ctx.cwd, state.activeEffortBySession.get(sessionId)), "info");
  }

  async function handleWayfinderChart(destination: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const freshnessWarn = buildFreshnessWarning(checkFactFreshness(ctx.cwd));
    if (freshnessWarn) ctx.ui.notify(freshnessWarn, "warning");

    if (!destination) {
      // Bugfix — bare /wayfind no-op. activeEffortBySession is in-memory and
      // per-process (never restored on resume), so a fresh/resumed session used
      // to hit a toast-only usage warning even with `status: active` efforts
      // sitting on disk — zero persisted trace, no steer, no claim. Now: fall
      // back to disk and adopt the most-recently-modified active effort, then
      // run the exact same claim path as the in-memory branch below.
      let effort = state.activeEffortBySession.get(sessionId);
      if (!effort) {
        const adopted = adoptMostRecentActiveEffort(ctx.cwd);
        if (adopted) {
          effort = adopted.effort;
          ctx.ui.notify(
            `🧭 No active effort in this session — adopting ${effort} (most recent of ${adopted.activeCount} active on disk). Use /wayfind -- <destination> to chart a different one.`,
            "info",
          );
        }
      }
      if (!effort) {
        // Nothing chartable anywhere — show the full usage overview (incl.
        // efforts on disk) instead of a dead-end one-liner.
        ctx.ui.notify(renderWayfindHelp(ctx.cwd, undefined), "warning");
        return;
      }
      syncChainState(ctx.cwd, effort);
      const claimed = claimNextTicket(ctx.cwd, effort, sessionId);
      if (!claimed) {
        const r = effortStatus(ctx.cwd, effort);
        ctx.ui.notify(
          r.ok
            ? `${renderStatus(r)}\nNo unclaimed frontier ticket — chart more or resolve claimed ones.`
            : `No map at .planning/${effort}/`,
          "info",
        );
        return;
      }
      state.activeEffortBySession.set(sessionId, effort);
      overlay.setActiveEffort(effort, ctx.cwd);
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

    const normalizedDestination = destination.trim().toLowerCase();
    if (PLACEHOLDER_DESTINATIONS.has(normalizedDestination)) {
      ctx.ui.notify(
        `[${PKG_NAME}] "${destination.trim()}" looks like a placeholder, not an effort name. Run /wayfind with no arguments to work the next frontier ticket, or pass a concrete destination (e.g. /wayfind -- resume-zk-spawn).`,
        "warning",
      );
      return;
    }

    const effort = effortSlug(destination);
    chartMap(ctx.cwd, effort, destination);
    state.activeEffortBySession.set(sessionId, effort);
    overlay.setActiveEffort(effort, ctx.cwd);
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

  return {
    chart: handleWayfinderChart,
    status: handleWayfinderStatus,
    spec: handleToSpec,
    tickets: handleToTickets,
    seed: handleWayfindSeed,
    sync: handleChainSync,
    done: handleWayfindDone,
    validate: handleWayfindValidate,
    statusbar: handleWayfindStatusbar,
    help: handleWayfindHelp,
  };
}
