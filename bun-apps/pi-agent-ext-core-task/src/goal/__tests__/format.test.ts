/**
 * Tests for goal/format.ts pure helpers — overlay line rendering + the
 * Loop 2 / Task 7 queue suffix (`· ☰ position/total` + `· ⚠N parked`).
 *
 * The theme stub is a no-op Proxy: every styling method returns its LAST
 * string arg (the text being styled) so visibleWidth() is faithful and
 * substring assertions reflect the rendered content verbatim.
 */
import { describe, expect, test } from "bun:test";
import { formatGoalOverlayLine, type ActiveGoal } from "../format.js";

// Minimal theme stub: theme.fg("dim", x) -> x; theme.fg("warning", x) -> x.
const theme = new Proxy(
	{},
	{
		get:
			() =>
			(...args: unknown[]) => {
				const strs = args.filter((a): a is string => typeof a === "string");
				return strs[strs.length - 1] ?? "";
			},
	},
) as never;

const goal: ActiveGoal = {
	id: "g1",
	text: "ship the dim queue suffix widget",
	status: "active",
	startedAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
	iteration: 1,
	tokensUsed: 100,
	timeUsedSeconds: 60,
	baselineTokens: 0,
};

describe("formatGoalOverlayLine queue suffix", () => {
	test("no queue → byte-identical to today (no ☰ segment)", () => {
		const a = formatGoalOverlayLine(goal, theme, 100);
		const b = formatGoalOverlayLine(goal, theme, 100); // same args
		expect(a).toBe(b);
		expect(a).not.toContain("☰");
	});
	test("total < 2 → no ☰ segment", () => {
		expect(formatGoalOverlayLine(goal, theme, 100, { position: 1, total: 1 })).not.toContain("☰");
	});
	test("total >= 2 → shows ☰ position/total at the end", () => {
		expect(formatGoalOverlayLine(goal, theme, 100, { position: 2, total: 5 })).toContain("☰ 2/5");
	});
	test("parked > 0 → shows ⚠N parked", () => {
		expect(formatGoalOverlayLine(goal, theme, 100, { position: 2, total: 5, parked: 1 })).toContain("⚠1 parked");
	});
	test("parked = 0 → no ⚠ segment", () => {
		expect(formatGoalOverlayLine(goal, theme, 100, { position: 2, total: 5, parked: 0 })).not.toContain("⚠");
	});
	test("middle-width terminal → drops the ☰ segment via the showQueue guard (objective survives)", () => {
		// Land in the showQueue=false MIDDLE domain: the objective fits but the
		// queue segment does not, so showQueue evaluates false and the ☰ segment
		// is dropped — while the head + objective survive. This exercises the
		// showQueue guard, NOT the remaining<=6 early-return (width=30 hit that
		// domain, where showQueue is never evaluated). Empirically the middle
		// band is w in [38,44]; 42 sits at its center (4-unit margin from both
		// the <=36 early-return floor and the >=46 queue-show ceiling).
		const line = formatGoalOverlayLine(goal, theme, 42, { position: 2, total: 5 });
		// ☰ dropped by the showQueue guard.
		expect(line).not.toContain("☰");
		// head (status word) AND objective survived → NOT the early-return path.
		expect(line).toContain("goal active");
		expect(line).toContain(goal.text.slice(0, 10));
	});
	test("wide terminal → queue appears AFTER the objective", () => {
		const line = formatGoalOverlayLine(goal, theme, 100, { position: 3, total: 7 });
		const objIdx = line.indexOf(goal.text.slice(0, 10));
		const queueIdx = line.indexOf("☰ 3/7");
		expect(objIdx).toBeGreaterThanOrEqual(0);
		expect(queueIdx).toBeGreaterThan(objIdx);
	});
});
