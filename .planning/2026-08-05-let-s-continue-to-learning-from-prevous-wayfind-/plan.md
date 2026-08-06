# Failure-Memory Model v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the decided `failureModel: "v1"` spec (wayfind effort 2026-08-05, tickets 02/04/05/06) — topic-key dedup, write-gate recurrence→skill graduation warning, and deterministic backlog canonicalization — behind a feature flag, defaulting to today's behavior.

**Architecture:** A new pure `topic-key.ts` module (no LLM) extracts a deterministic subject-key per failure entry; the existing write-time warning gate in `_addInner` is extended (gated on `failureModel === "v1"`) to flag 2nd+ entries sharing a topic-key; a new `failure-model-migration.ts` (mirroring `project-memory-migration.ts`) collapses the existing backlog via deterministic longest-wins + compress-resolved rules. Graduation *execution* stays agent-driven (no auto-skill-creation) — the build makes recurrence *detectable* so the already-existing prompt rule at `constants.ts:132` can fire.

**Tech Stack:** TypeScript, Bun (`bun test`), YAML frontmatter (`yaml`), proper-lockfile, MLX-free pure functions.

## Spec reconciliation (read before implementing)

Two corrections to the wayfind spec, verified against the live code:

1. **`constants.ts:145` → `constants.ts:132`.** The spec cites "constants.ts:145 ('same procedure 2+ times → skill candidate')" as an existing rule the build "activates." The actual line is **132** (inside `MEMORY_POLICY_PROMPT`), and it is **prompt text**, not executable code. Implication: there is no auto-graduation mechanism to wire — graduation is the agent following prompt guidance once recurrence is *detectable*. This plan builds detection + warning only; graduation execution stays agent-driven (matches ticket 04 D3).
2. **`pi-memory-bulk-dedup` skill does not exist.** Ticket 04 treats it as pre-existing ("extend the existing skill"). A repo-wide search found no such skill. Task 5 therefore **creates** it (not extends).

## Global Constraints

- **Feature flag, default `legacy`.** `config.failureModel: "legacy" | "v1"`, default `"legacy"`. Legacy path must be byte-identical (the write-gate gate ensures this).
- **⚠ Config drift trap (4 spots).** Adding `failureModel` requires touching ALL of: `types.ts` (field) + `constants.ts` (`DEFAULT_FAILURE_MODEL`) + `config.ts` `DEFAULT_CONFIG` + `config.ts` `loadConfig` allowlist. Missing any one silently drops a config-file value.
- **Destructive canonicalization (REJECTED.md).** No lineage links; merged entries are the new truth. Overflow/trim priority: superseded FIRST, stale lower, active NEVER trimmed.
- **`.md`-first.** The `.md` is source of truth; the DB re-hydrates. The migration operates on the `.md`; no direct DB writes.
- **Agent-driven.** Warn-don't-block. No auto-skill-creation, no auto-eviction. Every destructive compression passes an agent eye.
- **Deterministic migration (no LLM).** The backlog canonicalization is pure fs read/write → auditable before/after diff.
- **Tests.** Run via `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`. Co-located `*.test.ts` next to modules (matching `merge-plan.test.ts`, `auto-consolidate.test.ts`); config tests live in `tests/config.test.ts`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/types.ts` | Add `failureModel?: "legacy" \| "v1"` + `FailureModel` type | 1 |
| `src/constants.ts` | Add `DEFAULT_FAILURE_MODEL = "legacy"` | 1 |
| `src/config.ts` | `DEFAULT_CONFIG` + `loadConfig` allowlist + import | 1 |
| `tests/config.test.ts` | `failureModel` parse/default/invalid cases | 1 |
| `src/store/topic-key.ts` | **Create** — pure topic-key extraction + recurrence finder + warning formatter | 2 |
| `src/store/topic-key.test.ts` | **Create** — unit tests for all exports | 2 |
| `src/store/memory-store.ts` | Extend `_addInner` with the gated recurrence warning | 3 |
| `src/failure-model-migration.ts` | **Create** — deterministic backlog canonicalization (mirror `project-memory-migration.ts`) | 4 |
| `src/failure-model-migration.test.ts` | **Create** — fixture-based collapse/compress assertions | 4 |
| `skills/pi-memory-bulk-dedup/SKILL.md` | **Create** — the bulk-dedup procedural skill (near-dup + topic-family + graduation) | 5 |

---

## Task 1: `failureModel` config flag (the 4-spot drift trap)

**Files:**
- Modify: `src/types.ts` (add type + field)
- Modify: `src/constants.ts` (add default)
- Modify: `src/config.ts` (import + `DEFAULT_CONFIG` + `loadConfig` allowlist)
- Test: `tests/config.test.ts` (append cases)

**Interfaces:**
- Consumes: nothing (leaf config task).
- Produces: `config.failureModel: "legacy" | "v1"` readable as `this.config.failureModel` inside `MemoryStore` (used by Task 3).

- [ ] **Step 1: Write the failing test** — append to `tests/config.test.ts`:

```typescript
test("failureModel: default legacy, reads v1, ignores invalid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-fm-"));
  const cfgPath = path.join(dir, "hermes-memory-config.json");
  // absent → default legacy
  fs.writeFileSync(cfgPath, JSON.stringify({}));
  expect(loadConfig(cfgPath).failureModel).toBe("legacy");
  // explicit v1
  fs.writeFileSync(cfgPath, JSON.stringify({ failureModel: "v1" }));
  expect(loadConfig(cfgPath).failureModel).toBe("v1");
  // invalid value ignored → default
  fs.writeFileSync(cfgPath, JSON.stringify({ failureModel: "bogus" }));
  expect(loadConfig(cfgPath).failureModel).toBe("legacy");
});
```

Ensure the file's top imports already include `loadConfig`, `fs`, `os`, `path` (the existing config tests do). If `os` is missing, add `import * as os from "node:os";`.

- [ ] **Step 2: Run the test — verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/config.test.ts )`
Expected: FAIL — `failureModel` is `undefined` (field does not exist yet), so `.toBe("legacy")` fails.

