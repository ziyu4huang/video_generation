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
 *   /wayfind help               — usage overview: subcommand table + efforts on disk (alias: usage)
 *
 * Each subcommand's logic lives in its own private handler function, unchanged
 * from the pre-consolidation per-command registrations — only the routing
 * layer (two `pi.registerCommand` calls instead of ten) is new.
 *
 * Type-only imports keep this module cycle-free with index.ts.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { seedPlan, syncChainState } from "./chain.js";
import { PKG_NAME } from "./constants.js";
import { publishWayfindGrill, unpublishWayfindGrill } from "./coordination.js";
import { adoptMostRecentActiveEffort, listEfforts } from "./effort-query.js";
import { renderValidate, validateEffort } from "./effort-tool.js";
import { buildFreshnessWarning, checkFactFreshness } from "./freshness.js";
import { buildGrillPriming } from "./grill.js";
import { readEffortMeta } from "./lifecycle.js";
import type { WayfindOverlay } from "./overlay.js";
import { procedurePath } from "./procedures.js";
import { writeWayfindStatusBar } from "./settings.js";
import { getSessionId, isGrillActive, type RuntimeState } from "./state.js";
import { tidyNextGoals } from "./tidy-next-goals.js";
import {
  chartMap,
  claimNextTicket,
  closeEffortReflection,
  effortSlug,
  renderStatus,
  statusReport,
} from "./wayfinder.js";

const WAYFIND_KEYWORDS = new Set([
  "status",
  "spec",
  "tickets",
  "seed",
  "sync",
  "done",
  "validate",
  "statusbar",
  "help",
  "usage",
]);

/** Subcommand keywords whose remainder is NOT an effort id — the dispatcher
 *  never banners these (statusbar takes on|off; help/usage take nothing). */
const NO_BANNER_KEYWORDS = new Set(["statusbar", "help", "usage"]);

// Guard: placeholder words passed as destinations almost always mean "work the next frontier", not a new effort named e.g. "next".
const PLACEHOLDER_DESTINATIONS = new Set([
  "next",
  "continue",
  "later",
  "now",
  "new",
  "todo",
  "today",
  "current",
  "frontier",
  "latest",
]);

/** Resolve the effort id in play for a `/wayfind <args>` invocation, so the
 *  dispatcher can banner it on EVERY run. Mirrors the dispatcher's own parsing
 *  (force-chart `--`, reserved-keyword subcommand, bare chart, no-arg claim) so
 *  the banner always matches the effort the subcommand operates on. Returns
 *  undefined only when no effort is in play yet (bare `/wayfind` with no active
 *  effort → a usage warning follows; no banner). Pure: takes the trimmed arg
 *  plus an active-effort lookup so it is unit-testable without a live session. */
export function resolveWayfindEffortId(trimmed: string, getActive: () => string | undefined): string | undefined {
  if (trimmed.startsWith("--")) {
    const destination = trimmed.slice(2).trim();
    return destination ? effortSlug(destination) : getActive();
  }
  const [first, ...rest] = trimmed.split(/\s+/);
  if (first && WAYFIND_KEYWORDS.has(first)) {
    return rest.join(" ").trim() || getActive();
  }
  if (trimmed) return effortSlug(trimmed);
  return getActive();
}

/** Render the full `/wayfind` usage overview: subcommand table, efforts on
 *  disk, and next steps. The on-disk section reuses {@link listEfforts} — the
 *  same read path bare-/wayfind adoption uses — ranked by map.md mtime,
 *  newest first (the same signal adoptMostRecentActiveEffort ranks by), capped
 *  at 10. Pure: takes cwd + the session's active effort slug (marked
 *  `(active)` in the listing) so it is unit-testable without a live session. */
export function renderWayfindHelp(cwd: string, activeEffort: string | undefined): string {
  const lines: string[] = [
    "🧭 wayfind — usage",
    "",
    "  /wayfind <destination>      chart a new effort: grill + map the frontier under .planning/<effort>/",
    "  /wayfind                    resume the active effort: claim + steer the next frontier ticket",
    "  /wayfind status [effort]    frontier + open/closed/claimed/fog counts (auto-closes completed plan phases)",
    "  /wayfind spec [effort]      steer: synthesize this conversation into .planning/<effort>/spec.md",
    "  /wayfind tickets [effort]   steer: break the spec into tracer-bullet tickets under .planning/<effort>/tickets/",
    "  /wayfind seed [effort]      flatten tickets/decisions into .planning/<effort>/task_plan.md (refuses to overwrite)",
    "  /wayfind sync [effort]      close tickets whose task_plan phase completed",
    "  /wayfind done [effort]      closing ceremony: harvest to output/next-goal-<ts>.md + archive to .planning/done/",
    "  /wayfind validate [effort]  check map/manifest/ticket conformance",
    "  /wayfind statusbar on|off   toggle the persistent effort status bar",
    "  /wayfind help               this overview (alias: usage)",
    "  /wayfind -- <destination>   force-chart a name that starts with a reserved keyword",
    "",
    "  [effort]: explicit id, else the session's active effort (status, seed, sync, done, validate);",
    "  spec/tickets use it only to name the output dir.",
    "",
    "Efforts on disk (most recent first):",
  ];
  const ranked = listEfforts(cwd)
    .efforts.map((e) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(cwd, ".planning", e.slug, "map.md")).mtimeMs;
      } catch {
        // unreadable map.md — rank last (mtime 0), still listed
      }
      return { e, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.e.slug.localeCompare(b.e.slug));
  if (ranked.length === 0) lines.push("  (none — chart one with /wayfind <destination>)");
  for (const { e } of ranked.slice(0, 10)) {
    lines.push(
      `  ${e.slug}${e.slug === activeEffort ? " (active)" : ""} — ${e.status} · open ${e.ticketCounts.open} / closed ${e.ticketCounts.closed}`,
    );
  }
  if (ranked.length > 10) lines.push(`  … +${ranked.length - 10} more`);
  lines.push(
    "Next steps: inspect with /wayfind status <effort> · resume with bare /wayfind · chart new with /wayfind <destination>",
  );
  return lines.join("\n");
}

