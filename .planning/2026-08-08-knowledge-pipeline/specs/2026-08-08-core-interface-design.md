---
status: approved
effort: 2026-08-08-knowledge-pipeline
ticket: "12"
date: 2026-08-08
---
# `@repo/pi-agent-ext-core-interface` — design (knowledge-pipeline task 12)

## Context
Task 12 of the knowledge-pipeline effort. Unblocks ticket 06 (hermes spine typed-impl). Contract pinned by ticket 11 (4 forks, closed); interface shape informed by decisions 03 (two-layer graph) + 04 (embed backend), both closed. The `__pi*` globalThis seam family currently has NO compile-time link between publisher and consumer — drift is caught only by the runtime `bun-apps/tests/seam-contract.test.ts` guard. This package graduates that family into a first-class typed layer.

## Goal
Scaffold `@repo/pi-agent-ext-core-interface` — a types-first workspace LIBRARY hosting:
1. `SEAM_KEYS` registry (single source of truth for seam key names + crossPackage flags).
2. Type-safe `publishSeam` / `readSeam` accessors over `globalThis` with compile-time orphan prevention.
3. The `KnowledgePipeline` interface (first tenant; provider = zk, consumer = hermes).

Ship zk publishing + hermes consuming `__piKnowledgePipeline` so ticket 06 unblocks.

## Key findings (from code exploration)
- **`extract` is gone** — zk removed `zk_extract` (was a 100% passthrough to `obsidian_distill`). `KnowledgePipeline` mirrors zk's 4 real functions, not 5.
- zk has **no `src/index.ts`**; this package establishes the barrel convention (3 consumers: zk, hermes, the seam test).
- `SEAM_KEYS` currently lives inline in `bun-apps/tests/seam-contract.test.ts` (7 keys); relocates here + `__piKnowledgePipeline` = 8.
- 03/04's "interface impact" is already in zk's code (`retrieveRecords` already has `semantic` / `queryText` / `_testEmbedder`); no new params needed.
- It's a **library, not an extension** — no `extensions/` entry, no `manifest.json` registration.

## Design

### 1. Identity & layout
Pure **library** (no `extensions/`, no `manifest.json` entry) — a workspace dep. `private:true`, v0.1.0, lockstep peer-dep `@earendil-works/pi-coding-agent@0.84.1` + `typebox:*`; `package.json`/`tsconfig.json` mirror `pi-agent-ext-devops`.
```
src/
  index.ts                              # barrel
  seam-keys.ts                          # SEAM_KEYS registry + SeamKey type + SEAM_KEY_ENTRIES
  seam.ts                               # publishSeam/readSeam + SeamImplMap + globalThis augmentation
  interfaces/knowledge-pipeline.ts      # KnowledgePipeline + contract types
tests/
  seam.test.ts                          # accessor round-trip + @ts-expect-error orphan fixture
```

### 2. SEAM_KEYS registry (single source of truth)
```ts
export const SEAM_KEYS = {
  __piCoreTaskStatusWidget: { crossPackage: true },
  __piGoalActive:           { crossPackage: false },
  __piKickHeartbeat:        { crossPackage: false },
  __piPlanIncomplete:       { crossPackage: true },
  __piPlanPhases:           { crossPackage: true },
  __piPlanSummary:          { crossPackage: true },
  __piWayfindGrill:         { crossPackage: true },
  __piKnowledgePipeline:    { crossPackage: true },   // NEW (task 12)
} as const;
export type SeamKey = keyof typeof SEAM_KEYS;
export const SEAM_KEY_ENTRIES = Object.entries(SEAM_KEYS)
  .map(([key, v]) => ({ key, crossPackage: v.crossPackage }));  // array shape seam-contract.test imports
```
`seam-contract.test.ts` drops its local const and imports `SEAM_KEY_ENTRIES` — its 4 invariants run unchanged over **8** keys.

### 3. Type-safe accessors (ticket 11 fork 2 → compile-time orphan prevention)
```ts
export interface SeamImplMap {
  __piKnowledgePipeline: KnowledgePipeline;     // typed now
  __piCoreTaskStatusWidget: unknown;            // 7 existing = unknown (incremental, fork 3)
  __piGoalActive: unknown;
  __piKickHeartbeat: unknown;
  __piPlanIncomplete: unknown;
  __piPlanPhases: unknown;
  __piPlanSummary: unknown;
  __piWayfindGrill: unknown;
}
declare global { var __piKnowledgePipeline: KnowledgePipeline | undefined; }  // only the new key augmented

export function publishSeam<K extends SeamKey>(key: K, impl: SeamImplMap[K]): void;
export function readSeam<K extends SeamKey>(key: K): SeamImplMap[K] | undefined;
```
`publishSeam("__piFoo", …)` → **compile error** (not in `SeamKey`). zk's impl object is type-checked against `KnowledgePipeline`. `readSeam` returns typed-or-undefined → hermes reads defensively. The 7 existing seams keep using inline `globalThis.__piX` (untouched — migration is follow-up per fork 3).

### 4. `KnowledgePipeline` interface (contract declares; zk conforms structurally)
Mirrors zk's **4** real functions (`extract` is gone). Contract types declared here as the canonical promise:
```ts
export interface KnowledgePipeline {
  collectInputFiles(paths: string[], opts: { source: SourceFamily; cwd: string }): CollectInputFilesResult;
  ingestRecords(records: KnowledgeRecord[], opts: IngestOptions): Promise<IngestSummary>;
  runConvergenceLoop(opts: ConvergeOptions): Promise<ConvergeReceipt>;
  retrieveRecords(opts: RetrieveOptions): Promise<RetrieveResult>;
}
// + contract types: SourceFamily, LinkWeighting, KnowledgeRecord, IngestOptions/Summary,
//   RetrieveOptions/Result, ConvergeOptions/Receipt, CollectInputFilesResult
```
zk's existing (richer) types are structurally assignable at the `publishSeam` call site; if zk ever drops a promised field, it fails to type-check there — the contract stays honest. Embed/graph knobs already live in `RetrieveOptions` (`semantic` / `queryText` / etc.) — no new params (03/04 already shipped in zk).

### 5. Wiring
- **zk** (`piKnowledgeCardExtension` factory in `extensions/knowledge-card.ts`): `publishSeam("__piKnowledgePipeline", { collectInputFiles, ingestRecords, runConvergenceLoop, retrieveRecords })`; add `@repo/pi-agent-ext-core-interface: workspace:*` dep.
- **hermes**: `const kp = readSeam("__piKnowledgePipeline"); if (kp) kp.retrieveRecords(…)` — undefined → graceful fallback; add the dep.
- **seam-contract.test.ts**: imports `SEAM_KEY_ENTRIES` from the pkg (replaces local const).

### 6. Acceptance & scope guard
- `bun test` green in core-interface (round-trip publish→read + `@ts-expect-error` orphan fixture) + `tsc --noEmit` clean.
- seam-contract guard green over 8 keys (no orphans/dead/self-only); `__piKnowledgePipeline` cross-package referenced by ≥2 packages (zk + hermes).
- zk + hermes affected tests green.

**Out of scope** (explicit follow-ups): migrating the 7 existing seams to typed accessors; relocating zk's types; ticket-06 full typed-impl build.

## Open questions
None — contract pinned by ticket 11; interface shape grounded in zk's actual exports.
