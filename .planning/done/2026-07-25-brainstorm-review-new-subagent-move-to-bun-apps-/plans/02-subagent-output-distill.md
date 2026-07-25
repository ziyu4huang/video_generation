# Subagent-Output Distill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hermes-memory background-review learning loop see (and thus auto-distill) `subagent` tool outputs, which are currently invisible because `getMessageText` only extracts `text` content blocks capped at 500 chars.

**Architecture:** A dedicated collector `collectSubagentOutputs(entries)` is added as a sibling to `collectMessageParts` in `src/handlers/message-parts.ts`. It builds an `id → toolName` map from assistant `toolCall`/`tool_use` blocks, then matches user-role `tool_result` blocks by `tool_use_id`, keeping only results of the `subagent` tool, extracting their textual content (string or text-block array) at a relaxed per-output cap (4000). `background-review.ts` appends these captured parts to the review prompt AFTER the recent-message window — so high-signal subagent findings are always reviewed without crowding out recent conversation. The shared `getMessageText` is deliberately left text-only (it is also consumed by `session-flush` and `correction-detector`; broadening it would inject grep/file-content noise into those paths).

**Tech Stack:** TypeScript, Bun runtime, `node:test` + `node:assert` (the project's test style — NOT `bun:test`'s `expect`).

## Global Constraints

- **Backend-neutral:** this feature only feeds text into the review PROMPT; the distill write path (`MemoryStore` / `MemoryRepository`) is untouched. No SQLite/Surreal hardcoding.
- **`getMessageText` stays text-only:** do NOT broaden `getMessageText` or `collectMessageParts` (used by `session-flush` + `correction-detector`). Subagent capture is a SEPARATE, dedicated path.
- **Always-on (no new config):** mirrors the existing background-review loop. The ticket's "always-on vs configurable" question is RESOLVED here as always-on — subagent outputs are captured whenever a review runs, exactly like user/assistant text. No config knob added.
- **Tool name:** the dispatch tool is registered as `"subagent"` (`pi-agent-ext-subagent/src/subagent-tool.ts:382`). Match that name only — NOT `subagent_runs` (read-only recall, no high-signal output).
- **Block shapes (grounded in `session-parser.ts` + `background-review.test.ts` fixtures):** assistant producer block is `{ type: "toolCall" | "tool_use", id: string, name: string }`; user result block is `{ type: "tool_result", tool_use_id: string, content: string | { type: "text", text: string }[] }`. Handle both `toolCall` (pi runtime) and `tool_use` (Anthropic) variants for the producer.
- **Test style:** `import { describe, it } from "node:test"; import assert from "node:assert";`. Run via `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`.
- **Deferred fog (from map "Not yet specified"):** e2e/real-dispatch validation appetite — this plan ships unit + integration coverage (construct a branch with a subagent exchange, assert the review prompt includes it). A real end-to-end "dispatch a subagent → observe a memory entry" test is deferred; the unit/integration pair is sufficient for correctness.

## File Structure

- **Modify** `src/handlers/message-parts.ts` — add `collectSubagentOutputs()` + a private `readToolResultContent()` helper + two named constants. Export the function (sibling to `collectMessageParts`).
- **Create** `tests/handlers/message-parts.test.ts` — unit tests for `collectSubagentOutputs` + a regression guard that `collectMessageParts` still excludes `tool_result` blocks.
- **Modify** `src/handlers/background-review.ts` — collect subagent outputs alongside conversation parts and append them to the review `parts` after the recent-message window; update the import.
- **Modify** `tests/handlers/background-review.test.ts` — integration test: a subagent tool_result in the branch reaches `reviewTask()`.
- **Modify** `CONTEXT.md` (package root) — append a short note documenting the subagent-output capture + the always-on stance + why `getMessageText` stays text-only.

The ticket estimated "~3-4 tasks"; the work decomposes cleanly into **2 right-sized tasks** below (pure collector; wiring + integration + docs). Forcing a 3rd would split a cohesive unit.

---

### Task 1: `collectSubagentOutputs()` pure collector + unit tests + shared-path guard

**Files:**
- Modify: `src/handlers/message-parts.ts` (append function + constants; do NOT touch existing `collectMessageParts` / `applyRecentMessageLimit` / the `getMessageText` import)
- Create: `tests/handlers/message-parts.test.ts`

