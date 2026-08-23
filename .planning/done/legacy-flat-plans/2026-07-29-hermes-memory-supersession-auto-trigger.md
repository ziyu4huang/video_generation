# Hermes Supersession Auto-Trigger (judge-gated) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a correction fires, an LLM judge decides which (active) memory the correction contradicts, then auto-supersedes it — the correction entry supersedes the contradicted memory via `supersedeMemory`. No contradiction (or judge unavailable/parse-fail) → no supersede (safe default). This completes spec 07's "triggered by correction-detection": supersession becomes automatic, not just agent-driven (Plan 4's tool).

**Architecture:** Integrated INTO `correction-detector.ts`'s existing `turn_end` handler (appended after the "save as failure memory" block) — same gate (rate-limit, grill-suppression, `correctionInProgress`), runs BEFORE worth-scoring drains the recall-set (Pi dispatches same-event handlers sequentially in registration order — confirmed), `memoryRepo`/`config`/`ctx` already in scope. **Candidate pool = `memoryRepo.searchMemories(correctionText)`** (NOT the recall-set) — decoupled from the recall-set drain, returns full entries with content, already filtered to `status='active'` (you can't supersede an already-superseded one). **The judge uses the direct `completeSimple` path** (`review-memory-ops.ts`'s `runDirectBackgroundReview` pattern — structured JSON output, honoring `llmModelOverride`/`llmThinkingOverride`), NOT `spawn` (free text). **`autoSupersede` defaults `false`** (opt-in) — supersession hides a memory from search; even judge-gated, a wrong call permanently hides a possibly-correct memory, so v1 is opt-in until the judge's precision is measured. **The one mandatory change:** capture the correction entry's DB id from `syncMemoryEntry` (currently discarded at `correction-detector.ts:258`) — there's no `newId` to supersede onto without it.

**Tech Stack:** TypeScript, `bun test` (`node:test`/`assert` for the handler test; match the judge-helper test to its file), on-disk tmpdir + mock-pi + fake-judge fixtures.

**Design decisions (from the seam digest):**
- **Candidate pool = `searchMemories`, not the recall-set.** Decoupled from the drain ordering; returns full entries; a correction may contradict a memory the agent *should* have recalled (search finds it). The recall-set stays worth-scoring's exclusive consumer.
- **Judge = direct `completeSimple` (structured JSON), not `spawn`.** Reuses `resolveReviewModel` + `effectiveThinkingOverride` + `buildDirectReviewCompletionOptions` + `extractJsonPayload` from `review-memory-ops.ts`.
- **`autoSupersede` default `false`** (opt-in) — destructive visibility mutation; flip to default-true after measuring precision.
- **Testability: inject a fake `runJudge`** into `setupCorrectionDetector` (default = the real helper) so tests control the verdict without an LLM/mock-model.
- **The `newId` is a `failure`-target correction entry; the prior may be any target.** `supersedeMemory` flips by id only (cross-target works at the DB level); the judge prompt notes the prior may be any target.

## Global Constraints

- **Safe default:** `contradictedId == null` (judge returns null, parse fails, judge throws, no candidates, or `autoSupersede` off) → **no supersede**. Never crash the session — best-effort, fully try/catch-wrapped (inherit correction-detector's envelope).
- **`autoSupersede` defaults `false`** — the block is skipped unless `config.autoSupersede === true`.
- **Reuse, don't duplicate:** `isCorrection` (existing), `supersedeMemory` (Plan 4), `resolveReviewModel`/`effectiveThinkingOverride`/`buildDirectReviewCompletionOptions`/`extractJsonPayload` (review-memory-ops). Export `extractJsonPayload` (currently module-private) rather than duplicating.
- **The judge is the direct path** (`completeSimple`), NOT `spawn`. `llmThinkingOverride` IS honored on the direct path (unlike spawn).
- **Capture the correction entry id** from the PARENT's `syncMemoryEntry` call (`correction-detector.ts:258`), not the subagent's save.
- Run tests via `( cd bun-apps/pi-agent-ext-hermes-memory && bun test … )` — never top-level `cd`.

## File Structure

- **Create:** `src/handlers/contradiction-judge.ts` (`runContradictionJudge` + `parseContradictionVerdict` + system prompt), `tests/handlers/contradiction-judge.test.ts`
- **Modify:** `src/handlers/review-memory-ops.ts` (export `extractJsonPayload`)
- **Modify:** `src/types.ts` (`autoSupersede?: boolean`), `src/config.ts` (DEFAULT `false` + loadConfig read)
- **Modify:** `src/handlers/correction-detector.ts` (capture `correctionEntryId`; add `runJudge` param; append the auto-trigger block)
- **Modify:** `tests/handlers/correction-detector.test.ts` (fake-`runJudge` tests)

---

## Task 1: `autoSupersede` config + the contradiction-judge helper

**Files:**
- Modify: `src/types.ts`, `src/config.ts`, `src/handlers/review-memory-ops.ts` (export `extractJsonPayload`)
- Create: `src/handlers/contradiction-judge.ts`, `tests/handlers/contradiction-judge.test.ts`

**Interfaces:**
- Produces: `MemoryConfig.autoSupersede?: boolean` (default false); `runContradictionJudge(ctx, { correctionText, candidates, config, signal, timeoutMs }): Promise<{ contradictedId: number | null }>`; `parseContradictionVerdict(raw): { contradictedId: number | null } | null` (pure).

- [ ] **Step 1: Write the failing test (parsing)** — create `tests/handlers/contradiction-judge.test.ts` (`node:test`/`assert`), unit-testing the PURE parser (no LLM):

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseContradictionVerdict } from "../../src/handlers/contradiction-judge.js";

describe("parseContradictionVerdict", () => {
  it("parses a contradicted_id", () => {
    assert.deepEqual(parseContradictionVerdict('{"contradicted_id": 42, "reason": "says npm not pnpm"}'), { contradictedId: 42 });
  });
  it("parses null (no contradiction)", () => {
    assert.deepEqual(parseContradictionVerdict('{"contradicted_id": null, "reason": "none"}'), { contradictedId: null });
  });
  it("handles a fenced json block", () => {
    assert.deepEqual(parseContradictionVerdict('```json\n{"contradicted_id": 7}\n```'), { contradictedId: 7 });
  });
  it("returns null on malformed", () => {
    assert.strictEqual(parseContradictionVerdict("not json"), null);
    assert.strictEqual(parseContradictionVerdict('{"contradicted_id": "oops"}'), null); // non-number
  });
});
```

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/contradiction-judge.test.ts )`. Expected: FAIL (module not found).

- [ ] **Step 3: Add the config flag** — `src/types.ts` (next to `worthScoring?: boolean`): `/** Auto-supersede a recalled memory when a correction contradicts it (judge-gated). Default: false (opt-in — supersession hides the prior from search). */ autoSupersede?: boolean;`. `src/config.ts`: `autoSupersede: false,` in `DEFAULT_CONFIG` (near `worthScoring: true`) + `if (typeof parsed.autoSupersede === "boolean") config.autoSupersede = parsed.autoSupersede;` in `loadConfig` (near the `worthScoring` read).

- [ ] **Step 4: Export `extractJsonPayload`** — in `src/handlers/review-memory-ops.ts`, change `function extractJsonPayload` to `export function extractJsonPayload`.

- [ ] **Step 5: Create `src/handlers/contradiction-judge.ts`** — read `src/handlers/review-memory-ops.ts` FIRST to get the exact `resolveReviewModel`/`effectiveThinkingOverride`/`buildDirectReviewCompletionOptions` exports + the `completeSimple`/`Message`/`Model`/`Api` import paths. Then:

```typescript
import { completeSimple, type Message } from "@earendil-works/pi-ai/compat"; // match review-memory-ops
import type { Model, Api } from "@earendil-works/pi-ai";                      // match review-memory-ops
import type { MemoryEntry } from "../store/repository.js";
import type { MemoryConfig } from "../types.js";
import { extractJsonPayload, resolveReviewModel, effectiveThinkingOverride, buildDirectReviewCompletionOptions } from "./review-memory-ops.js";

const CONTRADICTION_JUDGE_SYSTEM_PROMPT = `You judge whether a user's correction contradicts a stored memory.
Given a correction and a list of candidate memories (each with an id and content), return JSON: {"contradicted_id": <number|null>, "reason": "<short>"}
- Set contradicted_id to the SINGLE candidate id whose content the correction directly refutes/corrects. The candidate may be any target (memory/user/failure).
- If no candidate is contradicted, set contradicted_id to null.
- Output ONLY the JSON object.`;

/** Pure: parse + validate the judge's JSON verdict. Returns null if malformed. */
export function parseContradictionVerdict(raw: unknown): { contradictedId: number | null } | null {
  const json = typeof raw === "string" ? extractJsonPayload(raw) : raw;
  if (!json || typeof json !== "object") return null;
  const id = (json as { contradicted_id?: unknown }).contradicted_id;
  if (id === null) return { contradictedId: null };
  if (typeof id === "number" && Number.isFinite(id)) return { contradictedId: id };
  return null;
}

export interface ContradictionJudgeCtx {
  model: Model<Api> | undefined;
  modelRegistry: { getApiKeyAndHeaders(m: Model<Api>): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }> };
}

export interface ContradictionJudgeInput {
  correctionText: string;
  candidates: MemoryEntry[]; // already active-filtered by searchMemories
  config: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Returns the single contradicted candidate id, or null (no contradiction / unavailable / parse-fail). Never throws. */
export async function runContradictionJudge(
  ctx: ContradictionJudgeCtx,
  input: ContradictionJudgeInput,
): Promise<{ contradictedId: number | null }> {
  try {
    const model = resolveReviewModel(ctx.model, ctx.modelRegistry as never, input.config); // match review-memory-ops's registry type
    if (!model) return { contradictedId: null };
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return { contradictedId: null };
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? 30000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (input.signal) input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const candidateBlock = input.candidates.map((c) => `- id=${c.id}: ${c.content}`).join("\n");
      const userMessage: Message = { role: "user", content: [{ type: "text", text: `Correction: ${input.correctionText}\n\nCandidates:\n${candidateBlock}` }], timestamp: Date.now() };
      const thinking = effectiveThinkingOverride(input.config);
      const response = await completeSimple(
        model,
        { systemPrompt: CONTRADICTION_JUDGE_SYSTEM_PROMPT, messages: [userMessage] },
        buildDirectReviewCompletionOptions(model, { apiKey: auth.apiKey, headers: auth.headers ?? {}, env: auth.env }, thinking, controller.signal),
      );
      const text = typeof response === "string" ? response : (response as { content?: unknown }).content as string ?? "";
      return parseContradictionVerdict(text) ?? { contradictedId: null };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return { contradictedId: null }; // never throw — caller wraps best-effort anyway
  }
}
```
(Adjust the `completeSimple` response-shape read + the registry type cast to match `review-memory-ops.ts`'s exact usage — read `runDirectBackgroundReview` first and mirror it. The `response` text extraction must match how `review-memory-ops` extracts text from `completeSimple`'s result.)

- [ ] **Step 6: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/contradiction-judge.test.ts )` + `bunx tsc --noEmit`. Expected: parsing tests PASS; tsc clean.

- [ ] **Step 7: Commit** — `git add src/handlers/contradiction-judge.ts src/handlers/contradiction-judge.test.ts src/handlers/review-memory-ops.ts src/types.ts src/config.ts && git commit -m "feat(hermes-memory): autoSupersede config + contradiction-judge helper (completeSimple, judge-gated)"`.

---

## Task 2: Wire the auto-trigger into correction-detector

**Files:**
- Modify: `src/handlers/correction-detector.ts` (capture `correctionEntryId`; add `runJudge` param; append the auto-trigger block)
- Modify: `tests/handlers/correction-detector.test.ts` (fake-`runJudge` tests)

**Interfaces:**
- Produces: `setupCorrectionDetector(..., spawn, runJudge?)` — the new optional `runJudge` (default `runContradictionJudge`) for testability; the auto-trigger block fires when `config.autoSupersede === true`, fetches candidates via `searchMemories(directive)`, calls `runJudge`, and `supersedeMemory(contradictedId, correctionEntryId)` when contradicted.

- [ ] **Step 1: Write the failing tests** — append to `tests/handlers/correction-detector.test.ts` (mirror the existing scaffold). The tests pass a FAKE `runJudge` (9th param) so no LLM/model-registry is needed. Seed a prior memory, fire a correction turn, and assert:

```typescript
  it("auto-supersede (opt-in): judge contradicts → prior flipped to superseded", async () => {
    // seed a prior active memory the correction contradicts
    const prior = await memoryRepo.addMemory({ content: "always commit on main", target: "memory" });
    // fake judge that says `prior.id` is contradicted
    const fakeJudge = async () => ({ contradictedId: prior.id });
    setupCorrectionDetector(pi, store, projectStore, { ...config, autoSupersede: true } as any, memoryRepo, projectName, memoryToolDef, makeSpawn(), fakeJudge as any);
    fireMessageEnd("user", "no, never commit on main");
    fireTurnEnd([]);
    await settle();
    const got = await memoryRepo.getMemories({ target: "memory" });
    const p = got.find((m) => m.id === prior.id)!;
    assert.strictEqual(p.status, "superseded");
    assert.strictEqual(p.supersededBy, /* the correction entry's id — assert it's set / > 0 */ p.supersededBy);
    assert.ok(p.supersededBy && p.supersededBy > 0);
  });

  it("auto-supersede: judge returns null → no supersede", async () => {
    const prior = await memoryRepo.addMemory({ content: "use bun", target: "memory" });
    const fakeJudge = async () => ({ contradictedId: null });
    setupCorrectionDetector(pi, store, projectStore, { ...config, autoSupersede: true } as any, memoryRepo, projectName, memoryToolDef, makeSpawn(), fakeJudge as any);
    fireMessageEnd("user", "no, use pnpm instead"); // a correction
    fireTurnEnd([]);
    await settle();
    const p = (await memoryRepo.getMemories({ target: "memory" })).find((m) => m.id === prior.id)!;
    assert.notStrictEqual(p.status, "superseded"); // untouched
  });

  it("autoSupersede off (default): no judge call, no supersede", async () => {
    let judgeCalled = false;
    const fakeJudge = async () => { judgeCalled = true; return { contradictedId: null }; };
    const prior = await memoryRepo.addMemory({ content: "x", target: "memory" });
    setupCorrectionDetector(pi, store, projectStore, { ...config /* autoSupersede unset → false */ } as any, memoryRepo, projectName, memoryToolDef, makeSpawn(), fakeJudge as any);
    fireMessageEnd("user", "no, use pnpm instead");
    fireTurnEnd([]);
    await settle();
    assert.strictEqual(judgeCalled, false);
  });

  it("auto-supersede: judge throws → no supersede (best-effort)", async () => {
    const prior = await memoryRepo.addMemory({ content: "y", target: "memory" });
    const fakeJudge = async () => { throw new Error("boom"); };
    setupCorrectionDetector(pi, store, projectStore, { ...config, autoSupersede: true } as any, memoryRepo, projectName, memoryToolDef, makeSpawn(), fakeJudge as any);
    fireMessageEnd("user", "no, use pnpm instead");
    fireTurnEnd([]);
    await settle();
    const p = (await memoryRepo.getMemories({ target: "memory" })).find((m) => m.id === prior.id)!;
    assert.notStrictEqual(p.status, "superseded");
  });
