/**
 * `/loop` (cc-parity-2 ticket 06; cc-parity-task ticket 03 consolidated the
 * retired ext-task /loop into it): CC's recurring prompt command, built on the
 * ONE wakeup mechanism (map D7 — in-memory, session-live, no daemon):
 *
 *   /loop 5m <prompt>     fixed cadence — the wakeup auto-reschedules
 *                         (interval forms: 30s | 5m | 1h | 1d — a unit is REQUIRED)
 *   /loop <prompt>        fixed cadence at the default 10m
 *   /loop dynamic <prompt>  model-paced — each fired turn re-arms via
 *                          schedule_wakeup (delaySeconds + reason)
 *   /loop off | stop      cancel every active loop
 *
 * One mechanism, two paces: both modes are WakeupRegistry entries; fixed mode
 * re-arms in the tick, dynamic mode re-arms from the fired turn. The tick
 * idles-gates (busy ⇒ postpone) and every loop self-stops at 7 days.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WakeupRegistry } from "./wakeup-registry.js";
import { LOOP_FIXED_MAX_S, LOOP_FIXED_MIN_S, WAKEUP_DEFAULT_DELAY_S, WAKEUP_FIRE_CAP } from "./wakeup-registry.js";

export type LoopCommand =
  | { kind: "off" }
  | { kind: "status" }
  | { kind: "usage" }
  | { kind: "fixed"; prompt: string; delaySeconds: number; clamped: boolean }
  | { kind: "dynamic"; prompt: string };

/** Fixed-cadence clamp for the /loop surface — [60s, 7d], NOT the
 * schedule_wakeup tool's CC-parity 60–3600s (ext-task's retired /loop
 * accepted day-scale cadences; 7d is the ceiling because the max-age
 * self-stop governs loop lifetime). */
export function clampFixedIntervalSeconds(seconds: number): { value: number; clamped: boolean } {
  if (!Number.isFinite(seconds) || seconds < 1) return { value: LOOP_FIXED_MIN_S, clamped: true };
  if (seconds < LOOP_FIXED_MIN_S) return { value: LOOP_FIXED_MIN_S, clamped: true };
  if (seconds > LOOP_FIXED_MAX_S) return { value: LOOP_FIXED_MAX_S, clamped: true };
  return { value: seconds, clamped: false };
}

/**
 * Pure arg parser (tests pin it): `[interval] <prompt>` | `dynamic <prompt>` |
 * `off` / `stop` | `status`. Interval forms: `30s`, `5m`, `1h`, `1d` (unit
 * required).
 */
export function parseLoopArgs(args: string): LoopCommand {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "usage" };
  if (trimmed.toLowerCase() === "off" || trimmed.toLowerCase() === "stop") return { kind: "off" };
  // Bare subcommand words must never become a loop PROMPT — live incident
  // 2026-08-24: `/loop status` silently armed a fixed 10m loop whose prompt
  // was the word "status". `status` is a real read-only subcommand now;
  // `help` (and bare `dynamic`, below) are usage errors.
  if (trimmed.toLowerCase() === "status") return { kind: "status" };
  if (trimmed.toLowerCase() === "help") return { kind: "usage" };
  // Bare "dynamic" would otherwise arm a FIXED loop whose prompt is the word
  // "dynamic" — the explicit guard keeps it a usage error.
  if (trimmed.toLowerCase() === "dynamic") return { kind: "usage" };

  const dynamicMatch = /^dynamic\s+(.+)$/is.exec(trimmed);
  if (dynamicMatch) {
    const prompt = dynamicMatch[1]!.trim();
    if (!prompt) return { kind: "usage" };
    return { kind: "dynamic", prompt };
  }

  // Interval forms REQUIRE a unit (30s | 5m | 1h | 1d) — a bare leading number
  // is treated as prompt text ("404 is a fine status code to check" is a
  // prompt, not a 404-minute cadence).
  const intervalMatch = /^(\d+)\s*(ms|s|m|h|d)\s+(.+)$/is.exec(trimmed);
  if (intervalMatch) {
    const n = Number(intervalMatch[1]);
    const unit = intervalMatch[2]!.toLowerCase();
    const prompt = intervalMatch[3]!.trim();
    if (!prompt) return { kind: "usage" };
    const seconds = unit === "ms" ? -1 : n * (unit === "s" ? 1 : unit === "h" ? 3600 : unit === "d" ? 86_400 : 60);
    if (seconds < 1) return { kind: "usage" };
    const { value, clamped } = clampFixedIntervalSeconds(seconds);
    return { kind: "fixed", prompt, delaySeconds: value, clamped };
  }

  // No interval → the whole rest is the prompt at the default cadence.
  return { kind: "fixed", prompt: trimmed, delaySeconds: WAKEUP_DEFAULT_DELAY_S, clamped: false };
}

