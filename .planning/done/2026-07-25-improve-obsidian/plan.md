# pi-agent-ext-obsidian Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay down pi-agent-ext-obsidian's non-functional debt — split the 3918-line god file into focused modules under a behavior-preserving barrel, fix three open correctness issues, and add a typecheck gate — with zero change to any tool's public behavior.

**Architecture:** Four phases executed in order. Phase 0 establishes a `tsc --noEmit` safety net. Phase 1 moves `src/obsidian-lib.ts`'s ~115 exports into 13 focused `src/lib/*.ts` modules following an acyclic dependency DAG, leaving `obsidian-lib.ts` as a thin `export *` barrel so every consumer's import path stays byte-identical. Phase 2 fixes Windows atomic-overwrite, parallelizes inbound-link rewrites, and adds an opt-in semantic re-index hook. Phase 3 hardens CI/test messaging.

**Tech Stack:** TypeScript (Bun runtime), TypeBox schemas, `@earendil-works/pi-*` 0.82.0 peer deps, `bun test`, `bunx tsc --noEmit`.

## Global Constraints

- **Working dir:** `bun-apps/pi-agent-ext-obsidian/` (use `( cd bun-apps/pi-agent-ext-obsidian && ... )` — never top-level `cd`, per repo `no-cd-drift.sh`).
- **Python/venv:** N/A for this package (TypeScript only).
- **Behavior invariant (Phase 1):** `extensions/obsidian.ts`'s `export * from "../src/obsidian-lib.ts"` and every `import { ... } from "../src/obsidian-lib.ts"` (in `extensions/`, `lib/index.ts`, `extensions/__tests__/`) MUST remain unchanged after the split — the barrel re-exports keep all symbols resolvable. No function body, signature, or comment changes during the move.
- **Test gate (every commit):** `bun test extensions/__tests__/` MUST stay at 384/385 pass (the 1 skip/fail is the submodule-gated `search-baseline.txt` snapshot — not a regression).
- **Typecheck gate (after Phase 0):** `bunx tsc --noEmit` exit 0 (or spec-documented exemptions).
- **Schema-cost guard:** `extensions/__tests__/perf/schema-cost.regression.test.ts` must stay ≤ 280 tokens.
- **No new runtime deps** in Phase 1–2 (semantic hook uses platform `fetch`; Windows fallback uses node `fs`).

---

## Phase 0 — Typecheck guardrail

### Task 1: Add tsconfig + typecheck script, establish clean gate

**Files:**
- Create: `bun-apps/pi-agent-ext-obsidian/tsconfig.json`
- Modify: `bun-apps/pi-agent-ext-obsidian/package.json` (add `typecheck` script)

**Interfaces:** Produces a `bun run typecheck` command used by every subsequent task.

- [ ] **Step 1: Inspect a sibling package's tsconfig for the repo convention**