```
(Match the existing test file's exact `config`/`pi`/`store`/`projectStore`/`projectName`/`memoryToolDef` fixture names — read the file's beforeEach first. The `searchMemories("no, never commit on main"…)` must lexically surface the prior — verify the prior's content tokenizes with the correction's terms, or seed the prior with content matching the correction directive.)

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/correction-detector.test.ts )`. Expected: FAIL (runJudge param / auto-trigger absent).

- [ ] **Step 3: Wire correction-detector** — in `src/handlers/correction-detector.ts`:
  - (a) Import `runContradictionJudge` + `MemoryEntry` (type).
  - (b) Add a trailing optional `runJudge` param to `setupCorrectionDetector` (after `spawn`): `runJudge: typeof runContradictionJudge = runContradictionJudge,` (so prod uses the real one; tests inject a fake).
  - (c) In the "Also save as a failure memory" block, change the `await memoryRepo.syncMemoryEntry({...})` call to capture the id: `const correctionSync = await memoryRepo.syncMemoryEntry({...}); const correctionEntryId = correctionSync.entry.id;` (keep the same input object; just capture the result).
  - (d) AFTER that sync succeeds (inside the same `if (addResult.success && memoryRepo)` block, gated by `config.autoSupersede === true`), append the auto-trigger:

