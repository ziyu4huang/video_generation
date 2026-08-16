import { test, expect } from "bun:test";
import { persistLoop, clearPersistedLoop, loadLoopFromSession, LOOP_STATE_ENTRY_TYPE } from "../loop-persistence.js";
import { createLoop, __resetLoopState } from "../loop-state.js";

test("persistLoop appends a loop-state entry (cloned)", () => {
	const calls: any[] = [];
	const api = { appendEntry: (t: string, d: unknown) => calls.push({ t, d }) };
	const loop = createLoop({ target: "t", mode: "metricless" });
	persistLoop(api as any, loop);
	expect(calls[0].t).toBe(LOOP_STATE_ENTRY_TYPE);
	expect((calls[0].d as any).loop.id).toBe(loop.id);
	// clone: mutating the original after persist must not affect the stored copy
	loop.iteration = 99;
	expect((calls[0].d as any).loop.iteration).toBe(0);
});

test("clearPersistedLoop writes { loop: null }", () => {
	const calls: any[] = [];
	clearPersistedLoop({ appendEntry: (_t: string, d: unknown) => calls.push(d) } as any);
	expect(calls[0]).toEqual({ loop: null });
});

test("loadLoopFromSession recovers an active loop from the branch", () => {
	const loop = createLoop({ target: "t", mode: "metric" });
	const sm = { getBranch: () => [{ type: "custom", customType: LOOP_STATE_ENTRY_TYPE, data: { loop } }] };
	__resetLoopState();
	const got = loadLoopFromSession(sm);
	expect(got?.id).toBe(loop.id);
});

test("loadLoopFromSession skips a stopped loop", () => {
	const sm = { getBranch: () => [{ type: "custom", customType: LOOP_STATE_ENTRY_TYPE, data: { loop: { ...createLoop({ target: "t", mode: "metricless" }), active: false } } }] };
	expect(loadLoopFromSession(sm)).toBeUndefined();
});
