#!/usr/bin/env bun
/**
 * db-transfer — two-way sqlite ↔ SurrealDB reconciliation for hermes-memory
 * (kcard-openviking-parity ticket 11; D7: surrealdb default, sqlite fallback).
 *
 * One idempotent script, two directions:
 *
 *   bun bun-apps/s2-agent-ext-hermes-memory/scripts/db-transfer.ts --to-surreal
 *   bun bun-apps/s2-agent-ext-hermes-memory/scripts/db-transfer.ts --to-sqlite
 *
 * Semantics (both directions — the LIVE side is never mutated destructively):
 *   - memories: goes through the repositories' `addMemory`, whose C6 dedup
 *     identity (target + project + category + content, exact, NULL-aware) is
 *     the sanctioned cross-backend write primitive. Existing rows are LEFT
 *     ALONE (counted `skipped`); only rows absent on the destination are
 *     created — and each created row then gets a FIDELITY UPDATE restoring
 *     what addMemory's input cannot carry (status/supersedes/supersededBy,
 *     parentIds, mwSuccess/mwFail, pin, severity). Graph edges are re-synced
 *     by the surreal repo on create.
 *   - sessions / messages / session_files / session_assembly(_meta): raw
 *     row copy with the repositories' snake_case ↔ camelCase field maps,
 *     insert-if-absent keyed on each table's natural key (sessions.id,
 *     messages.id, session_files.path, session_assembly_meta.session_id,
 *     session_assembly (session_id, md_id)). Nothing is ever deleted.
 *   - Table sets that exist on ONE side only are out of scope by design:
 *     sqlite-only `card_md_hash`/`card_dep_hash` (the surreal card-store
 *     branch throws on them — documented backend divergence) and
 *     `extension_metadata`; surreal-only `tag`/`tagged` (edge rows are
 *     re-derivable from memories' category/target on the surreal side).
 *   - FTS indexes on both sides maintain themselves on insert.
 *
 * SurrealQL traps honored (kcard-parity ticket 03 probe): no `IN $ids` with
 * record ids (silent empty match) — destination diffs are computed from full
 * paginated id dumps filtered client-side; batches stay ≤1 MiB request body;
 * a PARSE error 400s the whole batch, so a failed batch replays row-by-row.
 *
 * Flags: --memory-dir <dir> (default ~/.pi/agent/pi-hermes-memory)
 *        --endpoint/--namespace/--database/--user/--pass (defaults: local
 *        service + per-user namespace per per-user-db.ts)
 *        --dry-run (read + report, no writes)  --json (machine report)
 *
 * Exit 0 ok (incl. dry-run) · 1 runtime failure · 2 usage.
 */

import path from "node:path";
import os from "node:os";
import { SqliteBackend } from "../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../src/store/sqlite/sqlite-memory-repo.js";
import { SurrealBackend } from "../src/store/surreal/surreal-backend.js";
import { SurrealMemoryRepository } from "../src/store/surreal/surreal-memory-repo.js";
import {
	derivePerUserNamespace,
	DEFAULT_SURREAL_DATABASE,
} from "../src/store/surreal/per-user-db.js";

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

export interface SqliteSessionRow {
	id: string; project: string; cwd: string;
	started_at: string; ended_at: string | null; message_count: number | null;
}
export interface SqliteMessageRow {
	id: string; session_id: string; role: string;
	content: string; timestamp: string; tool_calls: string | null;
}
export interface SqliteSessionFileRow {
	path: string; session_id: string; size: number;
	mtime_ms: number; indexed_at: string;
}
export interface SqliteAssemblyMetaRow {
	session_id: string; hash: string; captured_at: string;
}
export interface SqliteAssemblyRow {
	session_id: string; md_id: string; used_at: string | null;
}

export function chunk<T>(rows: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
	return out;
}

/** Surreal record id string for a table + plain key ("messages", "<uuid>"). */
export function recordId(table: string, key: string): string {
	return `${table}:${key}`;
}

/** One SurrealQL `CREATE type::record(...) SET ...;` statement with LET-bound
 * params (numbered suffixes keep rows in one batch collision-free). */
