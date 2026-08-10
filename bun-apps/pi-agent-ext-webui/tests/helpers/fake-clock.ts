import type { MutexClock, MutexTimer } from "../../src/mutex.js";

/**
 * Deterministic MutexClock for watchdog tests. Models a single active
 * setInterval (the AgentMutex watchdog) and lets a test advance virtual time,
 * firing the tick handler every `period` until elapsed.
 */
export class FakeClock implements MutexClock {
  private _now = 0;
  private handler: (() => void) | null = null;
  private period = 0;

  now(): number {
    return this._now;
  }

  setInterval(handler: () => void, ms: number): MutexTimer {
    this.handler = handler;
    this.period = ms;
    return { clear: () => { if (this.handler === handler) this.handler = null; } };
  }

  /** Advance `ms` of virtual time, firing the tick handler every `period`. */
  advance(ms: number): void {
    if (ms <= 0 || this.handler === null) {
      this._now += Math.max(0, ms);
      return;
    }
    const end = this._now + ms;
    while (this._now + this.period <= end) {
      this._now += this.period;
      this.handler();
      if (this.handler === null) break; // watchdog cleared (force-released)
    }
    if (this._now < end) this._now = end;
  }
}