- [ ] **Step 3: Add the type** — in `src/types.ts`, add near the `memoryMode` block:

```typescript
/** Failure-memory model generation. "legacy" (default) = today's behavior;
 *  "v1" = topic-key dedup + recurrence→skill graduation warning + deterministic
 *  backlog canonicalization (wayfind effort 2026-08-05). Mirrors `memoryMode`'s
 *  flag shape. ⚠ paired with config.ts loadConfig allowlist (the drift trap). */
export type FailureModel = "legacy" | "v1";
```

and inside `interface MemoryConfig { ... }` (next to `memoryMode`):

```typescript
  /** Failure-memory model generation. Default "legacy". See `FailureModel`. */
  failureModel?: FailureModel;
```

- [ ] **Step 4: Add the default constant** — in `src/constants.ts`, near `DEFAULT_FAILURE_CHAR_LIMIT`:

```typescript
/** Failure-memory model generation. Default "legacy" (today's behavior); "v1"
 *  opts into topic-key dedup + write-gate graduation warning + backlog
 *  canonicalization. Mirrors memoryMode's flag shape. */
export const DEFAULT_FAILURE_MODEL = "legacy" as const;
```

- [ ] **Step 5: Wire config.ts (DEFAULT_CONFIG + import + allowlist)** — three edits in `src/config.ts`:

(a) Add `DEFAULT_FAILURE_MODEL,` to the import block from `"./constants.js"` (lines 4–26).

(b) Add to `DEFAULT_CONFIG` (anywhere in the object, e.g. after `dbBackend: "sqlite",`):

```typescript
  failureModel: DEFAULT_FAILURE_MODEL,
```

(c) Add the allowlist line in `loadConfig()`, mirroring the `memoryMode` line (~line 239):

```typescript
  if (parsed.failureModel === "legacy" || parsed.failureModel === "v1") config.failureModel = parsed.failureModel;
```

- [ ] **Step 6: Run the test — verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/config.test.ts )`
Expected: PASS — all three assertions (default / v1 / invalid-ignored).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/types.ts bun-apps/pi-agent-ext-hermes-memory/src/constants.ts bun-apps/pi-agent-ext-hermes-memory/src/config.ts bun-apps/pi-agent-ext-hermes-memory/tests/config.test.ts
git commit -m "feat(memory): add failureModel config flag (legacy|v1)"
```

---

## Task 2: `topic-key.ts` — deterministic subject-key + recurrence finder

**Files:**
- Create: `src/store/topic-key.ts`
- Test: `src/store/topic-key.test.ts`

**Interfaces:**
- Consumes: `nearDupTokens` from `./near-dup.js`; `MemoryCategory` from `../types.js`.
- Produces: `topicKey(content)`, `deriveCategory(content)`, `findTopicRecurrence(content, existing)`, `formatTopicRecurrenceWarning(hit)` — used by Task 3 (write-gate) and Task 4 (migration).

