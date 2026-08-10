/**
 * notifier.ts — the MutexNotifier-over-Broadcaster adapter (spec §3 "MutexNotifier
 * implementation").
 *
 * webui supplies the {@link MutexNotifier} callbacks that the ticket-03
 * `MutexController` invokes; this adapter turns each callback into exactly one
 * outbound {@link WebFrame} pushed through the injected {@link Broadcaster} port.
 *
 *   notifyBlocked(blocked, by)        -> broadcast({ type: "mutex_blocked",        blocked, by })
 *   notifyForceRelease(driver)        -> broadcast({ type: "mutex_force_release",  driver })
 *
 * Purity: the adapter owns no state beyond the broadcaster reference. It is
 * deterministic — the same args always produce the same single frame — and its
 * only side effect is the broadcast (spec §3: broadcast is fire-and-forget).
 * It has no `bun` / runtime pi dependency; everything flows through the port.
 *
 * The `MutexNotifier` interface is consumed from `./mutex-controller.js` (the
 * ticket-03 module — **consumed, not edited**), per the wiring-ownership note.
 */
import type { Broadcaster } from "./broadcaster.js";
import type { MutexNotifier } from "./mutex-controller.js";

/**
 * Build a {@link MutexNotifier} that pushes `mutex_blocked` / `mutex_force_release`
 * frames through the given {@link Broadcaster}. Thin: the closure captures only
 * the broadcaster reference.
 *
 * Arg order (pinned by the MutexNotifier contract + the ticket-03 controller
 * tests): `notifyBlocked(blocked, by)` — blocked first, by second.
 */
export function makeMutexNotifier(broadcaster: Broadcaster): MutexNotifier {
  return {
    notifyBlocked(blocked, by) {
      broadcaster.broadcast({ type: "mutex_blocked", blocked, by });
    },
    notifyForceRelease(driver) {
      broadcaster.broadcast({ type: "mutex_force_release", driver });
    },
  };
}
