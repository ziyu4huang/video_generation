# PRD — Enhance `pi-obsidian`

- **Status:** Draft (planning only — no implementation this pass)
- **Scope:** `bun-apps/pi-obsidian/extensions/obsidian.ts` (3,749 lines, 16 tools + 3 commands)
- **Branch:** `pi-agent/enhance-obsidian-tool`
- **Reference vault:** `vaults_root/pi-agent-vault/` (submodule, pin `53febc7`) — real knowledge base that exercises every code path; source of the prior `Plan - Enhance obsidian_search.md` note.
- **Learning sources:** `vaults_root/pi-agent-vault/Inbox/Plan - Enhance obsidian_search.md`, `Design/pi-Obsidian *.md`, `Zettelkasten/Agent Knowledge - Obsidian Integration.md`, `Zettelkasten/Pattern - bun-pi-agent-cli Vault Submodule Remount.md`.

## 1. Problem

`pi-obsidian` is feature-rich but has three classes of debt that block trusting it as the long-term knowledge substrate:

1. **Robustness gaps** — filesystem errors are silently swallowed, cache can go stale on external edits, wiki-link rewriting corrupts code blocks / frontmatter, and optimistic concurrency (`expectedMtime`) is enforced on only 1 of 4 write tools.
2. **AI-workflow quality** — `obsidian_distill` / `obsidian_garden` subagents write to the vault with **no output validation**, inherit an unvalidated model, and their prompts lack examples / schema / quality gates.
3. **Integration / performance** — search is an O(lines) linear scan with no inverted index, the vault index rebuilds fully on every invalidate and is never persisted across sessions, and graph queries rebuild adjacency from scratch on every call.

Coverage is thin: **13 of 16 tools have no test**; critical functions (`safeNotePath`, `rewriteLinkToken`, `buildIndex`, `moveNote`/`deleteNote`, `atomicWriteFile`) are untested.

> **Note on the prior search plan:** the vault's `Plan - Enhance obsidian_search.md` (Phase 1–4: `matchMode`, `fields`, `sort`, `context`, `backlinks`, `groupByFile`) is **already implemented** in current `searchVault`. This PRD treats search as *done at the API level* and focuses on its *performance and correctness* rather than re-adding features.

## 2. Goals / Non-Goals

**Goals**
- G1 — No silent error swallowing; all tool failures surface structured, actionable errors.
- G2 — Cache & index stay coherent under external (Obsidian-app) edits within a session, without requiring manual `obsidian_invalidate`.
- G3 — Wiki-link rewriting is safe inside code blocks, frontmatter, embeds, and aliased/section links.
- G4 — Optimistic concurrency (`expectedMtime`) is available and enforced on every write tool.
- G5 — `distill` / `garden` outputs are validated before touching the vault; model is explicit and validated.
- G6 — Search and index scale acceptably to a 10k-note vault (stated target: ≤50ms search @ ≤500 notes; sub-second @ 10k).
- G7 — Critical functions have regression tests; a CI-runnable `bun test` covers the rewrite-edge and path-safety surface.

**Non-Goals**
- Adding brand-new tools (tag manager, template applier, dataview, transclude). (Deferred — a later goal.)
- Persisting cache to disk across sessions *in this pass* (spike only; see §5).
- MCP exposure / external API changes.
- Changing the public tool signatures in a backward-incompatible way. **All new params are Optional with legacy-preserving defaults.**

## 3. Workstreams

Each item cites the current code so implementation can start immediately. Severity = `🔴 high / 🟡 medium / 🟢 low`.

### WS-A — Robustness / Quality