export function buildCreate(
	prefix: string,
	table: string,
	key: string,
	fields: Record<string, unknown>,
): { sql: string; params: Record<string, unknown> } {
	const params: Record<string, unknown> = { [`${prefix}k`]: key };
	const sets = Object.entries(fields).map(([name, value], i) => {
		const p = `${prefix}f${i}`;
		params[p] = value;
		return `${name} = $${p}`;
	});
	const sql = `CREATE type::record("${table}", $${prefix}k) SET ${sets.join(", ")};`;
	return { sql, params };
}

/** Merge a chunk of per-row CREATE payloads into one batch body. A PARSE
 * error 400s the whole batch — callers replay rows individually on failure. */
export function mergeBatch(rows: Array<{ sql: string; params: Record<string, unknown> }>): {
	body: string;
	params: Record<string, unknown>;
} {
	return {
		body: rows.map((r) => r.sql).join("\n"),
		params: Object.assign({}, ...rows.map((r) => r.params)),
	};
}

// snake_case → camelCase row maps (field names mirror the repositories' DTOs).

export function sessionToSurreal(r: SqliteSessionRow): { key: string; fields: Record<string, unknown> } {
	return {
		key: r.id,
		fields: {
			sid: r.id, project: r.project, cwd: r.cwd,
			startedAt: r.started_at, endedAt: r.ended_at,
			messageCount: r.message_count ?? 0,
		},
	};
}
export function messageToSurreal(r: SqliteMessageRow): { key: string; fields: Record<string, unknown> } {
	return {
		key: r.id,
		fields: {
			sessionId: r.session_id, role: r.role, content: r.content,
			timestamp: r.timestamp, toolCalls: r.tool_calls,
		},
	};
}
export function sessionFileToSurreal(r: SqliteSessionFileRow): { key: string; fields: Record<string, unknown> } {
	return {
		key: r.path,
		fields: {
			path: r.path, sessionId: r.session_id, size: r.size,
			mtimeMs: r.mtime_ms, indexedAt: r.indexed_at,
		},
	};
}

// camelCase → snake_case (surreal rows arrive as the repositories wrote them).

export interface SurrealRow { id: string; [k: string]: unknown }

export function surrealIdKey(row: SurrealRow, table: string): string {
	// row.id is the full record id ("messages:<key>", possibly backticked);
	// strip the table prefix. Where the row carries its own plain key field
	// (sessions.sid), callers prefer that.
	const raw = String(row.id);
	const prefix = `${table}:`;
	return raw.startsWith(prefix) ? raw.slice(prefix.length).replace(/^`|`$/g, "") : raw;
}

export function sessionToSqlite(row: SurrealRow): SqliteSessionRow {
	return {
		id: typeof row.sid === "string" ? row.sid : surrealIdKey(row, "sessions"),
		project: String(row.project ?? ""), cwd: String(row.cwd ?? ""),
		started_at: String(row.startedAt ?? ""), ended_at: (row.endedAt as string | null) ?? null,
		message_count: Number(row.messageCount ?? 0),
	};
}
export function messageToSqlite(row: SurrealRow): SqliteMessageRow {
	return {
		id: surrealIdKey(row, "messages"),
		session_id: String(row.sessionId ?? ""), role: String(row.role ?? ""),
		content: String(row.content ?? ""), timestamp: String(row.timestamp ?? ""),
		tool_calls: (row.toolCalls as string | null) ?? null,
	};
}
export function sessionFileToSqlite(row: SurrealRow): SqliteSessionFileRow {
	return {
		path: typeof row.path === "string" ? row.path : surrealIdKey(row, "session_files"),
		session_id: String(row.sessionId ?? ""), size: Number(row.size ?? 0),
		mtime_ms: Number(row.mtimeMs ?? 0), indexed_at: String(row.indexedAt ?? ""),
	};
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface Args {
	direction: "to-surreal" | "to-sqlite";
	memoryDir: string;
	endpoint: string;
	namespace: string;
	database: string;
	user: string;
	pass: string;
	dryRun: boolean;
	json: boolean;
}

function parseArgs(argv: string[]): Args {
	let direction: Args["direction"] | null = null;
	let memoryDir = path.join(os.homedir(), ".pi", "agent", "pi-hermes-memory");
	let endpoint = "http://127.0.0.1:8000";
	let namespace = derivePerUserNamespace();
	let database = DEFAULT_SURREAL_DATABASE;
	let user = "root";
	let pass = "root";
	let dryRun = false;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = (): string => {
			const v = argv[++i];
			if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
			return v;
		};
		if (a === "--to-surreal") direction = "to-surreal";
		else if (a === "--to-sqlite") direction = "to-sqlite";
		else if (a === "--memory-dir") memoryDir = next();
		else if (a === "--endpoint") endpoint = next();
		else if (a === "--namespace") namespace = next();
		else if (a === "--database") database = next();
		else if (a === "--user") user = next();
		else if (a === "--pass") pass = next();
		else if (a === "--dry-run") dryRun = true;
		else if (a === "--json") json = true;
		else if (a === "--help" || a === "-h") { console.error(usage); process.exit(0); }
		else { console.error(`unknown flag ${a}`); console.error(usage); process.exit(2); }
	}
	if (!direction) { console.error("one of --to-surreal / --to-sqlite is required"); console.error(usage); process.exit(2); }
	return { direction, memoryDir, endpoint, namespace, database, user, pass, dryRun, json };
}

