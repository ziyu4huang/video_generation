> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
> EXCEEDED — rollout went beyond the 3 pilots (pi_deploy/pi_verify migrated).
# Spec — Taxonomy → per-tool `gating` field migration (3 pilots)

- **Effort**: `.planning/2026-08-02-taxonomy-gating-field-migration/`
- **Status**: design — awaiting plan
- **Date**: 2026-08-02
- **Decision source**: `.planning/2026-08-02-improve-extension-co-operation-less-hard-couplin/` (wayfinder map; tickets 02 + 03)
- **Next stage**: `writing-plans` (implementation plan from this spec)

## 1. Context

The wayfinder map settled two decisions for decoupling `tool-gate` / `core-task` / `power-tool` under a no-cross-dep isolation constraint:

- **02 (taxonomy)** — owner-declares: each tool's owner attaches a `gating` field to its `ToolDefinition`; tool-gate becomes the discoverer+applier (not the mirrorer). A strict drift-guard errors on pilot tools lacking `gating`.
- **03 (schema-cost)** — inline + guard test; the `pi-agent-cli → power-tool/schema-cost` host→extension delegation is in-bounds.

This spec converts those decisions into an executable design for the **3-pilot migration** (per the map's scope; the other ~9 extensions are a later rollout).

### Course-correction discovered during design exploration

The map's ticket 02 assumed a **new `bun patch`** was needed because "`getAllTools()` strips unknown fields." Exploration disproved this premise:

1. The repo patches the JS framework via **runtime monkey-patches** (`bun-apps/pi-agent/src/patches/`, env-gated + reversible, each with a `.test.ts`), **not** `bun patch`. `bunfig.toml` states this explicitly.
2. A **live, existing patch** — `src/patches/ext-api-get-all-tool-definitions.ts` — already exposes `pi.getAllToolDefinitions(): ToolDefinition[]`, returning the **full** definitions (whatever the owner registered, including a future `gating`). It is wired into `PATCH_TABLE` + `applyPatches()` (default on).

**Consequence**: no new runtime patch is required. tool-gate switches its 2 `pi.getAllTools()` calls to `pi.getAllToolDefinitions()` and reads `.gating`. The only new artifact is a **type augmentation** (so TypeScript accepts `gating` on `ToolDefinition`).

## 2. Goal & non-goals

**Goal** — Move the 3 pilot extensions' tool-taxonomy declarations from tool-gate's hardcoded `GATES`/`CORE_TOOLS` into per-tool `gating` fields owned by each tool's author, so tool-gate discovers rather than mirrors — without introducing any extension↔extension runtime dependency.

**Non-goals** (deferred):
- Migrating the other ~9 mirrored extensions (flux2/krea2/ltx/file2md/workflow/...) — later rollout.
- Upstreaming `gating` to `@earendil-works/pi-coding-agent` (replaces the augmentation long-term).
- Deleting tool-gate's hardcoded `GATES`/`CORE_TOOLS` entirely (stays as the hybrid fallback until rollout).
- Hook ordering, shared status widget, static-vs-dynamic registration.

## 3. The `gating` field contract

```ts
/** Owner-declared tool-gating metadata. Rides on `ToolDefinition.gating`. */
interface Gating {
  /**
   * Unambiguous triggers — bare-word / phrase match via tool-gate's
   * `matchesKeyword` (case-insensitive; single ASCII tokens use word
   * boundaries, phrases/CJK use substring). A gate fires if ANY keyword
   * matches, OR the `requires` co-occurrence is met.
   */
  keywords: string[];

  /**
   * Optional co-occurrence trigger: the gate fires only if the prompt has
   * ≥1 noun AND ≥1 verb (prevents bare-noun false-fires like "docker image").
   * Lifted verbatim from tool-gate's `CoOccurrence` interface + S2 tuning.
   */
  requires?: { nouns: string[]; verbs: string[] };

  /**
   * If true, the tool is always active (core / escape-hatch) and is NEVER
   * gated. Replaces membership in tool-gate's hardcoded `CORE_TOOLS` set.
   */
  core?: boolean;
}
```

**Semantics**:
- `core: true` ⇒ always-active; `keywords`/`requires` ignored (and should be omitted).
- A non-core tool with `keywords: []` and no `requires` ⇒ the drift-guard flags it (a gate that can never fire is almost certainly a declaration bug).
- Owner-declared `gating` is **authoritative** for that tool; tool-gate must not override it (the S2 false-fire gotchas become an owner tuning-guide, per ticket 05).

## 4. Type augmentation (local `.d.ts` per pilot)

Each pilot package carries a tiny local augmentation so its own TypeScript compilation accepts `gating`. Template (per pilot, ~8 lines):

```ts
// <pilot>/types/tool-gating.d.ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
  interface ToolDefinition {
    gating?: Gating;
  }
}

interface Gating {
  keywords: string[];
  requires?: { nouns: string[]; verbs: string[] };
  core?: boolean;
}
```

- **Why per-pilot**: fully isolated — zero runtime dep, zero type-only dep edge. The duplicated `Gating` interface is guardable by the drift-guard test (consistent with 03's inline+guard decision). Chosen over a shared `@repo/pi-shared-types` package (would add a type-only dep edge) and over host-owned in `pi-agent` (pilots may not resolve the host's ambient `.d.ts` under the isolated linker).
- **Exact import path** of `ToolDefinition` (root vs subpath) is a plan-level detail; the augmentation targets whatever module path each pilot already imports it from.
- A follow-up "augmentation-agreement" test asserts all pilot `Gating` interfaces are structurally identical (catches drift).

## 5. Components

### 5.1 tool-gate consumer switch
- Lines `487` and `519` in `extensions/tool-gate.ts`: `pi.getAllTools()` → `pi.getAllToolDefinitions()`.
- Build the gate map by reading `def.gating` off each returned definition.
- **Hybrid merge precedence** (transitional):
  1. If `def.gating` is present → use it (authoritative).
  2. Else → fall back to the hardcoded `GATES` lookup by tool name.
  3. Core check: `def.gating?.core === true` OR membership in hardcoded `CORE_TOOLS`.
- tool-gate reads **metadata only** (`getAllToolDefinitions()` returns full defs incl. `execute` — never invoke it).

### 5.2 power-tool migration (the inspect_* group — incl. the orphan fix)
Add `gating` to the 6 `inspect_*` tools:

| Tool | File | gating |
|------|------|--------|
| `inspect_context` | `src/index.ts:169` | `{ keywords, requires }` (from existing inspect_* gate) |
| `inspect_agent` | `src/index.ts:397` | same group |
| `inspect_extensions` | `src/index.ts:934` | same group |
| `inspect_tui` | `src/index.ts:1048` | same group |
| `inspect_pathology` | `src/pathology/index.ts:40` | same group |
| `inspect_hooks` | `src/tools/inspect-hooks.ts:236` | same group — **NEW** (was orphaned; this fixes the live bug) |

The keywords/requires are lifted **verbatim** from the existing inspect_* entry in tool-gate's `GATES` (preserving S2 tuning). The inspect_* entry is then **removed** from tool-gate's hardcoded `GATES` (the group is now fully owner-declared by power-tool). The other non-pilot entries (flux2/krea2/ltx/file2md/workflow) **remain** as the hybrid fallback until their owners migrate in the rollout.

### 5.3 core-task migration (core tools)
`gating: { core: true }` on:
- `ask_user_question` (`src/ask-user/ask-user-question.ts:72`)
- `todo` (`src/todo/todo.ts:44`)
- `goal_complete` (`src/goal/goal.ts:184`)

### 5.4 tool-gate self-migration
`gating: { core: true }` on `enable_tool` (`extensions/tool-gate.ts:557`) — the escape hatch stays always-active.

### 5.5 Drift-guard test (scoped to pilots)
- Iterates `pi.getAllToolDefinitions()`, filters to tools whose owner is one of the 3 pilots (by source-extension allowlist — exact identification mechanism, likely `sourceInfo`, is a plan detail).
- Asserts every pilot-owned tool has a non-null `gating`.
- Built-in tools (`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls` — `source: "builtin"`) are exempt.
- **Strict**: fails the test (not a warning) on any pilot tool missing `gating`.
- Includes a negative case: temporarily stripping `gating` from a pilot tool makes the test fail (proves the guard bites).

### 5.6 03 fold-in (schema-cost)
- **Guard test** (dev-time): imports `measureToolTokens` (tool-gate) and `estimateToolCost` (power-tool/schema-cost) and asserts they agree on a representative sample of tool definitions — drift caught, not silent.
- **Cleanup**: remove the `@deprecated delegate` re-export scaffolding in `pi-agent-cli/src/commands/schema-cost.ts` (≈ lines 48–52); consumers import from `@repo/pi-agent-ext-power-tool/schema-cost` directly. The CLI's schema-cost command still delegates to power-tool's engine (host→extension, in-bounds per 03).

## 6. Data flow

```
owner factory → pi.registerTool({ ..., gating })        # owner declares
        ↓
pi.getAllToolDefinitions()  (existing patch, live)       # surfaces full def incl. gating
        ↓
tool-gate @ session_start → reads each def.gating        # discovers (no longer mirrors)
        ↓
hybrid merge: gating ?? hardcoded GATES/CORE_TOOLS       # transitional fallback
        ↓
per-turn gate application + enable_tool escape hatch     # unchanged behavior
```

## 7. Error handling

- **Missing `gating` on a pilot tool** → strict drift-guard test failure (the guard is the enforcement; there is no runtime failure for end users).
- **Hybrid fallback guarantees zero regression** — unmigrated tools (flux2/krea2/ltx/file2md/workflow) keep working via the hardcoded `GATES`; the migration never removes fallback until a tool is verified migrated.
- **Malformed `gating`** (non-core tool with `keywords: []` and no `requires`) → drift-guard flags it.
- **Augmentation not applying** (TS doesn't see `gating`) → compile error in the pilot (fail-fast at build time, not silent).

## 8. Acceptance criteria (testable)

1. `gating?: Gating` is accepted by TypeScript in all 3 pilot packages (they compile).
2. tool-gate reads `.gating` from `getAllToolDefinitions()`; `extensions/tool-gate.test.ts` stays green.
3. A new test asserts `inspect_hooks` fires on its keywords — **the orphan bug is fixed**.
4. power-tool's 6 `inspect_*` tools carry `gating`; core-task's 3 core tools + tool-gate's `enable_tool` carry `{ core: true }`.
5. The drift-guard test passes for the 3 pilots AND fails (negative case) when a pilot tool's `gating` is removed.
6. Hybrid fallback regression test: flux2/krea2/ltx/file2md/workflow still gated via the hardcoded `GATES` (behavior unchanged).
7. Schema-cost guard test passes; the `@deprecated delegate` scaffolding is removed; `pi-agent-cli`'s schema-cost command still works (delegates to power-tool).
8. **No extension↔extension runtime dependency is introduced** (`grep`-verifiable: no new `@repo/pi-agent-ext-*` imports between the 3 pilots; only the existing host→extension `pi-agent-cli → power-tool/schema-cost` remains, which 03 ruled in-bounds).
9. An augmentation-agreement test confirms all pilot `Gating` interfaces are structurally identical.

## 9. Risks

- **Augmentation visibility under the isolated linker** — if a pilot's TS config doesn't pick up the local `.d.ts`, `gating` won't type-check. Mitigation: each pilot's `tsconfig.json` must include the `types/` glob; verified by criterion #1.
- **`getAllToolDefinitions()` returns full defs** — tool-gate must treat them as read-only metadata (it already does; no `execute` calls). Mitigation: code review + the existing test suite.
- **Hybrid merge precedence** — must neither double-gate nor skip. Mitigation: a dedicated merge-precedence unit test.
- **Drift-guard identification of "pilot-owned"** — if `sourceInfo` isn't on the raw `definition`, the guard needs another mapping (name→owner). Mitigation: resolved in the plan (the patch's `t.definition` source is inspected).

## 10. Out of scope / deferred prizes

(from the map's next-goal file)
- Roll `gating` out to the other ~9 mirrored extensions (gated on this effort landing).
- Upstream `gating` into `@earendil-works/pi-coding-agent` (removes the per-pilot augmentation + the runtime patch long-term).
- Delete tool-gate's hardcoded `GATES`/`CORE_TOOLS` once all extensions migrate.
