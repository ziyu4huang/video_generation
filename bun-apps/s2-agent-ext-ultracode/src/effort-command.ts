/**
 * Standing `/effort` opt-in (pi's answer to CC's ultracode): a session toggle that
 * auto-arms a workflow for substantive interactive messages, with effort-tier
 * guidance nudging fan-out breadth and the hard caps (tokenBudget / maxAgents) the
 * model should set on the workflow tool call.
 *
 * Honest scope: the runtime cannot enforce "reviewer N / loop K" — those live in
 * the script the model writes — so the tiers are guidance plus the model setting
 * the real hard caps (tokenBudget/maxAgents are genuine runtime ceilings). The
 * pre-flight ceiling-confirm for armed unbounded runs now lives at the tool
 * boundary (see preflightCeilingDecision below + workflow-tool.ts) — an `input`
 * hook here still transforms synchronously and cannot await a confirm;
 * `/effort` remains explicit opt-in, which is the safety valve.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type EffortLevel = "off" | "high" | "ultra";

export interface EffortState {
  level: EffortLevel;
}

export function createEffortState(): EffortState {
  return { level: "off" };
}

// CC-parity directives (2026-08-25 ultracode-cc-parity t01): each carries the
// scale-to-request ladder and the quality-pattern names inline, so an armed
// message teaches the model HOW to scale without a workflow_help detour. Keep
// them compact — they append to EVERY armed message.
const HIGH_DIRECTIVE =
  "Effort: HIGH. Author a workflow scaled to the request: a quick check needs a few finders plus single-vote verify(item); a broader ask gets a wider pool, verify(item, {reviewers: 3, lens}) for adversarial cross-checking, and a final big-tier synthesis agent returning a compact {ok, verdict} result. Filter nulls before synthesizing. Token thrift is not the constraint — coverage is; cap spend only when the user set an explicit budget.";
const ULTRA_DIRECTIVE =
  "Effort: ULTRA. Be exhaustive: wide fan-out (more reviewers/judges, deeper loopUntilDry() rounds), adversarial verify(item, {reviewers: 3-5, lens}), a judgePanel() where candidates compete, and a closing completenessCheck() plus big-tier synthesis agent returning a compact {ok, verdict} result. For multi-phase work, run one workflow per phase and read each result before authoring the next. Token thrift is not the constraint — set a high maxAgents, and leave tokenBudget unset (unbounded) unless the user set an explicit budget directive.";

/** The extra directive appended to the forced-workflow prompt for an effort level. */
export function effortDirective(level: EffortLevel): string | undefined {
  if (level === "high") return HIGH_DIRECTIVE;
  if (level === "ultra") return ULTRA_DIRECTIVE;
  return undefined;
}

/**
 * Whether a message should auto-arm under effort mode: a real interactive request,
 * not a terse acknowledgement or a slash command. (hasTrigger handles the explicit
 * "workflow(s)" keyword separately.)
 */
export function isSubstantive(text: string): boolean {
  const t = text.trim();
  return t.length >= 16 && !t.startsWith("/");
}

// ── Pre-flight ceiling-confirm (self-arc-24 t02) ─────────────────────────────
// Resolves the gap self-charted in this file's header (old roadmap "P1-5 #4"):
// an ultra-armed message used to launch a potentially huge fan-out with NO
// downscope point. The gate lives at the TOOL boundary (workflow-tool.ts),
// where tokenBudget/maxAgents are known and an await is possible — the input
// hook here transforms synchronously and still cannot ask.

/** Budget choice 2 of the pre-flight dialog injects when the caller set none. */
export const ULTRA_SUGGESTED_TOKEN_BUDGET = 1_000_000;

/** Armed ultra runs at or above this agent count are considered "wide fan-out". */
export const ULTRA_WIDE_FANOUT_MIN_AGENTS = 8;

export type CeilingDecision =
  | { action: "confirm"; maxAgents: number }
  | { action: "skip"; reason: "no-ui" | "not-ultra" | "budget-present" | "narrow-fanout" };

/**
 * Pure gate predicate for the pre-flight ceiling-confirm. Confirms only when a
 * dialog can actually be shown, effort is ULTRA-armed, the caller set NO token
 * budget, and the fan-out is wide (explicit >= ULTRA_WIDE_FANOUT_MIN_AGENTS, or
 * unspecified — the ultra directive itself tells the model to set a high
 * maxAgents). Everything else skips with its reason.
 */
export function preflightCeilingDecision(input: {
  effortLevel: EffortLevel;
  tokenBudget?: number;
  maxAgents?: number;
  hasSelectionUi: boolean;
}): CeilingDecision {
  if (!input.hasSelectionUi) return { action: "skip", reason: "no-ui" };
  if (input.effortLevel !== "ultra") return { action: "skip", reason: "not-ultra" };
  if (input.tokenBudget !== undefined) return { action: "skip", reason: "budget-present" };
  if (input.maxAgents !== undefined && input.maxAgents < ULTRA_WIDE_FANOUT_MIN_AGENTS) {
    return { action: "skip", reason: "narrow-fanout" };
  }
  return { action: "confirm", maxAgents: input.maxAgents ?? ULTRA_WIDE_FANOUT_MIN_AGENTS };
}

export function registerEffortCommand(pi: ExtensionAPI, state: EffortState): void {
  pi.registerCommand("effort", {
    description: "Standing workflow effort: off | high | ultra — auto-arms a workflow for substantive messages",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "effort", content, display: true });
      if (arg === "off" || arg === "high" || arg === "ultra") {
        state.level = arg;
        await say(
          arg === "off"
            ? "Effort off — messages are no longer auto-armed as workflows."
            : `Effort ${arg} — substantive messages now auto-arm a workflow (${arg === "ultra" ? "exhaustive" : "thorough"} fan-out). Use /effort off to stop.`,
        );
        return;
      }
      await say(`Effort is currently "${state.level}". Usage: /effort off | high | ultra`);
    },
  });

  // `/ultracode` — the headline name for the maximal-effort mode (Pi's ultracode):
  // `/ultracode` turns it on, `/ultracode off` turns it off. Alias for /effort ultra.
  pi.registerCommand("ultracode", {
    description:
      "Ultracode: standing maximal-effort mode — auto-arms an exhaustive workflow for substantive messages. /ultracode off to stop.",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "effort", content, display: true });
      if (arg === "off") {
        state.level = "off";
        await say("Ultracode off — messages are no longer auto-armed as workflows.");
        return;
      }
      state.level = "ultra";
      await say(
        "Ultracode ON — substantive messages now auto-arm an exhaustive workflow (wide fan-out, big-tier synthesis). Use /ultracode off to stop.",
      );
    },
  });
}