export function registerCommands(pi: ExtensionAPI, state: RuntimeState, overlay: WayfindOverlay): void {
  /** Shared kickoff: set the active-grill state, publish the grill seam, and
   *  send the priming user-message so the agent enters grilling mode. */
  function startGrill(ctx: ExtensionCommandContext, topic: string, withDocs: boolean): void {
    const sessionId = ctx.sessionManager.getSessionId();
    state.activeGrillBySession.set(sessionId, topic || "(current conversation)");
    state.grillWithDocsBySession.set(sessionId, withDocs);
    publishWayfindGrill(state);
    const priming = buildGrillPriming(topic || undefined, withDocs);
    pi.sendUserMessage(priming, { deliverAs: "steer" });
  }

  /** Resolve the active effort for a `/wayfind <cmd> <effort>` subcommand: an
   *  explicit arg wins, else fall back to the session's active effort. If
   *  neither resolves, notify the full usage overview (subcommands + efforts
   *  on disk) and return undefined. */
  function resolveEffortOrWarn(
    _command: string,
    args: string,
    ctx: ExtensionCommandContext,
    sessionId: string,
  ): string | undefined {
    const effort = args.trim() || state.activeEffortBySession.get(sessionId);
    if (!effort) {
      // No effort resolvable — notify the full usage overview (subcommands +
      // efforts on disk) so the user can pick/copy a name, not a bare one-liner.
      ctx.ui.notify(renderWayfindHelp(ctx.cwd, undefined), "warning");
      return undefined;
    }
    return effort;
  }

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

  async function handleChainSync(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = resolveEffortOrWarn("sync", args, ctx, sessionId);
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
    const effort = resolveEffortOrWarn("done", args, ctx, sessionId);
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
    const effort = resolveEffortOrWarn("seed", args, ctx, sessionId);
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
    const effort = resolveEffortOrWarn("validate", args, ctx, sessionId);
    if (!effort) return;
    ctx.ui.notify(renderValidate(validateEffort(ctx.cwd, effort)), "info");
  }

  async function handleWayfinderStatus(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = resolveEffortOrWarn("status", args, ctx, sessionId);
    if (!effort) return;
    syncChainState(ctx.cwd, effort);
    const r = statusReport(ctx.cwd, effort);
    if (!r) {
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
      "Wayfinder family: '<destination>' (chart a map) or no args (work next ticket); 'status'/'spec'/'tickets'/'seed'/'sync'/'validate'/'done' [effort]; 'help' (usage overview); '-- <destination>' force-charts a name that starts with a reserved keyword",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      // Always banner the wayfind id (effort slug) for this invocation — one
      // notify at the dispatcher top so EVERY /wayfind surfaces it, regardless
      // of subcommand. No banner when no effort is in play yet (bare /wayfind
      // with no active effort → a usage warning follows instead).
      const sessionId = getSessionId(ctx);
      // Bugfix — ambiguous-phrase guard. A bare non-keyword phrase while an effort
      // is already active is almost certainly a QUESTION about the current effort
      // (e.g. "show current effort id status"), not a new destination. Previously
      // this fell through to handleWayfinderChart, silently charting a brand-new
      // effort (writing .planning/<slug>/) AND clobbering the session's active
      // effort with no guard. Now: show the active effort's status and steer to the
      // explicit `/wayfind -- <destination>` escape to start a new effort.
      // First-chart (no active effort) and explicit `-- ` chart are unchanged.
      const firstToken = trimmed.split(/\s+/)[0] ?? "";
      const isExplicitChart = trimmed.startsWith("--") || WAYFIND_KEYWORDS.has(firstToken);
      const activeEffort = state.activeEffortBySession.get(sessionId);
      if (trimmed && activeEffort && !isExplicitChart) {
        ctx.ui.notify(
          `🧭 ${activeEffort} (active) — showing its status. Use \`/wayfind -- <destination>\` to start a NEW effort.`,
          "info",
        );
        return handleWayfinderStatus("", ctx);
      }
      const bannerEffort = resolveWayfindEffortId(trimmed, () => state.activeEffortBySession.get(sessionId));
      // The `statusbar`/`help`/`usage` subcommands take no effort id — never
      // banner them. Every other keyword banners the resolved effort id.
      if (bannerEffort && !NO_BANNER_KEYWORDS.has(firstToken)) ctx.ui.notify(`🧭 ${bannerEffort}`, "info");
      // "/wayfind -- <destination>" forces charting, escaping reserved keywords
      // (e.g. an effort named "sync the database"). Bare keywords still win.
      if (trimmed.startsWith("--")) {
        const destination = trimmed.slice(2).trim();
        if (!destination) {
          ctx.ui.notify(
            "Usage: /wayfind -- <destination>  (force-chart a name that starts with a reserved keyword like status/spec/tickets/seed/sync/done/validate)",
            "warning",
          );
          return;
        }
        return handleWayfinderChart(destination, ctx);
      }
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
          case "validate":
            return handleWayfindValidate(remainder, ctx);
          case "statusbar":
            return handleWayfindStatusbar(remainder, ctx);
          case "help":
          case "usage":
            return handleWayfindHelp(remainder, ctx);
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
  if (state.activeGrillBySession.size === 0 && state.activeEffortBySession.size === 0) {
    unpublishWayfindGrill();
  }
}
