# `@repo/pi-agent-ext-core-interface` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a types-first workspace library `@repo/pi-agent-ext-core-interface` hosting the `SEAM_KEYS` registry + type-safe `publishSeam`/`readSeam` accessors (compile-time orphan prevention) + the `KnowledgePipeline` interface; wire zk to publish and hermes to consume `__piKnowledgePipeline`.

**Architecture:** A pure library package (not an extension) under `bun-apps/`. It declares the seam-key registry as a single source of truth and typed accessors over `globalThis`. zk (knowledge-card, a STATIC extension) publishes its 4-function knowledge surface as `__piKnowledgePipeline`; hermes (hermes-memory, STATIC) reads it defensively. The repo-level `seam-contract.test.ts` imports `SEAM_KEY_ENTRIES` from this package instead of a local const. zk + hermes are STATIC extensions that already runtime-import workspace deps, so importing this library is safe.

**Tech Stack:** TypeScript, Bun, `@earendil-works/pi-coding-agent@0.84.1`, typebox.

## Global Constraints
- Platform: Apple Silicon, Bun (no build step; `tsc --noEmit` for type-checking).
- Lockstep peer-dep: `@earendil-works/pi-coding-agent: "0.84.1"`, `typebox: "*"`.
- Workspace: `bun-apps/` root with `"workspaces": ["./*"]` glob — a new dir with package.json auto-registers on `bun install`. Isolated linker → every imported package MUST be declared in the importing package's own deps.
- NEVER use a top-level `cd` — use `( cd <dir> && ... )` or `--cwd`.
- NEVER `git add -A` — stage exact paths.
- zk + hermes are STATIC extensions (in `bun-apps/pi-agent/src/static-extensions.ts`, NOT manifest.json). Do NOT add this library to either list (it is a dep, not an extension).
- The 4 zk functions: `collectInputFiles`, `ingestRecords` (from `src/ingest.ts`), `runConvergenceLoop` (from `src/loop.ts`), `retrieveRecords` (from `src/retrieve.ts`). `extract` is gone (do not add it).

---

### Task 1: Scaffold package + SEAM_KEYS registry

**Files:**
- Create: `bun-apps/pi-agent-ext-core-interface/package.json`
- Create: `bun-apps/pi-agent-ext-core-interface/tsconfig.json`
- Create: `bun-apps/pi-agent-ext-core-interface/src/index.ts`
- Create: `bun-apps/pi-agent-ext-core-interface/src/seam-keys.ts`
- Create: `bun-apps/pi-agent-ext-core-interface/tests/seam-keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SEAM_KEYS` (const object), `SeamKey` (type union), `SEAM_KEY_ENTRIES` (array of `{key, crossPackage}`).

- [ ] **Step 1: Write the failing test** `tests/seam-keys.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SEAM_KEYS, SEAM_KEY_ENTRIES, type SeamKey } from "../src/seam-keys.js";

describe("SEAM_KEYS", () => {
  it("registers __piKnowledgePipeline as crossPackage", () => {
    assert.equal(SEAM_KEYS.__piKnowledgePipeline.crossPackage, true);
  });
  it("exposes 8 entries in SEAM_KEY_ENTRIES", () => {
    assert.equal(SEAM_KEY_ENTRIES.length, 8);
    assert.ok(SEAM_KEY_ENTRIES.some((e) => e.key === "__piKnowledgePipeline" && e.crossPackage === true));
  });
  it("SeamKey includes the new key", () => {
    const k: SeamKey = "__piKnowledgePipeline";
    assert.equal(k, "__piKnowledgePipeline");
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-core-interface && bun test tests/seam-keys.test.ts )` — Expected: FAIL (cannot resolve module / dir missing).

- [ ] **Step 3: Write** `src/seam-keys.ts`:
```ts
/** The canonical `__pi*` seam-key registry — single source of truth.
 *  Consumed by bun-apps/tests/seam-contract.test.ts (via SEAM_KEY_ENTRIES)
 *  and by src/seam.ts (SeamKey type for compile-time orphan prevention). */
export const SEAM_KEYS = {
  __piCoreTaskStatusWidget: { crossPackage: true },
  __piGoalActive:           { crossPackage: false },
  __piKickHeartbeat:        { crossPackage: false },
  __piPlanIncomplete:       { crossPackage: true },
  __piPlanPhases:           { crossPackage: true },
  __piPlanSummary:          { crossPackage: true },
  __piWayfindGrill:         { crossPackage: true },
  __piKnowledgePipeline:    { crossPackage: true },
} as const;

export type SeamKey = keyof typeof SEAM_KEYS;

/** Array form {key, crossPackage}[] consumed by the repo-level seam-contract guard. */
export const SEAM_KEY_ENTRIES: ReadonlyArray<{ key: string; crossPackage: boolean }> =
  Object.entries(SEAM_KEYS).map(([key, v]) => ({ key, crossPackage: v.crossPackage }));
```

