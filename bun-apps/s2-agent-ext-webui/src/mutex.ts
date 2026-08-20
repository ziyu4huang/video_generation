/**
 * AgentMutex — agentic mutual-exclusion lock for co-driving frontends (TUI + web)
 * on one AgentSession. Deep module: state + transitions + a watchdog behind a tiny
 * interface, testable through that interface (pure logic + injectable clock; no pi,
 * no I/O).
 *
 * Design: specs/03-agentic-mutex-design.md (effort 2026-08-10-s2-agent-ext-webui-from-scratch).
 * Gate = the `input` extension event; release = `agent_settled`; watchdog backstops
 * hung turns. The extension wiring (mutex-controller.ts) feeds events and translates
 * verdicts into pi calls.
 */

/** A co-driving frontend. rpc is NOT a frontend (passes through ungated). */
export type Frontend = "tui" | "web";

/** Why the lock was released. */
export type ReleaseReason = "settled" | "watchdog" | "shutdown";

/** pi's InputSource — mirrored locally so this module has no pi import. */
export type InputSource = "interactive" | "rpc" | "extension";

/** Result of gating a submission. `verdict` maps 1:1 onto InputEventResult.action. */
export interface GateResult {
  verdict: "continue" | "handled";
  driver: Frontend | null;
  /** Present iff verdict === "handled". */
  blocked?: { by: Frontend };
}

/** Injectable wall clock + interval timer, so tests are deterministic. */
export interface MutexClock {
  now(): number;
  setInterval(handler: () => void, ms: number): MutexTimer;
}

export interface MutexTimer {
  clear(): void;
}

export interface WatchdogConfig {
  /** Force-release after this many ms with zero bumpActivity while driving. */
  staleMs: number;
  /** Watchdog tick interval (ms). */
  intervalMs: number;
}

/** Default: 10-min stale, 1s tick (pure app-logic turns do not take the lock). */
export const DEFAULT_WATCHDOG: WatchdogConfig = { staleMs: 10 * 60_000, intervalMs: 1000 };

/** Map a pi InputSource to a co-driving frontend (rpc -> null = passthrough). */
export function toFrontend(source: InputSource): Frontend | null {
  if (source === "interactive") return "tui";
  if (source === "extension") return "web";
  return null; // rpc
}

/** Watchdog callback — the controller wires this to notify both frontends. */
export interface MutexCallbacks {
  onForceRelease?(info: { driver: Frontend }): void;
}

export interface AgentMutexOptions {
  clock: MutexClock;
  watchdog?: WatchdogConfig;
  callbacks?: MutexCallbacks;
}

export class AgentMutex {
  private _driver: Frontend | null = null;
  private lastActivity = 0;
  private timer: MutexTimer | null = null;
  private watchdogSuspended = false;
  private readonly clock: MutexClock;
  private readonly watchdog: WatchdogConfig;
  private readonly callbacks: MutexCallbacks;

  constructor(opts: AgentMutexOptions) {
    this.clock = opts.clock;
    this.watchdog = opts.watchdog ?? DEFAULT_WATCHDOG;
    this.callbacks = opts.callbacks ?? {};
  }

  get driver(): Frontend | null {
    return this._driver;
  }

  /** Synchronous check-and-set. Call from the input handler BEFORE any await. */
  gate(source: InputSource): GateResult {
    const me = toFrontend(source);
    if (me === null) return { verdict: "continue", driver: this._driver }; // rpc passthrough
    if (this._driver === null) {
      this._driver = me;
      this.startWatchdog();
      return { verdict: "continue", driver: me };
    }
    if (this._driver === me) {
      this.bumpActivity();
      return { verdict: "continue", driver: me };
    }
    return { verdict: "handled", driver: this._driver, blocked: { by: this._driver } };
  }

  /** Release the lock. Idempotent (no-op when already idle). */
  release(_reason: ReleaseReason): void {
    if (this._driver === null) return;
    this.stopWatchdog();
    this._driver = null;
  }

  // Reset the watchdog inactivity timer. Call on every message_*/tool_* event.
  bumpActivity(): void {
    if (this._driver !== null) this.lastActivity = this.clock.now();
  }

  /**
   * Suspend/resume the stale watchdog (architecture v2 §3.5). While a HITL
   * presentation is pending, the agent turn is legitimately LIVE but produces
   * NO message/tool activity (the user is deciding) — a stale force-release
   * would free the mutex under the open presentation, letting the other
   * frontend drive while the present is still pending. The wiring suspends
   * while pending.size > 0 and resumes when the last pending resolves. A
   * suspended watchdog keeps ticking but never force-releases.
   */
  setWatchdogSuspended(suspended: boolean): void {
    this.watchdogSuspended = suspended;
  }

  private startWatchdog(): void {
    this.lastActivity = this.clock.now();
    this.timer?.clear();
    this.timer = this.clock.setInterval(() => this.tick(), this.watchdog.intervalMs);
  }

  private stopWatchdog(): void {
    this.timer?.clear();
    this.timer = null;
  }

  private tick(): void {
    if (this._driver === null) return;
    if (this.watchdogSuspended) return; // legitimate HITL block — never force-release
    if (this.clock.now() - this.lastActivity >= this.watchdog.staleMs) {
      const driver = this._driver;
      this.release("watchdog");
      this.callbacks.onForceRelease?.({ driver });
    }
  }
}
