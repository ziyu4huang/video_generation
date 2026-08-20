/**
 * MutexController — the adapter that wires a pure AgentMutex to an event-driven
 * host (pi extension events in production; a fake emitter in tests). It owns no
 * state beyond the mutex + a notifier; it translates gate verdicts into the
 * InputEventResult `action` and fires the blocked / force-release notifications.
 *
 * The real pi wiring (ticket 04) calls these methods from its pi.on(...) handlers.
 * Kept separate from mutex.ts so the pure module stays I/O-free and the
 * translation is independently testable.
 */

import {
  AgentMutex,
  toFrontend,
  type Frontend,
  type InputSource,
  type MutexClock,
  type WatchdogConfig,
} from "./mutex.js";

/** How the controller tells each side about a block / force-release. */
export interface MutexNotifier {
  /** `blocked` tried to submit while `by` was driving. */
  notifyBlocked(blocked: Frontend, by: Frontend): void;
  /** A hung turn by `driver` was force-released by the watchdog. */
  notifyForceRelease(driver: Frontend): void;
}

export interface MutexControllerOptions {
  clock: MutexClock;
  watchdog?: WatchdogConfig;
  notifier: MutexNotifier;
}

export class MutexController {
  private readonly mutex: AgentMutex;
  private readonly notifier: MutexNotifier;

  constructor(opts: MutexControllerOptions) {
    this.notifier = opts.notifier;
    this.mutex = new AgentMutex({
      clock: opts.clock,
      watchdog: opts.watchdog,
      callbacks: { onForceRelease: (i) => this.notifier.notifyForceRelease(i.driver) },
    });
  }

  get driver(): Frontend | null {
    return this.mutex.driver;
  }

  /** Called from pi.on("input"). Returns the InputEventResult `action`. */
  handleInput(source: InputSource): { action: "continue" | "handled" } {
    const r = this.mutex.gate(source);
    if (r.verdict === "handled" && r.blocked) {
      const blocked = toFrontend(source);
      if (blocked) this.notifier.notifyBlocked(blocked, r.blocked.by);
      return { action: "handled" };
    }
    return { action: "continue" };
  }

  /** Called from pi.on("agent_settled"). */
  handleSettled(): void {
    this.mutex.release("settled");
  }

  /** Called from pi.on("message_update" | "tool_execution_update"). */
  handleActivity(): void {
    this.mutex.bumpActivity();
  }

  /** Called from pi.on("session_shutdown"). */
  handleShutdown(): void {
    this.mutex.release("shutdown");
  }

  /**
   * Suspend/resume the stale watchdog (architecture v2 §3.5): while a HITL
   * presentation is pending, the agent turn is legitimately live with no
   * activity — a force-release would free the mutex under the open
   * presentation. The wiring calls this with pending.size > 0.
   */
  setWatchdogSuspended(suspended: boolean): void {
    this.mutex.setWatchdogSuspended(suspended);
  }
}
