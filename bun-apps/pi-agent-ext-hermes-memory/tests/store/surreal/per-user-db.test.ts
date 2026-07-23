import { describe, it } from "node:test";
import assert from "node:assert";
import { sanitizeUsername, currentUsername, derivePerUserDatabase } from "../../../src/store/surreal/per-user-db.ts";

describe("sanitizeUsername", () => {
	it("passes through a plain lowercase name", () => {
		assert.strictEqual(sanitizeUsername("huangziyu"), "huangziyu");
	});

	it("lowercases uppercase input", () => {
		assert.strictEqual(sanitizeUsername("HuangZiyu"), "huangziyu");
	});

	it("collapses hyphens to underscores (surrealdb rejects hyphens unescaped)", () => {
		assert.strictEqual(sanitizeUsername("john-doe"), "john_doe");
	});

	it("collapses dots / spaces / runs of invalid chars to a single underscore", () => {
		assert.strictEqual(sanitizeUsername("huang.ziyu"), "huang_ziyu");
		assert.strictEqual(sanitizeUsername("foo   bar!!!baz"), "foo_bar_baz");
	});

	it("trims leading/trailing separators", () => {
		assert.strictEqual(sanitizeUsername("---abc---"), "abc");
	});

	it("preserves existing underscores", () => {
		assert.strictEqual(sanitizeUsername("a_b_c"), "a_b_c");
	});

	it("falls back to `default` for empty input", () => {
		assert.strictEqual(sanitizeUsername(""), "default");
	});

	it("falls back to `default` for all-invalid input", () => {
		assert.strictEqual(sanitizeUsername("---...!!!"), "default");
	});
});

describe("currentUsername", () => {
	it("returns a non-empty string (the live OS user)", () => {
		const u = currentUsername();
		assert.ok(typeof u === "string" && u.length > 0, `expected non-empty, got ${JSON.stringify(u)}`);
		assert.ok(!u.includes(" "), "username should have no spaces");
	});
});

describe("derivePerUserDatabase", () => {
	it("produces the hermes_memory_<user> format", () => {
		const db = derivePerUserDatabase();
		assert.ok(db.startsWith("hermes_memory_"), `expected hermes_memory_ prefix, got ${db}`);
		// suffix is a legal surrealdb identifier (lowercase alnum + underscore only)
		assert.match(db, /^hermes_memory_[a-z0-9_]+$/);
	});

	it("is a valid unescaped SurrealDB identifier (no hyphens)", () => {
		const db = derivePerUserDatabase();
		assert.ok(!db.includes("-"), `db name must not contain hyphens: ${db}`);
		assert.match(db, /^[a-z][a-z0-9_]*$/);
	});

	it("is stable across calls (deterministic for the same OS user)", () => {
		assert.strictEqual(derivePerUserDatabase(), derivePerUserDatabase());
	});
});