Run: `( cd bun-apps && ls pi-agent-ext-*/tsconfig.json | head -3 )`
Pick one (e.g. `pi-agent-ext-subagent/tsconfig.json`), read it, and mirror its `compilerOptions` (`target`, `module`/`moduleResolution`, `strict`, `noEmit`, `types`, `lib`) and `include`/`exclude`. If no sibling has one, use:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["bun"],
    "lib": ["ESNext"],
    "paths": { "@repo/*": ["../*/"] }
  },
  "include": ["extensions/**/*.ts", "src/**/*.ts", "lib/**/*.ts"],
  "exclude": ["node_modules"]
}
```
Adjust `paths`/`references` to match whatever the sibling uses so workspace `@repo/*` imports resolve.

- [ ] **Step 2: Add the typecheck script**

In `package.json` `scripts`, add:
```json
"typecheck": "tsc --noEmit"
```

- [ ] **Step 3: Run typecheck and capture the baseline**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun run typecheck 2>&1 | tee /tmp/obs-typecheck-baseline.txt | tail -40 )`

- [ ] **Step 4: Triage baseline errors**

For each error in `/tmp/obs-typecheck-baseline.txt`:
- **Implicit-any / missing annotation that is safe to fix** → add the type annotation now (this is a pure additive type fix, no behavior change).
- **Intentional runtime-metadata escape hatch** (e.g. `_capturedTools` on the fat tool, already marked `@ts-expect-error`) → keep the `@ts-expect-error` with its existing comment; do not "fix".
- **Peer-package type gap** (error originates in `@earendil-works/pi-*` `.d.ts`) → leave; record in a new `docs/TYPECHECK-NOTES.md` one-liner so it is a known, not silent, gap.

Re-run `bun run typecheck` until exit 0 (or only spec-documented peer gaps remain). If errors exceed ~20 and look structural, STOP and report back before proceeding — do not brute-force.

- [ ] **Step 5: Verify the test suite still green**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ 2>&1 | tail -5 )`
Expected: `384 pass / 1 fail` (the submodule snapshot).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-obsidian/tsconfig.json bun-apps/pi-agent-ext-obsidian/package.json bun-apps/pi-agent-ext-obsidian/docs/TYPECHECK-NOTES.md bun-apps/pi-agent-ext-obsidian/src bun-apps/pi-agent-ext-obsidian/extensions
git commit -m "build(obsidian): add tsc --noEmit typecheck gate + triage baseline"
```

---

## Phase 1 — Structure split (13 modules + barrel)

**Method (applies to every Task 2–14):** each task moves ONE module's named symbols out of `src/obsidian-lib.ts` into a new `src/lib/<mod>.ts`. Symbols may be **non-contiguous** in the source (the file interleaves concerns) — move by symbol name, not by line range. The new module file imports only what it needs from already-created `./<dep>` modules (leaves first, per DAG order). `obsidian-lib.ts` gets an `export * from "./lib/<mod>"` line and, for any symbol its *remaining* code still references, an `import { ... } from "./lib/<mod>"` line. Every task ends green (test + typecheck) and committed, so the repo is correct at every intermediate state.

**Canonical step template** (illustrated fully in Task 2; Tasks 3–14 follow it with their own concrete symbol list + grep):

1. Derive the new module's inbound imports with a grep.
2. Create `src/lib/<mod>.ts` (moved symbols + imports).
3. Delete those symbols from `obsidian-lib.ts`; add `export * from "./lib/<mod>"`.
4. Add any import `obsidian-lib.ts`'s remaining code still needs from the new module (grep-driven).
5. `bun test` → 384/385; `bun run typecheck` → exit 0.
6. Commit.

**DAG move order (topological):** errors → utils → (path-safety, fs-cache, vault-resolution, frontmatter) → index → (search, graph, links, zettel, subagent) → routing.

### Task 2: Extract `lib/errors.ts` (leaf — canonical example)

**Files:**
- Create: `bun-apps/pi-agent-ext-obsidian/src/lib/errors.ts`
- Modify: `bun-apps/pi-agent-ext-obsidian/src/obsidian-lib.ts`

**Symbols to move:** `errMsg`, `ErrCode`, `VaultError`, `fsErrCode`, `classifyFsError`, `toolError`, `toolErrorFromCaught` (currently ~lines 696–779, contiguous).

- [ ] **Step 1: Confirm the symbols have no intra-module deps (leaf)**

Run: `( cd bun-apps/pi-agent-ext-obsidian && sed -n '696,779p' src/obsidian-lib.ts | grep -nE "from \"|require\(" || echo "no imports — leaf ✓" )`
Expected: these functions reference only node built-ins / types they define themselves. (If the grep shows an import of another obsidian-lib symbol, add that symbol's module to errors.ts's import list — but errors is expected to be a true leaf.)

- [ ] **Step 2: Create `src/lib/errors.ts`**

Copy the exact text of the 7 symbols (including their JSDoc comments and the `// ---- Structured errors (Phase 1: WS-A1 + WS-A2) ---` section header) from `obsidian-lib.ts` into `src/lib/errors.ts`. Add only the imports the grep in Step 1 revealed (expected: just `import { ... } from "node:..."` if any, likely none beyond what's already top-of-file). Keep `export` keywords verbatim.

- [ ] **Step 3: Remove those symbols from `obsidian-lib.ts` + add barrel re-export**

Delete the 7 symbols' definitions (and their section header) from `obsidian-lib.ts`. Add near the top (after the existing imports):
```ts
export * from "./lib/errors";
```

- [ ] **Step 4: Fix any remaining references in `obsidian-lib.ts`**

Run: `( cd bun-apps/pi-agent-ext-obsidian && grep -nE "errMsg|VaultError|classifyFsError|toolError|toolErrorFromCaught|fsErrCode|ErrCode" src/obsidian-lib.ts )`
The barrel `export *` re-exports them, so references resolve WITHOUT an explicit import (same-module re-export is in scope). If `tsc` in Step 5 complains, add `import { <used> } from "./lib/errors";`. Expected: no explicit import needed.

- [ ] **Step 5: Verify green**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ 2>&1 | tail -3 && bun run typecheck && echo TYPECHECK_OK )`
Expected: `384 pass / 1 fail` + `TYPECHECK_OK`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-obsidian/src/lib/errors.ts bun-apps/pi-agent-ext-obsidian/src/obsidian-lib.ts
git commit -m "refactor(obsidian): extract lib/errors.ts (leaf module)"
```

### Task 3: Extract `lib/utils.ts` (leaf)

**Symbols:** `execFileP` (~57), `_findMonorepoRoot` (~67), `_missingDeps` (~82). Non-contiguous with neighbors (`OBSIDIAN_JSON` at 59 stays in vault-resolution).

- [ ] **Step 1:** `( cd bun-apps/pi-agent-ext-obsidian && sed -n '57,57p;67,81p;82,102p' src/obsidian-lib.ts )` — confirm these 3 symbols' bodies. `execFileP` needs `promisify`/`execFile` from `node:child_process` and `join` (keep their imports); `_missingDeps` may use `execFileP`.
- [ ] **Step 2:** Create `src/lib/utils.ts` with the 3 symbols + needed `import { execFile } from "node:child_process"; import { promisify } from "node:util";` (and `join` source). Verify exact imports via: `grep -nE "promisify|execFile|join\(" src/obsidian-lib.ts | head`.
- [ ] **Step 3:** Delete the 3 symbols from `obsidian-lib.ts`; add `export * from "./lib/utils";`. If `obsidian-lib.ts` top still imports `execFile`/`promisify` for OTHER code, keep those imports; otherwise remove now-unused ones (tsc will flag unused).
- [ ] **Step 4:** `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ 2>&1 | tail -3 && bun run typecheck && echo OK )` → green.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/utils.ts (leaf)`.

### Task 4: Extract `lib/path-safety.ts`

**Symbols:** `safeNotePath` (510), `fsLstat` (570), `fsRealpath` (571), `WRITE_BLOCKLIST` (606), `assertWithinVault` (622), `assertWritablePath` (658). Depends on: `errors` (none expected — these throw plain `Error`; verify).

- [ ] **Step 1:** `sed -n '510,575p;606,667p' src/obsidian-lib.ts` — confirm bodies + imports (expects `node:fs`/`node:path` + `node:fs/promises`).
- [ ] **Step 2:** Create `src/lib/path-safety.ts` (symbols + fs/path imports). If any symbol throws a `VaultError`, add `import { VaultError } from "./errors";` (grep `VaultError` in the range to decide).
- [ ] **Step 3:** Delete from `obsidian-lib.ts`; add `export * from "./lib/path-safety";`.
- [ ] **Step 4:** Verify green (test + typecheck).
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/path-safety.ts`.

### Task 5: Extract `lib/fs-cache.ts`

**Symbols:** `atomicWriteFile` (576), `renameOverwrite` (591), `noteMtime` (782), `mtimeConflict` (795), `CacheEntry` (814), `fileCache` (819), `fileCacheMax` (823), `readCached` (828), `invalidateCache` (882), `__fileCacheOrder` (889), `readBatched` (895), `listNotes` (915), `countNotes` (941). Depends on: `errors` (for `VaultError`/`fsErrCode` — `noteMtime` throws VaultError per its JSDoc).

- [ ] **Step 1:** `grep -nE "VaultError|fsErrCode|classifyFsError|toolError" src/obsidian-lib.ts | head` filtered to the fs-cache symbol ranges → build the exact `import { ... } from "./errors";` list.
- [ ] **Step 2:** Create `src/lib/fs-cache.ts` with all 13 symbols + `import { VaultError, ... } from "./errors";` + node fs/path imports.
- [ ] **Step 3:** Delete from `obsidian-lib.ts`; add `export * from "./lib/fs-cache";`.
- [ ] **Step 4:** Verify green.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/fs-cache.ts`.

> **Note for Phase 2:** `renameOverwrite` lands here. Task 9 (Phase 2.1) will modify THIS file. Keep its current behavior identical for now.

### Task 6: Extract `lib/vault-resolution.ts`

**Symbols:** `OBSIDIAN_JSON` (59), `VaultEntry` (104), `ObsidianConfig` (109), `VaultSource` (121), `ResolvedVault` (129), `VaultConfigFile` (149), `runDirPath` (164), `runDirConfigPath` (175), `personalConfigPath` (188), `projectConfigPath` (193), `vaultConfigPath` (199), `readPersonalConfig` (204), `readProjectConfig` (216), `readVaultConfig` (249), `writeVaultConfig` (258), `readObsidianVaults` (284), `isDirEmpty` (301), `seedFromTemplate` (311), `basenameOf` (327), `resolveVault` (356), `listVaultCandidates` (467), `openObsidianUri` (671), `launcherForUri` (684). Depends on: `utils` (`_findMonorepoRoot`, `_missingDeps`, `execFileP`), `errors`.

- [ ] **Step 1:** `grep -nE "_findMonorepoRoot|_missingDeps|execFileP|VaultError|errMsg" src/obsidian-lib.ts` within the vault-resolution ranges → build imports from `./utils` and `./errors`.
- [ ] **Step 2:** Create `src/lib/vault-resolution.ts` (all 23 symbols + imports). `openObsidianUri` uses `execFileP` (from utils) — import it.
- [ ] **Step 3:** Delete from `obsidian-lib.ts`; add `export * from "./lib/vault-resolution";`.
- [ ] **Step 4:** Verify green.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/vault-resolution.ts`.

### Task 7: Extract `lib/frontmatter.ts`

**Symbols (3 disjoint chunks):** `extractWikiLinks` (1385), `ParsedFrontmatter` (1401), `parseFrontmatter` (1409), `stripScalar` (1458) [chunk A: ~1385–1465]; `stringifyFrontmatter` (2466), `updateFrontmatter` (2491) [chunk B: ~2466–2546]; `appendUnderHeading` (2776) [chunk C: ~2776–2871]. Depends on: `errors`, `fs-cache` (`atomicWriteFile`, `readCached`, `noteMtime`, `mtimeConflict` — the edit ops read-modify-write). **Does NOT depend on index** (verified: updateFrontmatter/appendUnderHeading don't call getIndex).

- [ ] **Step 1:** `grep -nE "atomicWriteFile|readCached|noteMtime|mtimeConflict|VaultError|classifyFsError|parseFrontmatter|extractWikiLinks" src/obsidian-lib.ts` within the 3 chunks → build imports from `./fs-cache`, `./errors`, and intra-module (parseFrontmatter is used by updateFrontmatter — same module, no import needed).
- [ ] **Step 2:** Create `src/lib/frontmatter.ts` with all 7 symbols (3 chunks concatenated) + imports.
- [ ] **Step 3:** Delete the 3 chunks from `obsidian-lib.ts`; add `export * from "./lib/frontmatter";`.
- [ ] **Step 4:** Verify green.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/frontmatter.ts`.

### Task 8: Extract `lib/index.ts`

**Symbols:** `NoteMeta` (1471), `VaultIndex` (1486), `contentTrigrams` (1509), `trigramCandidates` (1523), `parseNoteMeta` (1544), `indexCache` (1608), `indexInFlight` (1612), `INDEX_POLL_MS_DEFAULT` (1624), `indexPollMs` (1625), `indexRefreshAt` (1626), `getIndex` (1631), `buildIndex` (1663), `rebuildReverseAdjacency` (1693), `INDEX_CACHE_VERSION` (1717), `indexCachePath` (1718), `statMtimes` (1724), `serializeIndex` (1738), `saveIndex` (1761), `loadCachedIndex` (1776), `titleKeysFor` (1881), `indexNote` (1891), `unindexNote` (1926), `resolveLink` (1959), `reindexFile` (1968), `dropIndex` (1985), `refreshIndex` (1996). Depends on: `errors`, `fs-cache` (`readCached`/`readBatched`/`listNotes`), `frontmatter` (`extractWikiLinks`, `parseFrontmatter` — parseNoteMeta uses extractWikiLinks, verified).

> **⚠ Non-contiguity:** `toolAllowlist` (1846) and `assertExtensionApi` (1860) belong to **subagent** (Task 12), NOT index. They sit wedged between `loadCachedIndex` and `titleKeysFor`. Move them in Task 12; for THIS task, leave them in `obsidian-lib.ts` (they'll still resolve via the barrel until Task 12 claims them). Alternatively, move them to a temporary holding — simplest is to leave in obsidian-lib.ts until Task 12.

- [ ] **Step 1:** `grep -nE "readCached|readBatched|listNotes|extractWikiLinks|parseFrontmatter|noteMtime|VaultError" src/obsidian-lib.ts` within index ranges → build imports.
- [ ] **Step 2:** Create `src/lib/index.ts` (26 symbols + imports). Leave `toolAllowlist`/`assertExtensionApi` in `obsidian-lib.ts`.
- [ ] **Step 3:** Delete the 26 symbols from `obsidian-lib.ts`; add `export * from "./lib/index";`.
- [ ] **Step 4:** Verify green. Confirm `extensions/obsidian.ts:793-794` (`refreshIndex`/`trigramCandidates` calls in the search handler) still resolve via barrel.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/index.ts (vault index + trigram + persistence)`.

### Task 9: Extract `lib/search.ts` (near-leaf)

**Symbols:** `MatchMode` (949), `NoteField` (950), `isSubsequence` (953), `levenshtein` (964), `fuzzyMatch` (989), `deescapeRegex` (1026), `buildMatcher` (1030), `computeFieldLabels` (1105), `SearchMatch` (1144), `noteRecencyDays` (1155), `fieldWeight` (1165), `pickField` (1179), `searchVault` (1209), `renderContext` (1365). Depends on: `fs-cache` (`listNotes`, `readBatched` — searchVault uses both). **Does NOT depend on index** (trigram pre-filter is in the tool layer, verified).

- [ ] **Step 1:** `grep -nE "listNotes|readBatched|noteMtime" src/obsidian-lib.ts` within 949–1364 → build `import { listNotes, readBatched } from "./fs-cache";`.
- [ ] **Step 2:** Create `src/lib/search.ts` (14 symbols + imports).
- [ ] **Step 3:** Delete from `obsidian-lib.ts`; add `export * from "./lib/search";`.
- [ ] **Step 4:** Verify green. Run the search baseline test explicitly: `bun test extensions/__tests__/ --grep search` (the substring-default contract must stay byte-identical).
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/search.ts`.

### Task 10: Extract `lib/graph.ts`

**Symbols (2 chunks):** `resolveWikiLink` (2042), `backlinkPaths` (2050), `tagPaths` (2058), `GraphMode` (2064), `GraphResult` (2071), `graphOutgoing` (2079), `graphOrphans` (2100), `graphDeadLinks` (2110), `buildAdjacency` (2125), `getAdjacency` (2144), `graphNeighbors` (2155) [chunk A: ~2042–2190]; `queryNotes` (2547), `detectTitleStyleOutliers` (2599), `findBacklinks` (2635), `findTagNotes` (2696) [chunk B: ~2547–2775]. Depends on: `index` (`getIndex`, `VaultIndex`, `backlinkPaths` reads `idx.reverseAdjacency`, `findBacklinks`/`findTagNotes`/`queryNotes` call `getIndex` — verified at relative lines 95/190 of the 2466+ range).

- [ ] **Step 1:** `grep -nE "getIndex|VaultIndex|backlinkPaths|reverseAdjacency" src/obsidian-lib.ts` within graph ranges → `import { getIndex, ... , type VaultIndex } from "./index";`.
- [ ] **Step 2:** Create `src/lib/graph.ts` (15 symbols, 2 chunks + imports).
- [ ] **Step 3:** Delete from `obsidian-lib.ts`; add `export * from "./lib/graph";`.
- [ ] **Step 4:** Verify green.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/graph.ts`.

### Task 11: Extract `lib/links.ts`

**Symbols:** `rewriteLinkToken` (2195), `LINK_KEEP` (2236), `LINK_DELETE` (2237), `rewriteLinksProtected` (2245), `moveNote` (2314), `deleteNote` (2398). Depends on: `index` (backlinks via `backlinkPaths`/`getIndex`), `fs-cache` (`readCached`, `atomicWriteFile`), `errors`. **Does NOT depend on frontmatter** (verified).

- [ ] **Step 1:** `grep -nE "backlinkPaths|getIndex|readCached|atomicWriteFile|VaultError|errMsg" src/obsidian-lib.ts` within 2195–2465 → build imports.
- [ ] **Step 2:** Create `src/lib/links.ts` (6 symbols + imports).
- [ ] **Step 3:** Delete from `obsidian-lib.ts`; add `export * from "./lib/links";`.
- [ ] **Step 4:** Verify green. Run rewrite-protection tests: `bun test extensions/__tests__/ --grep rewrite`.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/links.ts`.

### Task 12: Extract `lib/subagent.ts`

**Symbols:** `toolAllowlist` (1846), `assertExtensionApi` (1860) [the two wedged in the index range — now claim them], `ZETTEL_SYSTEM_PROMPT` (2872), `getPiInvocation` (2963), `SubagentOptions` (2981), `makeSubagentProgressLogger` (2997), `buildSubagentArgs` (3037), `WEAK_MODEL_PATTERNS` (3076), `isWeakModel` (3088), `ResolvedModel` (3093), `resolveSubagentModel` (3106), `parseStructuredResult` (3141), `runSubagentWithRetry` (3159), `isTransientError` (3188), `runSubagentWithRetryImpl` (3210), `runSubagent` (3258), `GARDEN_SYSTEM_PROMPT` (3397). Depends on: `utils` (`_missingDeps`, `_findMonorepoRoot` — used by assertExtensionApi), `errors`.

- [ ] **Step 1:** `grep -nE "_missingDeps|_findMonorepoRoot|VaultError|errMsg" src/obsidian-lib.ts` within subagent ranges → build imports from `./utils`, `./errors`.
- [ ] **Step 2:** Create `src/lib/subagent.ts` (17 symbols + imports). Includes the two large prompt template literals verbatim.
- [ ] **Step 3:** Delete from `obsidian-lib.ts` (including `toolAllowlist`/`assertExtensionApi` finally leaving the file); add `export * from "./lib/subagent";`.
- [ ] **Step 4:** Verify green. Run subagent tests: `bun test extensions/__tests__/ --grep subagent`.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/subagent.ts`.

### Task 13: Extract `lib/zettel.ts`

**Symbols:** `ZETTEL_MAX_BYTES` (3456), `ZETTEL_REQUIRED_KEYS` (3458), `NoteValidation` (3460), `validateZettelNote` (3469), `validateZettelNotes` (3510), `IntegrityIssue` (3547), `validateNoteIntegrity` (3554), `validateNoteIntegrityBatch` (3579), `DetHealthResult` (3802), `registerDeterministicHealthCheck` (3814), `runDeterministicHealthCheck` (3825), `mtimeToZettelIds` (3846), `FrontmatterRepair` (3855), `repairZettelFrontmatter` (3871). Depends on: `errors`, `index` (`getIndex`, `type VaultIndex`, `validateZettelNotes` reads paths), `frontmatter` (`parseFrontmatter`/`stringifyFrontmatter` — validate/repair parse frontmatter).

- [ ] **Step 1:** `grep -nE "getIndex|VaultIndex|parseFrontmatter|stringifyFrontmatter|VaultError" src/obsidian-lib.ts` within zettel ranges → build imports.
- [ ] **Step 2:** Create `src/lib/zettel.ts` (14 symbols + imports).
- [ ] **Step 3:** Delete from `obsidian-lib.ts`; add `export * from "./lib/zettel";`.
- [ ] **Step 4:** Verify green.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/zettel.ts`.

### Task 14: Extract `lib/routing.ts`

**Symbols:** `scheduleVaultBanner` (3609), `searchRoutingDescription` (3646), `searchReferenceText` (3656), `obsidianRoutingDescription` (3706), `obsidianActionReferenceText` (3719). Depends on: `vault-resolution` (only if these reference vault name/path; verify — likely standalone string builders).

- [ ] **Step 1:** `grep -nE "resolveVault|ResolvedVault|vault" src/obsidian-lib.ts` within 3609–3800 → decide if `./vault-resolution` import is needed (likely none; these are pure string templates).
- [ ] **Step 2:** Create `src/lib/routing.ts` (5 symbols + any imports).
- [ ] **Step 3:** Delete from `obsidian-lib.ts`; add `export * from "./lib/routing";`.
- [ ] **Step 4:** Verify green.
- [ ] **Step 5:** Commit `refactor(obsidian): extract lib/routing.ts`.

### Task 15: Collapse `obsidian-lib.ts` to a pure barrel + final Phase 1 verify

**Files:**
- Modify: `bun-apps/pi-agent-ext-obsidian/src/obsidian-lib.ts` (should now contain ONLY the 13 `export *` lines + any leftover top-of-file imports that are now unused)

- [ ] **Step 1: Confirm obsidian-lib.ts has no remaining definitions**

Run: `( cd bun-apps/pi-agent-ext-obsidian && grep -cE "^export (async function|function|const|interface|type|class)" src/obsidian-lib.ts )`
Expected: `0`. If >0, a symbol was missed — identify and move it to the correct module (use `grep -nE "^export " src/obsidian-lib.ts` to list stragglers).

- [ ] **Step 2: Strip now-unused top-of-file imports**

`obsidian-lib.ts` should be ONLY:
```ts
// Barrel re-export — the public API of pi-obsidian's core library.
// Every consumer (extensions/obsidian.ts, lib/index.ts, __tests__) imports
// from here, so this file MUST stay a pure re-export of src/lib/*.
export * from "./lib/errors";
export * from "./lib/utils";
export * from "./lib/path-safety";
export * from "./lib/fs-cache";
export * from "./lib/vault-resolution";
export * from "./lib/frontmatter";
export * from "./lib/index";
export * from "./lib/search";
export * from "./lib/graph";
export * from "./lib/links";
export * from "./lib/subagent";
export * from "./lib/zettel";
export * from "./lib/routing";
```
Remove any now-dead `import` lines (tsc flags unused).

- [ ] **Step 3: Full verify**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ 2>&1 | tail -3 && bun run typecheck && echo OK )`
Expected: `384 pass / 1 fail` + `OK`.

- [ ] **Step 4: Confirm no consumer import paths changed**

Run: `( cd bun-apps/pi-agent-ext-obsidian && git diff --stat extensions/ lib/index.ts extensions/__tests__/ | tail -5 )`
Expected: **empty** (no diffs in consumers — the barrel kept their imports stable). If non-empty, a consumer was edited during Phase 1 — investigate (only test-file additions from Phase 2 should touch __tests__).

- [ ] **Step 5: Acyclicity check**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bunx madge --circular --extensions ts src/ 2>&1 | tail -10 || echo "madge not installed — rely on tsc" )`
Expected: no circular dependencies (or madge absent → tsc's OK in Step 3 suffices).

- [ ] **Step 6: Cross-package smoke**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test 2>&1 | tail -5 )`
Expected: green (it imports `@repo/pi-agent-ext-obsidian`; barrel keeps symbols resolvable).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-obsidian/src/obsidian-lib.ts
git commit -m "refactor(obsidian): collapse obsidian-lib.ts to pure barrel re-export"
```

---

## Phase 2 — Correctness fixes

### Task 16: Windows atomic-overwrite fallback in `renameOverwrite`

**Files:**
- Modify: `bun-apps/pi-agent-ext-obsidian/src/lib/fs-cache.ts` (`renameOverwrite`, ~lines moved from old 591)
- Test: `bun-apps/pi-agent-ext-obsidian/extensions/__tests__/renameOverwrite.test.ts` (create)

**Interfaces:** `renameOverwrite(from: string, to: string): Promise<void>` — signature unchanged; behavior gains a win32 EPERM/EEXIST fallback.

- [ ] **Step 1: Write the failing test**

Create `extensions/__tests__/renameOverwrite.test.ts`:
```ts
import { test, expect, mock, beforeEach } from "bun:test";
import { renameOverwrite } from "../src/obsidian-lib.ts";

// Drive renameOverwrite against an in-memory fs double so we can inject
// EPERM/EEXIST (win32 rename-onto-existing) without a real Windows box.
const fakeErr = (code: string) => Object.assign(new Error(code), { code });

test("renameOverwrite: plain rename success (fast path)", async () => {
	const rename = mock(() => Promise.resolve());
	await renameOverwrite("/v/a.tmp", "/v/a.md", { rename });
	expect(rename).toHaveBeenCalledTimes(1);
});

test("renameOverwrite: EPERM on existing target → unlink+retry succeeds", async () => {
	const rename = mock(() => Promise.reject(fakeErr("EPERM")));
	const unlink = mock(() => Promise.resolve());
	// second rename attempt (after unlink) succeeds
	let calls = 0;
	rename.mockImplementation(() => (calls++ === 0 ? Promise.reject(fakeErr("EPERM")) : Promise.resolve()));
	await renameOverwrite("/v/a.tmp", "/v/a.md", { rename, unlink });
	expect(unlink).toHaveBeenCalledWith("/v/a.md");
	expect(rename).toHaveBeenCalledTimes(2);
});

test("renameOverwrite: EEXIST → unlink+retry succeeds", async () => {
	const unlink = mock(() => Promise.resolve());
	let calls = 0;
	const rename = mock(() => (calls++ === 0 ? Promise.reject(fakeErr("EEXIST")) : Promise.resolve()));
	await renameOverwrite("/v/a.tmp", "/v/a.md", { rename, unlink });
	expect(unlink).toHaveBeenCalledTimes(1);
});

test("renameOverwrite: EXDEV → copy+delete path (unchanged)", async () => {
	const cp = mock(() => Promise.resolve());
	const unlink = mock(() => Promise.resolve());
	const rename = mock(() => Promise.reject(fakeErr("EXDEV")));
	await renameOverwrite("/v/a.tmp", "/v/a.md", { rename, cp, unlink });
	expect(cp).toHaveBeenCalled();
});

test("renameOverwrite: unrelated error rethrows", async () => {
	const rename = mock(() => Promise.reject(fakeErr("EACCES")));
	await expect(renameOverwrite("/v/a.tmp", "/v/a.md", { rename })).rejects.toThrow();
});
```

> **Design note:** the test passes an injectable `{ rename, unlink, cp }` fs double. The CURRENT `renameOverwrite` calls the real `node:fs/promises` directly. Step 3 refactors it to accept an optional fs injection (defaulting to node fs) so the test can drive error codes. This is a pure testability seam — production behavior uses the real fs defaults.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/renameOverwrite.test.ts 2>&1 | tail -15 )`
Expected: FAIL — `renameOverwrite` doesn't accept the options arg / doesn't handle EPERM.

- [ ] **Step 3: Implement the fallback**

In `src/lib/fs-cache.ts`, replace `renameOverwrite` with:
```ts
import { rename as fsRename, unlink as fsUnlink, cp as fsCp } from "node:fs/promises";

type FsDouble = {
	rename?: (from: string, to: string) => Promise<void>;
	unlink?: (p: string) => Promise<void>;
	cp?: (src: string, dst: string, opts?: { force?: boolean }) => Promise<void>;
};

/** rename with fallbacks: EXDEV → copy+delete; win32 EPERM/EEXIST → unlink+retry. */
export const renameOverwrite = async (
	from: string,
	to: string,
	fs: FsDouble = {},
): Promise<void> => {
	const rename = fs.rename ?? fsRename;
	const unlink = fs.unlink ?? fsUnlink;
	const cp = fs.cp ?? fsCp;
	try {
		await rename(from, to);
	} catch (e: any) {
		const code = e?.code;
		if (code === "EXDEV") {
			// cross-device: copy then delete source (unchanged behavior)
			await cp(from, to, { force: true });
			await unlink(from);
			return;
		}
		if (code === "EPERM" || code === "EEXIST") {
			// win32: rename onto an existing target throws; remove it and retry once.
			await unlink(to);
			await rename(from, to);
			return;
		}
		throw e;
	}
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/renameOverwrite.test.ts 2>&1 | tail -8 )`
Expected: PASS (5/5).

- [ ] **Step 5: Verify the full suite + typecheck still green**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ 2>&1 | tail -3 && bun run typecheck && echo OK )`
Expected: `389 pass / 1 fail` + `OK` (384 + 5 new).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-obsidian/src/lib/fs-cache.ts bun-apps/pi-agent-ext-obsidian/extensions/__tests__/renameOverwrite.test.ts
git commit -m "fix(obsidian): renameOverwrite handles win32 EPERM/EEXIST via unlink+retry"
```

### Task 17: Parallelize inbound-link rewrites in `moveNote` / `deleteNote`

**Files:**
- Modify: `bun-apps/pi-agent-ext-obsidian/src/lib/links.ts` (`moveNote`, `deleteNote`)
- Test: `bun-apps/pi-agent-ext-obsidian/extensions/__tests__/linkRewriteParallel.test.ts` (create)

**Interfaces:** `moveNote`/`deleteNote` signatures unchanged; per-source rewrite loop becomes `Promise.all`. `failedSources` collection semantics preserved.

- [ ] **Step 1: Write the failing test**

Create `extensions/__tests__/linkRewriteParallel.test.ts` using the existing `_vault-fixture.ts` helper:
```ts
import { test, expect, describe } from "bun:test";
import { getVault, cleanupVault } from "./_vault-fixture.ts";
import { create } from "./_fakes.ts"; // or inline a minimal create() helper
import { moveNote, deleteNote } from "../src/obsidian-lib.ts";

