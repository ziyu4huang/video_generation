/**
 * `zk.*` deterministic host-fn adapters (sub-project ②).
 *
 * Each adapter wraps an EXISTING pure library fn in `src/` (no LLM, no network
 * except the optional semantic-embed fallback) so the workflow runtime's
 * `call('zk.retrieve' | 'zk.ingest' | 'zk.health' | 'zk.heal', args)` can invoke
 * the knowledge layer without spawning a subagent. The runtime is vault-agnostic;
 * each adapter resolves the vault itself from `ctx.cwd` via `resolveVault`
 * (exactly as the `knowledge_query` tool does), or accepts `ctx.vaultPath` for
 * test injection.
 */
import { readFileSync } from "node:fs";
import { resolveVault } from "@repo/s2-agent-ext-obsidian";
import {
  graphHealth,
  healGraph,
  formatHealth,
  retrieveRecords,
  type RetrieveOptions,
  type GraphHealthResult,
  type HealResult,
  type RetrieveResult,
} from "./retrieve.js";
import { ingestRecords, coverageReport } from "./ingest.js";
import {
  adaptAutoMemoryMarkdown,
  adaptGenericMarkdown,
  adaptHermesMarkdown,
  collectInputFiles,
  parseKnowledgeJsonl,
} from "./adapters.js";
import type { KnowledgeRecord, SourceFamily } from "./types.js";
import { loadWatchlist, resolveSpecsToRecords, type SourceSpec } from "./source-watchlist.js";

/** Context handed to every zk.* host fn. vaultPath is optional (test injection). */
export interface HostFnCtxKC {
  cwd: string;
  signal: AbortSignal;
  runId: string;
  vaultPath?: string;
}

async function vaultOf(ctx: HostFnCtxKC, override?: string): Promise<string> {
  if (override) return override;
  if (ctx.vaultPath) return ctx.vaultPath;
  return (await resolveVault(ctx.cwd)).path;
}

export interface ZkRetrieveArgs {
  tags?: string[];
  query?: string;
  topK?: number;
  folder?: string;
  trace?: boolean;
  /** Override the semantic-embed blend (default true; set false for pure lexical). */
  semantic?: boolean;
  /** Render tier (ticket 07 ladder): "abstract" (L0, default) | "overview"
   *  (L1, detail) | "full" (L2, explicit). Selects the pre-rendered tier text
   *  in each card's `detail` + the digest; overflow demotes, never truncates. */
  tier?: "abstract" | "overview" | "full";
}

/**
 * Build the RetrieveOptions from adapter args. Exported so a parity test can
 * call retrieveRecords with the EXACT opts the adapter uses (DRY + honest).
 * Defaults mirror the `knowledge_query` tool (bodyMatch + slugDom + semantic),
 * which measured 1.00 hit-rate@4 on the 25-query eval.
 */
export function buildRetrieveOptions(args: ZkRetrieveArgs, vaultPath: string): RetrieveOptions {
  return {
    vaultPath,
    folder: args.folder ?? "Zettelkasten/knowledge-graph",
    tags: args.tags ?? [],
    topK: args.topK ?? 10,
    tier: args.tier ?? "abstract",
    bodyMatch: true,
    slugDom: true,
    semantic: args.semantic ?? true,
    queryText: args.query ?? "",
    includeTrace: args.trace === true,
  };
}

/** zk.retrieve — wraps retrieveRecords (the knowledge_query / zk-query path). */
export async function zkRetrieve(args: ZkRetrieveArgs, ctx: HostFnCtxKC): Promise<RetrieveResult> {
  const vaultPath = await vaultOf(ctx);
  return retrieveRecords(buildRetrieveOptions(args, vaultPath));
}

export interface ZkIngestArgs {
  files?: string[];
  dir?: string;
  source?: SourceFamily;
  folder?: string;
  dryRun?: boolean;
  vault?: string;
}

/** zk.ingest — wraps the zk_ingest tool's library path (no LLM). */
export async function zkIngest(args: ZkIngestArgs, ctx: HostFnCtxKC) {
  const vaultPath = await vaultOf(ctx, args.vault);
  const inputs = [...(args.files ?? []), ...(args.dir ? [args.dir] : [])];
  const source: SourceFamily = args.source ?? "workflow-jsonl";
  const { files } = collectInputFiles(inputs, { source, cwd: ctx.cwd });
  const records: KnowledgeRecord[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, "utf8");
    if (source === "hermes") {
      records.push(...adaptHermesMarkdown(content));
    } else if (source === "auto-memory") {
      const r = adaptAutoMemoryMarkdown(content);
      if (r) records.push(r);
    } else if (source === "generic") {
      const r = adaptGenericMarkdown(content, abs);
      if (r) records.push(r);
    } else {
      records.push(...parseKnowledgeJsonl(content).records);
    }
  }
  const sourceLabel = `${source}:${files[0]?.split("/").pop()?.replace(/\.(knowledge\.jsonl|md)$/, "") ?? ""}`;
  return ingestRecords(records, {
    vaultPath,
    source,
    sourceLabel,
    folder: args.folder,
    dryRun: args.dryRun === true,
  });
}

export interface ZkHealthArgs {
  folder?: string;
  fix?: boolean;
  /** When true, compute the coverage dimension (missing / sourceOrphaned per
   *  family) and attach it to health.coverage. Uses args.sources if given, else
   *  the watch-list (loadWatchlist). */
  coverage?: boolean;
  /** Source specs to check (unparsed dirs/files per family). Omit → watch-list. */
  sources?: SourceSpec[];
}

/** zk.health — wraps graphHealth (and healGraph first when fix:true). When
 *  coverage:true, also runs coverageReport and attaches it to health.coverage. */
export async function zkHealth(
  args: ZkHealthArgs,
  ctx: HostFnCtxKC,
): Promise<{ health: GraphHealthResult; text: string }> {
  const vaultPath = await vaultOf(ctx);
  const folder = args.folder ?? "Zettelkasten/knowledge-graph";
  const opts = { vaultPath, folder };
  if (args.fix) await healGraph(opts);
  const health = await graphHealth(opts);
  if (args.coverage) {
    const specs = args.sources ?? loadWatchlist(ctx.cwd);
    const sources = await resolveSpecsToRecords(specs, ctx.cwd);
    // Skip gracefully when no configured source resolves (e.g. dev worktree with
    // no watch-list dirs) — coverage stays undefined rather than reporting vacuous zeros.
    if (sources.length) {
      health.coverage = await coverageReport({ vaultPath, folder, sources });
    }
  }
  return { health, text: formatHealth(health) };
}

export interface ZkHealArgs {
  folder?: string;
}

/** zk.heal — wraps healGraph (granular alias of zk.health({fix:true})). */
export async function zkHeal(args: ZkHealArgs, ctx: HostFnCtxKC): Promise<HealResult> {
  const vaultPath = await vaultOf(ctx);
  return healGraph({ vaultPath, folder: args.folder ?? "Zettelkasten/knowledge-graph" });
}
