/**
 * Slash commands registered by s2-agent-ext-wayfind — thin dispatcher only.
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
 * Each subcommand's logic lives in its own handler module under ./commands/
 * (grill-handlers.ts, wayfind-handlers.ts; shared wiring in shared.ts, pure
 * helpers in help.ts, keyword tables in keywords.ts). This module owns only
 * routing: the two `pi.registerCommand` blocks, the ambiguous-phrase guard,
 * the banner logic, and the `--` force-chart escape — each guard lives once
 * here, never duplicated per-handler. Public surface re-exported below so
 * index.ts and tests keep importing from "./commands.js".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeGrillHandlers } from "./commands/grill-handlers.js";
import { resolveWayfindEffortId } from "./commands/help.js";
import { NO_BANNER_KEYWORDS, WAYFIND_KEYWORDS } from "./commands/keywords.js";
import { makeWayfindHandlers } from "./commands/wayfind-handlers.js";
import type { WayfindOverlay } from "./overlay.js";
import { getSessionId, type RuntimeState } from "./state.js";

export { endGrillForSession } from "./commands/grill-handlers.js";
export { renderWayfindHelp, resolveWayfindEffortId } from "./commands/help.js";

export function registerCommands(pi: ExtensionAPI, state: RuntimeState, overlay: WayfindOverlay): void {
  const grill = makeGrillHandlers(pi, state, overlay);
  const wayfind = makeWayfindHandlers(pi, state, overlay);

  pi.registerCommand("grill", {
    description:
      "Grilling family: 'me [topic]' (interview only), 'docs [topic]' (flagship, + CONTEXT.md/ADRs), 'done [--seed-plan]', 'domain' (glossary+ADR discipline directly)",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const remainder = rest.join(" ");
      switch (sub) {
        case "me":
          return grill.handleGrillMe(remainder, ctx);
        case "docs":
          return grill.handleGrillDocs(remainder, ctx);
        case "done":
          return grill.handleGrillDone(remainder, ctx);
        case "domain":
          return grill.handleGrillDomain(remainder, ctx);
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
        return wayfind.status("", ctx);
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
        return wayfind.chart(destination, ctx);
      }
      const [first, ...rest] = trimmed.split(/\s+/);
      const remainder = rest.join(" ");
      if (first && WAYFIND_KEYWORDS.has(first)) {
        switch (first) {
          case "status":
            return wayfind.status(remainder, ctx);
          case "spec":
            return wayfind.spec(remainder, ctx);
          case "tickets":
            return wayfind.tickets(remainder, ctx);
          case "seed":
            return wayfind.seed(remainder, ctx);
          case "sync":
            return wayfind.sync(remainder, ctx);
          case "done":
            return wayfind.done(remainder, ctx);
          case "validate":
            return wayfind.validate(remainder, ctx);
          case "statusbar":
            return wayfind.statusbar(remainder, ctx);
          case "help":
          case "usage":
            return wayfind.help(remainder, ctx);
        }
      }
      return wayfind.chart(trimmed, ctx);
    },
  });
}