describe("parallel link rewrite", () => {
	test("moveNote rewrites ALL inbound links when many sources point at the note", async () => {
		const v = await getVault("parallel-move");
		// Seed: target + 5 source notes each linking [[target]]
		await create(v.path, "target.md", "# Target\n");
		for (let i = 0; i < 5; i++) {
			await create(v.path, `src${i}.md`, `# S${i}\nSee [[target]]\n`);
		}
		const res = await moveNote(v.path, "target.md", "renamed.md");
		expect(res.failedSources).toEqual([]);
		// every source now links [[renamed]]
		for (let i = 0; i < 5; i++) {
			const body = await Bun.file(`${v.path}/src${i}.md`).text();
			expect(body).toContain("[[renamed]]");
			expect(body).not.toContain("[[target]]");
		}
		cleanupVault();
	});

	test("deleteNote strips inbound links from all sources in parallel", async () => {
		const v = await getVault("parallel-del");
		await create(v.path, "victim.md", "# V\n");
		for (let i = 0; i < 5; i++) {
			await create(v.path, `d${i}.md`, `# D${i}\nref [[victim]]\n`);
		}
		await deleteNote(v.path, "victim.md", { confirm: true });
		for (let i = 0; i < 5; i++) {
			const body = await Bun.file(`${v.path}/d${i}.md`).text();
			expect(body).not.toContain("[[victim]]");
		}
		cleanupVault();
	});
});
```
> If `extensions/__tests__/_fakes.ts` doesn't exist, use the same `create` pattern the existing `toolSmoke`/`expectedMtime` tests use (read those files first and mirror the helper). The test asserts behavior that is ALREADY true (sequential rewrites also pass it) — its job is to lock the contract so the parallelization in Step 3 can't regress it.

- [ ] **Step 2: Run test**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/linkRewriteParallel.test.ts 2>&1 | tail -10 )`
Expected: PASS already (current sequential code satisfies it) — this is a characterization test guarding the refactor.

