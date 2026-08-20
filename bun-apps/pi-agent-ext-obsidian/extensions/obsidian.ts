/**
 * Obsidian Extension — tool registrations + barrel re-exports.
 *
 * Library code lives in ../src/obsidian-lib.ts. This file contains ONLY:
 *   1. Barrel re-exports (consumers importing from this path are unaffected)
 *   2. The default export function with tool registrations
 *
 * Phase 2 refactor (2026-07-11): split from the 5320-line god-file.
 */

import { execFile, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import {
	join,
	resolve,
	normalize,
	sep,
	relative,
	isAbsolute,
} from "node:path";
import { promisify } from "node:util";
import {
	readFile,
	writeFile,
	mkdir,
	readdir,
	cp,
	mkdtemp,
	rm,
	lstat,
	realpath,
	stat,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
import { shExtDir } from "../src/lib/ext-dir";

// ─── Gate family (wayfinder ticket 02 — demoted from core) ──────────────────
// obsidian + obsidian_help share the vault I/O domain (vault read/write/search/
// organize across 18 actions). Demoted from always-active core to an on-demand
// gate: vault work is bursty (a "put this in the vault" turn), not per-turn.
// Keywords are the vault/note vocabulary; the noun∧verb requires path keeps
// "check the vault for X" reachable without a bare vault keyword.
GATE_DEFS["obsidian"] = {
  id: "obsidian",
  keywords: ["obsidian", "vault", "vault note", "vault file", "weekly-news", "筆記庫", "知識庫", "放入 vault"],
  requires: {
    nouns: ["vault", "note", "file", "folder", "筆記", "檔案", "資料夾"],
    verbs: ["read", "write", "search", "organize", "move", "create", "讀取", "寫入", "搜尋", "整理", "建立"],
  },
  description: "Vault I/O (read/write/search/organize 18 actions) + on-demand help",
};

/**
 * The `obsidian` actions that MUTATE the vault.
 *
 * Single source of truth for anything that needs to distinguish read from write
 * — notably pi-agent's `--dry-run` (see `dryRunExclude` / `applyDryRunEnv` in
 * `bun-apps/pi-agent/src/cli/sessions/shared.ts`).
 *
 * Before the 18 `obsidian_*` tools collapsed into this one action-dispatched
 * facade, a caller could suppress writes by leaving the write TOOLS out of the
 * session allowlist. That lever is gone: there is exactly one registered tool
 * and excluding it would remove reads too. So the refusal now has to happen
 * here, at dispatch, keyed off `OB_DRY_RUN=1`.
 */
export const OBSIDIAN_WRITE_ACTIONS: readonly string[] = [
	"create",
	"append",
	"append_section",
	"update_frontmatter",
	"move",
	"rename",
	"delete",
	"invalidate",
	"distill",
	"garden",
];

const WRITE_ACTION_SET = new Set(OBSIDIAN_WRITE_ACTIONS);

/** `OB_DRY_RUN=1` → the facade refuses every write action. */
export function isObsidianDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.OB_DRY_RUN === "1" || env.OB_DRY_RUN === "true";
}

/**
 * Deterministic dry-run gate: refuse a write action instead of performing it.
 * Returns the refusal text, or `null` when the action may proceed.
 */
export function dryRunRefusal(action: string, env?: NodeJS.ProcessEnv): string | null {
	if (!isObsidianDryRun(env)) return null;
	if (!WRITE_ACTION_SET.has(action)) return null;
	return (
		'[dry-run] refused obsidian action "' + action + '" — it writes to the vault. ' +
		"Read-only actions (list, read, search, semantic_search, query, open, status) " +
		"are still available: gather context and report what you WOULD write."
	);
}

/** Runtime-validated args for the obsidian fat tool. After the param schema
 *  collapses to {action, args}, schema-layer validation disappears; this
 *  recovers it server-side against the per-action captured schema — zero
 *  token cost (the per-action schemas never appear in the schema the LLM sees).
 *  `resolveSchema` is injected because `_capture` lives in the factory closure. */
export function validateActionArgs(
	action: string,
	args: unknown,
	resolveSchema: (action: string) => unknown | null,
): { ok: true } | { ok: false; errorText: string } {
	const schema = resolveSchema(action);
	if (schema == null) {
		return {
			ok: false,
			errorText:
				"Unknown obsidian action: " + action +
				". Valid: list, read, create, append, append_section, search, semantic_search, query, move, rename, update_frontmatter, delete, invalidate, open, distill, garden, status",
		};
	}
	if (Value.Check(schema as ReturnType<typeof Type.Object>, args)) return { ok: true };
	return { ok: false, errorText: buildDispatchError(action, schema) };
}

/** Human-readable error listing the valid args for an action + a pointer to help. */
export function buildDispatchError(action: string, schema: unknown): string {
	const props = (schema as { properties?: Record<string, unknown> })?.properties ?? {};
	const argList = Object.keys(props).join(", ") || "(no args)";
	return (
		"obsidian \"" + action + "\" got invalid args. Valid args: " + argList +
		".\nCall the obsidian_help tool for per-action semantics."
	);
}

// Barrel re-export — all library symbols available from this path
export * from "../src/obsidian-lib.ts";

// Import everything the tool registrations need
import {
	type CacheEntry,
	type ErrCode,
	GARDEN_SYSTEM_PROMPT,
	type GraphMode,
	type GraphResult,
	INDEX_CACHE_VERSION,
	INDEX_POLL_MS_DEFAULT,
	type IntegrityIssue,
	LINK_DELETE,
	LINK_KEEP,
	type MatchMode,
	type NoteField,
	type NoteMeta,
	type NoteValidation,
	OBSIDIAN_JSON,
	type ObsidianConfig,
	type ParsedFrontmatter,
	type ResolvedModel,
	type ResolvedVault,
	type SearchMatch,
	type SubagentOptions,
	type VaultConfigFile,
	type VaultEntry,
	VaultError,
	type VaultIndex,
	type VaultSource,
	WEAK_MODEL_PATTERNS,
	WRITE_BLOCKLIST,
	ZETTEL_MAX_BYTES,
	ZETTEL_REQUIRED_KEYS,
	ZETTEL_SYSTEM_PROMPT,
	__fileCacheOrder,
	_findMonorepoRoot,
	_missingDeps,
	appendUnderHeading,
	assertExtensionApi,
	assertWithinVault,
	assertWritablePath,
	atomicWriteFile,
	backlinkPaths,
	basenameOf,
	buildAdjacency,
	buildIndex,
	buildMatcher,
	classifyFsError,
	computeFieldLabels,
	contentTrigrams,
	countNotes,
	deescapeRegex,
	deleteNote,
	detectTitleStyleOutliers,
	dropIndex,
	errMsg,
	execFileP,
	extractWikiLinks,
	fieldWeight,
	fileCache,
	fileCacheMax,
	findBacklinks,
	findTagNotes,
	fsErrCode,
	fsLstat,
	fsRealpath,
	fuzzyMatch,
	getAdjacency,
	getIndex,
	graphDeadLinks,
	graphNeighbors,
	graphOrphans,
	graphOutgoing,
	indexCache,
	indexCachePath,
	indexInFlight,
	indexNote,
	indexPollMs,
	indexRefreshAt,
	invalidateCache,
	isDirEmpty,
	isSubsequence,
	isWeakModel,
	launcherForUri,
	levenshtein,
	listNotes,
	listVaultCandidates,
	loadCachedIndex,
	makeSubagentProgressLogger,
	maybeTriggerReindex,
	moveNote,
	mtimeConflict,
	noteMtime,
	noteRecencyDays,
	openObsidianUri,
	parseFrontmatter,
	parseNoteMeta,
	parseStructuredResult,
	personalConfigPath,
	pickField,
	projectConfigPath,
	queryNotes,
	readBatched,
	readCached,
	readObsidianVaults,
	readPersonalConfig,
	readProjectConfig,
	rebuildReverseAdjacency,
	refreshIndex,
	reindexFile,
	renameOverwrite,
	renderContext,
	resolveLink,
	resolveSubagentModel,
	resolveVault,
	resolveWikiLink,
	rewriteLinkToken,
	rewriteLinksProtected,
	runDirConfigPath,
	runDirPath,
	runObsidianSubagent,
	safeNotePath,
	saveIndex,
	scheduleVaultBanner,
	obsidianActionReferenceText,
	obsidianRoutingDescription,
	searchReferenceText,
	searchRoutingDescription,
	searchVault,
	seedFromTemplate,
	serializeIndex,
	statMtimes,
	stringifyFrontmatter,
	stripScalar,
	tagPaths,
	titleKeysFor,
	toolAllowlist,
	repairZettelFrontmatter,
	runDeterministicHealthCheck,
	toolError,
	toolErrorFromCaught,
	trigramCandidates,
	unindexNote,
	updateFrontmatter,
	validateNoteIntegrity,
	validateNoteIntegrityBatch,
	validateZettelNote,
	validateZettelNotes,
	writeVaultConfig
} from "../src/obsidian-lib.ts";

export default function (pi: ExtensionAPI) {
	// Phase 5 / WS-C8: light ExtensionAPI contract guard. The ExtensionAPI type
	// is a type-only import (no runtime symbol), and pi-agent vendors an
	// inline copy — so a stale host could pass a `pi` that lacks methods this
	// extension calls. Fail fast on a missing CORE method (registerTool); warn
	// (don't throw) on the secondary ones so a forward-compatible host isn't
	// blocked. See the "Vault Submodule Remount" zettel for the inline-bundle
	// source-of-truth note.
	assertExtensionApi(pi);

	// Cached ResolvedVault (per session). `source` lets every tool surface
	// where the active vault came from; `staleReason` carries Tier-1 warnings.
	let vault: ResolvedVault | undefined;

	const getVault = async (cwd: string): Promise<ResolvedVault> => {
		if (!vault) vault = await resolveVault(cwd);
		return vault;
	};

	const vname = (v: { name: string }) => encodeURIComponent(v.name);

	// ---- Tool: obsidian_list -------------------------------------------------

	// Phase 3: Capture all tool registrations internally — only ONE fat tool is
	// exposed to the agent. The fat tool dispatches to these captured handlers.
	// `registerTool` is generic so each captured tool literal is contextually
	// typed as ToolDefinition<T> (T inferred from `parameters`) — this is what
	// gives the `execute(id, params, signal, onUpdate, ctx)` callbacks their
	// real param types instead of implicit-any. The old `t: any` signature
	// threw generics away and surfaced ~80 implicit-any errors once this file
	// became reachable via pi-agent's static import.
	const _capture = {
		_tools: {} as Record<string, ToolDefinition>,
		registerTool<T extends TSchema>(t: ToolDefinition<T>) { this._tools[t.name] = t; },
	};

	_capture.registerTool({
		name: "obsidian_list",
		label: "Obsidian List",
		promptSnippet: "List markdown notes in a vault folder (recursive)",
		description:
			"List markdown notes in an Obsidian vault folder (recursive). Returns paths relative to the vault root. Omit folder to list the whole vault.",
		parameters: Type.Object({
			folder: Type.Optional(
				Type.String({
					description: "Folder relative to vault root. Default: root.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const notes = await listNotes(v.path, params.folder ?? "");
			return {
				content: [
					{
						type: "text",
						text: notes.length
							? `Vault "${v.name}", ${notes.length} note(s):\n${notes.join("\n")}`
							: `No notes under "${params.folder || "root"}" in "${v.name}".`,
					},
				],
				details: { vault: v.name, notes },
			};
		},
	});

	// ---- Tool: obsidian_read -------------------------------------------------
	_capture.registerTool({
		name: "obsidian_read",
		label: "Obsidian Read",
		promptSnippet: "Read a note's contents",
		description: "Read a note's contents. Path with or without .md.",
		parameters: Type.Object({
			note: Type.String({
				description: "Note path relative to vault root (e.g. Inbox/idea).",
			}),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const abs = safeNotePath(v.path, params.note);
			assertWritablePath(v.path, abs);
			await assertWithinVault(v.path, abs);
			let content: string;
			try {
				content = await readFile(abs, "utf8");
			} catch (e) {
				const code = classifyFsError(e);
				return toolError(
					code,
					code === "NOT_FOUND"
						? `Note not found: ${params.note}`
						: `Cannot read ${params.note}: ${errMsg(e)}`,
					{ vault: v.name, note: params.note, fsCode: fsErrCode(e) },
				);
			}
			return {
				content: [{ type: "text", text: content }],
				details: { vault: v.name, note: params.note, bytes: content.length },
			};
		},
	});

	// ---- Tool: obsidian_create ----------------------------------------------
	_capture.registerTool({
		name: "obsidian_create",
		label: "Obsidian Create",
		promptSnippet: "Create/overwrite a note (refuses overwrite unless overwrite:true)",
		description:
			"Create or overwrite a note. Parent folders are created automatically. Obsidian picks up changes live. By default refuses to overwrite an existing note (set overwrite:true or pass expectedMtime to update an existing file).",
		parameters: Type.Object({
			note: Type.String({ description: "Note path relative to vault root." }),
			content: Type.String({ description: "Full markdown content." }),
			overwrite: Type.Optional(
				Type.Boolean({
					description:
						"Set true to replace an existing note. Default false (returns an error if the note exists).",
				}),
			),
			expectedMtime: Type.Optional(
				Type.Number({
					description:
						"Epoch-ms mtime of the note as last seen by the caller; if the on-disk mtime differs, the write is rejected as a conflict (optimistic concurrency).",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const abs = safeNotePath(v.path, params.note);
			assertWritablePath(v.path, abs);
			await assertWithinVault(v.path, abs);
			// existing-file check + conflict detection (A2.2 / A2.3)
			let existingMtime: number | undefined;
			try {
				const st = await stat(abs);
				existingMtime = st.mtimeMs;
			} catch (e) {
				// ENOENT = not present (expected). Anything else (EACCES/…) is real.
				if (fsErrCode(e) !== "ENOENT") {
					return toolError(
						classifyFsError(e),
						`Cannot stat ${params.note}: ${errMsg(e)}`,
						{ vault: v.name, note: params.note, fsCode: fsErrCode(e) },
					);
				}
			}
			if (existingMtime !== undefined) {
				if (
					params.expectedMtime !== undefined &&
					params.expectedMtime !== existingMtime
				) {
					return toolError(
						"CONFLICT",
						`Conflict: ${params.note} was modified (expected mtime ${params.expectedMtime}, actual ${existingMtime}).`,
						{
							vault: v.name,
							note: params.note,
							conflict: true,
							expectedMtime: params.expectedMtime,
							actualMtime: existingMtime,
						},
					);
				}
				if (!params.overwrite && params.expectedMtime === undefined) {
					return toolError(
						"ALREADY_EXISTS",
						`Note already exists: ${params.note} (mtime ${existingMtime}). Pass overwrite:true to replace, or expectedMtime for optimistic concurrency.`,
						{ vault: v.name, note: params.note, exists: true, mtime: existingMtime },
					);
				}
			}
			await mkdir(join(abs, ".."), { recursive: true });
			await atomicWriteFile(abs, params.content);
			invalidateCache(abs);
			await reindexFile(v.path, params.note);
			return {
				content: [
					{
						type: "text",
						text: `Wrote ${params.note} (${params.content.length} bytes) in "${v.name}".`,
					},
				],
				details: {
					vault: v.name,
					note: params.note,
					bytes: params.content.length,
					overwritten: existingMtime !== undefined,
				},
			};
		},
	});

	// ---- Tool: obsidian_append ----------------------------------------------
	_capture.registerTool({
		name: "obsidian_append",
		label: "Obsidian Append",
		promptSnippet: "Append text to a note (creates if missing)",
		description:
			"Append text to a note. Creates the note if missing. Adds a blank-line separator before appended text.",
		parameters: Type.Object({
			note: Type.String({ description: "Note path relative to vault root." }),
			content: Type.String({ description: "Text to append." }),
			expectedMtime: Type.Optional(
				Type.Number({
					description:
						"Optional epoch-ms mtime as last seen by the caller; if the note exists and the on-disk mtime differs, the append is rejected as a conflict (optimistic concurrency). Ignored when the note is created new.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const abs = safeNotePath(v.path, params.note);
			assertWritablePath(v.path, abs);
			await assertWithinVault(v.path, abs);
			await mkdir(join(abs, ".."), { recursive: true });
			let existing = "";
			let actualMtime: number | undefined;
			try {
				existing = await readFile(abs, "utf8");
				actualMtime = await noteMtime(abs);
			} catch (e) {
				// ENOENT → create-new (append's contract). Other FS errors surface.
				if (fsErrCode(e) !== "ENOENT") {
					return toolError(
						classifyFsError(e),
						`Cannot read ${params.note}: ${errMsg(e)}`,
						{ vault: v.name, note: params.note, fsCode: fsErrCode(e) },
					);
				}
			}
			// WS-A4: optimistic concurrency (only constrains the existing-file case).
			const conflict = mtimeConflict(params.note, params.expectedMtime, actualMtime);
			if (conflict) {
				return toolError("CONFLICT", conflict.message, {
					vault: v.name,
					note: params.note,
					conflict: true,
					expectedMtime: params.expectedMtime,
					actualMtime: actualMtime,
				});
			}
			const sep =
				existing && !existing.endsWith("\n")
					? "\n\n"
					: existing.endsWith("\n\n") || !existing
						? ""
						: "\n";
			const next =
				existing +
				sep +
				params.content +
				(params.content.endsWith("\n") ? "" : "\n");
			await atomicWriteFile(abs, next);
			invalidateCache(abs);
			await reindexFile(v.path, params.note);
			return {
				content: [
					{
						type: "text",
						text: `Appended ${params.content.length} bytes to ${params.note}.`,
					},
				],
				details: {
					vault: v.name,
					note: params.note,
					appended: params.content.length,
				},
			};
		},
	});

	// ---- Tool: obsidian_append_section --------------------------------------
	_capture.registerTool({
		name: "obsidian_append_section",
		label: "Obsidian Append Section",
		promptSnippet: "Append text under a heading in a note",
		description:
			"Append text under a heading in a note. Matches any heading level (## Foo, # Foo, ### Foo). If the heading does not exist it is appended as a new section. Useful for logging under a ## Log section without disturbing other content.",
		parameters: Type.Object({
			note: Type.String({ description: "Note path relative to vault root." }),
			heading: Type.String({
				description: "Heading text to append under (without the # marks).",
			}),
			content: Type.String({
				description: "Text to insert into that section.",
			}),
			expectedMtime: Type.Optional(
				Type.Number({
					description:
						"Optional epoch-ms mtime as last seen by the caller; if the note exists and the on-disk mtime differs, the update is rejected as a conflict (optimistic concurrency). Ignored when the note is created new.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			let res;
			try {
				res = await appendUnderHeading(
					v.path,
					params.note,
					params.heading,
					params.content,
					{ expectedMtime: params.expectedMtime },
				);
			} catch (e) {
				return toolErrorFromCaught(e, {
					vault: v.name,
					note: params.note,
					heading: params.heading,
				});
			}
			return {
				content: [
					{
						type: "text",
						text: `${res.created ? "Created" : "Updated"} ${params.note}; inserted under ${
							res.insertedAt === "heading"
								? `"${params.heading}"`
								: `new "## ${params.heading}" at end`
						}.`,
					},
				],
				details: {
					vault: v.name,
					note: params.note,
					heading: params.heading,
					...res,
				},
			};
		},
	});

	// ---- Tool: obsidian_search ----------------------------------------------
	_capture.registerTool({
		name: "obsidian_search",
		label: "Obsidian Search",
		promptSnippet: "Full-text search across notes (substring/regex/words/fuzzy) + backlinks",
		description: searchRoutingDescription(),
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query (`#` prefix = tag search).",
			}),
			matchMode: Type.Optional(
				StringEnum(["substring", "regex", "words", "fuzzy"] as const, {
						description:
							"substring|regex|words|fuzzy. → obsidian_search_help.",
						default: "substring",
					}),
			),
			caseSensitive: Type.Optional(
				Type.Boolean({
					description:
						"Default false.",
				}),
			),
			folder: Type.Optional(
				Type.String({
					description:
						"Folder (vault-relative). Default: whole vault.",
				}),
			),
			fields: Type.Optional(
				Type.Array(
					StringEnum(["all", "title", "tags", "body", "frontmatter"] as const, {
						description:
							"all|title|tags|body|frontmatter. → obsidian_search_help.",
					}),
				),
			),
			context: Type.Optional(
				Type.Number({
					description:
						"Context lines per match (0 default).",
				}),
			),
			sort: Type.Optional(
				StringEnum(["file", "relevance", "recency"] as const, {
					description:
						"file|relevance|recency. → obsidian_search_help.",
					default: "file",
				}),
			),
			groupByFile: Type.Optional(
				Type.Boolean({
					description:
						"Collapse to ≤ perFile matches/file. Default false.",
				}),
			),
			perFile: Type.Optional(
				Type.Number({
					description:
						"Matches per file when groupByFile. Default 3.",
				}),
			),
			backlinks: Type.Optional(
				Type.Boolean({
					description:
						"Legacy alias for graph:'backlinks'.",
				}),
			),
			graph: Type.Optional(
				StringEnum(
					["backlinks", "outgoing", "orphans", "dead-links", "neighbors"] as const,
					{
						description:
							"backlinks|outgoing|orphans|dead-links|neighbors. → obsidian_search_help.",
					},
				),
			),
			depth: Type.Optional(
				Type.Number({
					description: "Max hops for graph:'neighbors'. Default 1.",
					default: 1,
				}),
			),
			max: Type.Optional(
				Type.Number({ description: "Max matches to return. Default 50." }),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Vault-relative paths; ignores folder.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const max = params.max ?? 50;
			const folder = params.folder ?? "";
			const caseSensitive = params.caseSensitive ?? false;

			// --- Graph query modes (B2.5 unified surface) ---
			const graphMode =
				params.graph ?? (params.backlinks ? "backlinks" : undefined);
			if (graphMode) {
				const gidx = await getIndex(v.path);
				let results: GraphResult[] = [];
				let modeLabel: string = graphMode;
				if (graphMode === "backlinks") {
					// keep the line-aware findBacklinks for back-compat when possible
					const bl = await findBacklinks(v.path, params.query, {
						folder,
						caseSensitive,
						max,
					});
					results = bl.map((b) => ({
						path: b.file,
						line: b.line,
						text: b.text,
					}));
				} else if (graphMode === "outgoing") {
					results = graphOutgoing(gidx, params.query);
				} else if (graphMode === "orphans") {
					results = graphOrphans(gidx);
				} else if (graphMode === "dead-links") {
					results = graphDeadLinks(gidx);
				} else if (graphMode === "neighbors") {
					results = graphNeighbors(gidx, params.query, params.depth ?? 1, max);
					modeLabel = `neighbors(d=${params.depth ?? 1})`;
				}
				results = results.slice(0, max);
				return {
					content: [
						{
							type: "text",
							text: results.length
								? `${results.length} ${modeLabel} result(s):
` +
									results
										.map(
											(r) =>
												`${r.path}${r.line ? `:${r.line}` : ""}: ${r.text}${r.depth ? ` (depth ${r.depth})` : ""}`,
										)
										.join("\n")
								: `No ${modeLabel} results.`,
						},
					],
					details: {
						vault: v.name,
						query: params.query,
						mode: modeLabel,
						results,
					},
				};
			}

			// --- Legacy tag shortcut (#query) ---
			if (params.query.startsWith("#")) {
				const matches = await findTagNotes(v.path, params.query, {
					folder,
					caseSensitive,
					max,
				});
				return {
					content: [
						{
							type: "text",
							text: matches.length
								? `${matches.length} note(s) tagged ${params.query}:\n` +
									matches
										.map((m) => `${m.file}:${m.line}: ${m.text}`)
										.join("\n")
								: `No notes tagged ${params.query} in vault "${v.name}".`,
						},
					],
					details: { vault: v.name, query: params.query, mode: "tag", matches },
				};
			}

			const mode = (params.matchMode ?? "substring") as MatchMode;
			const built = buildMatcher(params.query, mode, caseSensitive);
			if (built.error || !built.match) {
				return {
					content: [
						{ type: "text", text: built.error ?? "Could not build matcher." },
					],
					details: { vault: v.name, query: params.query, matchMode: mode },
					isError: true,
				};
			}
			const sort = (params.sort ?? "file") as "file" | "relevance" | "recency";
			// Phase 6 / WS-C5: for substring queries, narrow the candidate set via
			// the trigram inverted index so searchVault reads only files that COULD
			// contain the query (skips reading+line-scanning the rest). Sound —
			// never drops a real hit — as long as the index covers every note;
			// refreshIndex reconciles just-written/external notes first (cheap
			// readdir+stat diff, far less than reading all file bodies). regex/
			// words/fuzzy don't benefit (their "match" isn't a literal substring),
			// and an explicit caller `paths` restriction always wins.
			let trigramPaths: string[] | undefined;
			if (mode === "substring" && !params.paths && process.env.OB_TRIGRAM_SEARCH !== "0") {
				try {
					const idx = await getIndex(v.path);
					await refreshIndex(idx, { force: false });
					const cand = trigramCandidates(idx, params.query);
					if (cand) trigramPaths = [...cand];
				} catch {
					// index unavailable — fall back to a full scan
				}
			}
			const searchOpts = {
				fileFilter: built.fileFilter,
				fields: (params.fields as NoteField[] | undefined) ?? null,
				folder,
				context: params.context ?? 0,
				sort,
				groupByFile: params.groupByFile ?? false,
				perFile: params.perFile ?? 3,
				max,
				paths: params.paths ?? trigramPaths,
			};
			let matches = await searchVault(v.path, {
				match: built.match,
				...searchOpts,
			});
			// Regex auto-repair: on a 0-match regex query containing an alternation `|`
			// (bare or escaped), retry the de-escaped form — weak models over-escape the
			// surrounding parens/pipe often (e.g. SEARCH\(WORD|TERM\)).
			let regexRepaired: string | undefined;
			if (
				mode === "regex" &&
				matches.length === 0 &&
				params.query.includes("|")
			) {
				const deescaped = deescapeRegex(params.query);
				if (deescaped !== params.query) {
					const rb = buildMatcher(deescaped, "regex", caseSensitive);
					if (rb.match && !rb.error) {
						const repaired = await searchVault(v.path, {
							match: rb.match,
							...searchOpts,
						});
						if (repaired.length > 0) {
							matches = repaired;
							regexRepaired = deescaped;
						}
					}
				}
			}
			const repairNote = regexRepaired
				? `(auto-repaired over-escaped regex: "${params.query}" -> "${regexRepaired}")\n`
				: "";
			return {
				content: [
					{
						type: "text",
						text: matches.length
							? `${repairNote}${matches.length} match(es) for "${params.query}":\n` +
								matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n")
							: `${repairNote}No matches for "${params.query}" in vault "${v.name}".`,
					},
				],
				details: {
					vault: v.name,
					query: params.query,
					matchMode: mode,
					sort,
					regexRepaired,
					matches,
				},
			};
		},
	});

	// ---- Tool: obsidian_search_help -----------------------------------------
	// On-demand reference for obsidian_search (~120 tok schema). A tool RESULT
	// (lives in conversation history), so the heavy per-enum/per-field prose
	// appears only in the turn it is requested — never in the static schema.
	// Reads the SAME searchReferenceText() the terse always-on description
	// deferred, so the two surfaces cannot drift. Retrieval-neutral: purely
	// additive, executes no search.
	_capture.registerTool({
		name: "obsidian_search_help",
		label: "Obsidian Search Reference",
		description:
			"On-demand reference for `obsidian_search`. Call to get the full per-enum semantics " +
			"(matchMode/fields/sort/graph modes) + output-shaping param details the terse " +
			"obsidian_search description defers. Executes no search.",
		promptSnippet:
			"Look up obsidian_search matchMode/fields/sort/graph semantics on demand.",
		parameters: Type.Object({}),
		async execute(_id, _params) {
			return {
				content: [{ type: "text", text: searchReferenceText() }],
				details: { ok: true, reference: "obsidian_search" },
			};
		},
	});

	// ---- Tool: obsidian_semantic_search ------------------------------------
	// Meaning-based (vector) retrieval over the vault via an external vault-mind
	// (ChromaDB) service. Complements obsidian_search (lexical): it surfaces
	// cards whose wording differs from the query but is conceptually on-point.
	// Optional infrastructure: when VAULT_MIND_BASE_URL is unset or the service
	// is unreachable, it returns a structured error (isError) so the agent can
	// fall back to obsidian_search without a hard failure. See README §Semantic.
	_capture.registerTool({
		name: "obsidian_semantic_search",
		label: "Obsidian Semantic Search",
		promptSnippet:
			"Meaning-based (vector) search across notes — finds cards lexical search misses",
		description:
			"Semantic (vector embedding) search over the vault via a vault-mind ChromaDB backend. " +
			"Retrieves cards by MEANING rather than keyword match — use when obsidian_search returns nothing " +
			"because the query is phrased differently from card titles/tags (e.g. 'gpu exploding on big images' " +
			"→ finds the OOM/MemoryError-guard cards). Returns ranked chunks with similarity scores + metadata. " +
			"Requires a running vault-mind service (VAULT_MIND_BASE_URL; default http://127.0.0.1:8000) with the " +
			"vault indexed there. Gracefully errors (isError) if unreachable — fall back to obsidian_search.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Natural-language query. Phrasing need not match card vocabulary — semantic similarity is what ranks results.",
			}),
			vault_name: Type.Optional(
				Type.String({
					description:
						"Indexed vault collection name. Default: the resolved vault's name.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max results (1-100). Default 10.",
					minimum: 1,
					maximum: 100,
				}),
			),
			similarity_threshold: Type.Optional(
				Type.Number({
					description:
						"Minimum cosine similarity (0-1). Default 0.3 — lowered from vault-mind's 0.4 to surface weak-but-relevant CJK/technical hits that a lightweight multilingual model ranks low.",
					minimum: 0,
					maximum: 1,
				}),
			),
			include_tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "Only return chunks whose tags include all of these.",
				}),
			),
			exclude_tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "Exclude chunks whose tags include any of these.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			// String-concat (not new URL(absPath, base)) so a base URL with a path
			// prefix (e.g. http://host:9999/vm/) keeps /vm/api/search rather than
			// having the prefix clobbered by the absolute "/api/search".
			const baseUrl = (
				process.env.VAULT_MIND_BASE_URL ?? "http://127.0.0.1:8000"
			).replace(/\/+$/, "");
			let vaultName = params.vault_name;
			if (!vaultName) {
				const v = await getVault(ctx.cwd);
				vaultName = v.name;
			}

			const u = new URL(baseUrl + "/api/search");
			u.searchParams.set("vault_name", vaultName);
			u.searchParams.set("query", params.query);
			u.searchParams.set("limit", String(params.limit ?? 10));
			u.searchParams.set(
				"similarity_threshold",
				String(params.similarity_threshold ?? 0.3),
			);
			if (params.include_tags?.length)
				u.searchParams.set("include_tags", params.include_tags.join(","));
			if (params.exclude_tags?.length)
				u.searchParams.set("exclude_tags", params.exclude_tags.join(","));

			let resp: Response;
			try {
				resp = await fetch(u.toString(), { method: "GET" });
			} catch (e) {
				return toolError(
					"IO_ERROR",
					`vault-mind unreachable at ${baseUrl}: ${errMsg(e)}. Set VAULT_MIND_BASE_URL or fall back to obsidian_search (lexical).`,
					{ vault: vaultName, query: params.query, baseUrl },
				);
			}
			if (!resp.ok) {
				return toolError(
					"IO_ERROR",
					`vault-mind /api/search returned HTTP ${resp.status} ${resp.statusText}.`,
					{ vault: vaultName, query: params.query, baseUrl },
				);
			}

			const json: any = await resp.json();
			const data = json?.data ?? {};
			const results: any[] = Array.isArray(data.results) ? data.results : [];

			const text = results.length
				? `${results.length} semantic result(s) for "${params.query}" (vault "${vaultName}", ${Math.round(
						data.search_time_ms ?? 0,
					)}ms):\n` +
					results
						.map((r, i) => {
							const m = r.metadata ?? {};
							const name =
								m.file_name ??
								(m.file_path ?? "").toString().split("/").pop() ??
								(r.id ?? "?");
							const score = Number(r.similarity_score ?? 0).toFixed(3);
							const snip = (r.content ?? "")
								.slice(0, 200)
								.replace(/\s+/g, " ")
								.trim();
							return `${i + 1}. [${score}] ${name}\n   » ${snip}`;
						})
						.join("\n")
				: `No semantic hits for "${params.query}" in vault "${vaultName}" (0 cards above threshold). Lower similarity_threshold, rephrase, or try obsidian_search.`;

			return {
				content: [{ type: "text", text }],
				details: {
					vault: vaultName,
					query: params.query,
					total_found: data.total_found ?? results.length,
					search_time_ms: data.search_time_ms,
					results: results.map((r) => ({
						score: r.similarity_score,
						file: r.metadata?.file_name ?? r.metadata?.file_path,
						id: r.id,
						tags: r.metadata?.searchable_tags,
						snippet: (r.content ?? "").slice(0, 280),
					})),
				},
			};
		},
	});

	// ---- Tool: obsidian_move (B3.1/B3.2) -----------------------------------
	_capture.registerTool({
		name: "obsidian_move",
		label: "Obsidian Move",
		promptSnippet: "Move/rename a note and rewrite inbound wiki-links",
		description:
			"Move/rename a note and rewrite all inbound [[wiki-links]] across the vault to point at the new location. Preserves aliases and #section refs. Atomic (temp+rename).",
		parameters: Type.Object({
			from: Type.String({ description: "Source note path (vault-relative)." }),
			to: Type.String({
				description: "Destination note path (vault-relative).",
			}),
			overwrite: Type.Optional(
				Type.Boolean({
					description: "Allow moving onto an existing note. Default false.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			try {
				const r = await moveNote(v.path, params.from, params.to, {
					overwrite: params.overwrite,
				});
				// A7: never silent partial state — if some inbound-link rewrites
				// failed, name them in the text (not just details) so the agent
				// knows the graph is half-rewritten and can retry those sources.
				const failedWarn =
					r.failedSources.length > 0
						? ` ⚠ ${r.failedSources.length} inbound rewrite(s) FAILED (${r.failedSources.join(", ")}) — those links still point at the old path; re-run or fix manually.`
						: "";
				return {
					content: [
						{
							type: "text",
							text: `Moved ${r.from} → ${r.to}; rewrote ${r.linksRewritten.length} inbound link(s).${failedWarn}`,
						},
					],
					details: r,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Move failed: ${errMsg(e)}` }],
					isError: true,
					details: { from: params.from, to: params.to },
				};
			}
		},
	});

	// ---- Tool: obsidian_rename (B3.3, alias of move, same dir) --------------
	_capture.registerTool({
		name: "obsidian_rename",
		label: "Obsidian Rename",
		promptSnippet: "Rename a note in place (same dir) and rewrite inbound links",
		description:
			"Rename a note in place (same directory) and rewrite inbound [[wiki-links]]. Thin alias of obsidian_move constrained to the basename.",
		parameters: Type.Object({
			note: Type.String({ description: "Source note path (vault-relative)." }),
			newName: Type.String({ description: "New basename (without folder)." }),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const dir = params.note
				.replace(/^[/\\]+/, "")
				.split("/")
				.slice(0, -1)
				.join("/");
			const to = dir ? `${dir}/${params.newName}` : params.newName;
			try {
				const r = await moveNote(v.path, params.note, to);
				return {
					content: [{ type: "text", text: `Renamed ${r.from} → ${r.to}.` }],
					details: r,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Rename failed: ${errMsg(e)}` }],
					isError: true,
					details: null,
				};
			}
		},
	});

	// ---- Tool: obsidian_query (B4) ----------------------------------------
	_capture.registerTool({
		name: "obsidian_query",
		label: "Obsidian Query",
		promptSnippet: "Index-only metadata query (tags/folder/date) without reading bodies",
		description:
			"Structured metadata query (Dataview-lite). Returns note paths/titles/tags/created WITHOUT reading bodies — index-only, cheap. Use to find notes by tag/folder/date, then pipe paths into obsidian_search via its `paths` param.",
		parameters: Type.Object({
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "AND semantics: notes carrying ALL these tags.",
				}),
			),
			anyTags: Type.Optional(
				Type.Array(Type.String(), {
					description: "OR semantics: notes carrying ANY of these tags.",
				}),
			),
			folder: Type.Optional(
				Type.String({ description: "Restrict to a sub-tree." }),
			),
			createdAfter: Type.Optional(
				Type.String({ description: "YYYY-MM-DD; notes with created >= this." }),
			),
			createdBefore: Type.Optional(
				Type.String({ description: "YYYY-MM-DD; notes with created <= this." }),
			),
			max: Type.Optional(Type.Number({ description: "Cap. Default 200." })),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const rows = await queryNotes(v.path, params);
			return {
				content: [
					{
						type: "text",
						text:
							`${rows.length} note(s):\n` +
							rows
								.map((r) =>
									`- ${r.path} ${r.tags.length ? `#${r.tags.join(" #")}` : ""} ${r.created ?? ""}`.trimEnd(),
								)
								.join("\n"),
					},
				],
				details: { vault: v.name, count: rows.length, rows },
			};
		},
	});

	// ---- Tool: obsidian_update_frontmatter (B3.5) --------------------------
	_capture.registerTool({
		name: "obsidian_update_frontmatter",
		label: "Obsidian Update Frontmatter",
		promptSnippet: "Merge keys into a note's frontmatter (tags additive)",
		description:
			"Merge keys into a note's frontmatter without touching the body. `tags` is special-cased: array union (additive), not overwrite. Other keys are set/replace.",
		parameters: Type.Object({
			note: Type.String({ description: "Note path (vault-relative)." }),
			patch: Type.Record(Type.String(), Type.Unknown(), {
				description:
					"Object of key→value pairs to merge. tags array is unioned.",
			}),
			expectedMtime: Type.Optional(
				Type.Number({
					description:
						"Optional epoch-ms mtime as last seen by the caller; if the on-disk mtime differs, the update is rejected as a conflict (optimistic concurrency).",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			try {
				const r = await updateFrontmatter(v.path, params.note, params.patch, {
					expectedMtime: params.expectedMtime,
				});
				return {
					content: [
						{
							type: "text",
							text: `Updated frontmatter of ${r.note}: ${r.updated.join(", ") || "(no changes)"}.`,
						},
					],
					details: r,
				};
			} catch (e) {
				return toolErrorFromCaught(e, {
					vault: v.name,
					note: params.note,
				});
			}
		},
	});

	// ---- Tool: obsidian_delete (B3.4) --------------------------------------
	_capture.registerTool({
		name: "obsidian_delete",
		label: "Obsidian Delete",
		promptSnippet: "Delete a note and strip inbound wiki-links (requires confirm:true)",
		description:
			"Delete/remove a note from the vault — THIS is the tool for removing or deleting a note. It also automatically strips all [[wiki-links]] pointing to the deleted note across the vault (cleanupLinks, default true), so a request to 'remove a note without leaving broken/dangling links' is satisfied automatically with no extra step. Set cleanupLinks:false to leave dangling refs. Requires confirm:true to actually delete (safety guard). If unsure whether the note exists, call obsidian_read or obsidian_list first rather than assuming it is absent.",
		parameters: Type.Object({
			note: Type.String({
				description: "Note path to delete (vault-relative).",
			}),
			cleanupLinks: Type.Optional(
				Type.Boolean({
					description:
						"Also remove [[note]] references across the vault. Default true.",
				}),
			),
			confirm: Type.Boolean({
				description: "Must be true to actually delete (safety guard).",
			}),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			if (!params.confirm) {
				return {
					content: [
						{
							type: "text",
							text: `Deletion requires confirm:true (got false). No changes made.`,
						},
					],
					isError: true,
					details: { note: params.note, confirmed: false },
				};
			}
			const r = await deleteNote(v.path, params.note, {
				cleanupLinks: params.cleanupLinks,
			});
			return {
				content: [
					{
						type: "text",
						text: `Deleted ${r.note}; cleaned ${r.linksCleaned.length} inbound link(s).`,
					},
				],
				details: r,
			};
		},
	});

	// ---- Tool: obsidian_invalidate (B1.4 / Phase 4: WS-C3) ------------------
	_capture.registerTool({
		name: "obsidian_invalidate",
		label: "Obsidian Invalidate",
		promptSnippet: "Reconcile read cache/index with on-disk state after external edits",
		description:
			"Reconcile the read cache and vault index with the current on-disk state so subsequent searches reflect external edits (e.g. notes changed in the Obsidian app out-of-band). Pass `path` (a note or folder, vault-relative) to reconcile only that subtree; omit it to reconcile the whole vault. Returns a small +added/~changed/-deleted summary.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"Optional vault-relative note or folder to reconcile scantly. Without it, the whole vault is reconciled incrementally (no full rebuild).",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const real = resolve(v.path);

			// Path-scoped reconcile: reindex only matching indexed entries.
			if (typeof params.path === "string" && params.path.trim()) {
				const note = safeNotePath(v.path, params.path);
				const abs = join(real, note);
				const isDir = await stat(abs)
					.then((s) => s.isDirectory())
					.catch(() => false);
				const idx = indexCache.get(real);
				if (!idx) {
					invalidateCache(abs);
					return {
						content: [
							{
								type: "text",
								text: `Cleared cache for "${params.path}" (index not yet built; next use builds it fresh).`,
							},
						],
						details: null,
					};
				}
				const prefix = isDir ? note.replace(/\/$/, "") + "/" : note;
				let n = 0;
				for (const p of [...idx.notes.keys()]) {
					const hit = isDir ? p.startsWith(prefix) : p === note;
					if (!hit) continue;
					invalidateCache(join(real, p));
					const entry = await readCached(join(real, p));
					if (entry) {
						indexNote(idx, parseNoteMeta(p, entry.content, entry.mtime));
						n++;
					} else {
						unindexNote(idx, p); // deleted externally
						n++;
					}
				}
				indexRefreshAt.set(real, Date.now());
				return {
					content: [
						{
							type: "text",
							text: `Reconciled ${n} note(s) under "${params.path}" in vault "${v.name}".`,
						},
					],
					details: null,
				};
			}

			// Whole-vault reconcile: clear file cache + incremental index refresh
			// (no full rebuild — only changed files are re-read/parsed).
			invalidateCache();
			const idx = indexCache.get(real);
			if (idx) {
				const diff = await refreshIndex(idx, { force: true });
				return {
					content: [
						{
							type: "text",
							text: `Refreshed vault "${v.name}": +${diff.added} added, ~${diff.changed} changed, -${diff.deleted} deleted.`,
						},
					],
					details: null,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Cleared cache for vault "${v.name}" (index not yet built; next use builds it fresh).`,
					},
				],
				details: null,
			};
		},
	});

	// ---- Tool: obsidian_open -------------------------------------------------
	_capture.registerTool({
		name: "obsidian_open",
		label: "Obsidian Open",
		promptSnippet: "Open a note or vault in the Obsidian app via URI scheme",
		description:
			"Open a note or the whole vault in the Obsidian app via its URI scheme. Supports opening to a specific heading via note:'Note#Section' (Advanced URI / native).",
		parameters: Type.Object({
			note: Type.Optional(
				Type.String({
					description:
						"Note path relative to vault root. Omit to open the vault.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const file = params.note
				? params.note.replace(/^[/\\]+/, "").replace(/\.md$/i, "")
				: undefined;
			const uri = file
				? `obsidian://open?vault=${vname(v)}&file=${encodeURIComponent(file)}`
				: v.registered
					? `obsidian://open?vault=${vname(v)}`
					: `obsidian://open?path=${encodeURIComponent(v.path)}`;
			await openObsidianUri(uri);
			return {
				content: [
					{
						type: "text",
						text: file
							? `Opened ${file} in Obsidian.`
							: `Opened vault "${v.name}".`,
					},
				],
				details: { vault: v.name, note: file ?? null, uri },
			};
		},
	});

	// ---- Tool: obsidian_distill (Zettelkasten subagent) --------------------
	// Tool allowlists for the spawned subagents. Defined once as arrays (not
	// inline CSV strings) so they are auditable and don't drift; passed as
	// string[] to runObsidianSubagent (the shared subprocess wrapper).
	// Phase 5 / WS-B6: distill/garden tool lists are env-overridable so a custom
	// workflow can grant extra tools (or restrict them) without code changes.
	// Each env var is a comma-separated tool-name list; empty/unset → defaults.
	// The distiller/gardener subagents now use the single fat `obsidian` tool
	// (action-based dispatch) — no more separate obsidian_* tool names. The
	// `read` tool stays for the distiller to read the input files (outside the
	// vault); the gardener is vault-only so it just gets `obsidian`.
	const OBSIDIAN_DISTILL_TOOLS = toolAllowlist("OB_DISTILL_TOOLS", [
		"read",
		"obsidian",
	]);
	const GARDEN_AUDIT_TOOLS = toolAllowlist("OB_GARDEN_AUDIT_TOOLS", [
		"obsidian",
	]);
	const GARDEN_FIX_TOOLS = toolAllowlist("OB_GARDEN_FIX_TOOLS", [
		...GARDEN_AUDIT_TOOLS,
	]);
	_capture.registerTool({
		name: "obsidian_distill",
		label: "Obsidian Distill",
		promptSnippet: "Distill files into atomic Zettelkasten notes via a subagent",
		description: [
			"Distill input markdown/text files into atomic Zettelkasten notes in the vault.",
			"Spawns an isolated subagent that reads the files, decomposes them into atomic ideas,",
			"creates one note per idea (following the Zettelkasten Note template), links each to",
			"existing notes via obsidian_search, and updates Tags/Index.md MOC. Output is Traditional Chinese.",
		].join(" "),
		parameters: Type.Object({
			files: Type.Array(Type.String(), {
				description:
					"Input file paths (markdown/text), relative to cwd or absolute. Each is decomposed into multiple notes.",
			}),
			folder: Type.Optional(
				Type.String({
					description:
						"Vault folder to write notes into. Default: Zettelkasten.",
					default: "Zettelkasten",
				}),
			),
			maxNotes: Type.Optional(
				Type.Number({
					description:
						"Optional hint: roughly cap the number of notes produced from all files combined.",
				}),
			),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const cwd = ctx.cwd;
			const files = (params.files ?? []).map((f) => resolve(cwd, f));
			const missing = files.filter((f) => !existsSync(f));
			if (files.length === 0)
				return {
					content: [{ type: "text", text: "No input files provided." }],
					isError: true,
					details: null,
				};
			if (missing.length > 0)
				return {
					content: [
						{ type: "text", text: `File(s) not found: ${missing.join(", ")}` },
					],
					isError: true,
					details: null,
				};

			const folder = params.folder ?? "Zettelkasten";
			const taskParts = [
				`把以下輸入檔分解成 Zettelkasten 原子筆記，寫入 vault 的「${folder}」資料夾。`,
				params.maxNotes
					? `（提示：全部合計約不超過 ${params.maxNotes} 張卡，品質優先於數量。）`
					: "",
				"輸入檔：",
				...files.map((f) => `- ${relative(cwd, f) || f}`),
			].filter(Boolean);
			const task = taskParts.join("\n");

			// Live progress: surface note creation to stderr so long distill runs
			// are observable (the subagent is otherwise silent until it exits).
			const prog = makeSubagentProgressLogger("distill");
			const t0 = Date.now();
			const { output, failure, result } =
				await runObsidianSubagent({
					cwd,
					systemPrompt: ZETTEL_SYSTEM_PROMPT,
					task,
					tools: OBSIDIAN_DISTILL_TOOLS,
					signal,
					onEvent: prog.onEvent,
				});
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			const { created, failed } = prog.stats();
			console.error(
				`  [distill] ${created} note(s) created${failed ? `, ${failed} failed` : ""} (${elapsed}s)`,
			);
			invalidateCache(); // A3.2: child wrote notes; parent search must see them
			if (failure?.kind === "timedout") {
				return {
					content: [
						{
							type: "text",
							text: `Distiller timed out after ${Number(process.env.OB_SUBAGENT_TIMEOUT_MS ?? 20 * 60_000) / 1000}s. Partial output:
${output.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message, result },
				};
			}
			if (failure && !output) {
				return {
					content: [
						{
							type: "text",
							text: `Distiller failed.\n${failure.message.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message, result },
				};
			}
			// Phase 2 / WS-B1: post-run audit of every note the subagent claims to
			// have created. Validate frontmatter schema, sane size, and wiki-link
			// resolvability; surface malformed output so the caller can repair it
			// instead of trusting silent corruption. Best-effort — never fails the
			// run, only annotates it.
			const reportedNotes = Array.isArray(result?.notes) ? result.notes.map(String) : [];
			let validation: { notes: NoteValidation[]; valid: number; invalid: number } | undefined;
			let validationText = "";
			// Resolved vault captured for the opt-in re-index hook below. Stays
			// undefined when no notes were written or vault resolution failed.
			let distillVault: ResolvedVault | undefined;
			if (reportedNotes.length > 0) {
				try {
					const v = await getVault(ctx.cwd);
					distillVault = v;
					validation = await validateZettelNotes(v.path, reportedNotes);
				} catch {
					validation = undefined;
				}
				if (validation && validation.invalid > 0) {
					// Schema backstop: auto-repair deterministically-fillable missing keys
					// (id/created/tags/sources), then re-validate. Turns an LLM's
					// forgotten field from a corrupt note into a fixed one.
					let repairText = "";
					try {
						const v = await getVault(ctx.cwd);
						const defaultSources = files.map((f) => basenameOf(f));
						const repair = await repairZettelFrontmatter(v.path, reportedNotes, defaultSources);
						const fixedNotes = repair.notes.filter((n) => n.repaired.length > 0);
						if (fixedNotes.length > 0) {
							invalidateCache();
							validation = await validateZettelNotes(v.path, reportedNotes);
							repairText =
								`\n\n🔧 Auto-repair: filled missing frontmatter in ${fixedNotes.length} note(s) — ` +
								fixedNotes.map((n) => `${n.path} (${n.repaired.join(", ")})`).join("; ");
						}
					} catch {
					}
					if (validation && validation.invalid > 0) {
						validationText =
							`\n\n⚠ Validation: ${validation.invalid}/${validation.notes.length} created note(s) still fail the Zettelkasten schema check after auto-repair — review before relying on them:\n` +
							validation.notes
								.filter((n) => !n.ok)
								.map((n) => `  - ${n.path}: ${n.errors.join("; ")}`)
								.join("\n") + repairText;
					} else {
						validationText = repairText + `\n\n✓ Validation: all ${validation?.valid ?? 0} created note(s) now pass the Zettelkasten schema check.`;
					}
				} else if (validation && validation.valid > 0) {
					validationText = `\n\n✓ Validation: all ${validation.valid} created note(s) pass the Zettelkasten schema check.`;
				}
			}
			// Phase 2 / Task 18: opt-in semantic re-index of vault-mind after a
			// successful distill run. Fire-and-forget (never awaited) and guarded by
			// VAULT_MIND_AUTO_REINDEX — when off this is a pure no-op (zero HTTP),
			// so distill behavior is unchanged. Failures only warn; never throw.
			if (distillVault && reportedNotes.length > 0) {
				void maybeTriggerReindex(distillVault.name, distillVault.path);
			}
			return {
				content: [
					{
						type: "text",
						text: (output || "(distiller produced no output)") + validationText,
					},
				],
				details: { status: failure?.kind ?? "done", error: failure?.message, result, validation },
			};
		},
	});

	// ---- Tool: obsidian_garden (vault gardener subagent) --------------------
	_capture.registerTool({
		name: "obsidian_garden",
		label: "Obsidian Garden",
		promptSnippet: "Audit/repair vault graph health (orphans, broken links, MOC drift)",
		description: [
			"Audit and optionally repair the Obsidian vault's knowledge-graph health.",
			"engine='deterministic' (default, fast, no LLM): library scan of the convergence folder",
			"for dead wiki-links, MOC drift (Tags/Knowledge Graph.md), and orphan cards.",
			"engine='llm': spawns an isolated subagent for a full-vault audit — orphan notes, broken",
			"links, missing frontmatter, suspected duplicates, unlinked-but-related notes, MOC drift.",
			"In 'fix' mode both engines apply safe repairs (never deletes or merges).",
		].join(" "),
		parameters: Type.Object({
			engine: Type.Optional(
				StringEnum(["deterministic", "llm"] as const, {
					description:
						"deterministic = fast library scan of the convergence folder (default, no LLM); llm = full-vault audit via subagent (smart but slow)",
					default: "deterministic",
				}),
			),
			mode: Type.Optional(
				StringEnum(["audit", "fix"] as const, {
					description:
						"audit = report only (default); fix = also apply safe repairs (add links, update MOC)",
					default: "audit",
				}),
			),
			scope: Type.Optional(
				Type.String({
					description:
						"Restrict the scan to a vault folder (e.g. 'Zettelkasten'). Default: whole vault.",
					default: "",
				}),
			),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const cwd = ctx.cwd;
			const mode = params.mode ?? "audit";
			const engine = params.engine ?? "deterministic";
			const scope = params.scope?.trim() || "整個 vault";
			// ── deterministic engine: fast library-based scan (no LLM) ──
			// Merged from graph_health tool (Phase 1 de-dup, 2026-07-11). Uses the
			// same graphHealth/healGraph library the CLI knowledge-pipeline consumes.
			// Dynamic import avoids circular dependency (retrieve.ts imports from
			// this module); both extensions are co-loaded at runtime.
			if (engine === "deterministic") {
				const v = await getVault(cwd);
				const folder = params.scope?.trim() || "Zettelkasten/knowledge-graph";
				const mocPath = "Tags/Knowledge Graph.md";
				try {
					const result = await runDeterministicHealthCheck({
						vaultPath: v.path, folder, mocPath, fix: mode === "fix",
					});
					return {
						content: [{ type: "text", text: result.text }],
						details: result.health,
					};
				} catch (e) {
					return {
						content: [{
							type: "text",
							text: `Deterministic health check failed (is pi-agent-ext-knowledge-card installed?): ${errMsg(e)}`,
						}],
						isError: true,
						details: { engine: "deterministic", error: errMsg(e) },
					};
				}
			}

			// ── llm engine: subagent-based full-vault audit ──
			const task = `請對${scope}執行健康度${mode === "fix" ? "檢查並修復（fix 模式）" : "審計（audit 模式，僅回報不改動）"}。`;
			// fix mode needs write tools; audit is read-only.
			const prog = makeSubagentProgressLogger("garden");
			const t0 = Date.now();
			const { output, failure, result } =
				await runObsidianSubagent({
					cwd,
					systemPrompt: GARDEN_SYSTEM_PROMPT,
					task,
					tools: mode === "fix" ? GARDEN_FIX_TOOLS : GARDEN_AUDIT_TOOLS,
					signal,
					onEvent: prog.onEvent,
				});
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			const { created, failed, toolCalls } = prog.stats();
			console.error(
				`  [garden] ${toolCalls} tool call(s)${created ? `, ${created} note(s) added` : ""}${failed ? `, ${failed} failed` : ""} (${elapsed}s)`,
			);
			invalidateCache(); // A3.2: child may have added links/notes
			if (failure?.kind === "timedout") {
				return {
					content: [
						{
							type: "text",
							text: `Gardener timed out after ${Number(process.env.OB_SUBAGENT_TIMEOUT_MS ?? 20 * 60_000) / 1000}s. Partial output:\n${output.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message, result },
				};
			}
			if (failure && !output) {
				return {
					content: [
						{
							type: "text",
							text: `Gardener failed.\n${failure.message.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message, result },
				};
			}
			// Phase 5 / WS-B4: in fix mode, audit every note the gardener
			// reported modifying for structural integrity (frontmatter
			// balanced, non-empty, code fences paired). A misbehaving child
			// could corrupt a note via append_section; this surfaces it
			// instead of leaving invalid markdown. Best-effort — annotates,
			// never fails the run.
			let validationText = "";
			let validation: { notes: IntegrityIssue[]; intact: number; broken: number } | undefined;
			if (mode === "fix") {
				const modified = Array.isArray((result as any)?.notesModified)
					? (result as any).notesModified.map(String)
					: [];
				if (modified.length > 0) {
					try {
						const v = await getVault(cwd);
						validation = await validateNoteIntegrityBatch(v.path, modified);
					} catch {
						validation = undefined;
					}
					if (validation && validation.broken > 0) {
						validationText =
							`\n\n⚠ Integrity: ${validation.broken}/${validation.notes.length} modified note(s) failed the markdown integrity check — review before relying on them:\n` +
							validation.notes
								.filter((n) => !n.ok)
								.map((n) => `  - ${n.path}: ${n.errors.join("; ")}`)
								.join("\n");
					} else if (validation && validation.intact > 0) {
						validationText = `\n\n✓ Integrity: all ${validation.intact} modified note(s) passed the markdown integrity check.`;
					}
				}
			}
			return {
				content: [
					{ type: "text", text: (output || "(gardener produced no output)") + validationText },
				],
				details: { status: failure?.kind ?? "done", error: failure?.message, result, validation },
			};
		},
	});

	// ---- Tool: obsidian_status ---------------------------------------------
	// Introspection: lets the agent (and zk_* workflows) see which vault is
	// active, where it came from, and all candidates BEFORE acting. Returns the
	// same `source` / `staleReason` fields the /obsidian-config command shows.
	_capture.registerTool({
		name: "obsidian_status",
		label: "Obsidian Status",
		promptSnippet: "Show the active vault (path/source/note count) — call before vault writes",
		description:
			"Show the active Obsidian vault: resolved path, name, resolution source (env|config|app|local|global), whether it is registered in the Obsidian app, note count, stale-config warnings, and all candidate vaults. Use this BEFORE any vault write or when the user asks which vault is in use — obsidian_* and zk_* tools all operate on this vault.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _u, ctx) {
			const cwd = ctx.cwd;
			const active = await getVault(cwd);
			const candidates = await listVaultCandidates(cwd);
			const personal = await readPersonalConfig();
			const projCfg = await readProjectConfig(cwd);
			const noteCount = await countNotes(active.path);
			const text = [
				`Active vault: ${active.name}`,
				`  path:       ${active.path}`,
				`  source:     ${active.source}${active.registered ? " (registered)" : " (not registered)"}`,
				active.staleReason ? `  ⚠ stale:     ${active.staleReason}` : null,
				`  notes:      ${noteCount}`,
				`  personal:   ${personalConfigPath()}${personal.vault_path ? ` → ${personal.vault_path}` : " (unset)"}`,
				`  project:    ${projectConfigPath(cwd)}${projCfg.vault_path ? ` → ${projCfg.vault_path}` : " (unset)"}${projCfg.mode ? ` (mode: ${projCfg.mode})` : ""}`,
				"",
				"Candidates:",
				...candidates.map((c) => {
					const here = c.path === active.path ? " ← active" : "";
					return `  ${c.exists ? "✓" : "✗"} ${c.source.padEnd(8)} ${c.path}${c.open ? " [open]" : ""}${here}`;
				}),
			]
				.filter((s) => s !== null)
				.join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					active: {
						path: active.path,
						name: active.name,
						source: active.source,
						registered: active.registered,
						staleReason: active.staleReason ?? null,
						noteCount,
					},
					candidates,
					personalConfigPath: personalConfigPath(),
					projectConfigPath: projectConfigPath(cwd),
					personal,
					project: projCfg,
				},
			};
		},
	});

	// ---- Command: /obsidian --------------------------------------------------
	pi.registerCommand("obsidian", {
		description:
			"Open Obsidian vault (or a note). Usage: /obsidian [note/path]",
		handler: async (args, ctx) => {
			try {
				const v = await getVault(ctx.cwd);
				const file = args?.trim()
					? args.trim().replace(/\.md$/i, "")
					: undefined;
				const uri = file
					? `obsidian://open?vault=${vname(v)}&file=${encodeURIComponent(file)}`
					: v.registered
						? `obsidian://open?vault=${vname(v)}`
						: `obsidian://open?path=${encodeURIComponent(v.path)}`;
				await openObsidianUri(uri);
				ctx.ui.notify(
					file ? `Opened ${file} in Obsidian` : `Opened vault "${v.name}"`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`Obsidian error: ${(e as Error).message}`, "error");
			}
		},
	});

	// ---- Command: /obsidian-init --------------------------------------------
	pi.registerCommand("obsidian-init", {
		description:
			"Register the project vault folder with the Obsidian app (opens it by absolute path).",
		handler: async (_args, ctx) => {
			try {
				const v = await getVault(ctx.cwd);
				// `obsidian://open?path=<abs>` adds the folder to Obsidian's vault list if absent.
				await openObsidianUri(
					`obsidian://open?path=${encodeURIComponent(v.path)}`,
				);
				ctx.ui.notify(
					`Registered vault "${v.name}" at ${v.path} with Obsidian`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`Obsidian init error: ${(e as Error).message}`, "error");
			}
		},
	});

	// ---- Command: /obsidian-config -----------------------------------------
	// Human-friendly vault inspection / switching. One-stop view of which vault
	// the obsidian_* and zk_* tools will actually hit, and a way to change it.
	//
	//   /obsidian-config                          show active vault + source + all candidates
	//   /obsidian-config <path>                   set vault (default scope = personal ~/.pi; mode "explicit")
	//   /obsidian-config <path> --scope project   set a PROJECT-scoped vault (<cwd>/.pi)
	//   /obsidian-config --use-app                follow the Obsidian app's open vault (always PROJECT scope — mode "app" is project-only)
	//   /obsidian-config --list                   list all registered vaults from obsidian.json
	//   /obsidian-config --clear                  forget the personal setting (--scope project clears the project one)
	pi.registerCommand("obsidian-config", {
		description:
			"Show or set the active Obsidian vault. Usage: /obsidian-config [path | --use-app | --list | --clear] [--scope project]",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const scopeProject =
				tokens.some((t, i) => t === "--scope" && tokens[i + 1] === "project") ||
				tokens.includes("--scope=project");
			const scope: "personal" | "project" = scopeProject ? "project" : "personal";
			const flagSet = new Set(tokens.filter((t) => t.startsWith("--")));
			const setPathTokens = tokens.filter((t, i) => {
				if (t.startsWith("--")) return false;
				// Skip the "project" value token of a "--scope project" pair.
				if (t === "project" && i > 0 && tokens[i - 1] === "--scope") return false;
				return true;
			});
			const setPath =
				setPathTokens.length > 0 ? setPathTokens.join(" ") : null;
			const hasUseApp = flagSet.has("--use-app");
			const hasList = flagSet.has("--list");
			const hasClear = flagSet.has("--clear");

			const lines: string[] = [];
			const push = (s: string) => lines.push(s);

			try {
				// --- mutations first ---
				if (setPath) {
					const abs = isAbsolute(setPath) ? setPath : resolve(cwd, setPath);
					if (!existsSync(abs)) {
						push(`⚠️  Path does not exist: ${abs}`);
						push(
							`Created config anyway. Run /obsidian-init after creating the folder.`,
						);
					} else {
						const count = await countNotes(abs);
						push(`✓ Active vault set to: ${abs} (${count} notes)`);
					}
					await writeVaultConfig(
						cwd,
						{ vault_path: abs, mode: "explicit" },
						scope,
					);
					push(
						`  Written to ${scope === "project" ? projectConfigPath(cwd) : personalConfigPath()} (mode: explicit, scope: ${scope})`,
					);
					ctx.ui.notify(`obsidian vault → ${basenameOf(abs)}`, "info");
				} else if (hasUseApp) {
					// mode:"app" is a PROJECT-tier feature (personal is explicit-only).
					await writeVaultConfig(cwd, { mode: "app" }, "project");
					push(
						`✓ Mode set to "app" (project scope): obsidian_* will follow the Obsidian app's open vault.`,
					);
					const personal = await readPersonalConfig();
					if (personal.vault_path)
						push(
							`  ⚠ A personal config (~/.pi → ${personal.vault_path}) is set and still wins over project mode:"app". Clear it (/obsidian-config --clear) to let app-follow take effect.`,
						);
					ctx.ui.notify("obsidian mode → app", "info");
				} else if (hasClear) {
					if (scope === "personal") {
						await writeVaultConfig(cwd, { vault_path: "" }, "personal");
						push(
							`✓ Cleared personal vault_path (~/.pi). Resolution falls through to project/app/local.`,
						);
					} else {
						await writeVaultConfig(
							cwd,
							{ vault_path: "", mode: "app" },
							"project",
						);
						push(
							`✓ Cleared project vault_path (<cwd>/.pi). Resolution falls through to app/local.`,
						);
					}
					ctx.ui.notify(`obsidian config cleared (${scope})`, "info");
				}

				// --- status (always shown) ---
				const active = await resolveVault(cwd);
				const personal = await readPersonalConfig();
				const projCfg = await readProjectConfig(cwd);
				push("");
				push(`Active vault: ${active.name}`);
				push(`  path:       ${active.path}`);
				push(
					`  source:     ${active.source}${active.registered ? " (registered in Obsidian app)" : " (not registered)"}`,
				);
				if (active.staleReason) push(`  ⚠ stale:     ${active.staleReason}`);
				push(`  notes:      ${await countNotes(active.path)}`);
				push(
					`  personal:   ${personalConfigPath()}${personal.vault_path ? ` → ${personal.vault_path}` : " (unset)"}`,
				);
				push(
					`  project:    ${projectConfigPath(cwd)}${projCfg.vault_path ? ` → ${projCfg.vault_path}` : " (unset)"}${projCfg.mode ? ` (mode: ${projCfg.mode})` : ""}`,
				);

				// --- candidates (for --list or whenever helpful) ---
				if (hasList || flagSet.size === 0) {
					push("");
					push("Candidates:");
					const seen = new Set<string>();
					for (const c of await listVaultCandidates(cwd)) {
						const key = c.path;
						if (seen.has(key)) continue;
						seen.add(key);
						const here = c.path === active.path ? " ← active" : "";
						const extra = c.open
							? " [open in app]"
							: c.source === "env"
								? " [env]"
								: c.source === "personal"
									? " [personal]"
									: c.source === "config"
										? " [config]"
										: c.source === "local"
											? " [local fallback]"
											: "";
						push(
							`  ${c.exists ? "✓" : "✗"} ${c.source.padEnd(8)} ${c.path}${extra}${here}`,
						);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e) {
				ctx.ui.notify(
					`/obsidian-config error: ${(e as Error).message}`,
					"error",
				);
			}
		},
	});

	// ---- Startup dep check --------------------------------------------------
	// Ext-dir via the `#pi/ext-dir` idiom (src/lib/ext-dir.ts): import.meta is
	// a SyntaxError risk inside the sh loader's cjs eval and bun folds it into
	// a build-machine path otherwise. Undefined under native ESM (tests) — the
	// dep-check hint degrades gracefully.
	const _EXT_DIR: string | undefined = shExtDir();


	// ── THE FAT TOOL (Phase 3: 18 tools → 1) ──────────────────────────────
	// One tool, action-based dispatch. Replaces 18 individual obsidian_* tools.
	pi.registerTool({
		name: "obsidian",
		label: "Obsidian",
		gating: { gate: "obsidian" }, // demoted from core (ticket 02),
		// Expose captured individual tools for backward compat (tests, CLI
		// introspection). Intentionally NOT part of ToolDefinition — read by
		// __tests__ via a loosely-typed mock registerTool.
		// @ts-expect-error — _capturedTools is runtime metadata, not a ToolDefinition field.
		_capturedTools: _capture._tools,
		// promptSnippet REMOVED (stealth): routing description + obsidian_help carry usage.
		description: obsidianRoutingDescription(),
		parameters: Type.Object({
			action: Type.String({
				description: "list,read,create,append,append_section,search,semantic_search,query,move,rename,update_frontmatter,delete,invalidate,open,distill,garden,status",
			}),
			args: Type.Optional(Type.Record(Type.String(), Type.Any())),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const validation = validateActionArgs(
				params.action,
				params.args ?? {},
				(a) => _capture._tools["obsidian_" + a]?.parameters ?? null,
			);
			if (!validation.ok) {
				return {
					content: [{ type: "text" as const, text: validation.errorText }],
					isError: true,
					details: { code: "BAD_REQUEST" as const },
				};
			}
			// Deterministic dry-run: refuse writes here rather than trusting the
			// model to obey a "don't write" instruction. Tool-level exclusion can
			// no longer express this — there is one tool for reads and writes both.
			const refusal = dryRunRefusal(params.action);
			if (refusal) {
				return {
					content: [{ type: "text" as const, text: refusal }],
					isError: true,
					details: { code: "BAD_REQUEST" as const },
				};
			}
			// `action` was just validated above (validation.ok), so the captured
			// sub-tool for this action is guaranteed to exist — assert non-null.
			return _capture._tools["obsidian_" + params.action]!.execute(
				_id, params.args ?? {}, signal, _u, ctx,
			);
		},
	});

	// ── On-demand help tool (~100 tok schema) ────────────────────────────
	// Returns per-action reference text. Same source as the terse routing
	// description (obsidianRoutingDescription / obsidianActionReferenceText)
	// so the two surfaces cannot drift. Retrieval-neutral: purely additive.
	pi.registerTool({
		name: "obsidian_help",
		label: "Obsidian Action Reference",
		gating: { gate: "obsidian" }, // demoted from core (ticket 02),
		description:
			"On-demand reference for the `obsidian` tool. Call to get the full " +
			"per-action semantics (what each action does, which params it uses, constraints). " +
			"Executes no vault operation.",
		// promptSnippet REMOVED (stealth): description already routes.
		parameters: Type.Object({}),
		async execute(_id, _params) {
			return {
				content: [{ type: "text", text: obsidianActionReferenceText() }],
				details: { ok: true, reference: "obsidian" },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const missing = _missingDeps(["@earendil-works/pi-coding-agent"], _EXT_DIR);
		if (missing.length > 0) {
			ctx.ui.notify(
				`pi-obsidian: missing npm packages: ${missing.join(", ")}.\nRun: bun install (in ${_findMonorepoRoot(_EXT_DIR)})`,
				"error",
			);
			return;
		}
		try {
			const v = await getVault(ctx.cwd);
			// Above-editor banner (same placement as the /goal banner), delayed
			// 10s. Delaying past the startup notify burst (zai-mcp fires right
			// after this handler) sidesteps the clobbering that previously forced
			// a "warning" type: by the time this lands, the startup notifies have
			// settled, so we render a clean banner instead of the scary
			// "Warning:" line. setWidget(key, [lines]) with default placement
			// renders above the input editor (like /goal); setStatus would land in
			// the footer status bar, which is the wrong spot for this. The vault
			// is cached per-session (getVault). This is a TRANSIENT confirmation
			// banner, not a persistent status indicator: it shows once to confirm
			// which vault is active, then auto-dismisses (the setWidget API has
			// no TTL, so we clear it ourselves with a second timer).
			const theme = ctx.ui.theme;
			const icon = v.registered ? "📓" : "📎";
			const label = theme.fg("dim", "obsidian vault active:");
			// Show the full resolved vault path (not just the folder basename)
			// so the user can tell which vault on disk is actually in use.
			const vault = theme.fg("accent", v.path);
			const tag = v.registered ? "" : theme.fg("dim", " (local)");
			// Timers can straddle a session switch (/resume, ctx.fork,
			// ctx.switchSession): the captured ctx goes stale, and the ctx.ui
			// getter throws assertActive() inside the callback ->
			// uncaughtException -> pi crashes. Guard every deferred ctx.ui call;
			// a stale session needs no banner (the replacement session renders
			// its own on its own session_start).
			scheduleVaultBanner(ctx, `${icon} ${label} ${vault}${tag}`);
		} catch {
			ctx.ui.notify("obsidian: no vault found", "warning");
		}
	});
}


/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of runtime gating).
 * Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts. Controls-only:
 * obsidian/obsidian_help were demoted from core in ticket 02.
 */
export const __GATE_PROBES__ = {
  gate: "obsidian",
  recallFloor: 0,
  adversarial: [],
  controls: [
    "put this note into the vault",
    "search the vault for weekly-news",
    "create a new vault file under the knowledge base",
    "read the obsidian note about the model",
  ],
};
