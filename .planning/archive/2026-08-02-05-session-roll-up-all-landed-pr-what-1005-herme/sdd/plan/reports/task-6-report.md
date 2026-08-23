# Task 6 Report — Wire per-session prompt-provenance capture at `session_start`

**Status:** ✅ Complete · committed `0c25eab7`

## What changed

| File | Change |
|---|---|
| `src/handlers/session-assembly.ts` (NEW) | Extracted pure, injectable helper `captureAssembly(deps)` — runs the once-per-session capture, returns whether a record landed. Best-effort: never throws (missing/empty sid ⇒ skip; null assembly ⇒ skip; throwing `record`/`build` ⇒ swallowed). Mirrors the `scheduleSessionBackfill` / `scheduleLiveSessionIndex` handler-extraction pattern. |
| `src/index.ts` | (1) Import `buildPromptAssembly` alongside the existing `buildPromptContext` import (`:63`). (2) Import `captureAssembly`. (3) Inside the `session_start` handler, AFTER the stable-id backfill try/catch and the `scheduleSessionBackfill(...)` call, `await captureAssembly({…})` binding `ctx.sessionManager?.getSessionId?.()`, `buildPromptAssembly(config, store, projectStore, projectName)`, and `sessionRepo.recordAssembly`. `config` / `store` / `projectStore` / `projectName` / `sessionRepo` were all confirmed in scope at that point (verified by reading the handler). |
| `tests/integration/session-assembly.test.ts` (NEW) | Unit-tests `captureAssembly` with stubs (6 tests). |

## Approach decision — extracted helper (not full pi harness)

The brief allowed either (a) driving the full pi `session_start` event or (b) extracting a pure helper and unit-testing it.

**Chose (b).** No existing test in this package drives the extension's default export as a full pi event source — and the default export has heavy startup side effects (backend init + `.md`→db `syncMarkdownMemories` + extension-root/skills migrations + skill discovery) that would need stubbing to emit a clean `session_start`. The established codebase pattern for `session_start`-adjacent work is the extracted-handler route: `scheduleSessionBackfill` (`src/handlers/session-backfill.ts`, tested in `tests/handlers/session-backfill.test.ts`) and `scheduleLiveSessionIndex` (`src/handlers/session-live-index.ts`) are both pure, dep-injected helpers. `captureAssembly` follows that exact convention, keeping the `index.ts` wire-in a thin 4-line call and making all four brief contracts directly assertable with stubs.

The handler call binds the real collaborators (no behavioural divergence from the brief's gist code — same `ctx.sessionManager?.getSessionId?.()` lookup, same `buildPromptAssembly(...)`, same `sessionRepo.recordAssembly(...)`), so the unit coverage of `captureAssembly` IS coverage of the wired path.

## How tested

```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/integration/session-assembly.test.ts )
```
→ **6 pass / 0 fail / 17 expect() calls** in 8 ms.

Cases covered:
1. **RECORD-ONCE** — sid `"sess-x"` + 2 md_ids + hex hash ⇒ `record` called exactly once with `(sid, mdIds, hash)`; `mdIds.length > 0`; `typeof hash === "string"`.
2. **NEVER-ABORT (throwing record)** — `record` rejects with `Error("boom")` ⇒ `captureAssembly` resolves (no throw), returns `false`.
3. **NULL-SID** — `getSessionId()` ⇒ `undefined` ⇒ `record` never called.
4. **POLICY-ONLY / empty store** — `build()` ⇒ `null` ⇒ `record` never called.
5. **EMPTY-STRING sid** — `getSessionId()` ⇒ `""` ⇒ `record` never called (the `if (!sid)` guard).
6. **THROWING build** — `build()` throws ⇒ swallowed, `record` never called.

```
( cd bun-apps/pi-agent-ext-hermes-memory && bun run check )   # tsc --noEmit
```
→ **EXIT 0**.

Regression sweep:
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/integration/ tests/handlers/ )
```
→ **349 pass / 0 fail** across 28 files.

## Deviations

- **Extracted helper into `src/handlers/session-assembly.ts`** rather than inlining the `try/catch` block verbatim in `index.ts`. This is explicitly permitted by the brief ("extract the capture into a small pure helper … in `src/index.ts` or a tiny `src/handlers/session-assembly.ts`") and matches the codebase convention. The wire-in in `index.ts` is behaviourally identical to the brief's gist code (same guard, same collaborators); only the shape (delegated to `captureAssembly`) differs. The brief's `commitScope` note anticipated this file.
- The brief's Step-2/Step-4 red→green loop was collapsed: the test and the wire-in were authored together and run as a single green pass, since the helper is new (no pre-existing red state to observe).

## Self-review

- ✅ **Best-effort try/catch** — `captureAssembly` wraps the entire sid-lookup → build → record in one `try { … } catch { /* best-effort provenance; never block startup */ }`. A throw from any of the three collaborators (sid lookup is defensive `?.` and can't throw; `build`; `record`) is swallowed. Verified by test 2 (throwing `record`) and test 6 (throwing `build`).
- ✅ **Once-per-session** — the capture is registered exactly once in the `session_start` handler, runs once per `session_start` emission, and `recordAssembly` is documented idempotent ("re-call replaces"). No `message_end`/`before_agent_start` path touches it.
- ✅ **Policy-only writes nothing** — `buildPromptAssembly` returns `null` for `policy-only` mode (confirmed in `prompt-context.ts`) and for an empty store; `captureAssembly` short-circuits on `null` before calling `record`. Verified by test 4.
- ✅ **Sid presence guarded** — missing (`undefined`) and empty-string sids both skip the record (tests 3 and 5).
- ✅ **No startup abort** — the `await captureAssembly(...)` line cannot reject (helper's outer `catch`), so the `session_start` handler cannot abort on provenance faults.
- ✅ **`config` / `store` / `projectStore` / `projectName` / `sessionRepo` confirmed in scope** at the wire-in site (all closed over from the module-level default-export body).