**Interfaces:**
- Consumes: the session-branch entry shape `{ type: "message", message: { role, content: Block[] } }` (same shape `collectMessageParts` already iterates).
- Produces: `export function collectSubagentOutputs(entries: unknown[]): string[]` — returns `["[SUBAGENT]: <text>", ...]`, one entry per captured subagent result, in branch order, each capped at `SUBAGENT_OUTPUT_MAX_CHARS` (4000).

- [ ] **Step 1: Write the failing tests**

Create `tests/handlers/message-parts.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { collectMessageParts, collectSubagentOutputs } from "../../src/handlers/message-parts.js";

const msg = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

describe("collectSubagentOutputs", () => {
  it("captures a subagent tool_result matched to a subagent toolCall by id", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "call_1", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "call_1", content: "The subagent found X" }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), ["[SUBAGENT]: The subagent found X"]);
  });

  it("skips tool_results of non-subagent tools", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "c1", content: "ls output" }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), []);
  });

  it("accepts the Anthropic tool_use variant for the producer block", () => {
    const entries = [
      msg("assistant", [{ type: "tool_use", id: "u1", name: "subagent", input: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "block output" }] }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), ["[SUBAGENT]: block output"]);
  });

  it("reads tool_result content whether it is a string or a text-block array", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "s", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "s", content: "plain string content" }]),
      msg("assistant", [{ type: "toolCall", id: "a", name: "subagent", arguments: {} }]),
      msg("user", [{
        type: "tool_result", tool_use_id: "a",
        content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), [
      "[SUBAGENT]: plain string content",
      "[SUBAGENT]: first\nsecond",
    ]);
  });

  it("does NOT truncate at the 500-char getMessageText cap (relaxed cap)", () => {
    const long = "a".repeat(600); // > 500 (getMessageText cap), < 4000 (subagent cap)
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "c1", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "c1", content: long }]),
    ];
    assert.strictEqual(collectSubagentOutputs(entries)[0], `[SUBAGENT]: ${long}`);
  });

  it("caps each output at SUBAGENT_OUTPUT_MAX_CHARS (4000)", () => {
    const long = "b".repeat(5000);
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "c1", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "c1", content: long }]),
    ];
    assert.strictEqual(collectSubagentOutputs(entries)[0].length, `[SUBAGENT]: `.length + 4000);
  });

  it("returns [] when there are no subagent calls", () => {
    assert.deepStrictEqual(
      collectSubagentOutputs([msg("user", "hi"), msg("assistant", [{ type: "text", text: "hello" }])]),
      [],
    );
  });

  it("ignores orphan tool_results whose producer is not in the branch", () => {
    assert.deepStrictEqual(
      collectSubagentOutputs([msg("user", [{ type: "tool_result", tool_use_id: "ghost", content: "orphan" }])]),
      [],
    );
  });

  it("captures multiple subagent outputs in branch order", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "a", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "a", content: "first" }]),
      msg("assistant", [{ type: "toolCall", id: "b", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "b", content: "second" }]),
    ];
    assert.deepStrictEqual(collectSubagentOutputs(entries), ["[SUBAGENT]: first", "[SUBAGENT]: second"]);
  });
});

describe("collectMessageParts (shared path — regression guard)", () => {
  it("still excludes tool_result blocks (subagent capture is the dedicated path)", () => {
    const entries = [
      msg("assistant", [{ type: "toolCall", id: "c1", name: "subagent", arguments: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "c1", content: "must NOT appear in shared path" }]),
      msg("user", [{ type: "text", text: "actual user text" }]),
    ];
    const parts = collectMessageParts(entries);
    assert.ok(!parts.some((p) => p.includes("must NOT appear")), "shared path must exclude tool_result");
    assert.ok(parts.some((p) => p.includes("actual user text")), "shared path keeps text blocks");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/message-parts.test.ts )`
Expected: FAIL — `collectSubagentOutputs` is not exported (import error / `undefined is not a function`).

- [ ] **Step 3: Implement `collectSubagentOutputs` + helper + constants**