- [ ] **Step 1: Write the failing test** — create `src/store/topic-key.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { topicKey, deriveCategory, findTopicRecurrence, formatTopicRecurrenceWarning } from "./topic-key.js";

test("tool-quirk topic-key = subject tool name (backtick span)", () => {
  expect(topicKey("[tool-quirk] `await_pr_merge` blocks when CI green — pre #1030")).toBe("await_pr_merge");
});

test("tool-quirk topic-key falls back to first identifier without backticks", () => {
  expect(topicKey("[tool-quirk] gh pr checks 1042 hangs on pending")).toBe("gh_pr");
});

test("non-tool-quirk topic-key = first 3 distinctive tokens", () => {
  expect(topicKey("[insight] SurrealDB snowball tokenizer ignores short terms"))
    .toBe("surrealdb_snowball_tokenizer");
});

test("evolving family: same subject, different wording → same key", () => {
  const a = "[tool-quirk] `await_pr_merge` kept blocking after #1028 cross-worktree merge";
  const b = "[tool-quirk] `await_pr_merge` now merges directly once CI green (post #1030)";
  expect(topicKey(a)).toBe(topicKey(b));
  expect(topicKey(a)).toBe("await_pr_merge");
});

test("findTopicRecurrence returns the first existing match", () => {
  const existing = [
    "[insight] some unrelated lesson about bun install caching",
    "[tool-quirk] `await_pr_merge` historical hazard pre-#1030",
  ];
  const hit = findTopicRecurrence("[tool-quirk] `await_pr_merge` new incident", existing);
  expect(hit).not.toBeNull();
  expect(hit!.index).toBe(1);
  expect(hit!.topicKey).toBe("await_pr_merge");
});

test("findTopicRecurrence null when no shared key", () => {
  expect(findTopicRecurrence("[tool-quirk] `git_rebase` quirk", ["[tool-quirk] `await_pr_merge` quirk"])).toBeNull();
});

test("deriveCategory reads the [category] prefix", () => {
  expect(deriveCategory("[tool-quirk] x")).toBe("tool-quirk");
  expect(deriveCategory("[failure] y")).toBe("failure");
  expect(deriveCategory("no prefix")).toBeNull();
});

test("formatTopicRecurrenceWarning names the key and previews the match", () => {
  const hit = findTopicRecurrence("[tool-quirk] `await_pr_merge` new", ["[tool-quirk] `await_pr_merge` old hazard"]);
  expect(hit).not.toBeNull();
  const msg = formatTopicRecurrenceWarning(hit!);
  expect(msg).toContain("await_pr_merge");
  expect(msg).toContain("skill");
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/topic-key.test.ts )`
Expected: FAIL — module `./topic-key.js` does not exist (import error).

- [ ] **Step 3: Write the implementation** — create `src/store/topic-key.ts`:

```typescript
/**
 * Topic-key extraction + recurrence detection for failureModel "v1"
 * (wayfind effort 2026-08-05, ticket 04 — hybrid identity).
 *
 * Containment (near-dup.ts) catches wording-variants but misses *evolving
 * families* — the same subject re-captured across different incidents with low
 * token overlap (e.g. the `await_pr_merge` ×7 cluster). The TOPIC-KEY is the
 * subject entity used to group such families; it is also the signal the
 * recurrence→skill graduation prompt rule (constants.ts:132) keys on.
 *
 * Deterministic (no LLM) so the backlog canonicalization is auditable.
 * tool-quirk → the subject tool name; other categories → the first few
 * distinctive content tokens.
 */
import type { MemoryCategory } from "../types.js";
import { nearDupTokens } from "./near-dup.js";

const CATEGORY_PREFIX_RE = /^\s*\[([^\]]+)\]\s*/;
const KNOWN_CATEGORIES: MemoryCategory[] = [
  "failure", "correction", "insight", "preference", "convention", "tool-quirk",
];

/** Derive the failure category from a leading `[category]` prefix, or null. */
export function deriveCategory(content: string): MemoryCategory | null {
  const m = content.match(CATEGORY_PREFIX_RE);
  if (!m) return null;
  return (KNOWN_CATEGORIES as string[]).includes(m[1]) ? (m[1] as MemoryCategory) : null;
}

function stripCategoryPrefix(text: string): string {
  return text.replace(CATEGORY_PREFIX_RE, "");
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 64);
}

/**
 * Deterministic topic-key for recurrence grouping.
 * - tool-quirk → subject tool/command: first backtick code span, else the first
 *   identifier-like token. (e.g. "`await_pr_merge` merges …" → "await_pr_merge".)
 * - other categories → first 3 distinctive content tokens (positional), joined "_".
 * Returns "" when no distinctive token is found (too short to group).
 */
export function topicKey(content: string): string {
  const category = deriveCategory(content);
  const body = stripCategoryPrefix(content).trim();
  if (category === "tool-quirk") {
    const codeSpan = body.match(/`([^`]+)`/);
    if (codeSpan) return normalizeKey(codeSpan[1]);
    const ident = body.match(/\b([a-z][a-z0-9_]+(?:[\s-][a-z][a-z0-9_-]+)?)\b/i);
    if (ident) return normalizeKey(ident[1]);
  }
  const tokens = [...nearDupTokens(body)];
  return tokens.slice(0, 3).join("_");
}