```typescript
          if (config.autoSupersede === true) {
            try {
              const candidates = await memoryRepo.searchMemories(directive, { project: scopedProjectName ?? undefined, limit: 6 });
              if (candidates.length > 0) {
                const verdict = await runJudge(
                  ctx as unknown as Parameters<typeof runContradictionJudge>[0], // ctx.model/modelRegistry
                  { correctionText: directive, candidates, config, signal: ctx.signal, timeoutMs: 30000 },
                );
                if (verdict.contradictedId != null && candidates.some((c) => c.id === verdict.contradictedId)) {
                  await memoryRepo.supersedeMemory(verdict.contradictedId, correctionEntryId);
                  try { ctx.ui?.notify?.(`Auto-superseded memory #${verdict.contradictedId} (corrected by #${correctionEntryId}).`, "info"); } catch { /* best-effort */ }
                }
              }
            } catch {
              // best-effort — auto-supersede must never block the session
            }
          }
```
  (The `ctx` is the `turn_end` handler's `ctx` — `ctx.model`/`ctx.modelRegistry` exist on the real `ExtensionContext`. The fake `runJudge` in tests ignores `ctx`. The `candidates.some(...)` guard ensures the judge's id is real before superseding.)

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/correction-detector.test.ts )` then the full `tests/handlers/` + `tests/store/` suites + `bunx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git add src/handlers/correction-detector.ts tests/handlers/correction-detector.test.ts && git commit -m "feat(hermes-memory): supersession auto-trigger (judge-gated, correction→supersede, opt-in)"`.