- [ ] **Step 4: Write** `src/index.ts` (barrel):
```ts
export { SEAM_KEYS, SEAM_KEY_ENTRIES, type SeamKey } from "./seam-keys.js";
```

- [ ] **Step 5: Write** `package.json`:
```json
{
  "name": "@repo/pi-agent-ext-core-interface",
  "private": true,
  "version": "0.1.0",
  "description": "Typed cross-extension seam contracts: SEAM_KEYS registry + publishSeam/readSeam accessors + KnowledgePipeline interface.",
  "license": "MIT",
  "keywords": ["pi-package", "seam", "contracts", "types"],
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "README.md"],
  "scripts": { "test": "bun test", "check": "tsc --noEmit" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "0.84.1", "typebox": "*" },
  "devDependencies": { "typescript": "^6.0.3" }
}
```

- [ ] **Step 6: Write** `tsconfig.json` (mirror pi-agent-ext-devops; include tests/):
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "Node16", "moduleResolution": "Node16",
    "lib": ["ES2022"], "outDir": "dist", "rootDir": ".",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true, "resolveJsonModule": true,
    "declaration": true, "sourceMap": true, "types": ["bun"],
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 7: Register the workspace package.** `( cd bun-apps && bun install )` — Expected: links the new package; bun.lock updated.

- [ ] **Step 8: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-core-interface && bun test tests/seam-keys.test.ts )` — Expected: PASS (3 tests).

- [ ] **Step 9: Type-check.** `( cd bun-apps/pi-agent-ext-core-interface && bun run check )` — Expected: no errors.

- [ ] **Step 10: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-core-interface/package.json bun-apps/pi-agent-ext-core-interface/tsconfig.json bun-apps/pi-agent-ext-core-interface/src/index.ts bun-apps/pi-agent-ext-core-interface/src/seam-keys.ts bun-apps/pi-agent-ext-core-interface/tests/seam-keys.test.ts bun-apps/bun.lock` then `git -C <WT> commit -m "feat(core-interface): scaffold package + SEAM_KEYS registry (task 12)"`.

---

### Task 2: KnowledgePipeline interface + type-safe accessors

**Files:**
- Create: `bun-apps/pi-agent-ext-core-interface/src/interfaces/knowledge-pipeline.ts`
- Create: `bun-apps/pi-agent-ext-core-interface/src/seam.ts`
- Create: `bun-apps/pi-agent-ext-core-interface/tests/seam-orphan.types.ts`
- Modify: `bun-apps/pi-agent-ext-core-interface/src/index.ts`
- Test: `bun-apps/pi-agent-ext-core-interface/tests/seam.test.ts`

**Interfaces:**
- Consumes: `SeamKey` from Task 1.
- Produces: `KnowledgePipeline` + contract types; `publishSeam<K>(key, impl)`, `readSeam<K>(key): SeamImplMap[K] | undefined`; `SeamImplMap`.