export interface TopicRecurrenceHit {
  /** Index into the `existing` array of the matched entry. */
  index: number;
  /** The shared topic-key. */
  topicKey: string;
  /** First ~60 chars of the matched existing entry. */
  preview: string;
}

/**
 * Find the first existing entry sharing `content`'s topic-key. `existing` entries
 * are assumed already metadata-stripped by the caller (as MemoryStore does for
 * near-dup). Returns null when `content` has no topic-key or no existing entry
 * shares it. Mirrors `findNearDuplicate`'s shape.
 */
export function findTopicRecurrence(
  content: string,
  existing: string[],
): TopicRecurrenceHit | null {
  const key = topicKey(content);
  if (!key) return null;
  for (let i = 0; i < existing.length; i++) {
    const entry = existing[i] ?? "";
    if (topicKey(entry) === key) {
      return { index: i, topicKey: key, preview: entry.slice(0, 60).trim() };
    }
  }
  return null;
}

/** Format the write-time recurrence warning (warn-don't-block). Pure + unit-tested
 *  so the _addInner wiring (Task 3) needs no store-harness test. */
export function formatTopicRecurrenceWarning(hit: TopicRecurrenceHit): string {
  return ` ⚠ recurring topic "${hit.topicKey}" (already captured: "${hit.preview}…"). A lesson needed ≥2× is procedural → consider graduating it to a skill (skill_manage) and consolidating these entries.`;
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/topic-key.test.ts )`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/topic-key.ts bun-apps/pi-agent-ext-hermes-memory/src/store/topic-key.test.ts
git commit -m "feat(memory): add topic-key extraction + recurrence detector"
```

---

## Task 3: Write-gate recurrence warning in `_addInner`

**Files:**
- Modify: `src/store/memory-store.ts` (import + ~6-line append in `_addInner`)

**Interfaces:**
- Consumes: Task 1 (`this.config.failureModel`), Task 2 (`findTopicRecurrence`, `formatTopicRecurrenceWarning`).
- Produces: a `⚠ recurring topic …` warning appended to the add result message when a 2nd+ failure entry shares a topic-key (v1 only). Legacy unchanged.

> **Test strategy:** the warning *logic* is the pure `findTopicRecurrence` + `formatTopicRecurrenceWarning` pair, already unit-tested in Task 2. The wiring here is a config-gated string append to the existing `nearDupNote` (so every return path that includes `nearDupNote` carries it). Verification = the full suite stays green (legacy byte-identical) + a manual legacy-default check. No new store-harness test is needed because no new logic lives here.

- [ ] **Step 1: Add the import** — in `src/store/memory-store.ts`, extend the near-dup import (line ~44):

```typescript
import { DEFAULT_NEAR_DUP_THRESHOLD, findNearDuplicate } from "./near-dup.js";
import { findTopicRecurrence, formatTopicRecurrenceWarning } from "./topic-key.js";
```

- [ ] **Step 2: Append the gated warning** — in `_addInner`, immediately AFTER the existing near-dup block that sets `nearDupNote` (the `if (nearDupThreshold > 0) { … }` block, ~line 1029), insert:

```typescript
    // Topic-key recurrence WARNING (wayfind 2026-08-05 ticket 04, failureModel v1):
    // 2nd+ failure entry sharing a topic-key → flag it so the agent graduates the
    // recurring procedure to a skill (constants.ts:132 prompt rule) instead of
    // accumulating. Warning only; graduation execution is agent-driven. Gated on
    // v1 so legacy behavior is byte-identical. Appended to nearDupNote so every
    // return path that surfaces nearDupNote carries it.
    if (target === "failure" && this.config.failureModel === "v1") {
      const topicHit = findTopicRecurrence(content, strippedEntries);
      if (topicHit) nearDupNote += formatTopicRecurrenceWarning(topicHit);
    }
```

- [ ] **Step 3: Run the full suite — verify no regression**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: PASS — all pre-existing tests green. The gate (`failureModel` defaults to `"legacy"`) means the new branch is dormant under default config, so existing assertions are unaffected.

- [ ] **Step 4: Manual legacy-default check**

