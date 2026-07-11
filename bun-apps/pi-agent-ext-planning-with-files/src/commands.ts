/**
 * Slash commands registered by the planning-with-files extension.
 *
 *   /plan-status            — show phase counts for the active plan
 *   /plan-attest [flags]    — SHA-256 lock the active plan (pure TS: --show / --clear)
 *   /plan-goal <text>       — set/clear the auto-continue goal condition
 *   /plan-execute [reset]   — approve the active plan & activate the hooks
 *   /plan-done [--delete]   — close the active plan (stop all nags); --delete removes the files
 *   /plan-loop [interval]   — start/stop periodic plan-loop ticks
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

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
  pi.registerCommand("plan-status", {
    description: "Show current planning-with-files plan status (+ injection token cost)",
    handler: async (_args, ctx) => {
      const status = readPlanStatus(ctx.cwd);
      if (!status.exists) {
        ctx.ui.notify("No active plan (task_plan.md not found)", "warning");
        return;
      }
      const mode = deriveEffectiveMode(resolveConfiguredMode(ctx.cwd), ctx);
      const cost = injectionTokenCost(status, mode);
      ctx.ui.notify(checkCompleteReport(ctx.cwd, cost.label), "info");
    },
  });

  pi.registerCommand("plan-list", {
    description: "List all plans under .planning/ (+ root): status, phases, attestation, active",
    handler: async (_args, ctx) => {
      ctx.ui.notify(renderPlanList(enumeratePlans(ctx.cwd)), "info");
    },
  });

  pi.registerCommand("plan-lint", {
    description: "Diagnose the active plan (--all for every plan): status format, files, attestation",
    handler: async (args, ctx) => {
      const all = ["--all", "all"].includes(args.trim().toLowerCase());
      const reports = all ? lintAllPlans(ctx.cwd) : [lintPlan(ctx.cwd)];
      for (const r of reports) {
        const lines = [
          `[${PKG_NAME}] ${r.planPath}`,
          ...r.findings.map((f) => `  ${f.level.toUpperCase()} ${f.code}: ${f.message}`),
        ];
        ctx.ui.notify(lines.join("\n"), r.ok ? "info" : "warning");
      }
    },
  });

  pi.registerCommand("plan-switch", {
    description: "Switch the active plan to .planning/<id> (use 'root' to clear the pin)",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /plan-switch <plan-id>  (or /plan-switch root to clear the pin)", "warning");
        return;
      }
      const res = switchActivePlan(ctx.cwd, id);
      ctx.ui.notify(res.message, res.ok ? "info" : "error");
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

  pi.registerCommand("plan-done", {
    description:
      "Close the active plan (finished/abandoned): deactivates hooks, stops all nags. Use --delete to also remove the plan files.",
    handler: async (args, ctx) => {
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
        ctx.ui.setStatus(PKG_NAME, "No active plan");
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
        ctx.ui.setStatus(PKG_NAME, "Plan closed (via /plan-done)");
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
      ctx.ui.setStatus(PKG_NAME, "Plan closed (via /plan-done)");
      ctx.ui.notify(
        [
          `[planning-with-files] Plan closed: ${summarizePlan(readPlanStatus(ctx.cwd))}`,
          `Marked: ${status.planPath}`,
          "Hooks deactivated for this plan. Run /plan-done --delete to remove the files, or delete the close marker to reactivate.",
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

        // A CLOSED plan (finished/abandoned via /plan-done) is inert — stop the
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
    },
  });
}