Append to `src/handlers/message-parts.ts` (after the existing `collectMessageParts`, before the file's end; do NOT modify any existing function):

```typescript
/** Per-output cap for captured subagent findings (relaxed vs getMessageText's 500). */
export const SUBAGENT_OUTPUT_MAX_CHARS = 4000;

/** Dispatch tool whose results the learning loop should capture. */
const SUBAGENT_TOOL_NAME = "subagent";

/** Read the textual content of a tool_result block (string or text-block array). */
function readToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as { type?: string; text?: string }[]) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Collect the textual output of `subagent` tool calls from a session branch.
 *
 * The shared `getMessageText` extracts only `text` content blocks (capped 500),
 * so a subagent's output — which returns as a `tool_result` block on the
 * preceding `subagent` tool_use — is invisible to `collectMessageParts` and thus
 * never reaches the background-review learning loop. This dedicated collector
 * closes that gap WITHOUT broadening `getMessageText` (which `session-flush` and
 * `correction-detector` also consume — broadening it would inject grep/file
 * noise into those paths).
 *
 * Pass 1 builds an `id → toolName` map from assistant `toolCall`/`tool_use`
 * blocks; pass 2 keeps user-role `tool_result` blocks whose producer was the
 * `subagent` tool, extracting their textual content at a relaxed per-output cap.
 */
export function collectSubagentOutputs(entries: unknown[]): string[] {
  const idToName = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    if (!message || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; id?: unknown; name?: unknown };
      if ((b.type === "toolCall" || b.type === "tool_use") && typeof b.id === "string" && typeof b.name === "string") {
        idToName.set(b.id, b.name);
      }
    }
  }

  const parts: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    if (!message || message.role !== "user") continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown };
      if (b.type !== "tool_result") continue;
      const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
      if (!id || idToName.get(id) !== SUBAGENT_TOOL_NAME) continue;
      const text = readToolResultContent(b.content);
      if (!text) continue;
      parts.push(`[SUBAGENT]: ${text.slice(0, SUBAGENT_OUTPUT_MAX_CHARS)}`);
    }
  }
  return parts;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/message-parts.test.ts )`
Expected: PASS — all 10 assertions green.

- [ ] **Step 5: Run the full handler suite to confirm no collateral damage**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: PASS — all pre-existing tests still green (the new file only adds tests; no source it depends on changed). Baseline before this PR was 695 pass.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/handlers/message-parts.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/handlers/message-parts.test.ts
git commit -m "feat(hermes-memory): collectSubagentOutputs — dedicated capture for learning loop"
```

---

### Task 2: Wire subagent outputs into the background-review loop + integration test + docs

**Files:**
- Modify: `src/handlers/background-review.ts` (import + the `parts` assembly inside `setupBackgroundReview`'s `turn_end` handler)
- Modify: `tests/handlers/background-review.test.ts` (add one integration test mirroring the existing "uses the full conversation by default" test)
- Modify: `CONTEXT.md` (package root — append a note)

**Interfaces:**
- Consumes: `collectSubagentOutputs(entries)` from Task 1 (same `entries` array already fetched via `ctx.sessionManager.getBranch()`).
- Produces: the review prompt (`reviewTask` / `directPrompt`) now includes `[SUBAGENT]: …` lines whenever a `subagent` dispatch occurred in the reviewed branch.

- [ ] **Step 1: Write the failing integration test**

In `tests/handlers/background-review.test.ts`, add a test alongside the existing "uses the full conversation by default" test (it reuses the file's existing `createMockPi` / `setupWithSpawn` / `fireMessageEnd` / `fireTurnEnd` / `makeBranch` / `reviewTask` helpers — read the file top to confirm their exact signatures):

```typescript
it("includes captured subagent outputs in the review prompt", async () => {
  const pi = createMockPi();
  setupWithSpawn(pi);

  fireMessageEnd("user");
  fireMessageEnd("user");
  fireMessageEnd("user");

  // A real-ish branch: threshold filler + a subagent dispatch and its tool_result.
  const branch = [
    ...makeBranch(6),
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "sa1", name: "subagent", arguments: {} }] } },
    { type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sa1", content: "The subagent surfaced a reusable pattern" }] } },
  ];

  for (let i = 0; i < 10; i++) {
    fireTurnEnd(branch);
  }
  await settle();

  const task = reviewTask();
  assert.ok(task.includes("The subagent surfaced a reusable pattern"), "review prompt must include the subagent output");
  assert.ok(task.includes("[SUBAGENT]"), "subagent output is labelled with its prefix");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/background-review.test.ts )`
Expected: FAIL — `task.includes("The subagent surfaced a reusable pattern")` is false (the subagent output is still filtered out by the text-only path).

- [ ] **Step 3: Wire `collectSubagentOutputs` into the review-loop `parts` assembly**

In `src/handlers/background-review.ts`:

(a) Update the import (line ~20) to also import `collectSubagentOutputs`:

```typescript
import { applyRecentMessageLimit, collectMessageParts, collectSubagentOutputs } from "./message-parts.js";
```

(b) Inside `setupBackgroundReview`'s `turn_end` handler, replace the conversation-parts assembly. The current block is:

```typescript
    let allParts: string[] = [];
    try {
      const entries = ctx.sessionManager.getBranch();
      allParts = collectMessageParts(entries);
    } catch {
      reviewInProgress = false;
      return;
    }
    if (allParts.length < 4) {
      reviewInProgress = false;
      return;
    }

    const parts = applyRecentMessageLimit(allParts, config.reviewRecentMessages);
