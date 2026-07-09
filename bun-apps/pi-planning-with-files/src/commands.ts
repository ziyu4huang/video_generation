/**
 * Slash commands registered by the planning-with-files extension.
 *
 *   /plan-status            — show phase counts for the active plan
 *   /plan-attest [flags]    — SHA-256 lock the active plan (pure TS: --show / --clear)
 *   /plan-goal <text>       — set/clear the auto-continue goal condition
 *   /plan-execute [reset]   — approve the active plan & activate the hooks
 *   /plan-loop [interval]   — start/stop periodic plan-loop ticks
 *
 * Type-only imports from `./runtime.js` (RuntimeState) are erased at compile
 * time, so this module does NOT create a runtime ESM cycle with runtime.ts.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { attestPlan, buildTamperMessage, checkPlanAttestation } from "./attestation.js";
import { DEFAULT_GOAL_CONDITION, DEFAULT_LOOP_INTERVAL_MS, DEFAULT_LOOP_PROMPT, PKG_NAME } from "./constants.js";
import { isAllPhasesComplete, readPlanStatus, summarizePlan } from "./plan.js";
import { checkCompleteReport } from "./scripts.js";
import { getPlanSessionKey, getSessionId, type RuntimeState } from "./state.js";

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

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
  pi.registerCommand("plan-status", {
    description: "Show current planning-with-files plan status",
    handler: async (_args, ctx) => {
      const status = readPlanStatus(ctx.cwd);
      if (!status.exists) {
        ctx.ui.notify("No active plan (task_plan.md not found)", "warning");
        return;
      }
      ctx.ui.notify(checkCompleteReport(ctx.cwd), "info");
    },
  });

  pi.registerCommand("plan-attest", {
    description: "SHA-256 lock the active plan (--show / --clear supported). Pure TS — no shell.",
    handler: async (args, ctx) => {
      const flag = args.trim().toLowerCase();
      const mode =
        flag === "--show" || flag === "show" ? "show" : flag === "--clear" || flag === "clear" ? "clear" : "attest";
      const result = attestPlan(ctx.cwd, mode);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  });

  pi.registerCommand("plan-goal", {
    description: "Set or clear plan completion goal for auto-continue loops",
    handler: async (args, ctx) => {
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
    },
  });

  pi.registerCommand("plan-execute", {
    description: "Approve the active plan and enable planning-with-files hook activation",
    handler: async (args, ctx) => {
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
        ctx.ui.setStatus(PKG_NAME, `${summarizePlan(status)} — run /plan-execute to activate hooks`);
        return;
      }

      const attestation = checkPlanAttestation(status);
      if (attestation.tampered) {
        ctx.ui.notify(buildTamperMessage(status), "error");
        return;
      }

      state.executionApprovedBySessionPlan.add(planKey);
      ctx.ui.notify(
        [
          `Plan execution approved: ${summarizePlan(status)}`,
          `Plan path: ${status.planPath}`,
          "planning-with-files hooks are now active for this session and plan.",
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("plan-loop", {
    description: "Start/stop planning loop ticks (default: 10m)",
    handler: async (args, ctx: ExtensionCommandContext) => {
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

        if (isAllPhasesComplete(status)) {
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
    },
  });
}