const usage = `usage: db-transfer.ts --to-surreal | --to-sqlite [flags]
  --memory-dir <dir>   sqlite side (default ~/.pi/agent/pi-hermes-memory)
  --endpoint <url>     SurrealDB (default http://127.0.0.1:8000)
  --namespace <ns>     (default per-user ${derivePerUserNamespace()})
  --database <db>      (default ${DEFAULT_SURREAL_DATABASE})
  --user/--pass        credentials (default root/root)
  --dry-run            read + report only   --json  machine report`;

// ─── Engine ──────────────────────────────────────────────────────────────────

interface TableReport {
	table: string; src: number; dst: number; created: number; skipped: number; failed: number;
	note?: string;
}
type Query = <T = unknown>(sql: string, params?: Record<string, unknown>) => Promise<T>;

/** Full paginated dump of a surreal table (LIMIT/START + ORDER BY id — no
 * record-id IN traps, stable pagination, no response gamble beyond a page). */
async function dumpSurreal<T extends SurrealRow>(q: Query, table: string, pageSize = 2000): Promise<T[]> {
	const out: T[] = [];
	for (let offset = 0; ; offset += pageSize) {
		const page = await q<T[]>(`SELECT * FROM ${table} ORDER BY id LIMIT ${pageSize} START ${offset};`);
		out.push(...page);
		if (page.length < pageSize) return out;
	}
}

/** C6 identity key as an unambiguous JSON tuple (a space separator could
 * collide on project names containing spaces). */
export function memoryIdentity(e: {
	target: string; project: string | null; category: string | null; content: string;
}): string {
	return JSON.stringify([e.target, e.project ?? "", e.category ?? "", e.content]);
}

/** Fidelity SET clauses for a surreal memories row — restores what addMemory's
 * input cannot carry. Clauses with null/NONE semantics (severity, pin,
 * supersedes/supersededBy) are included only when set, mirroring the repo's
 * convention of not writing fields that mean "absent". */
export function surrealFidelityClauses(e: {
	status?: string; supersedes?: number | null; supersededBy?: number | null;
	parentIds?: number[]; mwSuccess?: number; mwFail?: number; pin?: boolean;
	severity?: number | null;
}, prefix: string): { sets: string[]; params: Record<string, unknown> } {
	const sets = [`status = $${prefix}st`, `parentIds = $${prefix}pids`,
		`mwSuccess = $${prefix}mws`, `mwFail = $${prefix}mwf`];
	const params: Record<string, unknown> = {
		[`${prefix}st`]: e.status ?? "active", [`${prefix}pids`]: e.parentIds ?? [],
		[`${prefix}mws`]: e.mwSuccess ?? 0, [`${prefix}mwf`]: e.mwFail ?? 0,
	};
	if (e.severity != null) { sets.push(`severity = $${prefix}sev`); params[`${prefix}sev`] = e.severity; }
	if (e.pin === true) { sets.push(`pin = $${prefix}pin`); params[`${prefix}pin`] = true; }
	if (e.supersedes != null) { sets.push(`supersedes = $${prefix}sup`); params[`${prefix}sup`] = e.supersedes; }
	if (e.supersededBy != null) { sets.push(`supersededBy = $${prefix}supd`); params[`${prefix}supd`] = e.supersededBy; }
	return { sets, params };
}

