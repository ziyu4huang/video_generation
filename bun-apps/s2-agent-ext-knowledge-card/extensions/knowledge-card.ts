/**
 * pi-knowledge-card — Zettelkasten knowledge-management extension.
 *
 * Registers four tools that wrap the knowledge CRUD / RAG workflows as pi
 * tools. Each tool spawns an isolated subagent (via pi-obsidian's runner)
 * with the appropriate obsidian tools loaded — so this extension requires
 * pi-obsidian to be available in the same session.
 *
 * Tools:
 *   zk_card          CRUD over vault notes: add | find | update | remove | check
 *   zk_ask           graph-enhanced RAG query over the vault
 *   zk_ingest        deterministic convergence of .knowledge.jsonl → cards
 *   knowledge_query  deterministic cross-workflow tag-ranked digest (no LLM)
 *
 * Phase 1 de-dup (2026-07-11): zk_extract removed (was a 100% passthrough to
 *   obsidian_distill — use obsidian_distill directly). graph_health removed
 *   (merged into obsidian_garden with engine:deterministic|llm param). The
 *   library functions (graphHealth/healGraph in retrieve.ts) remain exported
 *   for the CLI knowledge-pipeline command.
 *
 * knowledge_query is the hub's direct agent surface over the retrieve.ts
 * library — it does NOT spawn a subagent (no LLM, no network), so it works
 * even where the subagent-backed zk_* tools are heavier.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the task builders
 * (buildDistillTask / buildAddTask / … / buildRagTask) and tool allowlists
 * (DISTILL_TOOLS / ADD_TOOLS / … / RAG_TOOLS). The `s2-agent cli`
 * zk-extract / zk-card / zk-ask commands import these same builders so the CLI
 * and the extension never drift apart.
 *
 * Env:
 *   OB_VAULT_PATH / OB_VAULT_DIR   vault resolution (passed through to obsidian)
 *   zk_* dispatch                  in-process spawnSubagent + role-aware bounds
 *                                  (writer/recon via roleAwareDefaults) since
 *                                  2026-08-18; the old 5-min child-process
 *                                  runner timeout no longer applies.
 *   KC_SUBAGENT_MODEL              distill/CRUD/RAG subagent model (default:
 *                                  central tiers.small from model-tiers.json —
 *                                  typically a LOCAL LM Studio model, keeps
 *                                  knowledge-card's LLM spend off the cloud
 *                                  bill; override per-call via the tool's
 *                                  `model` arg). Does NOT honor the
 *                                  sibling OB_SUBAGENT_MODEL (that one defaults
 *                                  to a cloud model); use KC_SUBAGENT_MODEL to
 *                                  override knowledge-card specifically.
 */

