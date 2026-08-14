/**
 * SurrealMemoryRepository — implements MemoryRepository against a local
 * SurrealDB server via SurrealClient. Mirrors SqliteMemoryRepository's
 * semantics (dedup identity = target+project+category+content; LIKE-style
 * matching for replace/remove; FTS @@ with a string::contains fallback).
 *
 * The DTO `id: number` is stored as the integer field `seq`; record keys are
 * Surreal's native random ids. Records are addressed by `WHERE seq = $id`.
 * No corruption layer — transient retry lives in SurrealClient.
 *
 * Note on null matching: SurrealDB v3.2.3 matches stored NULLs with the
 * `IS NULL` operator (verified live). The `IS NONE` form returns no rows
 * for a stored NULL, so it MUST NOT be used here.
 */

import type { SurrealBackend } from "./surreal-backend.js";
import type {
  MemoryRepository, MemoryEntry, MemorySyncInput, MemorySyncResult,
  MemoryUpdateResult, MemoryRemoveResult, MemoryRemoveOptions,
  MemorySearchOptions, MemoryListOptions, MemoryStats, MemoryTarget,
} from "../repository.js";
import type { MemoryCategory, FailureState } from "../../types.js";
import { today, normalizeNullable, normalizeCategory } from "../memory-format.js";
import { normalizeMemoryLookupText } from "../memory-lookup.js";
import { rankMemoryEntries } from "../graph-ranker.js";

/** Max graph neighbors fetched to augment a lexical search (before ranking). */
const GRAPH_NEIGHBOR_CAP = 20;

/** Keep the earliest of two YYYY-MM-DD strings. Mirrors sqlite helper. */
function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Keep the latest of two YYYY-MM-DD strings. Mirrors sqlite helper. */
function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Escape a string into a SurrealDB double-quoted string literal. */
function sqlStr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * A SurrealDB backtick record-id literal for a `tag` row keyed by `key`. Real
 * tag values (project/category/target enums + project names) never contain
 * backticks; strip defensively so a pathological value can never break out of
 * the record-id literal.
 */
