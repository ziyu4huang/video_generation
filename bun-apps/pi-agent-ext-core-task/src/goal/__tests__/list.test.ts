import { describe, expect, test } from "bun:test";
import { addListItems, removeListItem, promoteNext, goalToListItem, clearList } from "../list.js";
import type { ActiveGoal } from "../format.js";

describe("addListItems", () => {
	test("adds one item per text with fresh ids", () => {
		const list = addListItems([], ["a", "b"]);
		expect(list).toHaveLength(2);
		expect(list[0].text).toBe("a");
		expect(list[1].text).toBe("b");
		expect(list[0].id).not.toBe(list[1].id);
		expect(list[0].parked).toBeFalsy();
	});
	test("preserves existing tail (append)", () => {
		const list = addListItems([{ id: "x", text: "old" }], ["new"]);
		expect(list.map((i) => i.text)).toEqual(["old", "new"]);
	});
});

describe("removeListItem", () => {
	test("removes by 1-based index", () => {
		const list = [{ id: "1", text: "a" }, { id: "2", text: "b" }, { id: "3", text: "c" }];
		expect(removeListItem(list, 2).map((i) => i.text)).toEqual(["a", "c"]);
	});
	test("out-of-range index is a no-op", () => {
		const list = [{ id: "1", text: "a" }];
		expect(removeListItem(list, 5)).toEqual(list);
		expect(removeListItem(list, 0)).toEqual(list);
	});
});

describe("promoteNext", () => {
	test("pops the head of the tail, returns the rest", () => {
		const list = [{ id: "1", text: "a" }, { id: "2", text: "b" }];
		const r = promoteNext(list);
		expect(r.item?.text).toBe("a");
		expect(r.rest.map((i) => i.text)).toEqual(["b"]);
	});
	test("empty tail → item undefined, rest empty", () => {
		const r = promoteNext([]);
		expect(r.item).toBeUndefined();
		expect(r.rest).toEqual([]);
	});
});

describe("goalToListItem (park)", () => {
	test("preserves text + tokenBudget + audit; drops usage; fresh id; parked=true", () => {
		const goal: ActiveGoal = {
			id: "g1", text: "ship X", status: "active", startedAt: 0, updatedAt: 0,
			iteration: 5, tokensUsed: 999, timeUsedSeconds: 600, baselineTokens: 10,
			tokenBudget: 2000, auditEnabled: true, auditorModel: "anthropic/claude-sonnet-4",
			verificationContract: "tests green",
		};
		const item = goalToListItem(goal);
		expect(item.text).toBe("ship X");
		expect(item.tokenBudget).toBe(2000);
		expect(item.audit).toEqual({ auditEnabled: true, auditorModel: "anthropic/claude-sonnet-4", verificationContract: "tests green" });
		expect(item.parked).toBe(true);
		expect(item.id).not.toBe("g1");            // fresh id
	});
});

describe("clearList", () => {
	test("returns an empty array", () => {
		expect(clearList()).toEqual([]);
	});
});