- [ ] **Step 1: Write** `src/interfaces/knowledge-pipeline.ts` (contract types mirroring zk's public shapes; zk's richer impl types are structurally assignable):
```ts
/** Contract types for the KnowledgePipeline seam (zk publishes, hermes consumes).
 *  Mirrors pi-agent-ext-knowledge-card's public function signatures. */
export type SourceFamily = "workflow-jsonl" | "hermes" | "auto-memory" | "generic";
export type LinkWeighting = "count" | "idf";

export interface KnowledgeRecord {
  id: string; type: string; title: string; detail: string; tags: string[];
  dimension: string | null; confidence: number; status: string;
  superseded_by: string | null; entities?: unknown[];
}
export interface CollectInputFilesResult { files: string[]; skipped: { path: string; reason: string }[]; }
export interface IngestOptions {
  vaultPath: string; source: SourceFamily; sourceLabel: string; folder?: string;
  mocPath?: string; dryRun?: boolean; maxLinks?: number; wikiAware?: boolean; linkWeighting?: LinkWeighting;
}
export interface IngestCardReport { id: string; title: string; status: string; }
export interface IngestSummary {
  source: SourceFamily; sourceLabel: string; total: number; created: number; updated: number;
  unchanged: number; skipped: number; linked: number; wikiMerged: number; mocUpdated: boolean;
  vaultPath: string; folder: string; cards: IngestCardReport[]; parseErrors: { line: number; reason: string }[];
}
export interface SourceInput { path: string; family: SourceFamily; label?: string; }
export interface ConvergeOptions {
  sources: SourceInput[]; vaultPath: string; folder?: string; mocPath?: string;
  probeQueries?: unknown[]; probeTopK?: number; maxRounds?: number; consecutiveEmpty?: number;
  linkWeighting?: LinkWeighting; wikiAware?: boolean; maxLinks?: number;
}
export interface ConvergeReceipt {
  sourcesIngested: number; created: number; updated: number; unchanged: number;
  deadLinksBefore: number; deadLinksAfter: number; mocMissingBefore: boolean;
  mocMissingAfter: boolean; rounds: number; converged: boolean; truncated: boolean;
  probeHitRate?: number; health: unknown;
}
export interface RetrievedCard { id: string; title: string; detail: string; tags: string[]; }
export interface RetrieveOptions {
  vaultPath: string; folder?: string; tags: string[]; excludeIds?: string[]; topK?: number;
  maxDetailChars?: number; linkWeighting?: LinkWeighting; bodyMatch?: boolean; slugDom?: boolean;
  semantic?: boolean; queryText?: string; semanticAlpha?: number; semanticModel?: string;
}
export interface RetrieveResult {
  count: number; cards: RetrievedCard[]; digest: string; folder: string; scanned: number; excluded: number;
}
export interface KnowledgePipeline {
  collectInputFiles(paths: string[], opts: { source: SourceFamily; cwd: string }): CollectInputFilesResult;
  ingestRecords(records: KnowledgeRecord[], opts: IngestOptions): Promise<IngestSummary>;
  runConvergenceLoop(opts: ConvergeOptions): Promise<ConvergeReceipt>;
  retrieveRecords(opts: RetrieveOptions): Promise<RetrieveResult>;
}
```

- [ ] **Step 2: Write the failing test** `tests/seam.test.ts` (round-trip via an `unknown`-typed key so no full KnowledgePipeline mock is needed):
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { publishSeam, readSeam } from "../src/seam.js";

