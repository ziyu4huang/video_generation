import { describe, test, expect } from "bun:test";
import { asSwappable } from "../../src/store/swappable.ts";

describe("asSwappable", () => {
	test("delegates method calls to the current target", () => {
		let target: { get: () => number; add: (x: number) => number } = { get: () => 1, add: (x) => x + 1 };
		const proxy = asSwappable(() => target);
		expect(proxy.get()).toBe(1);
		expect(proxy.add(10)).toBe(11);
	});

	test("follows a target swap transparently (the whole point)", () => {
		let target: { whoami: () => string } = { whoami: () => "sqlite" };
		const proxy = asSwappable(() => target);
		expect(proxy.whoami()).toBe("sqlite");
		target = { whoami: () => "surrealdb" }; // live swap
		expect(proxy.whoami()).toBe("surrealdb");
	});

	test("binds methods so `this` is the live target", () => {
		let target: { n: number; get: () => number } = { n: 42, get() { return this.n; } };
		const proxy = asSwappable(() => target);
		expect(proxy.get()).toBe(42);
		target = { n: 7, get() { return this.n; } };
		expect(proxy.get()).toBe(7);
	});

	test("passes through non-function properties (read at access time)", () => {
		let target: { kind: string } = { kind: "sqlite" };
		const proxy = asSwappable(() => target);
		expect(proxy.kind).toBe("sqlite");
		target = { kind: "surrealdb" };
		expect(proxy.kind).toBe("surrealdb");
	});
});
