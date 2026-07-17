/**
 * Slash commands registered by the planning-with-files extension.
 *
 *   /plan status                     — show phase counts for the active plan
 *   /plan execute [reset]            — approve the active plan & activate the hooks
 *   /plan done [--delete]            — close the active plan (stop all nags)
 *   /plan attest [--show|--clear]    — SHA-256 lock the active plan
 *   /plan goal <text>                — set/clear the auto-continue goal condition
 *   /plan loop [interval]            — start/stop periodic plan-loop ticks
 *   /plan list                       — list all plans under .planning/ (+ root)
 *   /plan lint [--all]               — diagnose a plan
 *   /plan switch <id>                — pin the active plan
 *
 * Each subcommand's logic lives in its own private handler function, unchanged
 * from the pre-consolidation per-command registrations — only the routing
 * layer (one `pi.registerCommand` call instead of nine) is new.
 *
 * Type-only imports from `./runtime.js` (RuntimeState) are erased at compile
 * time, so this module does NOT create a runtime ESM cycle with runtime.ts.
 */

import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { attestPlan, buildTamperMessage, checkPlanAttestation } from "./attestation.js";
import {
  CLOSE_MARKER_COMMENT,
  CLOSE_MARKER_NOTE,
  DEFAULT_GOAL_CONDITION,
  DEFAULT_LOOP_INTERVAL_MS,
  DEFAULT_LOOP_PROMPT,
  PKG_NAME,
} from "./constants.js";
import { enumeratePlans, lintAllPlans, lintPlan, renderPlanList, switchActivePlan } from "./lifecycle.js";
import { deriveEffectiveMode, resolveConfiguredMode } from "./modes.js";
import type { PlanningOverlay } from "./overlay.js";
import { isAllPhasesComplete, isCloseMarker, readPlanStatus, resolvePlanPaths, summarizePlan } from "./plan.js";
import { checkCompleteReport } from "./scripts.js";
import { getPlanSessionKey, getSessionId, type RuntimeState } from "./state.js";
import { injectionTokenCost } from "./tokens.js";

/** Parse an interval spec like "10m", "30s", "2h", "1d" → milliseconds. */
export function parseIntervalSpec(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return undefined;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return undefined;

  const factors: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * factors[unit];
}

const PLAN_KEYWORDS = new Set(["status", "execute", "done", "attest", "goal", "loop", "list", "lint", "switch"]);