export interface LoopCommandOptions {
  registry: WakeupRegistry;
  /** Shared with schedule_wakeup + the tick: the loop a fired turn belongs to. */
  activeLoop: { id?: string };
  /** Idle-probe capture (ticket 03): invoked when a command ctx carries
   *  isIdle, so the tick's idle gate reads a REAL probe instead of the
   *  always-idle default (the ext-task latestIsIdle pattern). */
  setIdleProbe?: (isIdle: () => boolean) => void;
  /** Injectable clock (tests). */
  now?: () => Date;
}

const USAGE = [
  "Usage: /loop [interval] <prompt> — re-fire the prompt on a fixed cadence (interval: 30s | 5m | 1h | 1d, unit required; default 10m).",
  "       /loop dynamic <prompt> — the model paces itself via schedule_wakeup (60–3600s, with a reason).",
  "       /loop status — list active loops (mode, next fire, fire count/cap).",
  "       /loop off (or /loop stop) — cancel every active loop.",
  "Loops are session-live: they pause while the agent is busy, survive a session restart, self-stop after 7 days,",
  "and dynamic loops end when a fired turn doesn't call schedule_wakeup.",
].join("\n");

export function registerLoopCommand(pi: ExtensionAPI, options: LoopCommandOptions): void {
  const { registry, activeLoop, setIdleProbe, now = () => new Date() } = options;
  let nextLoopId = 1;
  const say = (content: string) => pi.sendMessage({ customType: "wakeup", content, display: true });

  pi.registerCommand("loop", {
    description:
      "Loop: /loop [interval] <prompt> re-fires a prompt on a cadence; /loop dynamic self-paces via schedule_wakeup; /loop off",
    async handler(
      args: string,
      ctx?: { isIdle?: () => boolean; ui?: { notify?: (m: string, k?: "info" | "warning" | "error") => void } },
    ) {
      // Capture the REAL idle probe whenever a ctx provides one (the ext-task
      // latestIsIdle pattern: a restored loop gates on the freshest known
      // probe, not an always-idle default that fires into a busy turn).
      if (typeof ctx?.isIdle === "function") setIdleProbe?.(ctx.isIdle);
      const parsed = parseLoopArgs(args);
      if (parsed.kind === "usage") {
        await say(USAGE);
        return;
      }
      if (parsed.kind === "status") {
        const entries = registry.list();
        if (!entries.length) {
          await say(
            "No active loops (no pending wakeups). Arm one with /loop [interval] <prompt> or /loop dynamic <prompt>.",
          );
          return;
        }
        const lines = entries.map((e) => {
          const secs = Math.max(0, Math.round((e.dueAt - now().getTime()) / 1000));
          const reason = e.lastReason ? ` — last reason: ${e.lastReason}` : "";
          return `- ${e.id} [${e.mode}] next fire in ${secs}s (${new Date(e.dueAt).toLocaleTimeString()}) — fire ${e.fireCount}/${WAKEUP_FIRE_CAP}${reason}`;
        });
        await say(`Active loops (${entries.length}):\n${lines.join("\n")}`);
        return;
      }
      if (parsed.kind === "off") {
        const ids = registry.list().map((e) => e.id);
        registry.clear();
        activeLoop.id = undefined;
        await say(
          ids.length
            ? `Stopped ${ids.length} loop${ids.length > 1 ? "s" : ""}: ${ids.join(", ")}.`
            : "No active loops.",
        );
        return;
      }
      const id = `loop-${nextLoopId++}`;
      if (parsed.kind === "fixed") {
        registry.schedule({
          id,
          prompt: parsed.prompt,
          mode: "fixed",
          delaySeconds: parsed.delaySeconds,
          dueAt: now().getTime() + parsed.delaySeconds * 1000,
          startedAt: now().getTime(),
        });
        activeLoop.id = id;
        await say(
          [
            `Loop "${id}" started — prompt re-fires every ${parsed.delaySeconds}s (fixed).`,
            parsed.clamped ? `(Requested interval clamped into the allowed 60–3600s range.)` : null,
            "Session-live only: it ends with the session; /loop off cancels.",
          ]
            .filter(Boolean)
            .join(" "),
        );
        return;
      }
      // dynamic: first fire is due NOW — the next tick (≤30s) delivers the
      // prompt, and the fired turn paces itself via schedule_wakeup thereafter.
      registry.schedule({
        id,
        prompt: parsed.prompt,
        mode: "dynamic",
        dueAt: now().getTime(),
        startedAt: now().getTime(),
        lastReason: "initial /loop dynamic fire",
      });
      activeLoop.id = id;
      await say(
        `Loop "${id}" started (dynamic) — the prompt fires within ~30s; each fired turn paces the next via schedule_wakeup (or ends the loop by not calling it). /loop off cancels.`,
      );
    },
  });
}