import { relative, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { GATE_DEFS, readAllToolDefinitions } from "@repo/s2-agent-core-interface";
import { zkRetrieve, zkIngest, zkHealth, zkHeal } from "../src/host-fns.ts";
import { resolveVault, registerDeterministicHealthCheck } from "@repo/s2-agent-ext-obsidian";
import { ingestRecords, formatSummary } from "../src/ingest.ts";
import {
	adaptAutoMemoryMarkdown,
	adaptHermesMarkdown,
	adaptGenericMarkdown,
	parseKnowledgeJsonl,
	collectInputFiles,
} from "../src/adapters.ts";

// ─── Gate families (wayfinder ticket 02 — demoted from core) ────────────────
// The 4 zettelkasten/knowledge tools were always-active core; ticket 02 demotes
// them to on-demand gates (each its own family — a "find my note" intent should
// not also load the ingest/query tools). Keywords are the tool's own label
// vocabulary; the noun∧verb `requires` mirrors the flux2 pattern so keyword-free
// paraphrases ("ask my vault about lora", "converge the knowledge records")
// still reach the right gate.
GATE_DEFS["zk_card"] = {
  id: "zk_card",
  keywords: ["zk card", "vault note", "note card", "zettelkasten", "卡片", "筆記卡", "新增筆記", "找筆記", "改筆記"],
  requires: {
    nouns: ["note", "card", "vault", "筆記", "卡片", "便籤"],
    verbs: ["add", "find", "update", "remove", "search", "新增", "尋找", "更新", "刪除", "搜尋"],
  },
  description: "Zettelkasten vault note CRUD (add/find/update/remove/check)",
};
GATE_DEFS["zk_ask"] = {
  id: "zk_ask",
  keywords: ["zk ask", "ask my vault", "ask my notes", "vault question", "問我的筆記", "知識問答"],
  requires: {
    nouns: ["vault", "note", "notes", "knowledge", "筆記", "知識"],
    verbs: ["ask", "query", "retrieve", "問", "查詢", "搜尋"],
  },
  description: "Graph-enhanced RAG over the Zettelkasten vault",
};
GATE_DEFS["zk_ingest"] = {
  id: "zk_ingest",
  keywords: ["zk ingest", "ingest knowledge", "converge", "knowledge.jsonl", "收錄知識", "匯入筆記"],
  requires: {
    nouns: ["knowledge", "record", "vault", "筆記", "知識"],
    verbs: ["ingest", "converge", "import", "收錄", "匯入", "收斂"],
  },
  description: "Deterministically converge .knowledge.jsonl records into the vault",
};
GATE_DEFS["knowledge_query"] = {
  id: "knowledge_query",
  keywords: ["knowledge query", "knowledge graph", "query cards", "查卡片", "知識圖譜"],
  requires: {
    nouns: ["knowledge", "card", "graph", "tag", "知識", "卡片"],
    verbs: ["query", "search", "match", "查詢", "搜尋"],
  },
  description: "Query the Zettelkasten knowledge graph by tags or question",
};
GATE_DEFS["zk_fs"] = {
  id: "zk_fs",
  keywords: ["zk fs", "list cards", "card tree", "knowledge grep", "card filesystem", "列出卡片", "瀏覽知識卡"],
  requires: {
    nouns: ["cards", "card", "knowledge", "卡片", "知識卡"],
    verbs: ["list", "browse", "tree", "grep", "stat", "列出", "瀏覽"],
  },
  description: "Deterministic FS-style browse over the knowledge vault (ls/tree/find/grep/stat)",
};
import type { KnowledgeRecord, SourceFamily } from "../src/types.ts";
import {
	retrieveRecords,
	type RetrieveOptions,
	graphHealth,
	healGraph,
	formatHealth,
} from "../src/retrieve.ts";
import { buildHierarchy } from "../src/hierarchy-build.ts";
import {
	publishKnowledgePipeline,
	unpublishKnowledgePipeline,
} from "../src/knowledge-pipeline-seam.ts";
import {
	spawnSubagent as __defaultSpawnSubagent,
	roleAwareDirectCall,
	type SpawnSubagentOptions,
	type SpawnSubagentResult,
} from "@repo/s2-agent-core-runtime";
import { runGate } from "../src/distill/gate.ts";
import { runConverge } from "../src/distill/converge.ts";
import { runExtraction, readHermesJournal } from "../src/extract.ts";
import { fsLs, fsTree, fsFind, fsGrep, fsStat } from "../src/fs-surface.ts";
import { onKnowledge } from "../src/emit.ts";
import { convergeKnowledgeEmission } from "../src/converge.ts";
import { readState } from "../src/distill/state.ts";
import type { MemoryEntry, EnrichedNote, ConvergeMetrics } from "../src/distill/types.ts";
import {
	ADD_TOOLS,
	CHECK_TOOLS,
	FIND_TOOLS,
	RAG_TOOLS,
	REMOVE_TOOLS,
	UPDATE_TOOLS,
	resolveDistillModel,
} from "../src/zk-task-config.ts";
import {
	buildAddTask,
	buildFindTask,
	buildRagTask,
	buildRemoveTask,
	buildUpdateTask,
	CHECK_TASK,
} from "../src/task-builders.ts";

// ---------------------------------------------------------------------------
// zk_* spawn seam (sub-project ①) — zk_card / zk_ask spawn through this
// swappable fn so the transport is injectable (tests) and converges on ONE
// path (spawnSubagent, in-process createAgentSession) instead of pi-obsidian's
// child-process runner. parentExtensionTools is captured at session_start for
// the R2 bridge (obsidian tools reach the child in manifest AND `-e` dev mode).
// ---------------------------------------------------------------------------
export type ZkSpawnFn = (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
let zkSpawn: ZkSpawnFn = __defaultSpawnSubagent;
let parentExtensionTools: ToolDefinition[] | undefined;
/** @internal test-only override of the zk_* spawner. null restores the default. */
export function __setZkSpawnForTest(fn: ZkSpawnFn | null): void {
	zkSpawn = fn ?? __defaultSpawnSubagent;
}

/** One-line vault header prepended to every zk_* tool result so the active
 *  vault is always visible (never silently operating on the wrong one).
 *  Resolves independently of the subagent so it works even if the subagent
 *  itself fails. Best-effort: returns "" on resolution error. */
async function vaultHeader(cwd: string): Promise<string> {
	try {
		const v = await resolveVault(cwd);
		const stale = v.staleReason ? " ⚠stale" : "";
		return `vault: ${v.name} (${v.path}) [${v.source}]${stale}`;
	} catch {
		return "";
	}
}

/** Prepend the vault header to a result text block. */
function withVault(header: string, body: string): string {
	return header ? `${header}\n${body}` : body;
}

/** Resolve the convergence vault for the no-LLM knowledge tools
 *  (knowledge_query / graph_health). Delegates to pi-obsidian's multi-tier
 *  `resolveVault` (env → config → app → local) — the SAME resolver the native
 *  zk_* tools use. The hub asks its forward-dep (pi-obsidian) to serve vault
 *  resolution rather than rolling its own; this also reads the run-dir config
 *  (`obsidian_config.json` vault_path) that the simplified resolver missed.
 *  Throws if no vault can be resolved — callers catch and return isError.
 *  (Consolidation-cycle fix: the power-tool version only checked OB_VAULT_PATH
 *  + cwd/"vault", so it failed at runtime when the vault was config-registered
 *  but not env-set. Now it resolves exactly like the sibling zk_* tools.) */
// --- test seam (deterministic vault-failure injection) --------------------------
// resolveVault has a Tier-2 (Obsidian app) fallback that resolves the real
// open vault on any dev machine with Obsidian installed, so a unit test can't
// make resolution fail by clearing OB_VAULT_PATH. This seam lets the error-
// path test inject a failing resolver deterministically. Null = use real.
let __vaultResolver: ((cwd: string) => Promise<string>) | null = null;
/** @internal test-only override of the vault resolver (pass null to restore). */
export function __setVaultResolverForTest(
	fn: ((cwd: string) => Promise<string>) | null,
): void {
	__vaultResolver = fn;
}

async function resolveKnowledgeVault(cwd: string): Promise<string> {
	if (__vaultResolver) return __vaultResolver(cwd);
	return (await resolveVault(cwd)).path;
}

// ---------------------------------------------------------------------------
// Deterministic health check registration (Phase 1 de-dup)
// Register graphHealth/healGraph with pi-obsidian so the obsidian garden tool's
// deterministic engine can call them without a backwards import dependency.
// ---------------------------------------------------------------------------
registerDeterministicHealthCheck(async (opts) => {
	const hOpts = { vaultPath: opts.vaultPath, folder: opts.folder, mocPath: opts.mocPath };
	if (opts.fix) {
		const healed = await healGraph(hOpts);
		console.error(
			`  [garden:det] heal: MOC ${healed.mocRegenerated ? "regenerated" : "no change"}, ` +
			`${healed.deadLinksPruned} dead link(s) pruned in ${healed.cardsTouched.length} card(s)`,
		);
	}
	const h = await graphHealth(hOpts);
	return { health: h, text: formatHealth(h) };
});

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

/**
 * tier rule: converge hermes-memory §-entries into the vault knowledge graph.
 * Owned by the HUB (not hermes) so hermes stays a pure TIER-0 foundation with
 * no upward dependency edge. Reads every `.md` in `hermesDir`, adapts via
 * `adaptHermesMarkdown`, ingests via `ingestRecords` (idempotent by canonical
 * id). Returns the ingest summary, or null if the dir is absent (hermes not
 * installed) or holds no records. Directly testable (no resolveVault/env coupling).
 */
export async function convergeHermesMemory(
	vaultPath: string,
	hermesDir: string,
) {
	let files: string[];
	try {
		files = readdirSync(hermesDir).filter((f) => f.endsWith(".md"));
	} catch {
		return null; // hermes dir absent/unreadable — hermes not installed
	}
	const records = files.flatMap((f) =>
		adaptHermesMarkdown(readFileSync(join(hermesDir, f), "utf8")),
	);
	if (records.length === 0) return null;
	return ingestRecords(records, {
		vaultPath,
		source: "hermes",
		sourceLabel: "hermes:auto-converge",
		wikiAware: true,
	});
}

export default function piKnowledgeCardExtension(pi: ExtensionAPI) {
	// Self-gate: BUN_PI_KNOWLEDGE_CARD=0 disables the entire extension — it
	// registers no tools, event hooks, or workflow host-fns. Mirrors
	// prompt-history's BUN_PI_PROMPT_HISTORY=0 so every extension in the
	// portable base set (s2-agent.registry.yaml) shares one symmetric
	// full-disable knob; enforced by tests/extension-isolation-contract.test.ts.
	// (Module-scope work — GATE_DEFS registration and the deterministic
	// health-check handoff to obsidian — is import-time by design; the knob
	// gates what THIS factory registers on the host.)
	if (process.env.BUN_PI_KNOWLEDGE_CARD === "0") return;

	// zk_extract tool removed (Phase 1 de-dup): it was a 100% passthrough to
	// obsidian_distill. Use obsidian_distill directly. buildDistillTask remains
	// exported above for the CLI zk-extract command.

	// Capture the parent session's extension tools so zk_* in-process subagents
	// (via spawnSubagent) reach obsidian tools in manifest AND `-e` dev mode (R2).
	pi.on("session_start", () => {
		// Fresh session → fresh capture. Since pi 0.84.2 the api-level
		// getAllToolDefinitions is dead (fixed-shape ExtensionAPI — see
		// readAllToolDefinitions in core-interface, found by the cc-parity-2
		// ticket-01 live smoke); the helper falls back to the runtime patch's
		// globalThis bridge. Kept on session_start (not lazy at spawn) because
		// the zk_* spawns read the module-level variable directly.
		parentExtensionTools = readAllToolDefinitions(pi) ?? parentExtensionTools;
		// Publish zk's 4-function knowledge surface as the __piKnowledgePipeline
		// seam (typed via @repo/s2-agent-core-interface). Live for the session;
		// unpublishKnowledgePipeline() tears it down at session_shutdown.
		publishKnowledgePipeline({ collectInputFiles, ingestRecords, retrieveRecords, healGraph, buildHierarchy });
	});

	// ── Auto-converge hermes memory → graph on session_shutdown (tier rule) ──
	// Convergence ownership lives in the HUB, not in hermes. Hermes is a pure
	// TIER-0 foundation; this handler PULLS its memory files at shutdown and
	// converges them via convergeHermesMemory() — so there is NO hermes→hub
	// dependency edge. Best-effort + config-gated (OB_HERMES_AUTOCONVERGE=0
	// disables); convergeHermesMemory tolerates a missing hermes dir. Never
	// blocks shutdown.
	pi.on("session_shutdown", async (_event, ctx) => {
		// Unpublish the seam first — it was published unconditionally at
		// session_start, so it must be torn down unconditionally (before the
		// OB_HERMES_AUTOCONVERGE early-return below).
		unpublishKnowledgePipeline();
		if (process.env.OB_HERMES_AUTOCONVERGE === "0") return;
		try {
			const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			const vaultPath = (await resolveVault(cwd)).path;
			const hermesDir =
				process.env.OB_HERMES_MEMORY_DIR ?? join(homedir(), ".pi", "agent", "pi-hermes-memory");
			// Raw lane (unchanged): hermes:* cards — cheap, deterministic.
			await convergeHermesMemory(vaultPath, hermesDir);
			// Extract lane (D31): the session-commit → extraction loop over
			// FRESH entries only (cursor-advanced). Best-effort like the raw
			// lane: bounded timeout (a slow local model must not hold shutdown
			// open long), silent fail — a failed run simply does not advance
			// the cursor and retries at the next commit.
			if (process.env.OB_KNOWLEDGE_EXTRACT === "0") return;
			const entries = readHermesJournal(hermesDir);
			if (entries.length > 0) {
				await runExtraction({
					vaultPath,
					entries,
					trigger: "shutdown",
					timeoutMs: 25_000,
				});
			}
		} catch {
			// Silent fail — best-effort; never block shutdown.
		}
	});

	// ---- Tool: zk_card ------------------------------------------------------
	pi.registerTool({
		name: "zk_card",
		label: "ZK Card",
		gating: { gate: "zk_card" }, // demoted from core (ticket 02),
		description: [
			"CRUD operations on Zettelkasten vault notes.",
			"Actions: add (new note with 4-layer duplicate check), find (multi-strategy search),",
			"update (smart-merge content into existing note), remove (backlink-safe delete),",
			"check (vault health audit: duplicates, orphans, dead links).",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(["add", "find", "update", "remove", "check"] as const, {
				description: "Operation to perform.",
			}),
			content: Type.Optional(
				Type.String({
					description:
						"Note content — required for add; new content to merge for update.",
				}),
			),
			query: Type.Optional(
				Type.String({ description: "Search query — required for find." }),
			),
			note: Type.Optional(
				Type.String({
					description:
						"Vault-relative note path — required for update and remove.",
				}),
			),
			folder: Type.Optional(
				Type.String({
					description: "Target folder for add (default: Zettelkasten).",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"add: bypass duplicate threshold. remove: delete even with backlinks.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "find: max results (default: 10).",
					minimum: 1,
				}),
			),
			context_lines: Type.Optional(
				Type.Number({
					description:
						"find: context lines around each match (default: 3; 0 = titles only).",
					minimum: 0,
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Override the subagent's model (provider/id[:thinking]). Default: central tiers.small from model-tiers.json; override session-wide via KC_SUBAGENT_MODEL env. Mirrors the CLI --model flag.",
				}),
			),
			exclude_tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Tool names to deny the subagent (mirrors the CLI --exclude-tools flag).",
				}),
			),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const { cwd } = ctx;
			const folder = params.folder ?? "Zettelkasten";

			let task: string;
			let tools: string[];

			switch (params.action) {
				case "add": {
					if (!params.content) {
						return {
							content: [
								{ type: "text", text: "zk_card add requires 'content'." },
							],
							isError: true,
							details: null,
						};
					}
					task = buildAddTask(params.content, folder, params.force ?? false);
					tools = ADD_TOOLS;
					break;
				}
				case "find": {
					if (!params.query) {
						return {
							content: [
								{ type: "text", text: "zk_card find requires 'query'." },
							],
							isError: true,
							details: null,
						};
					}
					task = buildFindTask(
						params.query,
						params.context_lines ?? 3,
						params.limit ?? 10,
					);
					tools = FIND_TOOLS;
					break;
				}
				case "update": {
					if (!params.note || !params.content) {
						return {
							content: [
								{
									type: "text",
									text: "zk_card update requires 'note' and 'content'.",
								},
							],
							isError: true,
							details: null,
						};
					}
					task = buildUpdateTask(params.note, params.content);
					tools = UPDATE_TOOLS;
					break;
				}
				case "remove": {
					if (!params.note) {
						return {
							content: [
								{ type: "text", text: "zk_card remove requires 'note'." },
							],
							isError: true,
							details: null,
						};
					}
					task = buildRemoveTask(params.note, params.force ?? false);
					tools = REMOVE_TOOLS;
					break;
				}
				case "check": {
					task = CHECK_TASK;
					tools = CHECK_TOOLS;
					break;
				}
				default: {
					return {
						content: [
							{ type: "text", text: `Unknown action: ${params.action}` },
						],
						isError: true,
						details: null,
					};
				}
			}

			const zkEnv = roleAwareDirectCall("writer", task, `zk-card-${Date.now()}`);
			const { output, failure } = await zkSpawn({
				cwd,
				task: zkEnv.task,
				tools,
				model: resolveDistillModel(params.model),
				...(zkEnv.tokenBudget !== undefined ? { tokenBudget: zkEnv.tokenBudget, maxTurns: zkEnv.maxTurns, timeoutMs: zkEnv.timeoutMs } : {}),
				excludeTools: params.exclude_tools,
				externalSignal: signal,
				extensionTools: parentExtensionTools,
			});
			if (failure?.kind === "timedout") {
				return {
					content: [
						{
							type: "text",
							text: `zk_card ${params.action} timed out.\n${output.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message },
				};
			}
			if (failure && !output) {
				return {
					content: [
						{
							type: "text",
							text: `zk_card ${params.action} failed.\n${failure.message.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: withVault(
							await vaultHeader(ctx.cwd),
							output || `(zk_card ${params.action} produced no output)`,
						),
					},
				],
				details: { status: failure?.kind ?? "done" },
			};
		},
	});

	// ---- Tool: zk_ask -------------------------------------------------------
	pi.registerTool({
		name: "zk_ask",
		label: "ZK Ask",
		gating: { gate: "zk_ask" }, // demoted from core (ticket 02),
		description: [
			"Graph-enhanced RAG over the Zettelkasten vault.",
			"Pipeline: seed retrieval (fuzzy title + tag + body keyword) →",
			"graph expansion (N-hop wiki-link traversal) →",
			"cluster & rank (0.7×search_score + 0.3×link_count) →",
			"context assembly (full read for top-K, snippet for rest) →",
			"synthesized answer in Traditional Chinese with reference list.",
		].join(" "),
		parameters: Type.Object({
			question: Type.String({
				description:
					"Natural language question to answer from vault knowledge.",
			}),
			depth: Type.Optional(
				Type.Number({
					description: "Graph hop depth for neighbor expansion (default: 2).",
					minimum: 1,
				}),
			),
			top_k: Type.Optional(
				Type.Number({
					description: "Max notes to include in context (default: 8).",
					minimum: 1,
				}),
			),
			max_neighbors: Type.Optional(
				Type.Number({
					description: "Max neighbor nodes per seed per hop (default: 5).",
					minimum: 1,
				}),
			),
			max_note_tokens: Type.Optional(
				Type.Number({
					description:
						"Token limit per note in the L2 full-read tier (default: 2000); a note over the limit demotes to its L1 overview instead of truncating.",
					minimum: 1,
				}),
			),
			summarize: Type.Optional(
				Type.Boolean({
					description: "Summarize each tag cluster before generating.",
				}),
			),
			retrieve_only: Type.Optional(
				Type.Boolean({
					description: "Return assembled context only, skip answer generation.",
				}),
			),
			no_refine: Type.Optional(
				Type.Boolean({
					description:
						"Skip seed quality gate (no query rewrite on poor seeds).",
				}),
			),
			folder: Type.Optional(
				Type.String({
					description: "Restrict seed search to this vault folder.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Override the RAG subagent's model (provider/id[:thinking]). Default: central tiers.small from model-tiers.json; override session-wide via KC_SUBAGENT_MODEL env. Mirrors the CLI --model flag.",
				}),
			),
			exclude_tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Tool names to deny the RAG subagent (mirrors the CLI --exclude-tools flag).",
				}),
			),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const { cwd } = ctx;
			const task = buildRagTask(
				params.question,
				params.depth ?? 2,
				params.top_k ?? 8,
				params.summarize ?? false,
				params.retrieve_only ?? false,
				params.max_neighbors ?? 5,
				params.max_note_tokens ?? 2000,
				params.no_refine ?? false,
				params.folder,
			);
			const zkAskEnv = roleAwareDirectCall("recon", task, `zk-ask-${Date.now()}`);
			const { output, failure } = await zkSpawn({
				cwd,
				task: zkAskEnv.task,
				tools: [...RAG_TOOLS],
				model: resolveDistillModel(params.model),
				...(zkAskEnv.tokenBudget !== undefined ? { tokenBudget: zkAskEnv.tokenBudget, maxTurns: zkAskEnv.maxTurns, timeoutMs: zkAskEnv.timeoutMs } : {}),
				excludeTools: params.exclude_tools,
				externalSignal: signal,
				extensionTools: parentExtensionTools,
			});
			if (failure?.kind === "timedout") {
				return {
					content: [
						{ type: "text", text: `zk_ask timed out.\n${output.slice(-2000)}` },
					],
					isError: true,
					details: { status: failure.kind, error: failure.message },
				};
			}
			if (failure && !output) {
				return {
					content: [
						{
							type: "text",
							text: `zk_ask failed.\n${failure.message.slice(-2000)}`,
						},
					],
					isError: true,
					details: { status: failure.kind, error: failure.message },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: withVault(
							await vaultHeader(ctx.cwd),
							output || "(zk_ask produced no output)",
						),
					},
				],
				details: { status: failure?.kind ?? "done" },
			};
		},
	});

	// ---- Tool: zk_ingest ----------------------------------------------------
	// Deterministic convergence primitive (the only zk_* tool that does NOT
	// spawn a subagent). Maps structured .knowledge.jsonl records 1:1 onto
	// zettel cards in the shared vault, dedup'd by record id, cross-linked by
	// shared tags, indexed by a MOC. See src/ingest.ts for the schema mapping.
	pi.registerTool({
		name: "zk_ingest",
		label: "ZK Ingest",
		gating: { gate: "zk_ingest" }, // demoted from core (ticket 02),
		description: [
			"Deterministically converge structured .knowledge.jsonl records into the shared Zettelkasten vault.",
			"One card per record (id/type/title/detail/tags/dimension/confidence/status/superseded_by/evidence),",
			"dedup'd by canonical record id (re-ingest upserts in place), cross-linked by shared tags,",
			"and indexed by a Knowledge Graph MOC. No LLM — lossless + idempotent, unlike obsidian_distill.",
			"This is the convergence sink that lets every self-improve loop's distilled knowledge flow",
			"into ONE queryable, backlinked graph that zk_ask can traverse cross-source.",
			"Optionally, with action='gate'|'converge'|'status' it drives the agent self-triggered distill pipeline ",
			"(Gate→Enrich-in-agent→Converge) over hermes-memory entries.",
		].join(" "),
		parameters: Type.Object({
			action: Type.Optional(
				StringEnum(["gate", "converge", "status", "extract"] as const, {
						description:
							"Distill pipeline action (absent = deterministic ingest, the default). " +
							"'gate' filters raw hermes-memory entries (dedup/stale/malformed) and returns " +
							"survivors for in-context enrichment (read-only). 'converge' writes enriched " +
							"notes via the ingest path, supersedes the raw hermes/pi-memory card, and adjusts the " +
							"adaptive threshold. 'status' reports the current threshold + run history. " +
							"'extract' runs the ticket-06 session-extraction loop end-to-end: gate → deterministic " +
							"classify → single local LLM call (typed cards + dedup votes; add_only forced for events) → " +
							"converge → supersede raw cards → audit diff under output/kcard-extract/ (fresh entries only, " +
							"cursor in .extract-state.json). Workflow: status → gate → enrich survivors in your reasoning → converge.",
					},
				),
			),
			entries: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						target: Type.String(),
						content: Type.String(),
						created: Type.String(),
						last: Type.Optional(Type.String()),
					}),
					{ description: "Raw hermes-memory entries (required for action='gate')." },
				),
			),
			notes: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						type: Type.String(),
						title: Type.String(),
						detail: Type.String(),
						tags: Type.Array(Type.String()),
						dimension: Type.Optional(Type.String()),
						confidence: Type.Optional(Type.Number()),
						supersedesCardId: Type.Optional(Type.String()),
					}),
					{ description: "Enriched notes (required for action='converge')." },
				),
			),
			metrics: Type.Optional(
				Type.Object(
					{
						candidates: Type.Number(),
						killed: Type.Number(),
						survivors: Type.Number(),
					},
					{ description: "Gate metrics (required for action='converge')." },
				),
			),
			files: Type.Array(Type.String(), {
				description:
					"Paths to input files (absolute or relative to cwd). Each entry may also be a DIRECTORY — recursively expanded for the source's file type (.md for auto-memory/hermes/generic, .knowledge.jsonl for workflow-jsonl); MEMORY.md/README.md index files are skipped. For a random .md folder, use source=generic.",
			}),
			dir: Type.Optional(
				Type.String({
					description:
						"Convenience: a directory to expand (equivalent to files:[<dir>]). Common case for ingesting a whole memory directory.",
				}),
			),
			source: Type.Optional(
				Type.String({
					description:
						"Source family: workflow-jsonl (.knowledge.jsonl), hermes (§-separated memory .md), auto-memory (name/description .md), or generic (ANY .md — the universal adapter that accepts a random .md folder). Default: workflow-jsonl.",
					default: "workflow-jsonl",
				}),
			),
			source_label: Type.Optional(
				Type.String({
					description:
						"Human-readable provenance string. Defaults to '<source>:<first file basename>'.",
				}),
			),
			folder: Type.Optional(
				Type.String({
					description:
						"Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). All sources converge into the SAME folder so cross-source edges form.",
				}),
			),
			dry_run: Type.Optional(
				Type.Boolean({
					description:
						"Report what would be created/updated without writing anything.",
				}),
			),
			vault: Type.Optional(
				Type.String({
					description:
						"Override the vault path (else resolved via OB_VAULT_PATH / --vault-dir / cwd/vault through pi-obsidian).",
				}),
			),
		}),
		async execute(_id, params, _signal, _u, ctx) {
			// ── distill pipeline actions (folded from s2-agent-ext-distill) ──
			const action = params.action as "gate" | "converge" | "status" | "extract" | undefined;
			if (action === "gate" || action === "converge" || action === "status" || action === "extract") {
				let vaultPath: string;
				try {
					vaultPath = params.vault ?? (await resolveVault(ctx.cwd)).path;
				} catch (e) {
					return {
						content: [
							{
								type: "text",
								text: `zk_ingest: vault resolution failed: ${(e as Error).message}`,
							},
						],
						isError: true,
						details: { code: "vault_resolution_failed" },
					};
				}

				if (action === "status") {
					const state = readState(vaultPath);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									threshold: state.threshold,
									lastRun: state.lastRun,
									historyEntries: state.history.length,
									recentRuns: state.history.slice(-3),
								}),
							},
						],
						isError: false,
						details: null,
					};
				}

				if (action === "extract") {
					if (process.env.OB_KNOWLEDGE_EXTRACT === "0") {
						return {
							content: [{ type: "text", text: "zk_ingest extract disabled (OB_KNOWLEDGE_EXTRACT=0)." }],
							isError: false,
							details: null,
						};
					}
					const hermesDir =
						process.env.OB_HERMES_MEMORY_DIR ?? join(homedir(), ".pi", "agent", "pi-hermes-memory");
					const entries = (params.entries?.length ? params.entries : readHermesJournal(hermesDir)) as MemoryEntry[];
					const result = await runExtraction({
						vaultPath,
						entries,
						trigger: "on-demand",
						dryRun: Boolean(params.dry_run),
					});
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						isError: false,
						details: { diffFile: result.diffFile },
					};
				}

				if (action === "gate") {
					const entries = (params.entries ?? []) as MemoryEntry[];
					const result = runGate(entries, vaultPath);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									candidates: result.candidates,
									killed: result.killed.length,
									survivors: result.survivors.map((s) => ({
										id: s.entry.id,
										content: s.entry.content,
										target: s.entry.target,
										reason: s.reason,
									})),
									killReasons: result.killed.reduce(
										(acc: Record<string, number>, k) => {
											acc[k.reason] = (acc[k.reason] ?? 0) + 1;
											return acc;
										},
										{},
									),
								}),
							},
						],
						isError: false,
						details: null,
					};
				}

				// action === "converge"
				const notes = (params.notes ?? []) as EnrichedNote[];
				const metrics = (params.metrics ?? { candidates: 0, killed: 0, survivors: 0 }) as ConvergeMetrics;
				const result = await runConverge(notes, vaultPath, metrics);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					isError: false,
					details: null,
				};
			}

			const { cwd } = ctx;
			const inputs = [...(params.files ?? []), ...(params.dir ? [params.dir] : [])];
			if (inputs.length === 0) {
				return {
					content: [{ type: "text", text: "No input files provided." }],
					isError: true,
					details: null,
				};
			}
			const source = (params.source ?? "workflow-jsonl") as SourceFamily;
			// Expand directories + resolve to absolute, sorted, unique paths.
			const { files, skipped } = collectInputFiles(inputs, { source, cwd });
			if (files.length === 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`zk_ingest: no input files resolved` +
								(skipped.length
									? `; skipped: ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`
									: ""),
						},
					],
					isError: true,
					details: { code: "no_input_files", skipped },
				};
			}
			const sourceLabel =
				params.source_label ??
				`${source}:${files[0]!.split("/").pop()!.replace(/\.(knowledge\.jsonl|md)$/, "")}`;
			let vaultPath: string;
			try {
				vaultPath = params.vault ?? (await resolveVault(cwd)).path;
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `zk_ingest: vault resolution failed: ${(e as Error).message}`,
						},
					],
					isError: true,
					details: { code: "vault_resolution_failed" },
				};
			}

			const records: KnowledgeRecord[] = [];
			const parseErrors: { line: number; reason: string }[] = [];
			for (const abs of files) {
				let content: string;
				try {
					content = readFileSync(abs, "utf8");
				} catch (e) {
					parseErrors.push({
						line: 0,
						reason: `${abs}: read failed (${(e as Error).message})`,
					});
					continue;
				}
				if (source === "hermes") {
					// hermes inputs are .md memory files with MANY `§`-separated entries
					// (failures/MEMORY/USER) — adapt to one record per entry.
					const recs = adaptHermesMarkdown(content);
					if (recs.length === 0) {
						parseErrors.push({ line: 0, reason: `${abs}: no § entries parsed` });
						continue;
					}
					records.push(...recs);
				} else if (source === "auto-memory") {
					const rec = adaptAutoMemoryMarkdown(content);
					if (!rec) {
						parseErrors.push({ line: 0, reason: `${abs}: not a memory file` });
						continue;
					}
					records.push(rec);
				} else if (source === "generic") {
					// generic inputs are ANY .md files (no frontmatter/H1/tag
					// assumptions) — one record per file via the universal adapter.
					const rec = adaptGenericMarkdown(content, abs);
					if (!rec) {
						parseErrors.push({ line: 0, reason: `${abs}: empty or unparseable` });
						continue;
					}
					records.push(rec);
				} else {
					const parsed = parseKnowledgeJsonl(content);
					records.push(...parsed.records);
					parseErrors.push(...parsed.parseErrors);
				}
			}

			const summary = await ingestRecords(records, {
				vaultPath,
				source,
				sourceLabel,
				folder: params.folder,
				dryRun: params.dry_run === true,
			});
			summary.parseErrors.push(...parseErrors);
			const skippedNote = skipped.length
				? `\nSkipped: ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`
				: "";
			return {
				content: [
					{
						type: "text",
						text: withVault(await vaultHeader(cwd), formatSummary(summary) + skippedNote),
					},
				],
				details: { ...summary, skipped },
			};
		},
	});

	// ─── knowledge_query tool (migrated from s2-agent-ext-power-tool) ────────
	// Deterministic, no-LLM cross-workflow digest over the convergence folder.
	// This is the hub's direct agent surface over retrieve.ts — the same library
	// zk-query (CLI) consumes. Behavior-preserving move (consolidation cycle).
	pi.registerTool({
		name: "knowledge_query",
		label: "Knowledge Query",
		gating: { gate: "knowledge_query" }, // demoted from core (ticket 02),
		description:
			"Query the project's Zettelkasten knowledge graph for cards matching given tags " +
			"or a natural-language question. Returns a compact digest of relevant stored " +
			"knowledge (gotchas, patterns, levers, avoid, false_positive, metric cards). " +
			"Call this BEFORE answering a question that may benefit from past workflow " +
			"lessons.",
		parameters: Type.Object({
			tags: Type.Optional(Type.Array(Type.String(), {
				description: "Tags to match (ANY semantics). e.g. [\"argparse\", \"lora\"]",
			})),
			query: Type.Optional(Type.String({
				description: "Natural language query. If provided without tags, tags are inferred.",
			})),
			topK: Type.Optional(Type.Number({
				description: "Max cards to return (default 10)",
				default: 10,
			})),
			trace: Type.Optional(Type.Boolean({
				description:
					"Opt-in retrieval trace (Phase C observability). When true, the result's " +
					"`details.trace` carries per-card score/sharedTags/source provenance (lexical " +
					"vs semantic) for debugging why cards surfaced. The text digest is " +
					"unchanged. Default false.",
				default: false,
			})),
			tier: Type.Optional(Type.Union([Type.Literal("abstract"), Type.Literal("overview"), Type.Literal("full")], {
				description:
					"Render tier (ticket 07 ladder): 'abstract' (L0 — title+tags+summary, DEFAULT), " +
					"'overview' (L1 — body lead ~600 chars / agg summary), 'full' (L2 — full body). " +
					"An entry whose tier text overflows its budget DEMOTES to a shallower tier " +
					"instead of truncating.",
				default: "abstract",
			})),
			type: Type.Optional(Type.String({
				description:
					"D18 typed filter (ticket 05): exact leaf type — gotcha|avoid|lever|pattern|" +
					"metric|false_positive|experience|event|case|preference. Deterministic " +
					"caller-passed filter (no intent analysis).",
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let vaultPath: string;
			try {
				vaultPath = await resolveKnowledgeVault(ctx.cwd);
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `knowledge_query: vault resolution failed: ${(e as Error).message}` }],
					isError: true,
					details: { code: "vault_resolution_failed" },
				};
			}

			const tags: string[] = params.tags ?? [];
			const query: string = params.query ?? "";
			const topK: number = params.topK ?? 10;
			const includeTrace: boolean = params.trace === true;

			if (tags.length === 0 && !query) {
				return {
					content: [{ type: "text" as const, text: "Provide tags[], a query string, or both." }],
					details: null,
				};
			}

			// If no tags but a query is provided, split the query into word tokens as tags.
			const effectiveTags = tags.length > 0 ? tags : (
				query
					.toLowerCase()
					.replace(/[^a-z0-9-]+/g, " ")
					.trim()
					.split(/\s+/)
					.filter((t) => t.length >= 3 && t.length <= 30)
					.slice(0, 10)
			);

			const opts: RetrieveOptions = {
				vaultPath,
				folder: "Zettelkasten/knowledge-graph",
				tags: effectiveTags,
				topK,
				// Tier ladder (ticket 07): L0 abstract is the default render;
				// 'overview' is the detail flag; 'full' is the explicit request.
				tier: params.tier ?? "abstract",
				// Body-match recall (kg-improvement-plan follow-on): also surface cards
				// whose query tokens appear in body prose, not just tags. Blend score
				// (tag×2 + body + callout) — measured 0.48 → 0.80 hit-rate@4, zero
				// regression on the 25-query eval. This is knowledge_query's recall win.
				bodyMatch: true,
				// Slug-dominant precision (iter-2): a card whose slug overlaps ≥3 query
				// tokens scores by slug×4 — the topic fingerprint beats ubiquitous-tag
				// noise. Measured 0.80 → 0.84 hit-rate@4, zero regression. Composes
				// with bodyMatch; cheap (slug = filename, no extra read).
				slugDom: true,
				// Semantic (embedding) blend (recall-regime-change-eval, 2026-07-12):
				// union lexical top-12 with a semantic cosine top-12, rerank by
				// α·lexRank + (1-α)·cosNorm. Bridges symptom→cause gaps lexical
				// retrieval cannot (measured 0.84 → 1.00 hit-rate@4, zero regression).
				// Graceful fallback: if LM Studio / the embed model is unavailable, retrieval is
				// pure lexical (the shipped 0.84 path) — no error.
				semantic: true,
				queryText: query,
				// Phase C observability: opt-in per-card provenance trace in `details`.
				includeTrace,
				// D18 typed filter (ticket 05): exact leaf-type match, hier `kind` /
				// flat frontmatter lanes alike.
				type: params.type,
			};

			const result = await retrieveRecords(opts);

			if (result.count === 0) {
				return {
					content: [{ type: "text" as const, text: `No knowledge cards matched tags [${effectiveTags.join(", ")}].` }],
					details: result,
				};
			}

			const lines = [
				`Knowledge graph: ${result.count} card(s) matched (scanned ${result.scanned}, excluded ${result.excluded})`,
				"",
				result.digest,
			];

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: result,
			};
		},
	});

	// ── zk_fs — OpenViking-style virtual-FS read surface (ticket 05, D32–D35) ─
	// Deterministic browse ops over the knowledge folder, tier-ladder rendered.
	// One tool + op param (zk_card's action-param precedent — schema-cost
	// discipline); vault-relative paths are the URIs (D33); `type/<kind>` is the
	// D18 virtual type namespace; ZERO LLM tokens per op (D5/D6).
	pi.registerTool({
		name: "zk_fs",
		label: "Knowledge FS Browse",
		gating: { gate: "zk_fs" },
		description:
			"BROWSE the knowledge vault like a filesystem instead of querying it: " +
			"ls (list a dir — '' root, or 'type/<kind>' for the virtual type directory), " +
			"tree (agg hierarchy, depth-capped), find (glob/substring over card stems), " +
			"grep (token search over titles/summaries/bodies), stat (one card). " +
			"Deterministic, zero LLM. Entries render tier-ladder L0 by default; pass " +
			"tier:'overview'|'full' to promote (demote-not-truncate). Paths are " +
			"vault-relative (e.g. 'Zettelkasten/knowledge-graph/<stem>').",
		parameters: Type.Object({
			op: Type.Union(
				[Type.Literal("ls"), Type.Literal("tree"), Type.Literal("find"), Type.Literal("grep"), Type.Literal("stat")],
				{ description: "Browse operation." },
			),
			path: Type.Optional(Type.String({
				description: "ls/stat target path (vault-relative). ls: '' = root, 'type/<kind>' = virtual type dir. Default ''.",
			})),
			pattern: Type.Optional(Type.String({ description: "find: glob over stems ('*' wildcard) or bare substring." })),
			query: Type.Optional(Type.String({ description: "grep: token query — FTS conjunction over title/summary/body." })),
			type: Type.Optional(Type.String({
				description: "D18 typed filter — exact leaf type (gotcha|avoid|lever|pattern|metric|false_positive|experience|event|case|preference).",
			})),
			depth: Type.Optional(Type.Number({ description: "tree: max depth (1–4, default 2).", default: 2 })),
			limit: Type.Optional(Type.Number({ description: "Max entries (default 50 ls / 30 find / 20 grep).", default: 50 })),
			tier: Type.Optional(Type.Union([Type.Literal("abstract"), Type.Literal("overview"), Type.Literal("full")], {
				description: "Render tier: 'abstract' (L0, DEFAULT) | 'overview' (L1) | 'full' (L2).",
				default: "abstract",
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let vaultPath: string;
			try {
				vaultPath = await resolveKnowledgeVault(ctx.cwd);
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `zk_fs: vault resolution failed: ${(e as Error).message}` }],
					isError: true,
					details: { code: "vault_resolution_failed" },
				};
			}
			const opts = { vaultPath, folder: "Zettelkasten/knowledge-graph", tier: params.tier ?? "abstract" };
			let result: import("../src/fs-surface.ts").FsResult;
			switch (params.op) {
				case "ls":
					result = await fsLs({ ...opts, path: params.path ?? "", limit: params.limit });
					break;
				case "tree":
					result = await fsTree({ ...opts, type: params.type, depth: params.depth });
					break;
				case "find":
					result = await fsFind({ ...opts, pattern: params.pattern ?? "", type: params.type, limit: params.limit });
					break;
				case "grep":
					result = await fsGrep({ ...opts, query: params.query ?? "", type: params.type, limit: params.limit });
					break;
				case "stat":
					result = await fsStat({ ...opts, path: params.path ?? "" });
					break;
			}
			if (!result.ok) {
				return { content: [{ type: "text" as const, text: `zk_fs ${params.op}: ${result.reason ?? "failed"}` }], details: result };
			}
			const lines = [
				`zk_fs ${params.op} (lane: ${result.lane}, considered ${result.scanned})`,
				"",
				...result.entries.map((e) => `- ${e.path} [${e.kind}] (${e.tier}) ${e.text.replace(/\n/g, " ")}`),
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: result };
		},
	});

	// ── Workflow host-fn registration (sub-project ②) ────────────────────────
	// Register the four deterministic zk.* fns with the workflow runtime over the
	// in-process event bus. Idempotent (the runtime overwrites on re-register);
	// re-emit on `request` so we still register if we loaded before the workflow
	// extension's listener existed. No-op if the workflow ext is absent.
	const __hostFnBus = (pi as unknown as {
		events?: { emit: (ch: string, p: unknown) => void; on: (ch: string, cb: (p: unknown) => void) => void };
	}).events;
	const __registerZkHostFns = () => {
		if (!__hostFnBus) return;
		const entries = [
			{ ns: "zk", name: "retrieve", fn: zkRetrieve, timeoutMs: 30_000 },
			{ ns: "zk", name: "ingest", fn: zkIngest, timeoutMs: 120_000 },
			{ ns: "zk", name: "health", fn: zkHealth, timeoutMs: 60_000 },
			{ ns: "zk", name: "heal", fn: zkHeal, timeoutMs: 60_000 },
		];
		for (const e of entries) __hostFnBus.emit("workflow:hostfn:v1:register", e);
	};
	__registerZkHostFns();
	__hostFnBus?.on("workflow:hostfn:v1:request", __registerZkHostFns);

	// ── pi:knowledge sink — de-orphan the bus (file2md opt-in convergence) ──
	// tier rule: the HUB owns convergence. Foundation extensions (file2md) emit
	// on the bus without importing the hub; this subscriber converges them.
	// Best-effort: resolveVault/ingest failures are swallowed — a bus handler
	// must never throw (mirrors src/emit.ts's swallow-on-failure contract).
	// (Placed last in the factory so the sink test's single-capture fake pi —
	// which keeps the last events.on handler — observes this subscriber.)
	onKnowledge(pi, async (payload) => {
		try {
			const cwd = process.cwd();
			const vaultPath = (await resolveVault(cwd)).path;
			await convergeKnowledgeEmission(payload, { vaultPath, cwd });
		} catch {
			// best-effort: never throw from a bus handler
		}
	});
}

