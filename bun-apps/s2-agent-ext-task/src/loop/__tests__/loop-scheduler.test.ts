/** LoopScheduler — timer chain, idle-gated, postpone-on-busy, 7-day max-age. */
import { test, expect, describe } from "bun:test";
import { LoopScheduler, SEVEN_DAYS_MS, type SchedulerHooks } from "../loop-scheduler.js";
import type { ActiveLoop } from "../loop-commands.js";

function makeLoop(intervalMs = 1000): ActiveLoop {
	return { id: "L1", prompt: "p", intervalMs, startedAt: 0, nextFireAt: intervalMs, iteration: 0 };
}

function harness(extraHooks: Partial<SchedulerHooks> = {}) {
	let now = 0;
	const fired: string[] = [];
	let idle = true;
	const timers: Array<{ at: number; fn: () => void } | undefined> = [];
	const s = new LoopScheduler(
		{
			fire: (prompt) => {
				fired.push(prompt);
			},
			isIdle: () => idle,
			...extraHooks,
		},
		{
			now: () => now,
			setTimer: (ms, fn) => {
				timers.push({ at: now + ms, fn });
				return timers.length - 1;
			},
			clearTimer: (h) => {
				timers[h as number] = undefined;
			},
		},
	);
	// Advance time to the earliest pending timer's deadline (min +1) and run
	// everything due — one tick == one scheduling round.
	const tick = () => {
		const pending = timers.filter((t): t is { at: number; fn: () => void } => !!t);
		now = pending.length ? Math.max(now + 1, Math.min(...pending.map((t) => t.at))) : now + 1;
		for (let i = 0; i < timers.length; i++) {
			const t = timers[i];
			if (t && t.at <= now) {
				timers[i] = undefined;
				t.fn();
			}
		}
	};
	return { s, fired, tick, setIdle: (v: boolean) => (idle = v) };
}

describe("LoopScheduler", () => {
	test("fires the prompt while idle and re-arms", () => {
		const h = harness();
		h.s.start(makeLoop(10));
		h.tick(); // t=10: timer due
		expect(h.fired).toEqual(["p"]);
		h.tick(); // t=20: re-armed timer due
		expect(h.fired).toEqual(["p", "p"]);
	});

	test("busy tick postpones, never drops", () => {
		const h = harness();
		h.s.start(makeLoop(10));
		h.setIdle(false);
		h.tick(); // due but busy
		expect(h.fired).toEqual([]);
		h.setIdle(true);
		h.tick(); // next opportunity fires
		expect(h.fired).toEqual(["p"]);
	});

	test("stop() cancels pending fires", () => {
		const h = harness();
		h.s.start(makeLoop(10));
		h.s.stop();
		h.tick();
		h.tick();
		expect(h.fired).toEqual([]);
		expect(h.s.active()).toBeUndefined();
	});

	test("7-day max-age: fires one last time then self-stops", () => {
		const h = harness();
		h.s.start(makeLoop(SEVEN_DAYS_MS)); // next fire == max age boundary
		h.tick();
		expect(h.fired.length).toBe(1);
		expect(h.s.active()).toBeUndefined();
	});

	test("iteration counts fires", () => {
		const h = harness();
		h.s.start(makeLoop(5));
		h.tick();
		h.tick();
		expect(h.s.active()?.iteration).toBe(2);
	});

	test("onTick fires after each fire's state update, with the incremented iteration", () => {
		const ticks: Array<ActiveLoop | undefined> = [];
		const h = harness({ onTick: (loop) => ticks.push({ ...loop }) });
		h.s.start(makeLoop(10));
		h.tick();
		h.tick();
		expect(ticks.map((l) => l?.iteration)).toEqual([1, 2]);
		// the observed loop carries the re-armed nextFireAt, not the stale one
		expect(ticks[1]?.nextFireAt).toBe(h.s.active()?.nextFireAt);
	});

	test("onStop fires when the 7-day max-age self-stop triggers", () => {
		let stops = 0;
		const h = harness({ onStop: () => stops++ });
		h.s.start(makeLoop(10));
		h.tick(); // ordinary fire — no stop
		expect(stops).toBe(0);
		// age the loop past max-age (fresh start), then let the timer fire
		h.s.start({ ...makeLoop(10), startedAt: -(SEVEN_DAYS_MS + 1) });
		h.tick();
		expect(stops).toBe(1);
		expect(h.s.active()).toBeUndefined();
	});
});