/** "already exists" / duplicate-index errors mean the row is present on the
 * destination — insert-only semantics satisfied, count as skipped (a failed
 * /sql batch may have committed earlier statements before erroring, so the
 * row-by-row replay hits these by design). */
export function isAlreadyExists(err: unknown): boolean {
	return /already (contains|exists)/i.test(err instanceof Error ? err.message : String(err));
}

/** Run one batch of merged CREATE statements; on batch failure replay rows
 * one-by-one so a single bad row cannot poison the batch (P3: one PARSE
 * error 400s the whole /sql body — but statements before it stay applied). */
async function runCreates(
	q: Query,
	rows: Array<{ sql: string; params: Record<string, unknown> }>,
	report: TableReport,
): Promise<void> {
	if (rows.length === 0) return;
	try {
		const batch = mergeBatch(rows);
		await q(batch.body, batch.params);
		report.created += rows.length;
		return;
	} catch (err) {
		console.error(`  ! batch failed (${err instanceof Error ? err.message : String(err)}), replaying rows individually`);
		for (const r of rows) {
			try {
				await q(r.sql, r.params);
				report.created++;
			} catch (rowErr) {
				if (isAlreadyExists(rowErr)) { report.skipped++; continue; }
				report.failed++;
				console.error(`  ! create failed: ${rowErr instanceof Error ? rowErr.message : String(rowErr)}`);
			}
		}
	}
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const reports: TableReport[] = [];

	const sqlite = new SqliteBackend(args.memoryDir);
	await sqlite.init();
	const sqliteDb = sqlite.getDb();
	const sqliteRepo = new SqliteMemoryRepository(sqlite);

	const surreal = new SurrealBackend({
		endpoint: args.endpoint, namespace: args.namespace, database: args.database,
		username: args.user, password: args.pass,
	});
	await surreal.init();
	const sq: Query = (sql, params) => surreal.client.query(sql, params);
	const surrealRepo = new SurrealMemoryRepository(surreal);

	const log = (m: string): void => { if (!args.json) console.error(m); };
	log(`# db-transfer ${args.direction}${args.dryRun ? " (dry-run)" : ""}`);
	log(`  sqlite ${path.join(args.memoryDir, "sessions.db")}  <->  surreal ${args.endpoint} ${args.namespace}/${args.database}`);

	// ── memories (repo path: C6 identity dedup; never mutates existing rows) ──
	{
		const report: TableReport = { table: "memories", src: 0, dst: 0, created: 0, skipped: 0, failed: 0,
			note: "addMemory + fidelity update — never overwrites a live destination row" };
		if (args.direction === "to-surreal") {
			const entries = await sqliteRepo.getMemories({});
			const dst = await surrealRepo.getMemories({});
			const dstIds = new Set(dst.map(memoryIdentity));
			// Rows whose mdId already exists on the destination are content-diverged
			// copies of a live row — NEVER overwrite the live side; skip them.
			const dstMdIds = new Set(dst.filter((e) => e.mdId).map((e) => e.mdId as string));
			report.src = entries.length; report.dst = dst.length;
			for (const e of entries) {
				if (dstIds.has(memoryIdentity(e))) { report.skipped++; continue; }
				if (e.mdId && dstMdIds.has(e.mdId)) { report.skipped++; continue; }
				if (args.dryRun) { report.created++; continue; }
				try {
					const created = await surrealRepo.addMemory(e);
					// Fidelity: restore what addMemory's input cannot carry
					// (status/supersession lineage would otherwise resurrect
					// retired rows as active).
					const f = surrealFidelityClauses(e, "fid_");
					await sq(`UPDATE type::record("memories", $fid_id) SET ${f.sets.join(", ")};`,
						{ fid_id: String(created.id), ...f.params });
					report.created++;
				}
				catch (err) { report.failed++; console.error(`  ! memory failed: ${err instanceof Error ? err.message : String(err)}`); }
			}
		} else {
			const entries = await surrealRepo.getMemories({});
			const dst = await sqliteRepo.getMemories({});
			const dstIds = new Set(dst.map(memoryIdentity));
			// Same rule reversed: a destination row with the same mdId is live — skip.
			const dstMdIds = new Set(dst.filter((e) => e.mdId).map((e) => e.mdId as string));
			report.src = entries.length; report.dst = dst.length;
			for (const e of entries) {
				if (dstIds.has(memoryIdentity(e))) { report.skipped++; continue; }
				if (e.mdId && dstMdIds.has(e.mdId)) { report.skipped++; continue; }
				if (args.dryRun) { report.created++; continue; }
				try {
					const created = await sqliteRepo.addMemory(e);
					// Fidelity (sqlite side): same fields addMemory cannot carry.
					sqliteDb.prepare(
						"UPDATE memories SET status = ?, supersedes = ?, superseded_by = ?, parent_ids = ?, mw_success = ?, mw_fail = ?, severity = ?, pin = ? WHERE id = ?",
					).run(
						e.status ?? "active", e.supersedes ?? null, e.supersededBy ?? null,
						JSON.stringify(e.parentIds ?? []), e.mwSuccess ?? 0, e.mwFail ?? 0,
						e.severity ?? null, e.pin === true ? 1 : 0, Number(created.id),
					);
					report.created++;
				}
				catch (err) { report.failed++; console.error(`  ! memory failed: ${err instanceof Error ? err.message : String(err)}`); }
			}
		}
		reports.push(report);
	}

	// ── sessions (key: id) ──
	{
		const report: TableReport = { table: "sessions", src: 0, dst: 0, created: 0, skipped: 0, failed: 0 };
		if (args.direction === "to-surreal") {
			const src = sqliteDb.prepare("SELECT id, project, cwd, started_at, ended_at, message_count FROM sessions").all() as unknown as SqliteSessionRow[];
			const dst = new Set((await dumpSurreal(sq, "sessions")).map((r) => (typeof r.sid === "string" ? r.sid : surrealIdKey(r, "sessions"))));
			report.src = src.length; report.dst = dst.size;
			const missing = src.filter((r) => !dst.has(r.id));
			report.skipped = src.length - missing.length;
			if (!args.dryRun) {
				for (const part of chunk(missing, 50)) {
					await runCreates(sq, part.map((r, i) => {
						const m = sessionToSurreal(r);
						return buildCreate(`s${i}_`, "sessions", m.key, m.fields);
					}), report);
				}
			} else report.created = missing.length;
		} else {
			const src = await dumpSurreal(sq, "sessions");
			const dst = new Set((sqliteDb.prepare("SELECT id FROM sessions").all() as unknown as Array<{ id: string }>).map((r) => r.id));
			report.src = src.length; report.dst = dst.size;
			const missing = src.map((r) => sessionToSqlite(r)).filter((r) => !dst.has(r.id));
			report.skipped = src.length - missing.length;
			if (!args.dryRun) {
				const insert = sqliteDb.prepare("INSERT OR IGNORE INTO sessions (id, project, cwd, started_at, ended_at, message_count) VALUES (?, ?, ?, ?, ?, ?)");
				for (const r of missing) {
					try { insert.run(r.id, r.project, r.cwd, r.started_at, r.ended_at, r.message_count); report.created++; }
					catch (err) { report.failed++; console.error(`  ! session failed: ${err instanceof Error ? err.message : String(err)}`); }
				}
			} else report.created = missing.length;
		}
		reports.push(report);
	}

	// ── messages (key: id; full paginated dump + client-side diff — no IN traps) ──
	{
		const report: TableReport = { table: "messages", src: 0, dst: 0, created: 0, skipped: 0, failed: 0 };
		if (args.direction === "to-surreal") {
			const src = sqliteDb.prepare("SELECT id, session_id, role, content, timestamp, tool_calls FROM messages").all() as unknown as SqliteMessageRow[];
			const dstRows = await dumpSurreal(sq, "messages");
			const dst = new Set(dstRows.map((r) => surrealIdKey(r, "messages")));
			report.src = src.length; report.dst = dst.size;
			const missing = src.filter((r) => !dst.has(r.id));
			report.skipped = src.length - missing.length;
			// The surreal session repo denormalizes project/cwd onto every
			// message (project-filtered session search reads them) — carry them
			// over from the session row when copying.
			const sessionMeta = new Map(
				(sqliteDb.prepare("SELECT id, project, cwd FROM sessions").all() as unknown as Array<{ id: string; project: string; cwd: string }>)
					.map((r) => [r.id, { project: r.project, cwd: r.cwd }]),
			);
			if (!args.dryRun) {
				for (const part of chunk(missing, 50)) {
					await runCreates(sq, part.map((r, i) => {
						const m = messageToSurreal(r);
						const meta = sessionMeta.get(r.session_id);
						const fields = meta ? { ...m.fields, project: meta.project, cwd: meta.cwd } : m.fields;
						return buildCreate(`m${i}_`, "messages", m.key, fields);
					}), report);
				}
			} else report.created = missing.length;
		} else {
			const src = await dumpSurreal(sq, "messages");
			const dst = new Set((sqliteDb.prepare("SELECT id FROM messages").all() as unknown as Array<{ id: string }>).map((r) => r.id));
			report.src = src.length; report.dst = dst.size;
			const missing = src.map((r) => messageToSqlite(r)).filter((r) => !dst.has(r.id));
			report.skipped = src.length - missing.length;
			if (!args.dryRun) {
				const insert = sqliteDb.prepare("INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp, tool_calls) VALUES (?, ?, ?, ?, ?, ?)");
				for (const r of missing) {
					try { insert.run(r.id, r.session_id, r.role, r.content, r.timestamp, r.tool_calls); report.created++; }
					catch (err) { report.failed++; console.error(`  ! message failed: ${err instanceof Error ? err.message : String(err)}`); }
				}
			} else report.created = missing.length;
		}
		reports.push(report);
	}

	// ── session_files (key: path) ──
	{
		const report: TableReport = { table: "session_files", src: 0, dst: 0, created: 0, skipped: 0, failed: 0 };
		if (args.direction === "to-surreal") {
			const src = sqliteDb.prepare("SELECT path, session_id, size, mtime_ms, indexed_at FROM session_files").all() as unknown as SqliteSessionFileRow[];
			const dst = new Set((await dumpSurreal(sq, "session_files")).map((r) => (typeof r.path === "string" ? r.path : surrealIdKey(r, "session_files"))));
			report.src = src.length; report.dst = dst.size;
			const missing = src.filter((r) => !dst.has(r.path));
			report.skipped = src.length - missing.length;
			if (!args.dryRun) {
				for (const part of chunk(missing, 50)) {
					await runCreates(sq, part.map((r, i) => {
						const m = sessionFileToSurreal(r);
						return buildCreate(`f${i}_`, "session_files", m.key, m.fields);
					}), report);
				}
			} else report.created = missing.length;
		} else {
			const src = await dumpSurreal(sq, "session_files");
			const dst = new Set((sqliteDb.prepare("SELECT path FROM session_files").all() as unknown as Array<{ path: string }>).map((r) => r.path));
			report.src = src.length; report.dst = dst.size;
			const missing = src.map((r) => sessionFileToSqlite(r)).filter((r) => !dst.has(r.path));
			report.skipped = src.length - missing.length;
			if (!args.dryRun) {
				const insert = sqliteDb.prepare("INSERT OR IGNORE INTO session_files (path, session_id, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)");
				for (const r of missing) {
					try { insert.run(r.path, r.session_id, r.size, r.mtime_ms, r.indexed_at); report.created++; }
					catch (err) { report.failed++; console.error(`  ! session_file failed: ${err instanceof Error ? err.message : String(err)}`); }
				}
			} else report.created = missing.length;
		}
		reports.push(report);
	}

	// ── session_assembly_meta (key: session_id) + session_assembly (session_id, md_id) ──
	for (const table of ["session_assembly_meta", "session_assembly"] as const) {
		const report: TableReport = { table, src: 0, dst: 0, created: 0, skipped: 0, failed: 0 };
		if (args.direction === "to-surreal") {
			const src = sqliteDb.prepare(`SELECT * FROM ${table}`).all() as unknown as Array<Record<string, unknown>>;
			const dstRows = await dumpSurreal(sq, table);
			const dst = new Set(dstRows.map((r) => `${r.sessionId ?? ""} ${r.mdId ?? ""}`));
			report.src = src.length; report.dst = dst.size;
			const missing = src.filter((r) => !dst.has(`${r.session_id ?? ""} ${r.md_id ?? ""}`));
			report.skipped = src.length - missing.length;
			if (!args.dryRun) {
				for (const part of chunk(missing, 50)) {
					await runCreates(sq, part.map((r, i) => {
						if (table === "session_assembly_meta") {
							return buildCreate(`a${i}_`, table, String(r.session_id), {
								sessionId: r.session_id, hash: r.hash, capturedAt: r.captured_at,
							});
						}
						// session_assembly has no natural record key — auto id. A null
						// used_at means never-used: omit the SET so the field stays
						// NONE (the repo reads used-at via `IS NOT NONE`; a stored
						// null would read as used).
						const params: Record<string, unknown> = {
							[`b${i}s`]: r.session_id, [`b${i}m`]: r.md_id,
						};
						const usedAtClause = r.used_at == null ? "" : `, usedAt = $b${i}u`;
						if (r.used_at != null) params[`b${i}u`] = r.used_at;
						return {
							sql: `CREATE ${table} SET sessionId = $b${i}s, mdId = $b${i}m${usedAtClause};`,
							params,
						};
					}), report);
				}
			} else report.created = missing.length;
		} else {
			const src = await dumpSurreal(sq, table);
			const dstRaw = sqliteDb.prepare(`SELECT * FROM ${table}`).all() as unknown as Array<Record<string, unknown>>;
			const dst = new Set(dstRaw.map((r) => `${r.session_id ?? ""} ${r.md_id ?? ""}`));
			report.src = src.length; report.dst = dst.size;
			const missing = src.filter((r) => !dst.has(`${r.sessionId ?? ""} ${r.mdId ?? ""}`));
			report.skipped = src.length - missing.length;
			if (!args.dryRun && missing.length > 0) {
				const cols = table === "session_assembly_meta" ? "(session_id, hash, captured_at)" : "(session_id, md_id, used_at)";
				const insert = sqliteDb.prepare(`INSERT OR IGNORE INTO ${table} ${cols} VALUES (?, ?, ?)`);
				for (const r of missing) {
					try {
						if (table === "session_assembly_meta") insert.run(String(r.sessionId), String(r.hash), String(r.capturedAt));
						else insert.run(String(r.sessionId), String(r.mdId), (r.usedAt as string | null) ?? null);
						report.created++;
					} catch (err) { report.failed++; console.error(`  ! ${table} failed: ${err instanceof Error ? err.message : String(err)}`); }
				}
			} else if (args.dryRun) report.created = missing.length;
		}
		reports.push(report);
	}

	await sqlite.close();

	if (args.json) {
		console.log(JSON.stringify({ direction: args.direction, dryRun: args.dryRun, tables: reports }, null, 2));
	} else {
		console.error("\n table                    src      dst  created  skipped  failed");
		for (const r of reports) {
			console.error(` ${r.table.padEnd(20)} ${String(r.src).padStart(6)} ${String(r.dst).padStart(7)} ${String(r.created).padStart(8)} ${String(r.skipped).padStart(8)} ${String(r.failed).padStart(7)}${r.note ? `   (${r.note})` : ""}`);
		}
		console.error(args.dryRun ? "\n dry-run — nothing written" : "\n done");
	}
	const failures = reports.reduce((n, r) => n + r.failed, 0);
	return failures > 0 ? 1 : 0;
}

// Library-safe: only run when invoked directly (tests import the helpers).
if (import.meta.main) {
	process.exit(await main());
}