- [ ] **Step 3: Parallelize the rewrite loops**

In `src/lib/links.ts`, find the per-source rewrite loops in `moveNote` and `deleteNote` (the `for (const src of sources) { await read; await rewrite; }` pattern). Replace each with:
```ts
const results = await Promise.all(
	sources.map(async (src) => {
		try {
			const body = await readFile(/* abs path of src */, "utf8");
			const next = rewriteLinksProtected(body, /* token fn */);
			await atomicWriteFile(/* abs path */, next);
			return { src, ok: true as const };
		} catch (e) {
			return { src, ok: false as const, err: e };
		}
	}),
);
const failedSources = results.filter((r) => !r.ok).map((r) => r.src);
```
Preserve the EXACT pre-existing: (a) `moveNote` moves the file FIRST and bails before touching backlinks if the rename throws; (b) `failedSources` is returned/populated identically; (c) the `obsidian_move` tool's warning text naming failed sources (already in `extensions/obsidian.ts`) is unaffected. Only the loop construct changes.

- [ ] **Step 4: Run test to verify still passes + full suite green**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ 2>&1 | tail -3 && bun run typecheck && echo OK )`
Expected: green + OK.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-obsidian/src/lib/links.ts bun-apps/pi-agent-ext-obsidian/extensions/__tests__/linkRewriteParallel.test.ts
git commit -m "perf(obsidian): parallelize inbound-link rewrites in moveNote/deleteNote"
```