describe("seam accessors", () => {
  it("round-trips a published value", () => {
    publishSeam("__piGoalActive", 42); // __piGoalActive is `unknown` in SeamImplMap
    assert.equal(readSeam("__piGoalActive"), 42);
    delete (globalThis as Record<string, unknown>).__piGoalActive;
  });
  it("readSeam returns undefined when unpublished", () => {
    delete (globalThis as Record<string, unknown>).__piGoalActive;
    assert.equal(readSeam("__piGoalActive"), undefined);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-core-interface && bun test tests/seam.test.ts )` — Expected: FAIL (cannot resolve ../src/seam.js).

- [ ] **Step 4: Write** `src/seam.ts`:
```ts
import type { SeamKey } from "./seam-keys.js";
import type { KnowledgePipeline } from "./interfaces/knowledge-pipeline.js";

/** key -> implementation type. KnowledgePipeline typed now; the 7 existing
 *  __pi* seams typed `unknown` (incremental migration — ticket 11 fork 3). */
export interface SeamImplMap {
  __piKnowledgePipeline: KnowledgePipeline;
  __piCoreTaskStatusWidget: unknown;
  __piGoalActive: unknown;
  __piKickHeartbeat: unknown;
  __piPlanIncomplete: unknown;
  __piPlanPhases: unknown;
  __piPlanSummary: unknown;
  __piWayfindGrill: unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __piKnowledgePipeline: KnowledgePipeline | undefined;
}

/** Publish a seam impl to globalThis. key is a typed SeamKey union, so an
 *  unregistered key (e.g. "__piFoo") is a COMPILE error — orphan prevention. */
export function publishSeam<K extends SeamKey>(key: K, impl: SeamImplMap[K]): void {
  (globalThis as Record<string, unknown>)[key] = impl;
}

/** Read a seam impl defensively. Returns undefined if unpublished. */
export function readSeam<K extends SeamKey>(key: K): SeamImplMap[K] | undefined {
  return (globalThis as Record<string, unknown>)[key] as SeamImplMap[K] | undefined;
}
```

- [ ] **Step 5: Write the compile-time orphan fixture** `tests/seam-orphan.types.ts`:
```ts
import { publishSeam } from "../src/seam.js";
// @ts-expect-error — "__piFoo" is not a registered SeamKey (orphan prevention)
publishSeam("__piFoo", {});
```

- [ ] **Step 6: Update** `src/index.ts` (barrel):
```ts
export { SEAM_KEYS, SEAM_KEY_ENTRIES, type SeamKey } from "./seam-keys.js";
export { publishSeam, readSeam, type SeamImplMap } from "./seam.js";
export type {
  KnowledgePipeline, KnowledgeRecord, SourceFamily, LinkWeighting,
  IngestOptions, IngestSummary, ConvergeOptions, ConvergeReceipt,
  RetrieveOptions, RetrieveResult, CollectInputFilesResult,
} from "./interfaces/knowledge-pipeline.js";
```

- [ ] **Step 7: Run tests to verify pass.** `( cd bun-apps/pi-agent-ext-core-interface && bun test )` — Expected: PASS (seam-keys + seam tests).

- [ ] **Step 8: Type-check (asserts the @ts-expect-error fixture).** `( cd bun-apps/pi-agent-ext-core-interface && bun run check )` — Expected: no errors. (If tsc reports "Unused '@ts-expect-error' directive", the orphan line did NOT error — that is a FAILURE: publishSeam must reject "__piFoo".)

- [ ] **Step 9: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-core-interface/src/interfaces/knowledge-pipeline.ts bun-apps/pi-agent-ext-core-interface/src/seam.ts bun-apps/pi-agent-ext-core-interface/src/index.ts bun-apps/pi-agent-ext-core-interface/tests/seam.test.ts bun-apps/pi-agent-ext-core-interface/tests/seam-orphan.types.ts` then `git -C <WT> commit -m "feat(core-interface): KnowledgePipeline interface + type-safe seam accessors"`.

---

### Task 3: zk publishes __piKnowledgePipeline

**Files:**
- Modify: `bun-apps/pi-agent-ext-knowledge-card/package.json` (add dep)
- Modify: `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts` (imports ~line 53-67; session_start handler ~640; session_shutdown handler)
- Create: `bun-apps/pi-agent-ext-knowledge-card/src/knowledge-pipeline-seam.ts`
- Test: `bun-apps/pi-agent-ext-knowledge-card/__tests__/knowledge-pipeline-seam.test.ts`

**Interfaces:**
- Consumes: `publishSeam` + `KnowledgePipeline` from core-interface; the 4 zk functions.
- Produces: `globalThis.__piKnowledgePipeline` set during session_start (live for the session).

- [ ] **Step 1: Add the dependency.** `( cd bun-apps/pi-agent-ext-knowledge-card && bun add @repo/pi-agent-ext-core-interface )` — verify package.json now lists `"@repo/pi-agent-ext-core-interface": "workspace:*"` under dependencies.

- [ ] **Step 2: Write the failing test** `__tests__/knowledge-pipeline-seam.test.ts`:
```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { readSeam } from "@repo/pi-agent-ext-core-interface";
import { collectInputFiles, ingestRecords } from "../src/ingest.js";
import { runConvergenceLoop } from "../src/loop.js";
import { retrieveRecords } from "../src/retrieve.js";
import { publishKnowledgePipeline } from "../src/knowledge-pipeline-seam.js";

const KEY = "__piKnowledgePipeline";

describe("zk publishes KnowledgePipeline seam", () => {
  beforeEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });
  afterEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });

  it("publishes the 4-function surface", () => {
    publishKnowledgePipeline({ collectInputFiles, ingestRecords, runConvergenceLoop, retrieveRecords });
    const kp = readSeam(KEY);
    assert.ok(kp, "seam must be published");
    assert.equal(typeof kp.collectInputFiles, "function");
    assert.equal(typeof kp.ingestRecords, "function");
    assert.equal(typeof kp.runConvergenceLoop, "function");
    assert.equal(typeof kp.retrieveRecords, "function");
  });
});
```

- [ ] **Step 3: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/knowledge-pipeline-seam.test.ts )` — Expected: FAIL (cannot resolve ../src/knowledge-pipeline-seam.js).

- [ ] **Step 4: Create** `src/knowledge-pipeline-seam.ts`:
```ts
import { publishSeam, type KnowledgePipeline } from "@repo/pi-agent-ext-core-interface";

/** Publish zk's knowledge surface as the __piKnowledgePipeline seam.
 *  Called from the extension factory on session_start. */
export function publishKnowledgePipeline(impl: KnowledgePipeline): void {
  publishSeam("__piKnowledgePipeline", impl);
}

/** Unpublish (session_shutdown / unload). */
export function unpublishKnowledgePipeline(): void {
  delete (globalThis as Record<string, unknown>).__piKnowledgePipeline;
}
```

- [ ] **Step 5: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/knowledge-pipeline-seam.test.ts )` — Expected: PASS.

- [ ] **Step 6: Wire the factory** (`extensions/knowledge-card.ts`):
  - Add to the import block (near line 53-67): `import { publishKnowledgePipeline, unpublishKnowledgePipeline } from "../src/knowledge-pipeline-seam.js";`
  - Add `runConvergenceLoop` to the imports from `../src/loop.js` (it is NOT currently imported; `collectInputFiles`/`ingestRecords` from `../src/ingest.js` and `retrieveRecords` from `../src/retrieve.js` already are).
  - In the `session_start` handler body (after the `parentExtensionTools = ...` assignment), add: `publishKnowledgePipeline({ collectInputFiles, ingestRecords, runConvergenceLoop, retrieveRecords });`
  - In the `session_shutdown` handler body (at the top, before the try/catch), add: `unpublishKnowledgePipeline();`

- [ ] **Step 7: Verify zk suite + types.** `( cd bun-apps/pi-agent-ext-knowledge-card && bun test && bunx tsc --noEmit )` — Expected: PASS, no type errors.

- [ ] **Step 8: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-knowledge-card/package.json bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts bun-apps/pi-agent-ext-knowledge-card/src/knowledge-pipeline-seam.ts bun-apps/pi-agent-ext-knowledge-card/__tests__/knowledge-pipeline-seam.test.ts bun-apps/bun.lock` then `git -C <WT> commit -m "feat(knowledge-card): publish __piKnowledgePipeline seam (task 12)"`.

---

### Task 4: hermes consumes __piKnowledgePipeline defensively

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/package.json` (add dep)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-pipeline-seam.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/index.ts` (re-export)
- Test: `bun-apps/pi-agent-ext-hermes-memory/__tests__/knowledge-pipeline-seam.test.ts`

**Interfaces:**
- Consumes: `readSeam` + `KnowledgePipeline` from core-interface.
- Produces: `getKnowledgePipeline(): KnowledgePipeline | undefined` (defensive reader for ticket 06).

- [ ] **Step 1: Add the dependency.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun add @repo/pi-agent-ext-core-interface )`.

- [ ] **Step 2: Write the failing test** `__tests__/knowledge-pipeline-seam.test.ts` (mirror grill-seam.test.ts):
```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { getKnowledgePipeline } from "../src/knowledge-pipeline-seam.js";

const KEY = "__piKnowledgePipeline";

describe("hermes reads KnowledgePipeline defensively", () => {
  beforeEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });
  afterEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });

  it("returns undefined when zk is absent", () => {
    assert.equal(getKnowledgePipeline(), undefined);
  });
  it("returns the impl when published", () => {
    const fake = { collectInputFiles() { return { files: [], skipped: [] }; } };
    (globalThis as Record<string, unknown>)[KEY] = fake;
    assert.equal(getKnowledgePipeline(), fake);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/knowledge-pipeline-seam.test.ts )` — Expected: FAIL (cannot resolve).

- [ ] **Step 4: Create** `src/knowledge-pipeline-seam.ts` (mirror src/grill-seam.ts):
```ts
import { readSeam, type KnowledgePipeline } from "@repo/pi-agent-ext-core-interface";

/** hermes-memory's defensive reader of zk's KnowledgePipeline seam.
 *  Returns undefined when zk is absent (graceful fallback). Ticket 06's spine
 *  orchestration consumes this. */
export function getKnowledgePipeline(): KnowledgePipeline | undefined {
  return readSeam("__piKnowledgePipeline");
}
```

- [ ] **Step 5: Re-export from** `src/index.ts`. Add the line: `export { getKnowledgePipeline } from "./knowledge-pipeline-seam.js";`

- [ ] **Step 6: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/knowledge-pipeline-seam.test.ts )` — Expected: PASS.

- [ ] **Step 7: Type-check.** `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )` — Expected: no errors.

- [ ] **Step 8: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/package.json bun-apps/pi-agent-ext-hermes-memory/src/knowledge-pipeline-seam.ts bun-apps/pi-agent-ext-hermes-memory/src/index.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/knowledge-pipeline-seam.test.ts bun-apps/bun.lock` then `git -C <WT> commit -m "feat(hermes-memory): consume __piKnowledgePipeline defensively (task 12)"`.