export function registerCommands(pi: ExtensionAPI, state: RuntimeState, overlay: PlanningOverlay): void {
  async function handleStatus(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const status = readPlanStatus(ctx.cwd);
    if (!status.exists) {
      ctx.ui.notify("No active plan (task_plan.md not found)", "warning");
      return;
    }
    const mode = deriveEffectiveMode(resolveConfiguredMode(ctx.cwd), ctx);
    const cost = injectionTokenCost(status, mode);
    ctx.ui.notify(checkCompleteReport(ctx.cwd, cost.label), "info");
  }

  async function handleList(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    ctx.ui.notify(renderPlanList(enumeratePlans(ctx.cwd)), "info");
  }

  async function handleLint(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const all = ["--all", "all"].includes(args.trim().toLowerCase());
    const reports = all ? lintAllPlans(ctx.cwd) : [lintPlan(ctx.cwd)];
    for (const r of reports) {
      const lines = [
        `[${PKG_NAME}] ${r.planPath}`,
        ...r.findings.map((f) => `  ${f.level.toUpperCase()} ${f.code}: ${f.message}`),
      ];
      ctx.ui.notify(lines.join("\n"), r.ok ? "info" : "warning");
    }
  }

  async function handleSwitch(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const id = args.trim();
    if (!id) {
      ctx.ui.notify("Usage: /plan switch <plan-id>  (or /plan switch root to clear the pin)", "warning");
      return;
    }
    const res = switchActivePlan(ctx.cwd, id);
    ctx.ui.notify(res.message, res.ok ? "info" : "error");
  }

  async function handleAttest(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const flag = args.trim().toLowerCase();
    const mode =
      flag === "--show" || flag === "show" ? "show" : flag === "--clear" || flag === "clear" ? "clear" : "attest";
    const result = attestPlan(ctx.cwd, mode);
    ctx.ui.notify(result.message, result.ok ? "info" : "error");
  }

  async function handleGoal(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const normalized = args.trim();
    if (!normalized || ["clear", "off", "disable"].includes(normalized.toLowerCase())) {
      state.goalBySession.delete(sessionId);
      ctx.ui.notify("Plan goal cleared", "info");
      return;
    }

    const goal = normalized === "default" ? DEFAULT_GOAL_CONDITION : normalized;
    state.goalBySession.set(sessionId, goal);
    ctx.ui.notify(`Plan goal set: ${goal}`, "info");
  }

  async function handleExecute(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const status = readPlanStatus(ctx.cwd);
    if (!status.exists) {
      ctx.ui.notify("No active plan (task_plan.md not found)", "warning");
      return;
    }

    const planKey = getPlanSessionKey(ctx, status);
    const normalized = args.trim().toLowerCase();
    if (["clear", "off", "reset", "disable"].includes(normalized)) {
      state.executionApprovedBySessionPlan.delete(planKey);
      ctx.ui.notify(`Plan execution approval cleared: ${summarizePlan(status)}`, "info");
      overlay.setLine(`${summarizePlan(status)} — run /plan execute to activate hooks`);
      return;
    }

    const attestation = checkPlanAttestation(status);
    if (attestation.tampered) {
      ctx.ui.notify(buildTamperMessage(status), "error");
      return;
    }

    state.executionApprovedBySessionPlan.add(planKey);
    // Refresh the status bar so it reflects the approved/executing state
    // immediately — without this the bar kept showing the passive
    // "run /plan execute" prompt until the next agent turn boundary.
    overlay.setLine(`${summarizePlan(status)} — hooks active`);
    ctx.ui.notify(
      [
        `Plan execution approved: ${summarizePlan(status)}`,
        `Plan path: ${status.planPath}`,
        "planning-with-files hooks are now active for this session and plan.",
      ].join("\n"),
      "info",
    );
  }

  async function handleDone(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const status = readPlanStatus(ctx.cwd);
    if (!status.exists || !status.planPath) {
      ctx.ui.notify("No active plan (task_plan.md not found) — nothing to close.", "info");
      return;
    }

    const flag = args.trim().toLowerCase();

    // --delete: fully remove the active plan files/dir (gitignored scratch).
    // Resolves the exact same paths readPlanStatus uses, so it never touches
    // anything outside the active plan.
    if (flag === "--delete" || flag === "delete" || flag === "rm") {
      const paths = resolvePlanPaths(ctx.cwd);
      const targets: string[] = [];
      if (paths.scope === "scoped" && paths.planDir) {
        targets.push(paths.planDir);
      } else {
        for (const f of [paths.planPath, paths.progressPath, paths.findingsPath]) {
          if (f && existsSync(f)) targets.push(f);
        }
        const rootAttest = paths.attestationCandidates[0];
        if (rootAttest && existsSync(rootAttest)) targets.push(rootAttest);
      }
      // Clear approval so any lingering session state goes passive too.
      state.executionApprovedBySessionPlan.delete(getPlanSessionKey(ctx, status));
      state.goalBySession.delete(getSessionId(ctx));
      for (const t of targets) {
        try {
          rmSync(t, { recursive: true, force: true });
        } catch {
          // best-effort; report what we can below
        }
      }
      overlay.setLine("No active plan");
      ctx.ui.notify(`[planning-with-files] Plan deleted: ${targets.join(", ")}`, "info");
      return;
    }

    // Default: mark the plan closed (non-destructive — keeps the plan as a
    // record). Writes an inert comment marker + a human-visible note. The
    // runtime treats a closed plan as inert (no injection, no nag).
    const existing = (() => {
      try {
        return readFileSync(status.planPath, "utf-8");
      } catch {
        return "";
      }
    })();
    if (isCloseMarker(existing)) {
      // Already closed — just clear approval + confirm.
      state.executionApprovedBySessionPlan.delete(getPlanSessionKey(ctx, status));
      overlay.setLine("Plan closed (via /plan done)");
      ctx.ui.notify(`[planning-with-files] Plan already closed: ${status.planPath}`, "info");
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const block = `\n\n---\n${CLOSE_MARKER_COMMENT}\n${CLOSE_MARKER_NOTE} (${stamp})\n`;
    try {
      appendFileSync(status.planPath, block, "utf-8");
    } catch (err) {
      ctx.ui.notify(`[planning-with-files] Could not write close marker: ${String(err)}`, "error");
      return;
    }
    // Drop approval so the very next agent_end doesn't fire the approved
    // auto-continue branch before the closed guard short-circuits it.
    state.executionApprovedBySessionPlan.delete(getPlanSessionKey(ctx, status));
    state.goalBySession.delete(getSessionId(ctx));
    overlay.setLine("Plan closed (via /plan done)");
    ctx.ui.notify(
      [
        `[planning-with-files] Plan closed: ${summarizePlan(readPlanStatus(ctx.cwd))}`,
        `Marked: ${status.planPath}`,
        "Hooks deactivated for this plan. Run /plan done --delete to remove the files, or delete the close marker to reactivate.",
      ].join("\n"),
      "info",
    );
  }

  async function handleLoop(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const raw = args.trim();

    if (["stop", "off", "clear", "disable"].includes(raw.toLowerCase())) {
      const timer = state.loopTimersBySession.get(sessionId);
      if (timer) clearInterval(timer);
      state.loopTimersBySession.delete(sessionId);
      ctx.ui.notify("plan-loop stopped", "info");
      return;
    }

    const parts = raw ? raw.split(/\s+/) : [];
    const maybeInterval = parseIntervalSpec(parts[0]);
    const intervalMs = maybeInterval ?? DEFAULT_LOOP_INTERVAL_MS;
    const prompt = maybeInterval ? parts.slice(1).join(" ").trim() : parts.join(" ").trim();
    const tickPrompt = prompt || DEFAULT_LOOP_PROMPT;

    const existing = state.loopTimersBySession.get(sessionId);
    if (existing) clearInterval(existing);

    const timer = setInterval(() => {
      const status = readPlanStatus(ctx.cwd);
      if (!status.exists) return;

      // A CLOSED plan (finished/abandoned via /plan done) is inert — stop the
      // loop, mirroring before_agent_start / agent_end / session_before_compact.
      // Without this, the loop ticks forever on a closed plan because
      // isAllPhasesComplete() returns false when status.closed is true (its
      // `!status.closed` guard), so the stop branch below never fires.
      if (status.closed || isAllPhasesComplete(status)) {
        const active = state.loopTimersBySession.get(sessionId);
        if (active) clearInterval(active);
        state.loopTimersBySession.delete(sessionId);
        pi.sendMessage({
          customType: PKG_NAME,
          content: `[${PKG_NAME}] plan-loop stopped: ${summarizePlan(status)}.`,
          display: true,
        });
        return;
      }

      try {
        pi.sendUserMessage(tickPrompt, { deliverAs: "followUp" });
      } catch {
        // best-effort loop tick, ignore transient send errors
      }
    }, intervalMs);

    state.loopTimersBySession.set(sessionId, timer);
    ctx.ui.notify(`plan-loop started (${Math.round(intervalMs / 1000)}s)`, "info");
  }

  pi.registerCommand("plan", {
    description:
      "Planning-with-files family: 'status'/'execute [reset]'/'done [--delete]'/'attest [--show|--clear]'/'goal <text>'/'loop [interval]'/'list'/'lint [--all]'/'switch <id>'",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);
      const remainder = rest.join(" ");
      if (!sub || !PLAN_KEYWORDS.has(sub)) {
        ctx.ui.notify("Usage: /plan status|execute|done|attest|goal|loop|list|lint|switch [args]", "warning");
        return;
      }
      switch (sub) {
        case "status":
          return handleStatus(remainder, ctx);
        case "execute":
          return handleExecute(remainder, ctx);
        case "done":
          return handleDone(remainder, ctx);
        case "attest":
          return handleAttest(remainder, ctx);
        case "goal":
          return handleGoal(remainder, ctx);
        case "loop":
          return handleLoop(remainder, ctx);
        case "list":
          return handleList(remainder, ctx);
        case "lint":
          return handleLint(remainder, ctx);
        case "switch":
          return handleSwitch(remainder, ctx);
      }
    },
  });
}