export { ADD_TOOLS, CHECK_TOOLS, DISTILL_TOOLS, FIND_TOOLS, RAG_TOOLS, REMOVE_TOOLS, resolveDistillModel, UPDATE_TOOLS } from "../src/zk-task-config.ts";
export { buildAddTask, buildDistillTask, buildFindTask, buildRagTask, buildRemoveTask, buildUpdateTask, CHECK_TASK } from "../src/task-builders.ts";

/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of the runtime gating).
 * Consumed by s2-agent-ext-tool-gate/qa/collect-probes.ts. Plain object, no
 * `satisfies` — shape enforced by tool-gate's drift-guard. Controls-only
 * (recallFloor 0, adversarial []): the 4 zk_* gates were demoted from core in
 * ticket 02; their narrow keywords are intentional, so we assert each fires on
 * its own keyword / requires path, not paraphrased intent.
 */
export const __GATE_PROBES__ = [
	{
		gate: "zk_card",
		recallFloor: 0,
		adversarial: [],
		controls: [
			"add a vault note about the lora fix",
			"find my card on argparse",
			"update the note about swin transformers",
			"remove the stale zettel card",
		],
	},
	{
		gate: "zk_ask",
		recallFloor: 0,
		adversarial: [],
		controls: [
			"ask my vault about the training recipe",
			"query my notes on attention heads",
			"retrieve knowledge from the vault about lora",
		],
	},
	{
		gate: "zk_ingest",
		recallFloor: 0,
		adversarial: [],
		controls: [
			"converge the knowledge records into the vault",
			"ingest the .knowledge.jsonl records",
			"import the distilled knowledge into the zettelkasten",
		],
	},
	{
		gate: "knowledge_query",
		recallFloor: 0,
		adversarial: [],
		controls: [
			"query the knowledge graph for lora cards",
			"search the knowledge cards matching argparse",
			"查卡片 matching the tag lora",
		],
	},
	{
		gate: "zk_fs",
		recallFloor: 0,
		adversarial: [],
		controls: [
			"list the cards in the knowledge vault",
			"grep the knowledge cards for lora",
			"show the card tree of the zettelkasten",
			"browse the type directory of event cards",
		],
	},
];