Run: `grep -n "this.config.failureModel" bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts`
Expected: exactly one hit, inside the `if (target === "failure" && …)` gate. Confirm `failureModel` is never read without the `"v1"` equality check (legacy default never appends the warning).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts
git commit -m "feat(memory): write-gate recurrence→skill warning (failureModel v1)"
```

---

## Task 4: Deterministic backlog canonicalization (`failure-model-migration.ts`)

**Files:**
- Create: `src/failure-model-migration.ts`
- Test: `src/failure-model-migration.test.ts`

**Interfaces:**
- Consumes: `ENTRY_DELIMITER` (`./constants.js`), `parseMarkdownMemoryEntry` / `serializeMetadataComment` (`./store/memory-format.js`), `findNearDuplicate` (`./store/near-dup.js`), `topicKey` / `findTopicRecurrence` (`./store/topic-key.js`).
- Produces: `canonicalizeFailureBacklog({ failuresPath, dryRun })` → `FailureModelMigrationResult` (counts + diff). Mirrors `project-memory-migration.ts`'s pure-fs + result-struct pattern.

**Canonicalization rules (deterministic, no LLM):**
1. **Near-dup wording collapse** — containment ≥0.6 (reuse `findNearDuplicate`); within a group keep the LONGEST entry, drop the rest.
2. **Topic-family collapse** — among survivors, group by `topicKey`; any group ≥2 keeps the entry with the most recent `last` date (ties → longest), drops the rest.
3. **Compress resolved/stale** — survivors with `state === "resolved"` OR content matching the resolved-marker regex compress to a one-line canonical fact (first sentence, ≤120 chars) re-serialized via `serializeMetadataComment`.
4. Active/unique entries are never touched (REJECTED.md: trim never touches active).

- [ ] **Step 1: Write the failing test** — create `src/failure-model-migration.test.ts`:

```typescript
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ENTRY_DELIMITER } from "./constants.js";
import { canonicalizeFailureBacklog } from "./failure-model-migration.js";

/** Build a frontmatter-shape failure entry (matches the store's encodeEntry output). */
function fm(id: string, body: string, created: string, last: string, state?: string): string {
  const fmLines = ["---", `id: ${id}`, `created: ${created}`, `last: ${last}`];
  if (state) fmLines.push(`state: ${state}`);
  fmLines.push("---", body);
  return fmLines.join("\n");
}

test("dry-run collapses the await_pr_merge family (7→fewer) and compresses resolved", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-mig-"));
  const failuresPath = path.join(dir, "failures.md");
  const entries = [
    fm("a", "[tool-quirk] `await_pr_merge` blocks merge until CI green — pre #1030 hazard", "2026-08-02", "2026-08-02"),
    fm("b", "[tool-quirk] `await_pr_merge` blocks merge until CI green — pre #1030 hazard", "2026-08-02", "2026-08-02"), // verbatim dupe
    fm("c", "[tool-quirk] `await_pr_merge` cross-worktree #1028 incident details here", "2026-08-03", "2026-08-03"),
    fm("d", "[tool-quirk] `await_pr_merge` now merges directly once CI green (post #1030) — resolved", "2026-08-04", "2026-08-04", "resolved"),
    fm("e", "[insight] unrelated unique lesson about mlx bfloat16 dtype handling", "2026-08-01", "2026-08-01"),
  ];
  fs.writeFileSync(failuresPath, entries.join(ENTRY_DELIMITER), "utf-8");

  const result = canonicalizeFailureBacklog({ failuresPath, dryRun: true });

  expect(result.scanned).toBe(5);
  // the unique insight (e) must survive untouched
  expect(result.diff).toContain("unrelated unique lesson about mlx");
  // 4 await_pr_merge entries collapsed + 1 verbatim dupe dropped → net < 5 survivors
  expect(result.dropped + result.nearDupCollapsed + result.topicCollapsed).toBeGreaterThan(0);
  // dry-run must NOT mutate the file
  expect(fs.readFileSync(failuresPath, "utf-8")).toBe(entries.join(ENTRY_DELIMITER));
});

test("apply writes a smaller file and produces a backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-mig-"));
  const failuresPath = path.join(dir, "failures.md");
  const original = [
    fm("a", "[tool-quirk] `await_pr_merge` first capture", "2026-08-02", "2026-08-02"),
    fm("b", "[tool-quirk] `await_pr_merge` second capture", "2026-08-03", "2026-08-03"),
  ].join(ENTRY_DELIMITER);
  fs.writeFileSync(failuresPath, original, "utf-8");

  const result = canonicalizeFailureBacklog({ failuresPath, dryRun: false, backup: true });
  const after = fs.readFileSync(failuresPath, "utf-8");
  expect(after.length).toBeLessThan(original.length);
  expect(fs.existsSync(failuresPath + ".bak")).toBe(true);
  expect(fs.readFileSync(failuresPath + ".bak", "utf-8")).toBe(original);
});