---

### Task 5: Migrate seam-contract.test.ts to SEAM_KEY_ENTRIES; full verification

**Files:**
- Modify: `bun-apps/tests/seam-contract.test.ts` (lines ~67-78: replace local SEAM_KEYS with import)
- Modify: `bun-apps/package.json` (add @repo/pi-agent-ext-core-interface devDep if the import needs it)
- Test: `bun-apps/tests/seam-contract.test.ts` (4 invariants over 8 keys)

**Interfaces:**
- Consumes: `SEAM_KEY_ENTRIES` from core-interface.
- Produces: the repo-level seam-contract guard runs over the single-source registry (8 keys).

- [ ] **Step 1: Edit** `bun-apps/tests/seam-contract.test.ts`. Replace the local block (the `type SeamKey = ...`, `const SEAM_KEYS: readonly SeamKey[] = [...]`, `const SEAM_KEY_SET = ...`) with:
```ts
import { SEAM_KEY_ENTRIES } from "@repo/pi-agent-ext-core-interface";
type SeamKey = { key: string; crossPackage: boolean };
const SEAM_KEYS: readonly SeamKey[] = SEAM_KEY_ENTRIES;
const SEAM_KEY_SET = new Set<string>(SEAM_KEYS.map((s) => s.key));
```
  Leave the scanner + 4 invariants unchanged.