function tagRecordLiteral(key: string): string {
  return "`" + key.replace(/`/g, "") + "`";
}

type Row = Partial<{
  seq: number; project: string | null; target: string; category: string | null;
  content: string; failureReason: string | null; toolState: string | null;
  correctedTo: string | null; created: string; lastReferenced: string;
  mwSuccess?: number; mwFail?: number;
  status?: string; supersedes?: number | null; supersededBy?: number | null;
  parentIds?: unknown;
  mdId?: string | null;
  state?: string | null;
  severity?: number | null;
  pin?: boolean;
}>;

function mapRow(r: Row): MemoryEntry {
  return {
    id: Number(r.seq),
    project: r.project ?? null,
    target: (r.target ?? "memory") as MemoryTarget,
    category: (r.category ?? null) as MemoryCategory | null,
    content: r.content ?? "",
    failureReason: r.failureReason ?? null,
    toolState: r.toolState ?? null,
    correctedTo: r.correctedTo ?? null,
    created: r.created ?? today(),
    lastReferenced: r.lastReferenced ?? r.created ?? today(),
    mwSuccess: r.mwSuccess ?? 0,
    mwFail: r.mwFail ?? 0,
    status: ((r.status as "active" | "superseded") ?? "active"),
    supersedes: r.supersedes ?? null,
    supersededBy: r.supersededBy ?? null,
    parentIds: Array.isArray(r.parentIds) ? (r.parentIds as unknown[]).map(Number) : [],
    mdId: r.mdId ?? null,
    state: (r.state as FailureState) ?? "active",
    severity: r.severity ?? null,
    // Pin (ticket 02): stored as a bool; surface as `true` only when pinned,
    // else omit (absent === unpinned, matching the frontmatter + SQLite contract).
    ...(r.pin === true ? { pin: true } : {}),
  };
}

const FIELDS = "seq, project, target, category, content, failureReason, toolState, correctedTo, created, lastReferenced, mwSuccess, mwFail, status, supersedes, supersededBy, parentIds, mdId, state, severity, pin";

// ---------------------------------------------------------------------------
// Batched-sync helpers (shared by syncMemoryEntry → syncMemoryEntriesBatch).
// Pure statement builders: single + batch share ONE implementation because the
// single path delegates to the batch. All use per-representative param/var
// prefixes (a SINGLE `$param` namespace spans the whole batched request).
// ---------------------------------------------------------------------------

/** A MemorySyncInput after the exact normalization the old single path did. */
interface NormalizedSyncInput {
  content: string;
  target: MemoryTarget;
  project: string | null;
  category: MemoryCategory | null;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  created: string;
  lastReferenced: string;
  mwSuccess: number;
  mwFail: number;
  /** Stable markdown-side id to mirror (Task 7). null when the caller omitted it. */
  mdId: string | null;
  /** Failure lifecycle state (Task 4 of hermes-failure-lifecycle). */
  state: FailureState;
  /** Advisory failure severity (1–3); null when the caller omitted it. */
  severity: number | null;
  /** Pin lock (ticket 02); strict boolean. */
  pin: boolean;
}

/** Normalize a raw sync input exactly as the old single syncMemoryEntry did. */
function normalizeSyncInput(input: MemorySyncInput): NormalizedSyncInput {
  const created = input.created?.trim() || today();
  return {
    content: input.content.trim(),
    target: (input.target ?? "memory") as MemoryTarget,
    project: normalizeNullable(input.project),
    category: normalizeCategory(input.category),
    failureReason: normalizeNullable(input.failureReason),
    toolState: normalizeNullable(input.toolState),
    correctedTo: normalizeNullable(input.correctedTo),
    created,
    lastReferenced: input.lastReferenced?.trim() || created,
    mwSuccess: input.mwSuccess ?? 0,
    mwFail: input.mwFail ?? 0,
    mdId: input.mdId && input.mdId.length > 0 ? input.mdId : null,
    state: input.state ?? "active",
    severity: input.severity ?? null,
    pin: input.pin === true,
  };
}

/** Dedup identity mirroring syncMemoryEntry's SELECT scope (target/project/
 *  category) + exact content. Two inputs with the same key resolve to the
 *  same stored row. */
function dedupKey(n: NormalizedSyncInput): string {
  return `${n.target}|${n.project ?? ""}|${n.category ?? ""}|${n.content}`;
}

/** True iff a stored row matches a normalized input's dedup scope exactly
 *  (null-aware). Used to map pre-fetched / trailing-SELECT rows back to inputs. */
function rowMatchesInput(r: Row, n: NormalizedSyncInput): boolean {
  if ((r.content ?? "") !== n.content) return false;
  if ((r.target ?? "memory") !== n.target) return false;
  if ((r.project ?? null) !== n.project) return false;
  if ((r.category ?? null) !== n.category) return false;
  return true;
}

/** Computed merge values for the UPDATE path (keep earliest created, latest
 *  lastReferenced, preserve existing non-null optionals). Mirrors the old
 *  single-path merge exactly. */
interface MergeValues {
  created: string;
  lastReferenced: string;
  category: MemoryCategory | null;
  failureReason: string | null;
  toolState: string | null;
  correctedTo: string | null;
  /** Task 7 / F1: the input's birth id; when present, overwrites the existing
   *  row's mdId (orphan-readd). Absent → the existing mdId is preserved. */
  mdId?: string | null;
  /** Failure lifecycle state mirrored onto the row (Task 4). Defaults `active`. */
  state: FailureState;
  /** Advisory failure severity mirrored onto the row (Task 4). */
  severity: number | null;
  /** Pin lock mirrored onto the row (ticket 02); strict boolean. */
  pin: boolean;
}

/** The implicit-tag set whose graph edges a memory owns (project/category/
 *  target). For existing rows the caller derives this from the refreshed row
 *  (single path re-fetches); for new rows from the input. */
interface TagScope { project: string | null; category: MemoryCategory | null; target: MemoryTarget; }

/** Build the ONE-statement pre-fetch SELECT (big OR over every rep's dedup
 *  scope) + its params. NULL-aware per rep (IS NULL vs = $x). Returns all
 *  matches ORDER BY seq ASC so the caller can pick the lowest-seq row per key
 *  (mirrors the single path's LIMIT 1 ORDER BY seq ASC). */
function buildPrefetchSelect(
  reps: Array<{ i: number; n: NormalizedSyncInput }>,
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const disjuncts = reps.map(({ n }, idx) => {
    const p = `p${idx}`;
    const conds = [`target = $tg_${p}`, `content = $ct_${p}`];
    params[`tg_${p}`] = n.target;
    params[`ct_${p}`] = n.content;
    if (n.project === null) conds.push("project IS NULL");
    else { conds.push(`project = $pj_${p}`); params[`pj_${p}`] = n.project; }
    if (n.category === null) conds.push("category IS NULL");
    else { conds.push(`category = $ca_${p}`); params[`ca_${p}`] = n.category; }
    return `(${conds.join(" AND ")})`;
  });
  return {
    sql: `SELECT ${FIELDS} FROM memories WHERE ${disjuncts.join(" OR ")} ORDER BY seq ASC;`,
    params,
  };
}

/** Append the UPDATE-merge statements for one existing representative to
 *  `stmts`/`params`. Binds `$seq_<p>` so the trailing SELECT + graph edges can
 *  reference the same seq. */
function buildMergeStatements(
  p: string,
  seq: number,
  merge: MergeValues,
  params: Record<string, unknown>,
): string[] {
  params[`seq_${p}`] = seq;
  params[`ca_${p}`] = merge.category;
  params[`fr_${p}`] = merge.failureReason;
  params[`ts_${p}`] = merge.toolState;
  params[`cto_${p}`] = merge.correctedTo;
  params[`cr_${p}`] = merge.created;
  params[`lr_${p}`] = merge.lastReferenced;
  params[`st_${p}`] = merge.state;
  params[`sv_${p}`] = merge.severity;
  params[`pn_${p}`] = merge.pin;
  // Task 7 / F1: stamp the birth id when the caller carried one (orphan-readd);
  // omit the clause entirely when absent so the existing mdId is preserved.
  const mdIdClause = merge.mdId
    ? (params[`mdi_${p}`] = merge.mdId, `, mdId = $mdi_${p}`)
    : "";
  return [
    `UPDATE memories SET category = $ca_${p}, failureReason = $fr_${p}, toolState = $ts_${p}, correctedTo = $cto_${p}, created = $cr_${p}, lastReferenced = $lr_${p}, state = $st_${p}, severity = $sv_${p}, pin = $pn_${p}${mdIdClause} WHERE seq = $seq_${p};`,
  ];
}

/** Append the CREATE-insert statements for one new representative. Allocates
 *  a distinct seq inside the tx (`LET $n_<p>`) and binds every column. The
 *  `$n_<p>` var is reused by the graph edges + the trailing SELECT. */
function buildInsertStatements(
  p: string,
  n: NormalizedSyncInput,
  params: Record<string, unknown>,
): string[] {
  params[`pj_${p}`] = n.project;
  params[`tg_${p}`] = n.target;
  params[`ca_${p}`] = n.category;
  params[`ct_${p}`] = n.content;
  params[`fr_${p}`] = n.failureReason;
  params[`ts_${p}`] = n.toolState;
  params[`cto_${p}`] = n.correctedTo;
  params[`cr_${p}`] = n.created;
  params[`lr_${p}`] = n.lastReferenced;
  params[`mws_${p}`] = n.mwSuccess;
  params[`mwf_${p}`] = n.mwFail;
  params[`mdi_${p}`] = n.mdId;
  params[`st_${p}`] = n.state;
  params[`sv_${p}`] = n.severity;
  params[`pn_${p}`] = n.pin;
  return [
    `LET $n_${p} = (UPDATE seq:memory SET value += 1 RETURN VALUE value)[0];`,
    `CREATE type::record("memories", $n_${p}) SET seq = $n_${p}, project = $pj_${p}, target = $tg_${p}, category = $ca_${p}, content = $ct_${p}, failureReason = $fr_${p}, toolState = $ts_${p}, correctedTo = $cto_${p}, created = $cr_${p}, lastReferenced = $lr_${p}, mwSuccess = $mws_${p}, mwFail = $mwf_${p}, status = 'active', supersedes = NONE, supersededBy = NONE, parentIds = [], mdId = $mdi_${p}, state = $st_${p}, severity = $sv_${p}, pin = $pn_${p};`,
  ];
}

/** Append the graph-edge statements for one representative: clear existing
 *  outgoing `tagged` edges, then UPSERT each tag node + RELATE. Uses the
 *  LET-var RELATE trick (`LET $m = type::record(…); RELATE $m->tagged->$tag;`)
 *  because RELATE rejects `type::record()` inline. `seqRef` is either `$n_<p>`
 *  (new) or `$seq_<p>` (existing) — both are batch-namespace vars. The DELETE
 *  is a harmless no-op for brand-new rows (no prior edges) and keeps the
 *  builder uniform across both branches. */
function buildGraphEdgeStatements(
  p: string,
  tagScope: TagScope,
  params: Record<string, unknown>,
  seqRef: string,
): string[] {
  const tags: Array<{ key: string; kind: string; value: string }> = [];
  if (tagScope.project != null) tags.push({ key: `project:${tagScope.project}`, kind: "project", value: tagScope.project });
  if (tagScope.category != null) tags.push({ key: `category:${tagScope.category}`, kind: "category", value: tagScope.category });
  if (tagScope.target != null) tags.push({ key: `target:${tagScope.target}`, kind: "target", value: tagScope.target });
  const stmts: string[] = [
    `LET $m_${p} = type::record("memories", ${seqRef});`,
    `DELETE FROM tagged WHERE in = $m_${p};`,
  ];
  tags.forEach((t, ti) => {
    const tp = `tg_${p}_${ti}`;
    params[`k_${tp}`] = t.key;
    params[`kd_${tp}`] = t.kind;
    params[`vd_${tp}`] = t.value;
    stmts.push(
      `LET $tag_${tp} = type::record("tag", $k_${tp});`,
      `UPSERT $tag_${tp} SET key = $k_${tp}, kind = $kd_${tp}, value = $vd_${tp};`,
      `RELATE $m_${p}->tagged->$tag_${tp};`,
    );
  });
  return stmts;
}

/** Build SurrealQL WHERE fragments + a params object for scope conditions. */
function buildScope(
  target?: MemoryTarget, project?: string | null, category?: MemoryCategory | null,
  includeSuperseded = true,
): { where: string; params: Record<string, unknown> } {
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  // Supersession UX: hide superseded entries unless the caller opts in. The
  // default `true` (no filter) preserves the mutation paths' current behavior
  // (sync/replace/remove must see every row regardless of status); ONLY the
  // read/recall paths (searchMemories, fetchGraphNeighbors) pass `false`.
  // SCHEMALESS-robust: `status != 'superseded'` (NOT `status = 'active'`) so
  // pre-feature rows that lack the field (absent) are treated as active,
  // mirroring mapRow's `r.status ?? "active"` coalescing. SQLite's table has
  // a DEFAULT 'active' so it can use the strict `= 'active'` equality; the
  // SCHEMALESS store cannot.
  if (!includeSuperseded) { conds.push("status != 'superseded'"); }
  if (target) { conds.push("target = $target"); params.target = target; }
  if (project !== undefined) {
    // v3.2.3 matches stored NULL via `IS NULL` (NOT `IS NONE`).
    if (project === null) { conds.push("project IS NULL"); }
    else { conds.push("project = $project"); params.project = project; }
  }
  if (category !== undefined) {
    if (category === null) { conds.push("category IS NULL"); }
    else { conds.push("category = $category"); params.category = category; }
  }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

export class SurrealMemoryRepository implements MemoryRepository {
  constructor(private readonly backend: SurrealBackend) {}

  private get c() { return this.backend.client; }

  async addMemory(input: {
    content: string; target?: MemoryTarget; project?: string | null;
    category?: MemoryCategory | null; failureReason?: string | null;
    toolState?: string | null; correctedTo?: string | null;
    created?: string; lastReferenced?: string;
    mdId?: string | null;
    state?: FailureState; severity?: number | null;
    pin?: boolean;
  }): Promise<MemoryEntry> {
    // C6: exact-dup dedup is part of the MemoryRepository contract — mirror
    // the sync path's identity (target + project + category + content, exact
    // equality, NULL-aware) before CREATE. Hit → return the EXISTING row; no
    // duplicate is written (the existing row's graph edges stay untouched).
    const dedupScope = buildScope(
      input.target ?? "memory",
      input.project ?? null,
      input.category ?? null,
    );
    const dup = (await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories ${dedupScope.where}${dedupScope.where ? " AND" : " WHERE"} content = $content ORDER BY seq ASC LIMIT 1;`,
      { ...dedupScope.params, content: input.content },
    ))[0];
    if (dup) return mapRow(dup);

    const created = input.created ?? today();
    const lastReferenced = input.lastReferenced ?? created;
    // Task 7 / F1: stamp the stable id at birth (NONE when the caller omitted it).
    const mdId = input.mdId && input.mdId.length > 0 ? input.mdId : null;
    // Pin (ticket 02): strict boolean — only literal `true` writes `true`.
    const pin = input.pin === true;
    const sql = `
      LET $next = (UPDATE seq:memory SET value += 1 RETURN VALUE value)[0];
      CREATE type::record("memories", $next) SET
        seq = $next,
        project = $project,
        target = $target,
        category = $category,
        content = $content,
        failureReason = $failureReason,
        toolState = $toolState,
        correctedTo = $correctedTo,
        created = $created,
        lastReferenced = $lastReferenced,
        mwSuccess = 0,
        mwFail = 0,
        status = 'active',
        supersedes = NONE,
        supersededBy = NONE,
        parentIds = [],
        mdId = $mdId,
        state = $state,
        severity = $severity,
        pin = $pin
      RETURN ${FIELDS};
    `;
    const rows = await this.c.query<Row[]>(sql, {
      project: input.project ?? null,
      target: input.target ?? "memory",
      category: input.category ?? null,
      content: input.content,
      failureReason: input.failureReason ?? null,
      toolState: input.toolState ?? null,
      correctedTo: input.correctedTo ?? null,
      created,
      lastReferenced,
      mdId,
      state: input.state ?? "active",
      severity: input.severity ?? null,
      pin,
    });
    const entry = mapRow(rows[0]);
    await this.syncGraphEdges(
      Number(entry.id),
      input.project ?? null,
      input.category ?? null,
      input.target ?? "memory",
    );
    return entry;
  }

  // The single entry path delegates to the batch with one input: there is ONE
  // sync implementation (the batched transaction), so single + batch can never
  // diverge. The batch collapses N per-entry HTTP round-trips into ONE
  // pre-fetch SELECT + ONE transaction (≤2 round-trips for any N).
  async syncMemoryEntry(input: MemorySyncInput): Promise<MemorySyncResult> {
    const [result] = await this.syncMemoryEntriesBatch([input]);
    return result;
  }

  /**
   * Sync N entries in ≤2 HTTP round-trips:
   *   1. ONE pre-fetch SELECT (big OR over every input's dedup scope) →
   *      classify each input as existing (capture seq + merge values) or new.
   *   2. ONE `BEGIN TRANSACTION … COMMIT TRANSACTION` script that runs the
   *      per-entry UPDATE-or-CREATE + graph-edge statements for ALL inputs,
   *      trailed by a `SELECT … WHERE seq IN […]` whose result `query()`
   *      returns (it always returns the LAST statement in a batch).
   * The 5c `supersedeMemory` precedent proves the BEGIN…COMMIT-in-one-query
   * pattern; the per-entry builders below are shared with nothing else
   * because the single path routes through here.
   *
   * SurrealDB v3 has NO usable `IF … END` statement form in a batched /sql
   * request (parse error on `END`), so the existing-vs-new branch is resolved
   * in TS from the pre-fetch — the transaction body is pure unconditional
   * statements, one shape per branch. Graph edges reuse the LET-var RELATE
   * trick from the single `syncGraphEdges` (`LET $m = type::record(…);
   * RELATE $m->tagged->$tag;`) because RELATE rejects `type::record()` inline.
   */
  async syncMemoryEntriesBatch(inputs: MemorySyncInput[]): Promise<MemorySyncResult[]> {
    if (inputs.length === 0) return [];

    // Normalize every input once (mirrors the old single-path normalization).
    const norm = inputs.map((input, i) => ({ i, n: normalizeSyncInput(input) }));

    // Intra-batch dedup: preserve order, keep the FIRST occurrence per dedup
    // key as the representative, alias the rest. This mirrors N sequential
    // `syncMemoryEntry` calls (the 2nd same-key call finds the 1st's row).
    const reps: Array<{ i: number; n: NormalizedSyncInput }> = [];
    const keyToRepIdx = new Map<string, number>();
    const aliasToRepIdx: number[] = []; // by original input index → reps index
    for (const { i, n } of norm) {
      const key = dedupKey(n);
      const existing = keyToRepIdx.get(key);
      if (existing !== undefined) {
        aliasToRepIdx[i] = existing;
      } else {
        const repIdx = reps.length;
        reps.push({ i, n });
        keyToRepIdx.set(key, repIdx);
        aliasToRepIdx[i] = repIdx;
      }
    }

    // ── Round 1: pre-fetch existing rows for every representative (1 query) ──
    const existingByRep = new Map<number, Row>(); // repIdx → lowest-seq row
    if (reps.length > 0) {
      const { sql, params } = buildPrefetchSelect(reps);
      const rows = await this.c.query<Row[]>(sql, params);
      // ORDER BY seq ASC at the DB; per key keep the first (lowest seq) match —
      // mirrors the single path's `ORDER BY seq ASC LIMIT 1`.
      for (const r of rows) {
        const n = reps.find(({ n }) => rowMatchesInput(r, n));
        if (!n) continue;
        const key = dedupKey(n.n);
        const repIdx = keyToRepIdx.get(key)!;
        if (!existingByRep.has(repIdx)) existingByRep.set(repIdx, r);
      }
    }

    // ── Classify each representative as existing (UPDATE) or new (CREATE) ──
    type Plan =
      | { kind: "existing"; repIdx: number; seq: number; merge: MergeValues; tagScope: TagScope }
      | { kind: "new"; repIdx: number; n: NormalizedSyncInput; tagScope: TagScope };
    const plans: Plan[] = [];
    for (let repIdx = 0; repIdx < reps.length; repIdx++) {
      const { n } = reps[repIdx];
      const ex = existingByRep.get(repIdx);
      if (ex) {
        const seq = Number(ex.seq);
        const merge: MergeValues = {
          created: minDate(ex.created ?? n.created, n.created),
          lastReferenced: maxDate(ex.lastReferenced ?? n.lastReferenced, n.lastReferenced),
          category: (ex.category as MemoryCategory | null) ?? n.category,
          failureReason: ex.failureReason ?? n.failureReason,
          toolState: ex.toolState ?? n.toolState,
          correctedTo: ex.correctedTo ?? n.correctedTo,
          mdId: n.mdId,
          state: n.state,
          severity: n.severity,
          pin: n.pin,
        };
        // Graph edges use the refreshed row's tags (single path re-fetches):
        // project/target are untouched by the merge UPDATE, category = merged.
        const tagScope: TagScope = {
          project: ex.project ?? null,
          category: merge.category,
          target: (ex.target ?? "memory") as MemoryTarget,
        };
        plans.push({ kind: "existing", repIdx, seq, merge, tagScope });
      } else {
        plans.push({
          kind: "new",
          repIdx,
          n,
          tagScope: { project: n.project, category: n.category, target: n.target },
        });
      }
    }

    // ── Round 2: ONE batched transaction + trailing SELECT (1 query) ──
    const stmts: string[] = ["BEGIN TRANSACTION;"];
    const params: Record<string, unknown> = {};
    // Per-rep seq reference for the final SELECT IN-list: a `$n_<rep>` var for
    // new reps (allocated inside the tx) or a `$seq_<rep>` param for existing.
    const seqRefs: string[] = [];
    for (const plan of plans) {
      const p = `p${plan.repIdx}`; // unique param/var prefix per representative
      if (plan.kind === "existing") {
        stmts.push(...buildMergeStatements(p, plan.seq, plan.merge, params));
        seqRefs.push(`$seq_${p}`);
      } else {
        stmts.push(...buildInsertStatements(p, plan.n, params));
        seqRefs.push(`$n_${p}`);
      }
      stmts.push(...buildGraphEdgeStatements(p, plan.tagScope, params, plan.kind === "new" ? `$n_${p}` : `$seq_${p}`));
    }
    stmts.push("COMMIT TRANSACTION;");
    // Trailing SELECT: `query()` returns the LAST statement, so this hands back
    // every affected row in the SAME round-trip as the mutation.
    stmts.push(`SELECT ${FIELDS} FROM memories WHERE seq IN [${seqRefs.join(", ")}];`);

    const rows = await this.c.query<Row[]>(stmts.join("\n"), params);
    const rowBySeq = new Map<number, Row>();
    for (const r of rows) rowBySeq.set(Number(r.seq), r);

    // ── Build per-representative results, then replicate to aliases ──
    const repResults: MemorySyncResult[] = plans.map((plan) => {
      const seq = plan.kind === "existing" ? plan.seq : undefined;
      // For new reps the seq is unknown in TS; find the row whose content matches.
      let row: Row | undefined;
      if (seq !== undefined) row = rowBySeq.get(seq);
      if (!row) {
        const n = plan.kind === "existing" ? reps[plan.repIdx].n : plan.n;
        row = rows.find((r) => rowMatchesInput(r, n));
      }
      if (!row) {
        // Should not happen: the trailing SELECT covers every seq we touched.
        throw new Error("syncMemoryEntriesBatch: trailing SELECT missed a synced entry");
      }
      return { action: plan.kind === "existing" ? "existing" as const : "inserted" as const, entry: mapRow(row) };
    });

    // Map representatives back to input order; aliases inherit their rep's
    // result as "existing" (the rep's row now exists).
    const results: MemorySyncResult[] = new Array(inputs.length);
    for (let origIdx = 0; origIdx < inputs.length; origIdx++) {
      const repIdx = aliasToRepIdx[origIdx];
      const repRes = repResults[repIdx];
      results[origIdx] = (origIdx === reps[repIdx].i)
        ? repRes
        : { action: "existing", entry: repRes.entry };
    }
    return results;
  }

  async replaceSyncedMemories(oldText: string, updates: {
    content: string; target: MemoryTarget; project?: string | null;
    category?: MemoryCategory | null; failureReason?: string | null;
    toolState?: string | null; correctedTo?: string | null; lastReferenced?: string | null;
    mdId?: string | null;
    state?: FailureState | null; severity?: number | null;
    pin?: boolean;
  }): Promise<MemoryUpdateResult> {
    const normalizedOldText = normalizeMemoryLookupText(oldText);
    if (!normalizedOldText) return { matched: 0, updated: 0, entries: [] };
    const scope = buildScope(updates.target, updates.project ?? undefined);
    const nextLastReferenced = updates.lastReferenced?.trim() || today();
    // Task 7 / F1: stamp the replacement's fresh uuid onto the updated row's
    // mdId when the caller carried it; omit the clause when absent.
    const birthMdId = updates.mdId && updates.mdId.length > 0 ? updates.mdId : null;
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old) ORDER BY seq ASC;`,
      { ...scope.params, old: normalizedOldText },
    );
    if (rows.length === 0) return { matched: 0, updated: 0, entries: [] };
    const entries: MemoryEntry[] = [];
    for (const r of rows) {
      const seq = Number(r.seq);
      const mdIdClause = birthMdId !== null ? `, mdId = $mdId` : "";
      await this.c.query(
        `UPDATE memories SET content = $content, category = $category, failureReason = $failureReason, toolState = $toolState, correctedTo = $correctedTo, lastReferenced = $lastReferenced, state = $state, severity = $severity, pin = $pin${mdIdClause} WHERE seq = $seq;`,
        {
          seq,
          content: updates.content.trim(),
          category: updates.category === undefined ? r.category : normalizeNullable(updates.category),
          failureReason: updates.failureReason === undefined ? r.failureReason : normalizeNullable(updates.failureReason),
          toolState: updates.toolState === undefined ? r.toolState : normalizeNullable(updates.toolState),
          correctedTo: updates.correctedTo === undefined ? r.correctedTo : normalizeNullable(updates.correctedTo),
          lastReferenced: nextLastReferenced,
          // Task 4 gap-fix: carry state/severity through the replace UPDATE.
          // Inherit the row's prior state when `updates.state` is undefined
          // (coalesce SCHEMALESS-absent → "active"); else use the supplied value.
          state: updates.state === undefined ? ((r.state as FailureState) ?? "active") : (updates.state ?? "active"),
          severity: updates.severity === undefined ? (r.severity ?? null) : (updates.severity ?? null),
          // Pin (ticket 02): inherit the row's prior pin when `updates.pin` is
          // undefined (coalesce SCHEMALESS-absent → false); else stamp strictly.
          pin: updates.pin === undefined ? (r.pin === true) : (updates.pin === true),
          ...(birthMdId !== null ? { mdId: birthMdId } : {}),
        },
      );
      // Re-fetch by seq so returned entries reflect the NEW content (sqlite
      // does getMemoryById(row.id) per row post-update).
      const refreshed = (await this.c.query<Row[]>(`SELECT ${FIELDS} FROM memories WHERE seq = $seq;`, { seq }))[0];
      if (refreshed) {
        entries.push(mapRow(refreshed));
        await this.syncGraphEdges(seq, refreshed.project ?? null, (refreshed.category ?? null) as MemoryCategory | null, (refreshed.target ?? "memory") as MemoryTarget);
      }
    }
    return { matched: rows.length, updated: rows.length, entries };
  }

  async removeSyncedMemories(oldText: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    const normalizedOldText = normalizeMemoryLookupText(oldText);
    if (!normalizedOldText) return { matched: 0, removed: 0 };
    const scope = buildScope(options.target, options.project ?? undefined);
    const matched = await this.c.query<Row[]>(
      `SELECT seq FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old);`,
      { ...scope.params, old: normalizedOldText },
    );
    if (matched.length === 0) return { matched: 0, removed: 0 };
    await this.c.query(`DELETE FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} string::contains(content, $old);`, { ...scope.params, old: normalizedOldText });
    return { matched: matched.length, removed: matched.length };
  }

  /** @deprecated backfill-only — use {@link removeByMdId} in steady state. */
  async removeExactSyncedMemories(content: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    const scope = buildScope(options.target, options.project ?? undefined);
    const matched = await this.c.query<Row[]>(
      `SELECT seq FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content;`,
      { ...scope.params, content: content.trim() },
    );
    if (matched.length === 0) return { matched: 0, removed: 0 };
    await this.c.query(`DELETE FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content;`, { ...scope.params, content: content.trim() });
    return { matched: matched.length, removed: matched.length };
  }

  async removeByMdId(mdId: string, options: MemoryRemoveOptions): Promise<MemoryRemoveResult> {
    const scope = buildScope(options.target, options.project ?? undefined);
    const matched = await this.c.query<Array<{ id: string }>>(
      `SELECT id FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} mdId = $mdId;`,
      { ...scope.params, mdId },
    );
    if (matched.length === 0) return { matched: 0, removed: 0 };
    await this.c.query(`DELETE FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} mdId = $mdId;`, { ...scope.params, mdId });
    return { matched: matched.length, removed: matched.length };
  }

  async getMdIdByContent(content: string, options: MemoryRemoveOptions): Promise<string | null> {
    const scope = buildScope(options.target, options.project ?? undefined);
    const rows = await this.c.query<Array<{ mdId?: string | null }>>(
      `SELECT mdId FROM memories ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content LIMIT 1;`,
      { ...scope.params, content: content.trim() },
    );
    return rows[0]?.mdId ?? null;
  }

  async setMdIdByContent(content: string, mdId: string, options: MemoryRemoveOptions): Promise<number> {
    // `UPDATE memories SET ... WHERE ...` (mirrors replaceSyncedMemories) updates
    // every matching row and returns them; `res.length` is the rows-updated count.
    // The brief's `type::thing("memories", "seq")` form targets a single record
    // id (`memories:seq`), which would not match the scope/content predicate, so
    // the plain-table form (the repo's established UPDATE pattern) is used.
    const scope = buildScope(options.target, options.project ?? undefined);
    const res = await this.c.query<Array<{ id: string }>>(
      `UPDATE memories SET mdId = $mdId ${scope.where ? `${scope.where} AND` : "WHERE"} content = $content;`,
      { ...scope.params, mdId, content: content.trim() },
    );
    return res.length;
  }

  async searchMemories(query: string, options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    if (query.trim().length === 0) return [];
    const { project, target, category, limit = 10, includeSuperseded = false } = options;
    const scope = buildScope(target, project, category, includeSuperseded);
    const tail = `ORDER BY lastReferenced DESC LIMIT ${Number(limit)};`;
    const where = scope.where ? `${scope.where.replace("WHERE ", "")} AND` : "";

    // Lexical match: FTS @@ with a string::contains fallback.
    let lexicalRows: Row[] = [];
    try {
      lexicalRows = await this.c.query<Row[]>(
        `SELECT ${FIELDS} FROM memories WHERE ${where} content @@ $q ${tail}`,
        { ...scope.params, q: query },
      );
    } catch { /* fall through to contains fallback */ }
    if (lexicalRows.length === 0) {
      lexicalRows = await this.c.query<Row[]>(
        `SELECT ${FIELDS} FROM memories WHERE ${where} string::contains(content, $q) ${tail}`,
        { ...scope.params, q: query },
      );
    }
    if (lexicalRows.length === 0) return [];
    const lexicalResults = lexicalRows.map(mapRow);

    // Graph augmentation: neighbors sharing an implicit tag with the seeds,
    // ranked together by the shared backend-neutral ranker.
    const neighbors = await this.fetchGraphNeighbors(lexicalResults, { project, target, category, includeSuperseded });
    if (neighbors.length === 0) {
      // Close the no-neighbor fast path: route single-match / no-shared-
      // neighbor searches through the shared ranker so the worth multiplier
      // applies (instead of raw lastReferenced DESC). Neighbors stay empty
      // here — the ranker simply re-orders the lexical set by recency + worth.
      return rankMemoryEntries({
        candidates: lexicalResults,
        lexicalMatchIds: new Set(lexicalResults.map((m) => m.id)),
        limit,
      });
    }

    return rankMemoryEntries({
      candidates: [...lexicalResults, ...neighbors],
      lexicalMatchIds: new Set(lexicalResults.map((m) => m.id)),
      limit,
    });
  }

  /**
   * Fetch graph neighbors via SurrealDB RELATE traversal: memories pointing
   * (via `tagged` edges) at any tag node shared with the seed set, excluding
   * the seeds, within the same search scope, capped. Mirrors the SQLite
   * column-equality neighbor fetch through the shared ranker for cross-backend
   * equivalence.
   */
  private async fetchGraphNeighbors(
    seeds: MemoryEntry[],
    scope: { project?: string | null; target?: MemoryTarget; category?: MemoryCategory; includeSuperseded?: boolean },
  ): Promise<MemoryEntry[]> {
    const seedSeqs = seeds.map((m) => m.id);
    const keys = new Set<string>();
    for (const m of seeds) {
      if (m.project) keys.add(`project:${m.project}`);
      if (m.category) keys.add(`category:${m.category}`);
      if (m.target) keys.add(`target:${m.target}`);
    }
    if (keys.size === 0) return [];

    // Mirror runSearch: superseded neighbors are hidden unless opted in.
    const s = buildScope(scope.target, scope.project, scope.category, scope.includeSuperseded ?? false);
    const where = s.where ? `${s.where.replace("WHERE ", "")} AND` : "";
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories
       WHERE ${where} seq NOT IN $seedSeqs
         AND array::intersect(->tagged->tag.key, $keys) != []
       ORDER BY lastReferenced DESC LIMIT $cap;`,
      { ...s.params, seedSeqs, keys: [...keys], cap: GRAPH_NEIGHBOR_CAP },
    );
    return rows.map(mapRow);
  }

  /**
   * Idempotently sync this memory's `tagged` graph edges for its implicit tags
   * (project/category/target). Clears existing outgoing edges first, then
   * ensures each tag node exists and re-creates the edge.
   */
  private async syncGraphEdges(
    seq: number,
    project: string | null,
    category: MemoryCategory | null,
    target: MemoryTarget,
  ): Promise<void> {
    await this.c.query(`DELETE FROM tagged WHERE in = type::record("memories", $seq);`, { seq });
    const tags: Array<{ key: string; kind: string; value: string }> = [];
    if (project != null) tags.push({ key: `project:${project}`, kind: "project", value: project });
    if (category != null) tags.push({ key: `category:${category}`, kind: "category", value: category });
    if (target != null) tags.push({ key: `target:${target}`, kind: "target", value: target });
    if (tags.length === 0) return;
    for (const t of tags) {
      await this.c.query(`UPSERT type::record("tag", $key) SET key = $key, kind = $kind, value = $value;`, t);
      await this.c.query(
        `LET $mem = type::record("memories", $seq); LET $tag = type::record("tag", $key); RELATE $mem->tagged->$tag;`,
        { seq, key: t.key },
      );
    }
  }

  /**
   * One-time migration: heal legacy memory rows whose Surreal record id is an
   * auto-generated random string (`memories:<random>`) rather than seq-based
   * (`memories:<seq>`). Such rows were created before the create path switched
   * to `CREATE type::record("memories", $next)`. Every graph-edge operation
   * (syncGraphEdges / backfillGraphEdges / removeMemory) keys the source by
   * `memories:<seq>`, so legacy rows' edges land on a PHANTOM node and the row
   * is a permanent graph orphan — backfill re-creates phantom edges every boot
   * (never converging) and the `tagged` table bloats with duplicates.
   *
   * For each mismatched row: UPSERT a seq-based clone with all fields copied,
   * then delete the random-id original. When ≥1 row is migrated, ALSO wipe
   * `tagged` so the caller's immediately-following `backfillGraphEdges()`
   * rebuilds a minimal correct edge set (the wipe is gated on actual migration
   * so it never runs on an already-clean DB and never destroys legit edges).
   *
   * Idempotent: once every row is seq-based the mismatch SELECT returns 0 →
   * no-op. Best-effort: any error is swallowed (returns 0) so it cannot trip
   * the sqlite fallback in createBackendBundleWithFallback. Chunked (CHUNK=100)
   * to bound each HTTP request. Concurrency note: sibling agents racing the
   * first migration could create some duplicate edges (non-fatal; one-time).
   */
  async normalizeLegacyMemoryIds(): Promise<number> {
    try {
      const legacy = await this.c.query<Array<Row & { id: string }>>(
        `SELECT id, seq, project, target, category, content, failureReason,
                toolState, correctedTo, created, lastReferenced, mwSuccess,
                mwFail, status, supersedes, supersededBy, parentIds
         FROM memories WHERE record::id(id) != seq;`,
      );
      if (legacy.length === 0) return 0;

      const CHUNK = 100;
      const str = (v: unknown): string => (v == null ? "NONE" : sqlStr(String(v)));
      const num = (v: unknown): string => (v == null ? "NONE" : String(Number(v)));
      for (let i = 0; i < legacy.length; i += CHUNK) {
        const stmts: string[] = [];
        for (const r of legacy.slice(i, i + CHUNK)) {
          const seq = Number(r.seq);
          // Inline the old random id part (Surreal auto-ids are [a-z0-9]; safe literal).
          const oldIdPart = String(r.id.split(":")[1]);
          stmts.push(
            `UPSERT type::record("memories", ${seq}) SET ` +
              `seq = ${seq}, project = ${str(r.project)}, target = ${str(r.target)}, ` +
              `category = ${str(r.category)}, content = ${str(r.content)}, ` +
              `failureReason = ${str(r.failureReason)}, toolState = ${str(r.toolState)}, ` +
              `correctedTo = ${str(r.correctedTo)}, created = ${str(r.created)}, ` +
              `lastReferenced = ${str(r.lastReferenced)}, mwSuccess = ${num(r.mwSuccess)}, ` +
              `mwFail = ${num(r.mwFail)}, status = ${str(r.status)}, ` +
              `supersedes = ${num(r.supersedes)}, supersededBy = ${num(r.supersededBy)}, ` +
              `parentIds = ${JSON.stringify(r.parentIds ?? [])};`,
          );
          stmts.push(`DELETE memories:${oldIdPart};`);
        }
        await this.c.query(stmts.join("\n"));
      }
      // Wipe bloated/phantom edges ONLY because we migrated ≥1 row; the caller's
      // backfillGraphEdges() rebuilds a clean minimal set for every row.
      await this.c.query(`DELETE FROM tagged;`);
      return legacy.length;
    } catch {
      // Best-effort: never abort startup or trigger the sqlite fallback.
      return 0;
    }
  }

  /**
   * Backfill `tagged` graph edges for pre-existing memory rows that have none
   * (e.g. rows written before graph-augmented search shipped). Selects memories
   * with no outgoing edge and rebuilds their edges in batched SurrealQL scripts
   * (UPSERT tag node + RELATE per implicit tag), chunked to keep each HTTP
   * request bounded. Safe to call on every startup: once all rows have edges
   * the "no-edge" set is empty and this is a single cheap SELECT. Best-effort —
   * never throws so it cannot trip the backend-factory fallback to sqlite.
   *
   * Batched (not a per-row HTTP round-trip) because a large pre-existing corpus
   * (hundreds–thousands of rows) would otherwise make startup take tens of
   * seconds one edge at a time.
   */
  async backfillGraphEdges(): Promise<number> {
    try {
      // Orphan check via the graph walk `count(->tagged) = 0` rather than
      // `id NOT IN (SELECT VALUE in FROM tagged)`. The NOT-IN subquery builds
      // the full `tagged.in` set every boot and times out at Surreal's 10s
      // request ceiling on large corpora (controller probe: 10001ms timeout on
      // 1227 memories x 30144 edges). The graph walk is semantically
      // equivalent (a memory has a tagged edge iff it has an outgoing
      // `->tagged`) and runs in ~17ms on the same data.
      const orphans = await this.c.query<Row[]>(
        `SELECT seq, project, target, category FROM memories
         WHERE count(->tagged) = 0;`,
      );
      if (orphans.length === 0) return 0;
      // Orphan rows have no existing edges, so no prior-edge DELETE is needed.
      // Chunk so each request stays bounded for very large corpora.
      const CHUNK = 100;
      for (let i = 0; i < orphans.length; i += CHUNK) {
        const stmts: string[] = [];
        for (const r of orphans.slice(i, i + CHUNK)) {
          const seq = Number(r.seq);
          const tags: Array<{ key: string; kind: string; value: string }> = [];
          if (r.project != null) tags.push({ key: `project:${r.project}`, kind: "project", value: r.project });
          if (r.category != null) tags.push({ key: `category:${r.category}`, kind: "category", value: r.category });
          if (r.target != null) tags.push({ key: `target:${r.target}`, kind: "target", value: r.target });
          for (const t of tags) {
            stmts.push(
              `UPSERT type::record("tag", ${sqlStr(t.key)}) SET key = ${sqlStr(t.key)}, kind = ${sqlStr(t.kind)}, value = ${sqlStr(t.value)};`,
            );
            // type::record() cannot appear inline in a RELATE source/target
            // (parse error), so the tag id uses a record-id literal here.
            stmts.push(`RELATE memories:${seq}->tagged->tag:${tagRecordLiteral(t.key)};`);
          }
        }
        if (stmts.length > 0) await this.c.query(stmts.join("\n"));
      }
      return orphans.length;
    } catch {
      // Best-effort migration: a transient query failure must not abort startup
      // or trigger the sqlite fallback. Missing edges only weaken graph recall.
      return 0;
    }
  }

  async getMemories(options: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    const scope = buildScope(options.target, options.project, options.category);
    const params = { ...scope.params };
    let where = scope.where;
    if (options.status) {
      params.status = options.status;
      where = where ? `${where} AND status = $status` : "WHERE status = $status";
    }
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories ${where} ORDER BY lastReferenced DESC;`,
      params,
    );
    return rows.map(mapRow);
  }

  async getRecentFailures(maxAgeDays = 7, project?: string | null): Promise<MemoryEntry[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffStr = cutoff.toISOString().split("T")[0];
    // Mirror sqlite: a non-null project matches `project = ? OR project IS NULL`
    // so project-agnostic (null-project) failures still surface. Do NOT route
    // through the strict buildScope for project here.
    const params: Record<string, unknown> = { cutoff: cutoffStr };
    const conds: string[] = ["target = $target", "created >= $cutoff", "state = $state"];
    params.target = "failure";
    params.state = "active";
    if (project !== undefined) {
      if (project === null) {
        conds.push("project IS NULL");
      } else {
        params.project = project;
        conds.push("(project = $project OR project IS NULL)");
      }
    }
    const rows = await this.c.query<Row[]>(
      `SELECT ${FIELDS} FROM memories WHERE ${conds.join(" AND ")} ORDER BY created DESC LIMIT 5;`,
      params,
    );
    return rows.map(mapRow);
  }

  async getMemoryStats(): Promise<MemoryStats> {
    const total = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM memories GROUP ALL;`);
    const byProject = await this.c.query<Array<{ project: string | null; count: number }>>(`SELECT project, count() AS count FROM memories GROUP BY project;`);
    const byTarget = await this.c.query<Array<{ target: string; count: number }>>(`SELECT target, count() AS count FROM memories GROUP BY target;`);
    return {
      total: total[0]?.count ?? 0,
      byProject: byProject.map((r) => ({ project: r.project ?? null, count: r.count })),
      byTarget: byTarget.map((r) => ({ target: r.target, count: r.count })),
    };
  }

  async removeMemory(id: number): Promise<boolean> {
    const seq = Number(id);
    await this.c.query(`DELETE FROM memories WHERE seq = $seq;`, { seq });
    await this.c.query(`DELETE FROM tagged WHERE in = type::record("memories", $seq);`, { seq });
    return true;
  }

  async touchMemory(id: number): Promise<void> {
    await this.c.query(`UPDATE memories SET lastReferenced = $t WHERE seq = $seq;`, { seq: Number(id), t: today() });
  }

  async bumpMemoryWorth(id: number, successDelta = 0, failDelta = 0): Promise<void> {
    // success increments unconditionally; fail only while state='active'
    // (§3.6 memworth.fail freeze — a resolved/acquired failure no longer "fails").
    await this.c.query(
      `UPDATE memories SET mwSuccess = (mwSuccess ?? 0) + $s WHERE seq = $seq;
       UPDATE memories SET mwFail = (mwFail ?? 0) + $f WHERE seq = $seq AND state = 'active';`,
      { seq: Number(id), s: successDelta, f: failDelta },
    );
  }

  /**
   * Mark `priorId` as superseded by `newId`, and record the reverse lineage on
   * `newId`. Two UPDATEs (NOT delete+insert) so the prior row's `seq` stays
   * stable for any external lineage references — mirroring `bumpMemoryWorth`.
   * SurrealDB `memories` is SCHEMALESS, so the lineage fields are free columns;
   * `parentIds` is stored as a native array. Id stable across the supersession.
   */
  async supersedeMemory(priorId: number, newId: number): Promise<void> {
    const p = Number(priorId), n = Number(newId);
    await this.c.query(
      `BEGIN TRANSACTION;
       UPDATE memories SET status = 'superseded', supersededBy = $n WHERE seq = $p;
       UPDATE memories SET supersedes = $p, parentIds = [$p] WHERE seq = $n;
       COMMIT TRANSACTION;`,
      { p, n },
    );
  }
}
