/**
 * db-transfer.test — pure-helper coverage for scripts/db-transfer.ts
 * (kcard-parity ticket 11). The engine itself needs a live SurrealDB server
 * and is exercised by the real run recorded in the ticket; these tests pin
 * the row maps and SurrealQL statement builders so the mapping cannot drift.
 */
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
	chunk,
	recordId,
	buildCreate,
	mergeBatch,
	sessionToSurreal,
	sessionToSqlite,
	messageToSurreal,
	messageToSqlite,
	sessionFileToSurreal,
	sessionFileToSqlite,
	surrealIdKey,
	memoryIdentity,
	surrealFidelityClauses,
	isAlreadyExists,
} from "../scripts/db-transfer.js";

describe("chunk", () => {
	it("splits evenly and carries the tail", () => {
		assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
		assert.deepEqual(chunk([], 10), []);
	});
});

describe("record ids", () => {
	it("prefixes with the table name", () => {
		assert.equal(recordId("messages", "abc"), "messages:abc");
	});
	it("strips the table prefix (and backticks) from full record ids", () => {
		assert.equal(surrealIdKey({ id: "messages:0000553f" }, "messages"), "0000553f");
		assert.equal(surrealIdKey({ id: "session_files:`/a/b c.jsonl`" }, "session_files"), "/a/b c.jsonl");
	});
});

describe("buildCreate / mergeBatch", () => {
	it("binds the key + every field via LET params (no string interpolation of values)", () => {
		const { sql, params } = buildCreate("m0_", "messages", "uuid-1", {
			sessionId: "s1", role: "user", content: "he said \"hi\"; DROP TABLE x", timestamp: "t", toolCalls: null,
		});
		assert.ok(sql.startsWith('CREATE type::record("messages", $m0_k) SET'));
		assert.ok(sql.includes("content = $m0_f2"));
		assert.equal(params.m0_k, "uuid-1");
		assert.equal(params.m0_f2, 'he said "hi"; DROP TABLE x'); // value NEVER inlined
	});
	it("merges a chunk into one body with collision-free params", () => {
		const rows = [
			buildCreate("s0_", "sessions", "a", { project: "p1" }),
			buildCreate("s1_", "sessions", "b", { project: "p2" }),
		];
		const batch = mergeBatch(rows);
		assert.equal(batch.body.split("\n").length, 2);
		assert.deepEqual(batch.params, { s0_k: "a", s0_f0: "p1", s1_k: "b", s1_f0: "p2" });
	});
});

describe("memory identity + fidelity", () => {
	it("identity is an unambiguous JSON tuple (space-containing values cannot collide)", () => {
		const a = { target: "memory", project: "a b", category: null, content: "c" };
		const b = { target: "memory", project: "a", category: null, content: "b c" };
		assert.notEqual(memoryIdentity(a), memoryIdentity(b));
	});
	it("fidelity clauses restore supersession lineage + counters; absent-valued fields stay unset", () => {
		const e = { status: "superseded", supersedes: 7, supersededBy: null, parentIds: [1, 2], mwSuccess: 3, mwFail: 1, pin: false, severity: null };
		const f = surrealFidelityClauses(e, "x_");
		assert.ok(f.sets.includes("status = $x_st"));
		assert.ok(f.sets.includes("supersedes = $x_sup"));
		assert.ok(f.sets.includes("parentIds = $x_pids"));
		// absent-semantics fields must NOT be written (repo convention: NONE)
		assert.ok(!f.sets.some((s) => s.startsWith("supersededBy")));
		assert.ok(!f.sets.some((s) => s.startsWith("pin")));
		assert.ok(!f.sets.some((s) => s.startsWith("severity")));
		assert.deepEqual(f.params, { x_st: "superseded", x_pids: [1, 2], x_mws: 3, x_mwf: 1, x_sup: 7 });
	});
});

describe("isAlreadyExists", () => {
	it("classifies duplicate-index and record-exists errors as skips", () => {
		assert.ok(isAlreadyExists(new Error("Database index `memories_md_id` already contains 'x', with record `memories:1`")));
		assert.ok(isAlreadyExists(new Error("Record already exists: `sessions:abc`")));
		assert.ok(!isAlreadyExists(new Error("SurrealDB HTTP 500: boom")));
	});
});

describe("row maps round-trip", () => {
	it("sessions: sqlite → surreal → sqlite is identity", () => {
		const row = { id: "019f", project: "p", cwd: "/c", started_at: "2026-08-23T00:00:00Z", ended_at: null, message_count: 6 };
		const surreal = sessionToSurreal(row);
		const back = sessionToSqlite({ id: `sessions:\`${surreal.key}\``, sid: surreal.key, ...surreal.fields });
		assert.deepEqual(back, row);
	});
	it("messages: sqlite → surreal → sqlite is identity (tool_calls passthrough)", () => {
		const row = { id: "m-1", session_id: "s-1", role: "assistant", content: "body", timestamp: "t", tool_calls: "[{\"a\":1}]" };
		const surreal = messageToSurreal(row);
		const back = messageToSqlite({ id: `messages:${surreal.key}`, ...surreal.fields });
		assert.deepEqual(back, row);
	});
	it("session_files: sqlite → surreal → sqlite is identity", () => {
		const row = { path: "/a/b--c/2026.jsonl", session_id: "s", size: 1130, mtime_ms: 1784114851731, indexed_at: "2026-08-23T00:00:00Z" };
		const surreal = sessionFileToSurreal(row);
		const back = sessionFileToSqlite({ id: `session_files:\`${surreal.key}\``, ...surreal.fields });
		assert.deepEqual(back, row);
	});
});
