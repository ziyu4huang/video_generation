import { test, expect, describe } from "bun:test";
import {
	LENGTH_CONTINUE_MAX,
	LENGTH_CONTINUE_TEXT,
	makeLengthContinueTracker,
	tickLengthContinue,
	resetLengthContinue,
} from "../length-continue.js";

describe("makeLengthContinueTracker", () => {
	test("a normal turn (stopped=false) does not fire and resets the streak", () => {
		const t = makeLengthContinueTracker();
		expect(t.tick(false)).toEqual({ fire: false, giveUpNow: false, consecutive: 0 });
	});

	test("a truncated turn fires and increments the streak", () => {
		const t = makeLengthContinueTracker();
		expect(t.tick(true)).toEqual({ fire: true, giveUpNow: false, consecutive: 1 });
		expect(t.tick(true).consecutive).toBe(2);
		expect(t.tick(true).consecutive).toBe(3);
	});

	test("after MAX consecutive truncations it gives up once, then stops firing", () => {
		const t = makeLengthContinueTracker(); // max = 3
		t.tick(true); t.tick(true); t.tick(true); // 1,2,3 — all fire
		const over = t.tick(true); // 4 > MAX
		expect(over.fire).toBe(false);
		expect(over.giveUpNow).toBe(true);
		expect(over.consecutive).toBe(4);
		const still = t.tick(true); // 5 — still over, already gave up
		expect(still.fire).toBe(false);
		expect(still.giveUpNow).toBe(false);
	});

	test("a normal turn after the cap resets gaveUp, so a later truncate fires again", () => {
		const t = makeLengthContinueTracker();
		for (let i = 0; i < 4; i++) t.tick(true); // hit cap + give up
		t.tick(false); // normal turn resets
		expect(t.tick(true)).toEqual({ fire: true, giveUpNow: false, consecutive: 1 });
	});
});

describe("module singleton", () => {
	test("resetLengthContinue zeroes the singleton streak", () => {
		resetLengthContinue();
		tickLengthContinue(true);
		tickLengthContinue(true);
		expect(tickLengthContinue(true).consecutive).toBe(3);
		resetLengthContinue();
		expect(tickLengthContinue(true).consecutive).toBe(1);
	});
});

describe("constants", () => {
	test("MAX is 3 and the continue text instructs continuing where it stopped", () => {
		expect(LENGTH_CONTINUE_MAX).toBe(3);
		expect(LENGTH_CONTINUE_TEXT).toMatch(/Continue EXACTLY where you stopped/);
		expect(LENGTH_CONTINUE_TEXT.length).toBeGreaterThan(0);
	});
});