### Task 18: Opt-in semantic re-index hook on `obsidian_distill`

**Files:**
- Modify: `bun-apps/pi-agent-ext-obsidian/src/lib/subagent.ts` (the distill post-run audit path) OR `extensions/obsidian.ts` (wherever the distill `execute` runs its post-run audit — locate first)
- Test: `bun-apps/pi-agent-ext-obsidian/extensions/__tests__/semanticReindex.test.ts` (create)

**Interfaces:** New env `VAULT_MIND_AUTO_REINDEX` (truthy → enable). New internal helper `maybeTriggerReindex(vaultName, vaultPath, opts?): Promise<void>` — fire-and-forget, never throws into the caller.

- [ ] **Step 1: Locate the distill post-run audit**

Run: `( cd bun-apps/pi-agent-ext-obsidian && grep -nE "result.notes|validateZettelNotes|post-run" extensions/obsidian.ts src/lib/subagent.ts src/lib/zettel.ts | head )`
Identify the exact function/line where `obsidian_distill` finishes and audits `result.notes`. That is the hook point.

- [ ] **Step 2: Write the failing test**

Create `extensions/__tests__/semanticReindex.test.ts`:
```ts
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { maybeTriggerReindex } from "../src/obsidian-lib.ts";

const BASE = "http://127.0.0.1:8000";

beforeEach(() => { delete process.env.VAULT_MIND_AUTO_REINDEX; delete process.env.VAULT_MIND_BASE_URL; });

test("disabled by default: no HTTP issued", async () => {
	const fetchMock = mock(() => Promise.resolve(new Response("{}")));
	await maybeTriggerReindex("pi-agent-vault", "/v", { fetch: fetchMock, base: BASE });
	expect(fetchMock).not.toHaveBeenCalled();
});

test("enabled + base set: POSTs /api/index with force_reindex:true", async () => {
	process.env.VAULT_MIND_AUTO_REINDEX = "1";
	const fetchMock = mock(() => Promise.resolve(new Response('{"job_id":"j1"}', { status: 200 })));
	await maybeTriggerReindex("pi-agent-vault", "/v", { fetch: fetchMock, base: BASE });
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0];
	expect(String(url)).toContain("/api/index");
	expect((init as any).method).toBe("POST");
	const body = JSON.parse((init as any).body);
	expect(body).toMatchObject({ vault_name: "pi-agent-vault", force_reindex: true });
});

test("service down: warns, does not throw into caller", async () => {
	process.env.VAULT_MIND_AUTO_REINDEX = "1";
	const fetchMock = mock(() => Promise.reject(new Error("ECONNREFUSED")));
	await expect(maybeTriggerReindex("pi-agent-vault", "/v", { fetch: fetchMock, base: BASE })).resolves.toBeUndefined();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/semanticReindex.test.ts 2>&1 | tail -10 )`
