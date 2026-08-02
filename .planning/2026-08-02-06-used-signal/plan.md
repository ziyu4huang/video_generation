# Plan — "used vs dropped" signal (UPSP §9, ticket #06)

Spec: `.planning/2026-08-02-06-used-signal/spec.md`. Built via subagent-driven-development (SDD): one implementer subagent per task (tier medium, watchdog L2 on), each followed by a read-only reviewer subagent. Recovery ledger: `sdd/plan/progress.md`.

**Discipline (from #05):** each task is red→green→refactor TDD; `commitScope` per task so out-of-scope `.planning/sdd/` scratch is flagged; controller never edits impl directly; per-task reviewer APPROVE/CHANGES before next task; final whole-branch review before PR.

## Baseline (pre-flight, controller-run)

- Branch off `origin/main` (@ f9501247): `feat/hermes-used-signal`.
- `git rev-parse origin/main` → `BASE` (first review-package merge-base).
- Baseline test count recorded before Task 1 (full suite green). Target: +N new tests, 0 regressions.

---

## Task 1 — signature extraction (pure) + manifest emit

**Goal:** a pure, unit-tested signature function + extend the two assembly-manifest methods to emit per-entry signatures.

**Files:** `src/store/memory-store.ts` (`getAssemblyManifest` ~L1314, `getProjectAssemblyManifest` ~L1348); new pure helper (e.g. `src/store/signature.ts` or co-located export) `computeSignature(body: string, minChars: number): string | null`.

**Design:**
- `computeSignature`: normalize (lowercase, collapse whitespace, strip markdown fences ` ``` ` + `#`/`-`/`*` leading markers), split into candidate fragments (lines/sentences), return the **longest** fragment with normalized length ≥ `minChars`, or `null` if none (entry too generic → skip).
- Extend both manifest methods to return `signatures: { mdId: string; signature: string }[]` — one entry per surfaced md_id whose `computeSignature(body, minChars)` is non-null (skipped entries simply omitted). **Same iteration** as the existing md_id harvest (DRY — no duplicated selection; the #05 drift finding does not recur).
- `{ block, mdIds }` fields unchanged — purely additive; #05 consumers unaffected.

**Tests:** normalization cases; longest-fragment selection; min-length skip (short entry → null → omitted from signatures); manifest returns exactly one signature per qualifying surfaced md_id; entries under min omitted but still present in `mdIds`. Config `usedSignatureMinChars` honored.

**Verification:** new unit tests pass; existing `getAssemblyManifest`/`getProjectAssemblyManifest` tests (#05) still green (additive field).

---

## Task 2 — extend AssemblyReceipt + buildPromptAssembly

**Goal:** thread signatures through the prompt-assembly receipt so session_start can hold them.

**Files:** `src/handlers/session-assembly.ts` (`AssemblyReceipt` interface); `src/prompt-context.ts:56` (`buildPromptAssembly`).

**Design:**
- `AssemblyReceipt { mdIds: string[]; hash: string }` → add `signatures: { mdId: string; signature: string }[]` (union of memory-store + project-store signatures).
- `buildPromptAssembly` unions the two manifest `signatures` arrays (dedupe by mdId — a memory + project entry could share an id; keep first).
- `captureAssembly` unchanged (it ignores `signatures`; #05 record path untouched).

**Tests:** `buildPromptAssembly` returns `signatures` = union of both manifests; receipt shape; null-assembly (policy-only/empty) still returns null (no signatures either).

**Verification:** prompt-context tests pass; #05 `captureAssembly` tests unaffected.

---

## Task 3 — markUsed interface + SQLite impl + used_at migration

**Goal:** persist the used marking on SQLite.

**Files:** `src/store/repository.ts:186` (`SessionRepository` interface); `src/store/sqlite/schema.ts` (`session_assembly` + migration); `src/store/sqlite/sqlite-session-repo.ts` (`recordAssembly` sibling).

**Design:**
- Interface: `markUsed(sessionId: string, mdIds: readonly string[], usedAt: string): Promise<void>`.
- SQLite impl: `UPDATE session_assembly SET used_at = ? WHERE session_id = ? AND md_id IN (...)` — sets only matched rows for that session; idempotent (re-mark no-op); leaves non-matched null; never touches `session_assembly_meta`.
- Migration: add `used_at TEXT` to the `session_assembly` CREATE TABLE (fresh installs) **+** an idempotent `ALTER TABLE session_assembly ADD COLUMN used_at TEXT` for existing DBs (try/catch on "duplicate column name" — SQLite treats re-add as error code 1). Wire into the existing schema-init path using the **established pattern** (`sqlite-backend.ts:696` `ensureLegacySchemaColumns` → per-table `ensureXxxColumns` via `getColumnNames(db,'table').has('col')` presence-guard, NOT try/catch). Add `ensureSessionAssemblyColumns(db)` mirroring `ensureMemoriesColumns`: `if (!getColumnNames(db,'session_assembly').has('used_at')) db.exec('ALTER TABLE session_assembly ADD COLUMN used_at TEXT');`, called from `ensureLegacySchemaColumns`. SCHEMA_SQL execs at `sqlite-backend.ts:310`.

**Tests:** markUsed sets used_at on matched rows only; non-matched stay null; idempotent re-mark; empty mdIds is a no-op; `session_assembly_meta` and other tables untouched; migration idempotent (run twice → no error, column present).

**Verification:** sqlite-session-repo tests pass; migration test runs ALTER twice safely.

---

## Task 4 — markUsed Surreal impl (parity)

**Goal:** Surreal parity — SCHEMALESS, no DDL.

**Files:** `src/store/surreal/surreal-session-repo.ts` (~L250, the `recordAssembly` region); `src/store/surreal/schema.ts` (no change — SCHEMALESS).

**Design:** `UPDATE session_assembly SET usedAt = $now WHERE sessionId = $sid AND mdId IN $ids;` — field name `usedAt` (camelCase, matches `sessionId`/`mdId`/`capturedAt`). Idempotent (re-update no-op). Mirrors the recordAssembly delete-then-write region's query style.

**Tests (contract):** parity with SQLite — matched rows get usedAt, non-matched stay absent, idempotent, meta untouched.

**Verification:** Surreal contract test passes; both backends behave identically.

---

## Task 5 — SurfacedSignatureSet + setupUsedDetection handler

**Goal:** the per-session match engine + the event wiring.

**Files:** new `src/handlers/used-detection.ts` (mirrors `worth-scoring.ts` structure); `SurfacedSignatureSet` class (mirrors `RecallSet`).

**Design:**
- `SurfacedSignatureSet`: holds `Map<signature, mdId>`. Methods: `populate(entries: { mdId, signature }[])` (replaces the set — called once at session_start); `matchAndForget(normalizedText: string): string[]` (returns matched mdIds, **removes matched signatures** from the set — monotonic; unmatched stay for future turns).
- `setupUsedDetection(pi, sessionRepo, surfacedSignatures, config)`:
  - `message_end` (role === 'assistant'): append the message text to a per-turn buffer (`turnText`). **Note:** `getMessageText` (types.ts:280) truncates to 500 chars — for the scan buffer pass a large `maxLength` (e.g. 100_000) or a full-text extraction so long assistant messages aren't clipped (a ≥24-char signature could live past char 500).
  - `turn_end`: `const matched = surfacedSignatures.matchAndForget(normalize(turnText)); turnText = ""; if (matched.length && sessionRepo) try { await sessionRepo.markUsed(sid, matched, new Date().toISOString()); } catch { /* best-effort */ }`.
  - Best-effort, fully try/catch-wrapped — never blocks the turn (mirrors worth-scoring's safety envelope).
  - Config-gated: `config.usedDetection !== false` (default on; independent of `worthScoring`).
  - `normalize` = the SAME normalization as `computeSignature` (Task 1) — extract to a shared `normalizeForSignature(text)` so both sides agree (DRY).

**Tests:** match marks the right mdId; no-match returns [] and leaves set intact; monotonic (signature matched once then forgotten — second turn no-op); multi-match in one turn; populate replaces; buffer resets each turn; throwing markUsed swallowed; disabled when `usedDetection===false`.

**Verification:** used-detection unit tests pass (stub sessionRepo); worth-scoring tests untouched (distinct signal).

---

## Task 6 — session_start wiring + surfaced-set population

**Goal:** connect #05's capture to #06's detection; ensure the surfaced set reflects exactly what #05 recorded.

**Files:** `src/index.ts` (the session_start handler ~L333, after `captureAssembly`).

**Design:**
- After `captureAssembly(...)`: `const receipt = buildPromptAssembly(...)` (captureAssembly currently calls build internally — refactor so the receipt is available to BOTH capture and the signature populate, OR call buildPromptAssembly once and pass its result to a captureAssembly variant). Populate `surfacedSignatures.populate(receipt.signatures)` when receipt is non-null + sid present.
- Construct the shared `surfacedSignatures` instance + `setupUsedDetection(pi, sessionRepo, surfacedSignatures, config)` once at extension setup (alongside `setupWorthScoring`).
- **Invariant (testable):** the surfaced-signature mdIds == the mdIds #05 recorded (same `buildPromptAssembly` receipt feeds both). This guarantees §5↔§9 join consistency.

**Tests:** integration — session_start populates surfacedSignatures from the same receipt captureAssembly recorded; usedDetection===false skips populate + detection; null assembly (policy-only) leaves set empty.

**Verification:** integration test passes; session_start ordering (after loadFromDisk + backfillStableIds + captureAssembly) preserved.

---

## Task 7 — full test matrix + contract + final review + PR

**Goal (controller-run):** whole-branch gate.

- Full suite (baseline + new), extension-contract (3), `tsc --noEmit` exit 0.
- review-package `BASE..HEAD` (all commits) → final whole-branch reviewer (tier big): spec coverage (D1–D4 + Acceptance 1–6), backend parity, distinctness from worth-scoring, monotonic correctness, migration safety.
- `gh pr create --base main --head feat/hermes-used-signal --title "feat(hermes): used-vs-dropped signal (prompt-provenance §9, record-only)"`.
- `await_pr_merge` (rebase, delete branch).

---

## Risks / pre-flight notes

- **#05 drift recurrence:** the manifest already duplicates `getActiveFailureEntries`' filter for id harvest (the parked #05 finding). Task 1's signature emit rides the SAME iteration as the md_id harvest → does NOT add a third copy. Good. (A future follow-up extracts `getActiveRawFailureEntries` to kill the original duplication.)
- **Migration safety:** SQLite ALTER-on-existing-table — Task 3 uses the established `ensureLegacySchemaColumns` + `getColumnNames` presence-guard pattern (mirrors `ensureMemoriesColumns`); idempotent by construction, no try/catch needed.
- **Normalization DRY:** Task 1 `computeSignature` and Task 5 `normalize` must share one `normalizeForSignature` — else signatures never match. Explicit shared export.
- **Surreal field naming:** `usedAt` (camelCase) — matches existing convention; verify in Task 4.
- **No tool-event hooking:** assistant text only (D3 refinement) — no `tool_call`/`tool_execution` blocking risk.