test("active unique entries are never trimmed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-mig-"));
  const failuresPath = path.join(dir, "failures.md");
  const entries = [
    fm("a", "[insight] unique active lesson one about surrealdb snowball", "2026-08-01", "2026-08-01"),
    fm("b", "[insight] unique active lesson two about mlx performance", "2026-08-02", "2026-08-02"),
  ].join(ENTRY_DELIMITER);
  fs.writeFileSync(failuresPath, entries, "utf-8");

  const result = canonicalizeFailureBacklog({ failuresPath, dryRun: true });
  expect(result.dropped).toBe(0);
  expect(result.nearDupCollapsed).toBe(0);
  expect(result.topicCollapsed).toBe(0);
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/failure-model-migration.test.ts )`
Expected: FAIL — module `./failure-model-migration.js` does not exist.

- [ ] **Step 3: Write the implementation** — create `src/failure-model-migration.ts`:

```typescript
/**
 * One-time deterministic canonicalization of the failure backlog (wayfind
 * 2026-08-05, tickets 04/05/06). Mirrors project-memory-migration.ts: pure fs
 * read/write, result struct, no LLM → auditable before/after diff.
 *
 * Three tiers, applied in order: (1) near-dup wording collapse (longest-wins),
 * (2) topic-family collapse (most-recent/resolved wins), (3) compress resolved/
 * stale to a one-line canonical fact. Active unique entries are never touched.
 *
 * `.md`-first: operates on the markdown source-of-truth; the DB re-hydrates.
 * Always dry-run first; the agent confirms the diff before an apply with backup.
 */
import * as fs from "node:fs";
import { ENTRY_DELIMITER } from "./constants.js";
import { parseMarkdownMemoryEntry, serializeMetadataComment, today } from "./store/memory-format.js";
import { findNearDuplicate, DEFAULT_NEAR_DUP_THRESHOLD } from "./store/near-dup.js";
import { topicKey } from "./store/topic-key.js";

export interface FailureModelMigrationResult {
  scanned: number;
  /** Near-dup wording groups collapsed. */
  nearDupCollapsed: number;
  /** Topic-family groups collapsed. */
  topicCollapsed: number;
  /** Resolved/stale entries compressed to a one-line fact. */
  compressed: number;
  /** Entries dropped (verbatim dupes / consumed by a group). */
  dropped: number;
  /** Final char total after canonicalization. */
  finalChars: number;
  warnings: string[];
  /** Human-readable before→after diff (populated even in dry-run). */
  diff: string;
}

const RESOLVED_MARKER_RE = /\b(resolved|RESOLVED|superseded|fixed|now (works|merges|succeeds))\b/i;
const COMPRESS_MAX_CHARS = 120;

function readEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];
  return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

/** Compress a resolved entry to a one-line canonical fact. */
function compressToFact(raw: string): string {
  const parsed = parseMarkdownMemoryEntry(raw, "failure");
  const body = parsed.content.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
  const firstSentence = body.split(/[.—]/)[0]?.trim() ?? body;
  const capped = firstSentence.length > COMPRESS_MAX_CHARS
    ? firstSentence.slice(0, COMPRESS_MAX_CHARS - 1) + "…"
    : firstSentence;
  return serializeMetadataComment({
    text: `[${parsed.category ?? "failure"}] ${capped} (resolved/compressed)`,
    created: parsed.created ?? today(),
    lastReferenced: today(),
  });
}