Expected: FAIL — `maybeTriggerReindex` not exported.

- [ ] **Step 4: Implement the helper**

Add to `src/lib/subagent.ts` (or `src/lib/routing.ts` — place near where vault-mind base URL is read; default `subagent.ts` since distill lives there):
```ts
const REINDEX_TIMEOUT_MS = 10_000;

/** Fire-and-forget vault-mind re-index. Opt-in via VAULT_MIND_AUTO_REINDEX.
 *  Never throws — failures only warn. Honors README's /api/index force_reindex flow. */
export async function maybeTriggerReindex(
	vaultName: string,
	vaultPath: string,
	opts: { fetch?: typeof fetch; base?: string } = {},
): Promise<void> {
	const enabled = String(process.env.VAULT_MIND_AUTO_REINDEX ?? "").trim();
	if (!enabled || ["0", "false", ""].includes(enabled.toLowerCase())) return;
	const base = (opts.base ?? process.env.VAULT_MIND_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
	const f = opts.fetch ?? globalThis.fetch;
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), REINDEX_TIMEOUT_MS);
		await f(`${base}/api/index`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ vault_name: vaultName, vault_path: vaultPath, force_reindex: true }),
			signal: ctrl.signal,
		});
		clearTimeout(t);
	} catch (e) {
		console.warn(`[obsidian] semantic re-index skipped: ${(e as Error).message}`);
	}
}
```