---

## Self-Review

1. **Spec coverage (07, auto-trigger):** correction→judge→supersede (T2), judge-gated attribution (T1 helper + T2 wiring), safe default (no contradiction → no supersede), opt-in config (`autoSupersede` default false). Reuses `isCorrection` (gate inherited), `supersedeMemory` (Plan 4), `searchMemories` (candidate pool), the direct-judge pattern. OUT: recall-set candidate pool (chose searchMemories — decoupled); consolidation-coupling (separate plan); `.md` write-through (DB-only).
2. **Placeholder scan:** every code step has real code; where an import path/response-shape is uncertain ("match review-memory-ops's exact usage — read runDirectBackgroundReview first"), the implementer reads the reference first — named, not hand-waved. The test's `searchMemories`-surfaces-prior assumption is flagged for verification.
3. **Type consistency:** `runJudge`'s signature matches `runContradictionJudge`; `verdict.contradictedId: number | null`; `supersedeMemory(contradictedId, correctionEntryId)` (both `number`); the `candidates.some` guard validates the id before superseding.
4. **Safety:** the block is fully try/catch-wrapped + best-effort; the `candidates.some(c => c.id === verdict.contradictedId)` guard prevents superseding a non-candidate id (judge hallucination); `autoSupersede` defaults off (opt-in); the judge never throws (catches → null). The correction-entry-id capture is the mandatory prerequisite (without it, no `newId`).
5. **Behavior change:** NONE unless `autoSupersede === true`. Default-off → existing behavior unchanged; opt-in activates the auto-trigger.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-hermes-memory-supersession-auto-trigger.md`.

**Two execution options:**
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between.
2. **Inline Execution** — execute in this session via executing-plans.

**Which approach?**

This is **Plan 5a** (the supersession auto-trigger — the headline post-Tier-1 piece). It completes spec 07's "triggered by correction-detection": supersession becomes automatic + judge-gated (opt-in). Remaining post-Tier-1 backlog: **5b** consolidation-lineage-preservation; **5c** worth `error→mw_fail`; **5d** stable-id lineage (optional); + the minor hardening (graph-leak test, transactional `supersedeMemory`, wire `evidence`/`sources`).