| # | Sev | Item | Current code | Acceptance |
|---|-----|------|--------------|------------|
| A1 | 🔴 | **Stop swallowing FS errors.** `readCached`/`listNotes`/`appendUnderHeading` bare `catch {}` return `null`/`undefined`, hiding EACCES/ENOCE races. | `obsidian.ts:529-533`, `:587-589`, `:2645-2649` | Distinguish `ENOENT` (expected → ok) from `EACCES`/`EIO` (→ structured error). No bare `catch {}` on filesystem ops. **✅ DONE (Phase 1-A)** — tool-layer reads (read/create/append/append_section/update_frontmatter) now classify ENOENT vs EACCES/EIO via `classifyFsError`; internal best-effort helpers (`readCached`, `listNotes`) de-bared their catches with documented rationale (batch resilience — surfacing is at the tool layer). |
| A2 | 🔴 | **Structured error types.** Today all errors are `{isError:true}` with no code. | all tools | Add `code` (`NOT_FOUND` / `PERMISSION_DENIED` / `CONFLICT` / `OUTSIDE_VAULT` / `INVALID_PATH`). Callers can branch. **✅ DONE (Phase 1-A)** — `ErrCode` + `VaultError` + `toolError()` / `toolErrorFromCaught()`; `details.code` on all converted tools (legacy `details.error` + booleans preserved). |
| A3 | 🔴 | **Wiki-link rewriting exclusions.** `rewriteLinkToken` rewrites `[[..]]` inside code blocks, inline code, and frontmatter YAML, corrupting both. | `obsidian.ts:1476-1510`, regex `:1547` | Rewrite skips fenced code blocks, inline `` `..` ``, and the frontmatter region. Handle `![[embed]]`, `[[x#section]]`, `[[x|alias]]`, `[[a|b|c]]`. **✅ DONE (Phase 1-B)** — `rewriteLinksProtected()` tokenizer (frontmatter + ``` / ~~~ fences + inline `code` spans) routes both moveNote + deleteNote rewrites; embed/section/alias/multi-pipe already round-tripped correctly. `LINK_KEEP` / `LINK_DELETE` sentinels. 12 D2 golden-input tests. |
| A4 | 🔴 | **`expectedMtime` on all writes.** Only `obsidian_create` checks it; `append`, `append_section`, `update_frontmatter` read-modify-write without conflict detection. | `obsidian.ts:2570-2588` (only create), `:2629`, `:2694`, `:3155` | All write tools accept optional `expectedMtime` and reject on mismatch; document the pattern. **✅ DONE (Phase 1-C)** — `mtimeConflict()` + `noteMtime()` helpers; `obsidian_append`, `obsidian_append_section` (via `appendUnderHeading`), and `obsidian_update_frontmatter` (via `updateFrontmatter`) all gain optional `expectedMtime` → CONFLICT on stale mtime. Rule: only constrains the existing-file case (append/create still create-new). |
| A5 | 🟡 | **Cache coherence for external edits.** Invalidation is manual-only; edits in the Obsidian app mid-session return stale reads. | `obsidian.ts:514-520`, `:3236` | Add an mtime recheck on cache read (already partially done) **and** an optional cheap fs watcher / size+mtime poll on the active vault folder; auto-invalidate changed entries. **✅ DONE (Phase 4)** — file cache was already mtime-coherent; index coherence added via `refreshIndex()` (readdir+stat diff, reindex only changed), called from `getIndex()` (throttled via `OB_INDEX_POLL_MS`). |
| A6 | 🟡 | **Path safety hardening.** `safeNotePath` allows `/./` segments, Windows reserved names, and Unicode control chars (`​-‏`). Symlink walk has a TOCTOU window. | `obsidian.ts:365-385`, `:433-464` | Normalize `.`/`..` segments; reject reserved names + Unicode controls; document the lstat TOCTOU residual as read-only. |
| A7 | 🟡 | **Atomic move rollback.** `moveNote` collects link-rewrite failures but leaves the graph half-rewritten. | `obsidian.ts:1584-1586` | Either best-effort-then-report with a precise failed-sources list the caller can retry, or rollback semantics; never silent partial state. |
| A8 | 🟢 | **LRU utility-awareness.** Cache evicts oldest regardless of access frequency (MOC/index notes thrash out). | `obsidian.ts:546-550` | True LRU on access order (Map insertion-order is not access-order). |

### WS-B — `distill` / `garden` AI-workflow Quality

| # | Sev | Item | Current code | Acceptance |
|---|-----|------|--------------|------------|
| B1 | 🔴 | **Output validation before write.** Subagents call `obsidian_create` / `append_section` directly; malformed YAML or missing `created`/`id`/`tags` corrupts the vault. | `obsidian.ts:3293-3310`, distill execute `:3339-3420` | Validate frontmatter schema (required keys parse, YAML valid), wiki-link targets resolve, sane size; reject + report rather than write garbage. |
| B2 | 🔴 | **Explicit, validated subagent model.** Model is inherited from parent (`opts.model ?? OB_PARENT_MODEL`); a weak/TC-unaware parent model silently degrades both prompts. | `obsidian.ts:2344-2346` | Default to a named capable model; warn if unset; never inherit a known-weak model. Both prompts require Traditional Chinese. |
| B3 | 🟡 | **Prompt hardening.** `ZETTEL_SYSTEM_PROMPT` / `GARDEN_SYSTEM_PROMPT` lack examples, output schema, and chunk-size guidance; `garden` has no severity thresholds and LLM-only duplicate detection. | `obsidian.ts:2024-2082`, `:2420-2457` | Add 1–2 example cards, explicit JSON/markdown schema, input-size cap; `garden` gains severity buckets and structured (non-LLM) duplicate candidates from the index. |
| B4 | 🟡 | **`garden` dry-run + safe fix.** Fix mode has no dry-run verification or rollback if it produces invalid markdown. | `obsidian.ts:2433-2438` | Add `dryRun` (report only) default; validate post-fix; never leave invalid markdown. |
| B5 | 🟡 | **`runSubagent` promise antipattern.** `new Promise(async …)` can leak unhandled rejections; `finish()` may double-fire. | `obsidian.ts:2321-2415` | Refactor to async/await with a single resolve path; cover with a test. |
| B6 | 🟢 | **Tool-allowlist extensibility.** Distill/garden tool lists are hardcoded arrays. | `obsidian.ts:3293-3310` | Config-driven allowlist (env or package option) for custom workflows. |

### WS-C — Integration / Performance

| # | Sev | Item | Current code | Acceptance |
|---|-----|------|--------------|------------|
| C1 | 🔴 | **`findBacklinks` should use the index.** It re-scans the whole vault line-by-line despite `idx.reverseAdjacency` already holding the answer. | `obsidian.ts:1833-1866` | Read from `idx.reverseAdjacency`; reserve scan for stale-index fallback. |
| C2 | 🔴 | **Memoize graph adjacency.** `graphNeighbors` rebuilds the full undirected adjacency map on every call. | `obsidian.ts:1423-1470` | Cache adjacency on `VaultIndex` (invalidate with the index). |
| C3 | 🟡 | **Incremental index update.** `obsidian_invalidate` triggers a full rebuild; `reindexFile` exists but only fires on writes. | `obsidian.ts:1203-1247`, `:1320`, `:3236` | Invalidate rebuilds only changed entries (path-scoped), not the whole vault. **✅ DONE (Phase 4)** — `obsidian_invalidate` now takes optional `path` (subtree-scoped reconcile); no-arg does a forced incremental `refreshIndex` instead of full drop+rebuild. |
| C4 | 🟡 | **Index build lock.** Concurrent `getIndex` calls trigger parallel full vault scans. | `obsidian.ts:1203-1209` | In-flight promise dedup (single flight). |
| C5 | 🟡 | **Search acceleration (spike).** Substring/regex/fuzzy are O(total_lines); no inverted index. | `obsidian.ts:873-1011` | Spike an in-memory trigram/term index for substring mode; fuzzy pre-filters via substring as the prior plan noted. Measure before committing. |
| C6 | 🟢 | **Cross-session index persistence (spike).** Index/cache are module-level Maps cleared on exit — every session pays full startup tax. | `obsidian.ts:521-522`, `:1200` | Spike a `.cache/` mtime-valided persisted index; measure win on the 10k-note reference vault. |
| C7 | 🟢 | **Schema token budget.** 16 tools add ~2.3k tokens/turn; `obsidian_search` alone has 12 params. | README §tokens | Trim verbose descriptions; consider a `minimal` package variant. |
| C8 | 🟢 | **Extension API contract check.** No runtime version check vs `@earendil-works/pi-coding-agent` `ExtensionAPI`; `pi-agent-cli` could vendor a stale inline copy. | `obsidian.ts:54`, `:2459` | Light version guard + document the inline-bundle source-of-truth (per the Vault Submodule Remount zettel). |

### WS-D — Test Coverage (cross-cutting)

| # | Sev | Item | Acceptance |
|---|-----|------|------------|
| D1 | 🔴 | **Path-safety tests** (`safeNotePath`, `assertWithinVault`): traversal, `/./`, reserved names, Unicode controls, symlink escape. | Tests added; symlinkTraversal test reinforced. |
| D2 | 🔴 | **Wiki-link rewrite tests** for A3: code blocks, inline code, frontmatter, embeds, aliases, sections. | Golden-input table covers all cases in A3. **✅ DONE (Phase 1-B)** — `rewriteProtection.test.mjs` (12 cases). |
| D3 | 🟡 | **Concurrency tests** for A4: concurrent write with `expectedMtime` mismatch → conflict; without → last-write-wins documented. | Simulated mtime-conflict fixtures. **✅ DONE (Phase 1-C)** — `expectedMtime.test.mjs` (9 cases) across append/append_section/update_frontmatter: stale→CONFLICT, matching→ok, new-note ignores mtime, no-mtime legacy. |
| D4 | 🟡 | **Tool smoke tests** for the 13 untested tools: list/read/create/append/move/delete/query/status round-trip on a temp vault. | One fixture-driven test per tool. |
| D5 | 🟡 | **Subagent mock tests** for B1/B5: feed a malformed subagent output, assert validation rejects; feed a thrown spawn, assert no unhandled rejection. | Mock `runSubagent` at the boundary. |

## 4. Phasing (suggested order)

- **Phase 1 — Hardening core (WS-A1–A4, WS-D1–D3):** error surfacing, structured codes, link-rewrite safety, `expectedMtime` everywhere. Highest blast-radius reduction; unblocks trusting the tool on the real vault.
- **Phase 2 — AI-workflow safety (WS-B1, B2, B5 + D5):** validate-before-write, explicit model, kill the promise antipattern. Stops vault corruption at the source.
- **Phase 3 — Perf quick wins (WS-C1, C2, C4):** index-backed backlinks, memoized adjacency, single-flight index. Pure wins, low risk.
- **Phase 4 — Cache coherence (WS-A5, C3):** auto-invalidate on external edits + incremental reindex. Behavior change; needs the reference vault to validate.
- **Phase 5 — Quality polish (rest of WS-A/B/C + D4):** LRU, prompt hardening, dry-run garden, schema trim. Iterative.
- **Phase 6 — Spikes (C5, C6):** inverted index + persisted cache; measure before adopting.

## 5. Open Questions

1. **Cache watcher scope:** fs watchers on macOS (FSEvents) over a large vault can be noisy — is mtime/size polling on the active folder sufficient, or do we need a real watcher? (Decide in Phase 4.)
2. **Subagent model default:** which named model is the floor for TC-aware distill/garden? Needs a decision before B2.
3. **Backward-compat surface for `expectedMtime`:** making it optional preserves compat, but should `obsidian_create`'s existing behavior (currently the *only* enforcer) change? Likely keep current default, add to others as opt-in first.
4. **Persisted-cache location:** `.cache/` inside vault (gitignored) vs `$XDG_CACHE_HOME`. Vault-internal keeps it co-located but risks Obsidian indexing it.

## 6. Acceptance (whole goal)

- All 🔴 items resolved or explicitly descoped with rationale.
- `bun test extensions/__tests__/` is green and covers WS-D.
- Manual run against `vaults_root/pi-agent-vault/`: `distill` on a real note validates; `garden --dryRun` reports without mutating; `search` over the full vault returns in the §2 G6 time budget; an external edit mid-session is reflected without manual invalidate.
- No public tool signature breaks; new params are Optional with legacy defaults.
- `pi-agent-cli` (which inline-bundles this extension) still builds and its zk-extract / pipeline workflows still pass.
