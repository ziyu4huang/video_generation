/**
 * `/loop` (cc-parity-2 ticket 06): CC's recurring prompt command, built on the
 * ONE wakeup mechanism (map D7 — in-memory, session-live, no daemon):
 *
 *   /loop 5m <prompt>     fixed cadence — the wakeup auto-reschedules
 *                         (interval forms: 30s | 5m | 1h — a unit is REQUIRED)
 *   /loop <prompt>        fixed cadence at the default 10m
 *   /loop dynamic <prompt>  model-paced — each fired turn re-arms via
 *                          schedule_wakeup (delaySeconds + reason)
 *   /loop off             cancel every active loop
 *
 * One mechanism, two paces: both modes are WakeupRegistry entries; fixed mode
 * re-arms in the tick, dynamic mode re-arms from the fired turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WakeupRegistry } from "./wakeup-registry.js";
import { WAKEUP_DEFAULT_DELAY_S, WAKEUP_FIRE_CAP } from "./wakeup-registry.js";
import { clampDelaySeconds } from "./wakeup-tools.js";

export type LoopCommand =
  | { kind: "off" }
  | { kind: "status" }
  | { kind: "usage" }
  | { kind: "fixed"; prompt: string; delaySeconds: number; clamped: boolean }
  | { kind: "dynamic"; prompt: string };

/**
 * Pure arg parser (tests pin it): `[interval] <prompt>` | `dynamic <prompt>` |
 * `off` | `status`. Interval forms: `30s`, `5m`, `1h` (unit required).
 */
export function parseLoopArgs(args: string): LoopCommand {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "usage" };
  if (trimmed.toLowerCase() === "off") return { kind: "off" };
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

  // Interval forms REQUIRE a unit (30s | 5m | 1h) — a bare leading number is
  // treated as prompt text ("404 is a fine status code to check" is a prompt,
  // not a 404-minute cadence).
  const intervalMatch = /^(\d+)\s*(ms|s|m|h)\s+(.+)$/is.exec(trimmed);
  if (intervalMatch) {
    const n = Number(intervalMatch[1]);
    const unit = intervalMatch[2]!.toLowerCase();
    const prompt = intervalMatch[3]!.trim();
    if (!prompt) return { kind: "usage" };
    const seconds = unit === "ms" ? -1 : n * (unit === "s" ? 1 : unit === "h" ? 3600 : 60);
    if (seconds < 1) return { kind: "usage" };
    const { value, clamped } = clampDelaySeconds(seconds);
    return { kind: "fixed", prompt, delaySeconds: value, clamped };
  }

  // No interval → the whole rest is the prompt at the default cadence.
  return { kind: "fixed", prompt: trimmed, delaySeconds: WAKEUP_DEFAULT_DELAY_S, clamped: false };
}

export interface LoopCommandOptions {
  registry: WakeupRegistry;
  /** Shared with schedule_wakeup + the tick: the loop a fired turn belongs to. */
  activeLoop: { id?: string };
  /** Injectable clock (tests). */
  now?: () => Date;
}

const USAGE = [
  "Usage: /loop [interval] <prompt> — re-fire the prompt on a fixed cadence (interval: 30s | 5m | 1h, unit required; default 10m).",
  "       /loop dynamic <prompt> — the model paces itself via schedule_wakeup (60–3600s, with a reason).",
  "       /loop status — list active loops (mode, next fire, fire count/cap).",
  "       /loop off — cancel every active loop.",
  "Loops are session-live: they end when the session ends, and dynamic loops end when a fired turn doesn't call schedule_wakeup.",
].join("\n");

export function registerLoopCommand(pi: ExtensionAPI, options: LoopCommandOptions): void {
  const { registry, activeLoop, now = () => new Date() } = options;
  let nextLoopId = 1;
  const say = (content: string) => pi.sendMessage({ customType: "wakeup", content, display: true });

  pi.registerCommand("loop", {
    description:
      "Loop: /loop [interval] <prompt> re-fires a prompt on a cadence; /loop dynamic self-paces via schedule_wakeup; /loop off",
    async handler(args: string) {
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
        lastReason: "initial /loop dynamic fire",
      });
      activeLoop.id = id;
      await say(
        `Loop "${id}" started (dynamic) — the prompt fires within ~30s; each fired turn paces the next via schedule_wakeup (or ends the loop by not calling it). /loop off cancels.`,
      );
    },
  });
}