- [ ] **Step 2: Ensure the test's import resolves** (it runs from bun-apps/ root). Add `"@repo/pi-agent-ext-core-interface": "workspace:*"` to `bun-apps/package.json` devDependencies, then `( cd bun-apps && bun install )`.

- [ ] **Step 3: Run the seam-contract guard.** `( cd bun-apps && bun run test:seam )` — Expected: PASS (4 invariants green over 8 keys).
  - If FAIL on invariant 4 (self-only): confirm BOTH `pi-agent-ext-knowledge-card/src/knowledge-pipeline-seam.ts` (publish) AND `pi-agent-ext-hermes-memory/src/knowledge-pipeline-seam.ts` (read) contain the quoted literal `"__piKnowledgePipeline"` in non-comment source — they do (publishSeam/readSeam call sites). Both are distinct packages → ≥2 refs.
  - If FAIL on invariant 1 (orphan): the literal must appear as a quoted string in production source — it does in both seam files.

- [ ] **Step 4: Full verification.** Run all four:
  `( cd bun-apps/pi-agent-ext-core-interface && bun test && bun run check )`
  `( cd bun-apps/pi-agent-ext-knowledge-card && bun test && bunx tsc --noEmit )`
  `( cd bun-apps/pi-agent-ext-hermes-memory && bun test && bunx tsc --noEmit )`
  `( cd bun-apps && bun run test:seam )`
  Expected: ALL green.

- [ ] **Step 5: Commit.** `git -C <WT> add bun-apps/tests/seam-contract.test.ts bun-apps/package.json bun-apps/bun.lock` then `git -C <WT> commit -m "test(seam-contract): import SEAM_KEY_ENTRIES from core-interface (task 12)"`.

---

## Notes for the implementer
- `<WT>` = the repo worktree root (`/Users/huangziyu/proj/video_generation__superpowers` or wherever this plan is executed). All `git -C <WT>` and `( cd ... )` calls use it.
- The repo disables remote CI and removes branch protection — `gh ship` (squash) merges with zero checks. Self-verify locally (the Step 4 full verification above) before shipping.
- Out of scope (follow-ups): migrating the 7 existing `__pi*` seams to typed accessors; relocating zk's types; ticket-06 full typed-impl build.
---