- [ ] **Step 5: Wire the hook into the distill post-run audit**

At the hook point found in Step 1, after the successful `validateZettelNotes` audit (only when notes were actually written — i.e. `result.notes.length > 0`), add a non-awaited call:
```ts
void maybeTriggerReindex(vault.name, v.path); // fire-and-forget; opt-in via env
```
(`v`/`vault` = the resolved vault in scope at that point.) Do NOT await it and do NOT let it affect the tool result.

- [ ] **Step 6: Run test to verify pass + full suite green**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ 2>&1 | tail -3 && bun run typecheck && echo OK )`
Expected: green + OK.

- [ ] **Step 7: Document in README**

In `bun-apps/pi-agent-ext-obsidian/README.md`, under the Environment variables table, add a row for `VAULT_MIND_AUTO_REINDEX` (default unset/off; set to `1` to auto re-index after `obsidian_distill`). Add a one-line note under "Semantic search" that this closes the manual re-index gap.

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-obsidian/src/lib/subagent.ts bun-apps/pi-agent-ext-obsidian/extensions/obsidian.ts bun-apps/pi-agent-ext-obsidian/extensions/__tests__/semanticReindex.test.ts bun-apps/pi-agent-ext-obsidian/README.md
git commit -m "feat(obsidian): opt-in semantic re-index after distill (VAULT_MIND_AUTO_REINDEX)"
```

