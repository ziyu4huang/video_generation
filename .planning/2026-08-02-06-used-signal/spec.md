# Spec — "used vs dropped" signal (UPSP §9, ticket #06)

**Ticket:** `06-do-used-signal-memworth` (`.planning/2026-08-02-try-to-checkout-code-use-gh-and-learning-from-ht/tickets/06-do-used-signal-memworth.md`)
**Builds on:** #05 (per-session assembly log, PR #1012 — `session_assembly(session_id, md_id)` + `session_assembly_meta`).
**Effort:** S–M · **Tier:** cheap (record-only) · **Backends:** SQLite + Surreal (parity, as in #05).

## What

Record, per session, which **surfaced** entries (the md_id set injected at `session_start`, captured by #05) the agent's subsequent actions actually **referenced** — and mark them `used` by setting `session_assembly.used_at`. This closes the UPSP §9 "默契集" loop: *"what setup pre-loaded vs what reaction actually used"*. It is a **sharper, distinct** signal from `worth-scoring`'s recall-based `mw_success`/`mw_fail` (which tracks memory that was *searched* and whether the turn then succeeded). Here we ask: of the memory *injected into the prompt*, did the agent's output actually draw on it?

Once decay (#1b) lands, `used_at IS NOT NULL` entries are spared and `surfaced-but-never-used` ones decay faster — but **that consumption is out of scope here** (record-only).

## Resolved design decisions (grilled)

- **D1 — referenced signal = content-signature match (cheap tier).** The injected block is **body-only** (`loadFromDisk` strips frontmatter/ids before `formatForSystemPrompt` fences the snapshot), so the agent never sees surfaced entries' ids → "reference by id" is impossible for the surfaced set, and recall (memory_search) is already tracked separately by `worth-scoring`'s `RecallSet`. So "used" must be a **content-based** signal: the agent's output contains a distinctive fragment of a surfaced entry's body. LLM-judge is the gold standard but is **deferred** (consistent with #05's cheap-tier-first); the schema slots it in later.
- **D2 — storage = add `used_at TEXT` to `session_assembly`.** Reuses #05's table: one row already exists per `(session_id, md_id)` for surfaced entries; `used_at` is nullable (null at capture, set on first match). Surfaced = row exists; used = `used_at IS NOT NULL`. *"Surfaced-but-never-used"* = `WHERE used_at IS NULL`. Trivial SQLite migration (`ALTER TABLE ADD COLUMN`); Surreal is SCHEMALESS (just set the field). No new table, no key duplication, the §5↔§9 join stays intact.
- **D3 — timing = `turn_end` batch, scan assistant text.** Accumulate the turn's **assistant `message_end` text** into a per-turn buffer; at `turn_end`, scan it once against the surfaced-entry signatures; mark `used_at` on first hit. Bounded (one scan per turn), and since `used` is **monotonic** (once matched, stays matched — no need to re-detect), per-turn incremental scanning is correct. Aligns with `worth-scoring`'s existing `turn_end` drain — one accounting point in the extension. **Tool-call args are NOT scanned** (cheap tier): the signature is a distinctive ≥`usedSignatureMinChars` fragment, which tool args rarely contain, and hooking tool events adds risk for negligible coverage. A later tier may add `tool_execution_start` args.
- **D4 — scope = record-only.** Capture `used_at` per D1–D3. **No** decay integration, **no** `mw_used` entry-level bump, **no** query tool/CLI. Consumption (spare-used / decay-unused) deferred to #1b. Hebbian / autonomous-distillation tables **SKIP** (needs a resident daemon). Mirrors #05's record-only philosophy + the ticket's explicit SKIP.

## Architecture (the signature flow)

```
session_start (index.ts, after #05 captureAssembly):
  buildPromptAssembly(config, store, projectStore, name)   ← extended to also return signatures
      ├─ store.getAssemblyManifest()        → { block, mdIds, signatures[] }   ← extended
      └─ projectStore.getProjectAssemblyManifest(name) → { ..., signatures[] } ← extended
  captureAssembly(...)                       ← #05, unchanged (records mdIds + hash)
  surfacedSignatures.set(signature → mdId)   ← NEW: hold the turn-scan set for this session

message_end (role === 'assistant'):
  accumulate message text into turnOutput buffer
turn_end:
  for each (signature, mdId) still in surfacedSignatures:
      if normalized(turnOutput) contains signature:
          matchedMdIds.add(mdId); delete signature from set   ← monotonic
  if matchedMdIds: sessionRepo.markUsed(sessionId, matchedMdIds, now)   ← NEW
```

### Signature algorithm (cheap-tier default)

For each surfaced entry, compute a **normalized distinctive fragment** and check substring presence in the **normalized turn output** (both lowercased, whitespace-collapsed, markdown fenced/headers stripped):

- **signature** = the entry's longest normalized line/sentence **≥ `usedSignatureMinChars`** (default **24**). If no fragment reaches the min length (short/generic entries), the entry is **skipped** (never credited as used — it is too generic to attribute).
- **match** = the signature is a substring of the normalized turn output.
- **monotonic**: once a signature matches, it is removed from the per-session set (no re-detection; idempotent `markUsed`).
- Rationale: cheapest deterministic signal, easy to unit-test, easy to reason about false positives; if it proves noisy, the deferred LLM-judge tier replaces it. `usedSignatureMinChars` is config-tunable.

## Storage / migration

- **SQLite:** add `used_at TEXT` to `session_assembly` in `SCHEMA_SQL` (fresh installs) **+** an idempotent `ALTER TABLE session_assembly ADD COLUMN used_at TEXT` migration for existing DBs (the table already exists post-#05; `IF NOT EXISTS` won't add the column). Migration uses the established `ensureLegacySchemaColumns` + `getColumnNames(db,'session_assembly').has('used_at')` **presence-guard** (mirrors `ensureMemoriesColumns`) — NOT try/catch.
- **Surreal:** `session_assembly` is SCHEMALESS — no DDL; `markUsed` just `UPDATE session_assembly SET usedAt = $now WHERE sessionId = $sid AND mdId IN $ids`. (Field naming `usedAt` matches the existing camelCase Surreal fields: `sessionId`, `mdId`, `capturedAt`.)
- **`SessionRepository` interface (repository.ts:186):** add `markUsed(sessionId: string, mdIds: readonly string[], usedAt: string): Promise<void>` — sibling to `recordAssembly`. Both impls UPDATE in place; idempotent (re-mark is a no-op).

## Timing / lifecycle (builds on the #05 session-row fact)

- Surfaced set is **frozen at `session_start`** (#05 captures it once). `used_at` is mutated later as matches occur.
- `markUsed` runs at `turn_end`, after `worth-scoring`'s recall drain (same event, independent concern). Best-effort, fully try/catch-wrapped — never blocks the turn/session (mirrors `worth-scoring`'s safety envelope).
- **FK-free** (inherited from #05): `markUsed` UPDATEs `session_assembly` by `(session_id, md_id)`; no `sessions` FK dependency.

## Acceptance

1. **Manifest emits signatures:** `getAssemblyManifest()` / `getProjectAssemblyManifest()` return `signatures: { mdId, signature }[]` for exactly the surfaced entries (same selection as the block — verified by test: one signature per mdId, skipped for entries whose longest fragment < min chars). #05's `{ block, mdIds }` consumers (`buildPromptAssembly`, `recordAssembly`) are unaffected (additive).
2. **Signature algorithm:** unit-tested — normalization (lowercase/whitespace/markdown-strip), longest-fragment-≥-min extraction, min-length skip, substring match. Config `usedSignatureMinChars` honored.
3. **`markUsed` (SQLite + Surreal):** sets `used_at`/`usedAt` on the matched rows for that session only; idempotent (re-mark no-op); leaves non-matched rows null; does not touch `session_assembly_meta` or any other table. Parity tests on both backends.
4. **Turn-end detection:** a surfaced entry whose signature appears in the turn's **assistant text** is marked `used_at` within that turn's `turn_end`; an entry never referenced stays null; a second match in a later turn is a no-op (monotonic). Best-effort: a throwing `markUsed` is swallowed and never blocks.
5. **Wiring at `session_start`:** the surfaced-signature set is populated after `captureAssembly` (so it reflects the same entries #05 recorded), gated on a non-empty sid + non-null assembly. Disabled cleanly when `worthScoring === false`? — **no**: `used` detection is independent of worth-scoring; gate on its own config `usedDetection !== false` (default on).
6. **No regressions:** full suite green, extension-contract green, `tsc --noEmit` exit 0. `worth-scoring`'s recall path unchanged (the two signals remain distinct).

## Out of scope / deferred

- **Decay / consumption** (#1b) — `used_at` is recorded, not consumed.
- **LLM-judge "used" tier** — deferred (the schema + `markUsed` path slot it in later: an LLM can emit matched md_ids into the same `markUsed`).
- **Hebbian co-occurrence / autonomous distillation tables** — SKIP (needs a resident daemon).
- **Query tool / CLI** to inspect surfaced-vs-used — not required by the ticket.
- **Entry-level `mw_used` counter** — not added (per-session `used_at` is the §9 signal; an entry-level counter would lose per-session provenance and break the §5↔§9 join).

## Key code sites (verified on `origin/main` @ f9501247)

- `src/store/memory-store.ts:1314` `getAssemblyManifest()` · `:1348` `getProjectAssemblyManifest()` — extend to emit `signatures`.
- `src/prompt-context.ts:56` `buildPromptAssembly()` — extend `AssemblyReceipt` with `signatures`.
- `src/handlers/session-assembly.ts` `AssemblyReceipt` interface + `captureAssembly` — additive (`signatures` field).
- `src/store/repository.ts:186` `SessionRepository.recordAssembly` — add sibling `markUsed`.
- `src/store/sqlite/schema.ts` `session_assembly` — add `used_at TEXT` + migration.
- `src/store/sqlite/sqlite-session-repo.ts` `recordAssembly` — add `markUsed`.
- `src/store/surreal/schema.ts:22` + `surreal-session-repo.ts:250` — SCHEMALESS (no DDL) + `markUsed` UPDATE.
- `src/handlers/worth-scoring.ts` — the **distinct** recall signal to keep separate; `setupUsedDetection` mirrors its `message_end`/`turn_end` shape (assistant-text buffer + turn_end scan; no tool-event hooking).
- `src/index.ts:333` captureAssembly call-site — add surfaced-signature hold + `setupUsedDetection` wiring.
