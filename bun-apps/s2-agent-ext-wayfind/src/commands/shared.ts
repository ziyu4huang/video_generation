/**
 * Cross-family command helpers shared by the grill and wayfind handler
 * modules: grill kickoff (state + seam publish + priming steer) and
 * effort-resolution-with-warning. Factory form because the helpers close
 * over `pi` and `state`. Moved verbatim from commands.ts (Task 9).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { publishWayfindGrill } from "../coordination.js";
import { buildGrillPriming } from "../grill.js";
import type { RuntimeState } from "../state.js";
import { renderWayfindHelp } from "./help.js";

export function makeCommandHelpers(pi: ExtensionAPI, state: RuntimeState) {
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

  return { startGrill, resolveEffortOrWarn };
}