---

## Phase 3 — Guardrail hardening

### Task 19: Stabilize snapshot messaging + final full verify

**Files:**
- Modify: `bun-apps/pi-agent-ext-obsidian/extensions/__tests__/fixtures/search-baseline.real.mjs` (improve the skip/fail message) — locate the `skipIf(!vaultAvailable())` site first
- Modify: `bun-apps/pi-agent-ext-obsidian/package.json` (wire typecheck into `test` if desired)

- [ ] **Step 1: Locate the snapshot gate**

Run: `( cd bun-apps/pi-agent-ext-obsidian && grep -rnE "skipIf|vaultAvailable|submodule" extensions/__tests__/ | head )`
Find where the real-vault snapshot is skipped.

- [ ] **Step 2: Improve the skip message**

At the skip site, make the message explicit (it likely already is — verify it names both the submodule init command AND the regen command):
```
skipped: vaults_root/pi-agent-vault submodule not initialized.
  Fix: `git submodule update --init vaults_root/pi-agent-vault`
  Or regenerate the in-package contract: `bun run regen:contract`
```
If the message already covers both, this step is a no-op — note it and move on.

- [ ] **Step 3: Confirm schema-cost regression guard**

Run: `( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/perf/schema-cost.regression.test.ts 2>&1 | tail -8 )`
Expected: `total schema ≤ 280 tokens` PASS (the split + fixes must not have added registered tools).

- [ ] **Step 4: Final full verify**

Run:
```bash
( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ 2>&1 | tail -4 && bun run typecheck && echo TYPECHECK_OK )
( cd bun-apps/pi-agent-ext-knowledge-card && bun test 2>&1 | tail -3 )
```
Expected: obsidian green + TYPECHECK_OK; knowledge-card green.

- [ ] **Step 5: Update KNOWN-ISSUES.md**

In `docs/KNOWN-ISSUES.md`:
- Move the Windows `renameOverwrite` bullet from *(open)* to **Resolved** (unlink+retry fallback, tested).
- Mark the `moveNote`/`deleteNote` sequential-await bullet **Resolved** (parallelized).
- Note the semantic re-index gap closed (opt-in `VAULT_MIND_AUTO_REINDEX`).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-obsidian/docs/KNOWN-ISSUES.md bun-apps/pi-agent-ext-obsidian/extensions/__tests__ bun-apps/pi-agent-ext-obsidian/package.json
git commit -m "docs(obsidian): mark Windows-overwrite + parallel-link-rewrite resolved; snapshot msg"
```

---

## Self-Review (completed by plan author)

**1. Spec coverage:** Phase 0 = spec §Phase 0 ✓. Phase 1 Tasks 2–15 = spec §Phase 1 (13 modules + barrel) ✓. Phase 2 Tasks 16/17/18 = spec §2.1/2.2/2.3 ✓. Phase 3 Task 19 = spec §Phase 3 ✓. Out-of-scope items (extensions/obsidian.ts split, zk_ingest hook, new features) correctly absent ✓.

**2. Placeholder scan:** No "TBD/TODO/implement later". Phase 1 import lists are derived via concrete grep commands (deterministic, not placeholders) — this is intentional for a mechanical refactor where hand-encoding ~115 symbols' cross-refs would be more error-prone than deriving them. Phase 2/3 have full test + impl code. The only "locate first" steps (Task 18 Step 1, Task 19 Step 1) give the exact grep to find the site.

**3. Type consistency:** `renameOverwrite`'s new `(from, to, fs?)` signature is used identically in its test. `maybeTriggerReindex(vaultName, vaultPath, opts?)` signature matches across impl + test + wiring call. `failedSources` return shape preserved in Task 17.

**4. Risk note:** Tasks 2–14 depend on the DAG order being correct; if any module's real imports diverge from the grep-derived list, `tsc` (Step 5 of each) catches it before commit — so a wrong import list fails the task rather than silently merging.