export function canonicalizeFailureBacklog(opts: {
  failuresPath: string;
  dryRun: boolean;
  backup?: boolean;
}): FailureModelMigrationResult {
  const result: FailureModelMigrationResult = {
    scanned: 0, nearDupCollapsed: 0, topicCollapsed: 0,
    compressed: 0, dropped: 0, finalChars: 0, warnings: [], diff: "",
  };

  const original = readEntries(opts.failuresPath);
  result.scanned = original.length;
  if (original.length === 0) {
    result.diff = "(empty store — nothing to canonicalize)";
    return result;
  }
  const before = original.join(ENTRY_DELIMITER);

  // Tier 1: near-dup wording collapse (longest-wins).
  const consumed = new Set<number>();
  const afterTier1: string[] = [];
  for (let i = 0; i < original.length; i++) {
    if (consumed.has(i)) continue;
    let group = [original[i]];
    const strippedI = parseMarkdownMemoryEntry(original[i], "failure").content;
    for (let j = i + 1; j < original.length; j++) {
      if (consumed.has(j)) continue;
      const strippedJ = parseMarkdownMemoryEntry(original[j], "failure").content;
      const hit = findNearDuplicate(strippedI, [strippedJ], DEFAULT_NEAR_DUP_THRESHOLD);
      if (hit) {
        group.push(original[j]);
        consumed.add(j);
      }
    }
    if (group.length > 1) {
      result.nearDupCollapsed += group.length - 1;
      result.dropped += group.length - 1;
      // longest-wins
      afterTier1.push(group.reduce((a, b) => (a.length >= b.length ? a : b)));
    } else {
      afterTier1.push(original[i]);
    }
  }

  // Tier 2: topic-family collapse (most-recent last-date wins; ties → longest).
  const consumed2 = new Set<number>();
  const afterTier2: string[] = [];
  for (let i = 0; i < afterTier1.length; i++) {
    if (consumed2.has(i)) continue;
    const keyI = topicKey(parseMarkdownMemoryEntry(afterTier1[i], "failure").content);
    if (!keyI) { afterTier2.push(afterTier1[i]); continue; }
    const groupIdx = [i];
    for (let j = i + 1; j < afterTier1.length; j++) {
      if (consumed2.has(j)) continue;
      const keyJ = topicKey(parseMarkdownMemoryEntry(afterTier1[j], "failure").content);
      if (keyJ === keyI) { groupIdx.push(j); consumed2.add(j); }
    }
    if (groupIdx.length > 1) {
      result.topicCollapsed += groupIdx.length - 1;
      result.dropped += groupIdx.length - 1;
      const winner = groupIdx
        .map((idx) => ({ idx, raw: afterTier1[idx], parsed: parseMarkdownMemoryEntry(afterTier1[idx], "failure") }))
        .sort((a, b) => (b.parsed.lastReferenced ?? "").localeCompare(a.parsed.lastReferenced ?? "")
          || b.raw.length - a.raw.length)[0];
      afterTier2.push(winner.raw);
    } else {
      afterTier2.push(afterTier1[i]);
    }
  }

  // Tier 3: compress resolved/stale survivors to a one-line canonical fact.
  const finalEntries = afterTier2.map((raw) => {
    const parsed = parseMarkdownMemoryEntry(raw, "failure");
    const isResolved = parsed.state === "resolved" || RESOLVED_MARKER_RE.test(parsed.content);
    if (!isResolved) return raw;
    result.compressed++;
    return compressToFact(raw);
  });

  const after = finalEntries.join(ENTRY_DELIMITER);
  result.finalChars = after.length;

  result.diff =
    `--- before (${before.length} chars, ${original.length} entries)\n` +
    `+++ after (${after.length} chars, ${finalEntries.length} entries)\n` +
    `near-dup collapsed: ${result.nearDupCollapsed} | topic collapsed: ${result.topicCollapsed} | ` +
    `compressed: ${result.compressed} | dropped: ${result.dropped}\n\n` +
    after;

  if (!opts.dryRun) {
    if (opts.backup) fs.writeFileSync(opts.failuresPath + ".bak", before, "utf-8");
    try {
      fs.writeFileSync(opts.failuresPath, after, "utf-8");
    } catch (err) {
      result.warnings.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/failure-model-migration.test.ts )`
Expected: PASS — family collapses, dry-run is non-mutating, apply writes + backs up, active uniques untouched.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/failure-model-migration.ts bun-apps/pi-agent-ext-hermes-memory/src/failure-model-migration.test.ts
git commit -m "feat(memory): deterministic failure-backlog canonicalization (v1)"
```

---

## Task 5: `pi-memory-bulk-dedup` skill (create — does not yet exist)

**Files:**
- Create: `skills/pi-memory-bulk-dedup/SKILL.md`

**Interfaces:**
- Consumes: Task 4 (`canonicalizeFailureBacklog` dry-run/apply), Task 2 (`topicKey`). This is a procedural skill (agent-facing doc), not code.
- Produces: a repeatable how-to for bulk dedup of the failure `.md` store — near-dup + topic-family detection, deterministic longest-wins, graduation recommendation, dry-run/backup/FTS-orphan-check, `.md`-first.

> **Spec note:** ticket 04 calls this an "existing skill to extend." It does not exist in-repo (verified). This task creates it.

- [ ] **Step 1: Create the skill** — `skills/pi-memory-bulk-dedup/SKILL.md`:

````markdown
---
name: pi-memory-bulk-dedup
description: Bulk-dedup the hermes-memory failure store — near-dup + topic-family collapse, resolved-compression, recurrence→skill graduation. Dry-run + backup + diff before any destructive apply.
---

# Bulk dedup the failure-memory store

Use when `memory_search(target="failure")` or a staleness audit shows recurring
topics / near-duplicates crowding the 40K-char failure budget (the
`await_pr_merge` ×7 pattern), and `config.failureModel` is `"v1"`.

## When to use

- The failure store is near its `failureCharLimit` (default 40K).
- A write-gate `⚠ recurring topic` warning fired and you want to consolidate.
- A staleness audit (`memory` tool, action `audit`) lists resolved/stale entries.

## Procedure

1. **Dry-run the deterministic canonicalization** (no LLM, auditable diff). In
   the `bun-apps/pi-agent-ext-hermes-memory` package, run the migration in
   dry-run against `~/.pi/agent/pi-hermes-memory/failures.md` and READ the diff:
   near-dup wording collapse (longest-wins) + topic-family collapse
   (most-recent/resolved wins) + resolved→one-line-fact compression. Active
   unique entries are never touched.

2. **Review the diff.** Confirm no unique lesson is dropped (REJECTED.md:
   destructive consolidation must not silently drop a unique lesson). If a
   collapsed family is a recurring *procedure* (≥2 captures), that is the
   graduation signal — capture it as a skill candidate first
   (`.planning/knowledge/<name>.md`), then promote via writing-skills.

3. **Apply with backup.** Only after the diff is confirmed, apply with
   `backup: true` so `failures.md.bak` preserves the pre-image.

4. **FTS-orphan check.** After apply, the `.md` is source-of-truth and the DB
   re-hydrates on next startup sync; confirm no orphan rows remain by re-running
   a `memory_search` for a known-dropped entry (expect no hit).

## Pitfalls

- Never run apply without reading the dry-run diff first.
- Never hard-delete a unique active entry — only consumed dupes / superseded.
- Graduation is agent-driven: warn + recommend; do NOT auto-create skills.
- Legacy entries without a topic-key simply don't group until they recur — no
  forced migration.

## Verification

- `failures.md.bak` exists and equals the pre-apply content.
- Post-apply char total < pre-apply (from the result struct's `finalChars`).
- A `memory_search` for a dropped canonical phrase returns the surviving
  canonical entry, not orphans.
````

- [ ] **Step 2: Verify the skill loads**

Run: `find bun-apps/pi-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup -name SKILL.md` and confirm the frontmatter parses (`name`, `description` present).

- [ ] **Step 3: Run the package suite — verify no regression**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
Expected: PASS — a doc-only addition; no test impact.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/SKILL.md
git commit -m "docs(memory): add pi-memory-bulk-dedup skill (topic-family + graduation)"
```

---

## Self-Review

**1. Spec coverage** (every decided item → a task):

| Spec item (ticket) | Task |
|---|---|
| `failureModel: legacy\|v1` config, ⚠ types.ts + loadConfig (06) | 1 |
| topic-key extraction: tool name for tool-quirk, key-phrase otherwise (04 D1) | 2 |
| write-gate graduation warning on 2nd+ topic-key, agent-driven (04 D3, 02) | 3 |
| deterministic longest-wins backlog canonicalization, mirror project-memory-migration (06) | 4 |
| compress resolved/stale → one-line canonical fact (05 D1) | 4 (tier 3) |
| bulk-dedup skill — topic-family detection + graduation rec (04 D4) | 5 |
| errors.log candidate — DROPPED (03) | (no task — correctly absent) |
| decay aging metadata — REUSE EXISTING (05) | (no task — correctly absent; staleness.ts + memory-format.ts already stamp created/last) |
| overflow consolidation retires superseded-first (05) | (no task — already in `_addInner` D2) |

**2. Placeholder scan:** no "TBD/TODO/implement later/similar to". Every code step shows complete code; every test shows complete assertions. The two spec citations (`constants.ts:145`, "existing bulk-dedup skill") are corrected in "Spec reconciliation" at the top.

**3. Type consistency:** `topicKey(content: string): string` and `findTopicRecurrence(content, existing): TopicRecurrenceHit | null` are used identically in Tasks 2/3/4. `formatTopicRecurrenceWarning(hit: TopicRecurrenceHit)` consumes exactly what `findTopicRecurrence` returns. `canonicalizeFailureBacklog` returns `FailureModelMigrationResult` whose fields the test asserts by the same names. `this.config.failureModel` (Task 3) is the field Task 1 adds.

**Gaps intentionally deferred (per spec "build details", not placeholders):**
- Consolidation-child *synthesized* fact for ongoing recurrence → reuses the existing `auto-consolidate.ts` one-shot child; agent-driven graduation means no new auto-synthesis code (ticket 04 D2 + 05).
- Exact compression sentence quality — deterministic first-sentence truncation (tier 3) is the v1 cut; a richer template can follow once the deterministic baseline ships.
