/** LoopScheduler — CC-style recurring prompt: timer chain, idle-gated. */
import type { ActiveLoop } from "./loop-commands.js";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // CC recurring auto-expiry

export interface SchedulerHooks {
	fire: (prompt: string) => Promise<void> | void;
	isIdle: () => boolean;
	/** Optional observer fired after each successful fire's state update —
	 *  the scheduler owns the only mutable copy of the loop, so callers that
	 *  mirror its state (overlay, persistence) need this to stay current. */
	onTick?: (loop: ActiveLoop) => void;
	/** Optional observer fired when the 7-day max-age self-stop triggers. */
	onStop?: () => void;
}

export interface SchedulerClock {
	now?: () => number;
	setTimer?: (ms: number, fn: () => void) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export class LoopScheduler {
	private loop: ActiveLoop | undefined;
	private handle: unknown;
	private readonly hooks: SchedulerHooks;
	private readonly now: () => number;
	private readonly setTimer: (ms: number, fn: () => void) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	constructor(hooks: SchedulerHooks, clock: SchedulerClock = {}) {
		this.hooks = hooks;
		this.now = clock.now ?? Date.now;
		// Default timer is unref'd — an armed loop (up to ~7 days) must never
		// keep a headless process alive (mirrors goal's status/heartbeat timers).
		this.setTimer =
			clock.setTimer ??
			((ms, fn) => {
				const timer = setTimeout(fn, ms);
				timer.unref?.();
				return timer;
			});
		this.clearTimer = clock.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	active(): ActiveLoop | undefined {
		return this.loop;
	}

	start(loop: ActiveLoop): void {
		this.stop();
		const now = this.now();
		// A restored loop carries its persisted nextFireAt — honor it while still
		// future so a session restart keeps the cadence instead of pushing it out
		// a full interval; a stale (past) due time re-anchors on a fresh interval
		// rather than burst-firing the missed prompt.
		const nextFireAt = loop.nextFireAt > now ? loop.nextFireAt : now + loop.intervalMs;
		this.loop = { ...loop, nextFireAt };
		this.arm(Math.max(0, nextFireAt - now));
	}

	stop(): void {
		if (this.handle !== undefined) this.clearTimer(this.handle);
		this.handle = undefined;
		this.loop = undefined;
	}

	private arm(ms: number): void {
		this.handle = this.setTimer(ms, () => this.tick());
	}

	/** One timer fire — synchronous, so tests and real timers see the same
	 *  state after a tick: fire is dispatched (not awaited; a slow send must
	 *  not delay re-arming), busy postpones by a minute, max-age self-stops. */
	private tick(): void {
		const loop = this.loop;
		if (!loop) return;
		const now = this.now();
		if (now - loop.startedAt >= SEVEN_DAYS_MS) {
			// CC recurring auto-expiry: this fire is the last one, then the
			// loop deletes itself.
			this.stop();
			this.dispatch(loop.prompt);
			this.hooks.onStop?.();
			return;
		}
		if (!this.hooks.isIdle()) {
			// Postpone-on-busy: re-check every minute; never drop a due fire.
			this.arm(60_000);
			return;
		}
		this.loop = { ...loop, iteration: loop.iteration + 1, nextFireAt: now + loop.intervalMs };
		this.dispatch(loop.prompt);
		if (this.loop) {
			this.hooks.onTick?.(this.loop);
			this.arm(this.loop.intervalMs);
		}
	}

	/** Fire-and-forget with swallowed rejection — a failed send must not
	 *  crash the timer chain (sendLoopPrompt-style best-effort). */
	private dispatch(prompt: string): void {
		try {
			void this.hooks.fire(prompt)?.catch?.(() => {});
		} catch {
			// best-effort
		}
	}
}