```

Replace it with (subagent outputs appended AFTER the recent-message window so they are always reviewed without crowding out recent conversation):

```typescript
    let parts: string[];
    try {
      const entries = ctx.sessionManager.getBranch();
      const convoParts = collectMessageParts(entries);
      if (convoParts.length < 4) {
        reviewInProgress = false;
        return;
      }
      // Subagent outputs are appended after the recent-message window: they are
      // high-signal findings that should always be reviewed, without displacing
      // recent conversation and without broadening getMessageText (shared by
      // session-flush / correction-detector). Captured via the dedicated path.
      const subagentParts = collectSubagentOutputs(entries);
      parts = [...applyRecentMessageLimit(convoParts, config.reviewRecentMessages), ...subagentParts];
    } catch {
      reviewInProgress = false;
      return;
    }
```

(The downstream `promptInput` / `directPrompt` / `reviewTask` consume `parts` unchanged — they already join `parts` into the review context.)

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/background-review.test.ts )`
Expected: PASS — the new test is green; all existing background-review tests still pass (the `< 4` gate + recent-limit semantics are preserved for the conversation parts).

- [ ] **Step 5: Run the full suite + confirm no regression to the shared path**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: PASS — all green. In particular `session-flush` and `correction-detector` tests are unaffected (their `getMessageText` / `collectMessageParts` are byte-unchanged). Confirm via:

```bash
git diff origin/main -- bun-apps/pi-agent-ext-hermes-memory/src/types.ts
```
Expected: EMPTY (the shared `getMessageText` is not touched).

- [ ] **Step 6: Document the capture in CONTEXT.md**

Append a short section to `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md` (under the background-review / learning-loop area; if no such heading exists, add a `## Learning loop: subagent-output capture` section):

```markdown
## Learning loop: subagent-output capture

The background-review learning loop now also reviews `subagent` tool outputs.
A subagent's output returns to the parent session as a `tool_result` content
block, which the shared `getMessageText` deliberately skips (text-only, 500-char
cap — it is also consumed by `session-flush` and `correction-detector`, where
injecting tool-result noise would be harmful). A dedicated collector,
`collectSubagentOutputs` (`src/handlers/message-parts.ts`), matches each
`tool_result` to its producing `subagent` tool_use and feeds the text into the
review prompt at a relaxed per-output cap (4000), always-on — no config knob.
The existing distill logic decides what is notable, exactly as for user/assistant
text. `getMessageText` / `collectMessageParts` are intentionally left unchanged.
```

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/handlers/background-review.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/handlers/background-review.test.ts \
        bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md
git commit -m "feat(hermes-memory): feed subagent outputs into the background-review learning loop"
```

---

## Self-Review

**1. Spec coverage** (against ticket 05's resolution + acceptance):
- *Identify subagent tool_results* → Task 1 `collectSubagentOutputs` (id→name map + tool_result match). ✅
- *Capture + relax cap* → Task 1 (`SUBAGENT_OUTPUT_MAX_CHARS = 4000`, not 500). ✅
- *Feed to review* → Task 2 (appended to `parts` → `reviewTask` / `directPrompt`). ✅
- *Verify* → Task 1 unit tests + shared-path guard; Task 2 integration test + full-suite + `types.ts` unchanged check. ✅
- *Dedicated path, NOT broadening getMessageText* → Task 1 adds a sibling fn; Task 2 Step 5 proves `types.ts` diff is empty. ✅
- *No regression to session-flush/correction-detector* → Task 1 guard test + Task 2 Step 5. ✅
- *Backend-neutral* → Global Constraint; no store changes (only prompt assembly). ✅
- *Always-on confirmed* → Global Constraint + CONTEXT.md note. ✅

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to". All code blocks are complete. Test fixtures use grounded block shapes. ✅

**3. Type consistency:** `collectSubagentOutputs(entries: unknown[]): string[]` — Task 1 defines it, Task 2 imports + calls it with the same `entries`. Constant `SUBAGENT_OUTPUT_MAX_CHARS` named consistently. Helper `readToolResultContent` is module-private (not referenced cross-task). Prefix `[SUBAGENT]: ` identical in impl + tests. ✅

No issues found — plan is complete.
