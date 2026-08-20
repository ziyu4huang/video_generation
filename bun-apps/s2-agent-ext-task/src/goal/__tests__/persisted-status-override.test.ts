import { describe, expect, test } from "bun:test";
import { shouldHonorPersistedStatus } from "../persistence.js";

describe("shouldHonorPersistedStatus", () => {
	test("same id, persisted paused -> honor (skip refire)", () => {
		expect(shouldHonorPersistedStatus({ id: "g1", status: "active" }, { id: "g1", status: "paused" })).toBe(true);
	});
	test("same id, persisted complete -> honor", () => {
		expect(shouldHonorPersistedStatus({ id: "g1", status: "active" }, { id: "g1", status: "complete" })).toBe(true);
	});
	test("same id, persisted active -> do not honor (normal loop)", () => {
		expect(shouldHonorPersistedStatus({ id: "g1", status: "active" }, { id: "g1", status: "active" })).toBe(false);
	});
	test("different goal id in journal -> do not honor", () => {
		expect(shouldHonorPersistedStatus({ id: "g1", status: "active" }, { id: "g2", status: "paused" })).toBe(false);
	});
	test("no persisted goal -> do not honor", () => {
		expect(shouldHonorPersistedStatus({ id: "g1", status: "active" }, undefined)).toBe(false);
	});
	test("no current goal -> do not honor", () => {
		expect(shouldHonorPersistedStatus(null, { id: "g1", status: "paused" })).toBe(false);
	});
});
