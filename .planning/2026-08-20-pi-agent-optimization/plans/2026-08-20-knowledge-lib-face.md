# Plan — obsidian src lib face + knowledge-card import-face fix (1 PR)

- **Effort**: `pi-agent-optimization` (knowledge-pipeline follow-up; Phase C runpy abandoned)
- **Date**: 2026-08-20
- **Status**: approved (plan-mode double-check session, same day)
- **Decision**: 方案 1 — fix root cause (lib face), do NOT merge packages

## Context

The knowledge-layer deploy blocker recorded in `pi-agent/docs/deploy-sh.md` ("knowledge-card —
imports obsidian's extension entry directly — dependency cascade") traces to one root cause:
`@repo/pi-agent-ext-obsidian`'s `main`/`exports["."]` points at the **registration entry**
`extensions/obsidian.ts`, so knowledge-card's 12 import statements (10 files) pull lib symbols
(`parseFrontmatter`, `resolveVault`, `getIndex`, `graphDeadLinks`, `graphOrphans`,
`invalidateCache`, `validateZettelNote`, `ZETTEL_MAX_BYTES`, `registerDeterministicHealthCheck`)
through the extension face. This violates the repo's shipped src-entry convention
(`main: "./src/index.ts"` is the lib face; `extensions/<X>.ts` is registration-only).

Ground truth verified 2026-08-20:

- All 9 symbols are defined in `pi-agent-ext-obsidian/src/lib/*` and re-exported by the existing
  barrel `src/obsidian-lib.ts` (13 star exports, declares nothing itself);
  `extensions/obsidian.ts:141` star-exports that barrel. Module-identity (fs-cache singletons
  etc.) is preserved by any specifier switch through the lib face.
- dep-guard (`bun-apps/tests/dep-guard.test.ts`) is specifier-agnostic (subpath captured-and-
  discarded) — the kc→obsidian edge is asserted either way; kc declares obsidian as
  peerDependency, satisfying the declared-dep invariant. Neither package is in the deploy base
  set, so the portable-base-set invariant is untouched.
- dead-export guard: a star-re-export barrel adds zero risk; the two obsidian ALLOWED entries
  (`vaultConfigPath`, `readVaultConfig`) stay valid.

## Changes

### 1. pi-agent-ext-obsidian — lib face

- **NEW** `src/index.ts` — 1-line barrel matching the repo shim convention:
  `export * from "./obsidian-lib.ts";`
  (Full lib surface — NOT a narrow 9-symbol face; narrowness buys nothing, dead-export risk is
  moot for star barrels.)
- `package.json`: `main` → `"./src/index.ts"`; `exports["."]` → `"./src/index.ts"`. Keep
  `"./extensions/*"` and `"./src/*"` unchanged. No `files` change (workspace consumers resolve
  source).

### 2. pi-agent-ext-tool-gate — REQUIRED break fix (2 sites)

Both bare-specifier imports consume the **default factory** via `main`, which the flip removes:

- `qa/evaluate.ts:61` → `import obsidianDefault from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";`
- `extensions/migrated-extensions.ts:44` → `import obsidianExtension from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";`

(Registration-purpose import walks the registration face. `qa/collect-probes.ts:108` already
uses the deep path; untouched.)

### 3. pi-agent-ext-knowledge-card — src specifier flip (10 files / 12 statements)

Change ONLY the specifier to bare `@repo/pi-agent-ext-obsidian`; symbol lists untouched:
`src/adapters.ts:4`, `src/host-fns.ts:13`, `src/graph-health.ts:39`, `src/retrieve.ts:38-39`,
`src/supersede.ts:20`, `src/card-format.ts:3`, `src/hierarchy-build.ts:35`,
`src/aggregation-write.ts:40`, `src/ingest.ts:48-51`, `extensions/knowledge-card.ts:56-59`.

### 4. kc tests — mock.module lockstep (silent-failure guard)

`mock.module` matches by specifier string; after the flip the old deep-path mocks silently stop
applying. Update in lockstep:

- `__tests__/e2e-orchestration.test.ts` — ~11 `mock.module("@repo/pi-agent-ext-obsidian/
  extensions/obsidian.ts", …)` sites (lines ≈64, 260, 275, 294, 344, 419, 440, 452, 485, 552,
  582) + the relative-path site at :59 → bare specifier. Mock factories unchanged.
- `__tests__/semantic.test.ts:35,37`; `__tests__/helpers/contract.mjs:28` (dynamic import).
- Test-file direct imports: `__tests__/ingest.test.ts:30`, `__tests__/ingest-generic.test.ts:18`,
  `__tests__/aggregation-write.test.ts:9` → bare specifier.

Behavioral proof that mocks still apply: e2e-orchestration asserts mock call counts — it fails
loudly if a mock went inert.

### 5. Docs

- `pi-agent/docs/deploy-sh.md` (~225-232): knowledge-card exclusion reason updated —
  entry-import cascade resolved via lib face; kc stays excluded because its Tier-0 dep
  (obsidian) is itself outside the portable base set.
- `pi-agent-ext-devops/scripts/deploy.ts:55-77` comment block: update the import-face
  description (kc now consumes the bare lib specifier).

### Out of scope (explicit)

- `pi-agent/src/cli/**` consumers (deep `/extensions/obsidian.ts` subpath — registration use,
  unaffected).
- `pi-agent/src/cli/commands/memory-to-vault.ts:25` default-factory import (legitimate
  registration use).
- `pi-agent-ext-research-tool` vault-parity test (`/src/obsidian-lib.ts` subpath — already lib
  face).
- `pi-agent-ext-obsidian/lib/` script barrels; `manifest-types.test.ts` fixture string;
  `files` field; merging packages (rejected 方案).

## Verification

1. `( cd bun-apps/pi-agent-ext-obsidian && bun run test )` — canonical (≈60 files).
2. `( cd bun-apps/pi-agent-ext-knowledge-card && bun run test )` — 40 files;
   e2e-orchestration is the import-chain + mock-application evidence.
3. `( cd bun-apps/pi-agent-ext-tool-gate && bun run test )` — proves the 2 flipped imports.
4. pi-agent cross-package typecheck (canonical pi-agent test gate) — `main` flip type-checked
   across all consumers.
5. Devops chain: `prepare-cli` → `local-ci-cli` (dep-guard, dead-export,
   extension-entry-typecheck, deploy-artifact guards inside) → `pr-finish-cli`. One PR.

## Execution mode

SDD per repo SOP: fresh implementer subagent, independent reviewer, fix loop ≤5 rounds,
whole-branch final review. All git phases through the devops tool chain. Watchdog off for the
write-heavy implementer dispatch.

## Risks

- **Mock inertness** (the one real trap): fully enumerated in §4; e2e-orchestration's
  call-count assertions are the tripwire.
- **Hidden bare-specifier consumers**: full-repo grep found exactly 2 (both tool-gate, both in
  scope); deep-subpath consumers unaffected by an `exports["."]` flip.
- **Module-identity**: preserved — all 9 symbols still resolve to the same `src/lib/*` modules.
