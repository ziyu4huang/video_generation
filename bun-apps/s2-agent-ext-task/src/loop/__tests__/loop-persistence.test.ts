/** Loop persistence — session-store round-trip of ActiveLoop. */
import { test, expect, describe } from "bun:test";
import { persistLoop, clearPersistedLoop, loadLoopFromSession, LOOP_STATE_ENTRY_TYPE } from "../loop-persistence.js";
import type { ActiveLoop } from "../loop-commands.js";

const loop: ActiveLoop = { id: "L1", prompt: "p", intervalMs: 300_000, startedAt: 1, nextFireAt: 2, iteration: 3 };

function fakeSession(entries: unknown[] = []) {
	return {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getBranch: () => entries,
	};
}

describe("loop persistence", () => {
	test("round-trip", () => {
		const sm = fakeSession();
		persistLoop(sm as never, loop);
		expect(loadLoopFromSession(sm)).toEqual(loop);
	});
	test("clear writes a null tombstone that loads as undefined", () => {
		const sm = fakeSession();
		persistLoop(sm as never, loop);
		clearPersistedLoop(sm as never);
		expect(loadLoopFromSession(sm)).toBeUndefined();
	});
	test("non-loop entries are ignored", () => {
		const sm = fakeSession([{ customType: "other", data: { loop: "x" } }]);
		expect(loadLoopFromSession(sm)).toBeUndefined();
	});
	test("entry type name unchanged from the old loop", () => {
		expect(LOOP_STATE_ENTRY_TYPE).toBe("loop-state");
	});
});
