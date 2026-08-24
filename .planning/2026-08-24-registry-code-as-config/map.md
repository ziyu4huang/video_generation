---
effort: 2026-08-24-registry-code-as-config
created: 2026-08-24
last: 2026-08-24
status: active
---

# registry-code-as-config — s2-agent.registry.yaml → typed TS registry (pre-load-providers pattern)

## Destination

`s2-agent.registry.yaml` is retired. The extension registry lives as ONE typed,
side-effect-free TS module in `bun-apps/s2-agent/src/` (same doctrine as
`pre-load-providers.ts`): every entry — including disabled ones — is a
first-class `enabled: false` value that stays type-checked, enumerable, and
invariant-tested. All six repo consumers import it instead of parsing YAML; the
`ext new` scaffold emits a TS entry; `run-dir/manifest.json` remains DERIVED
with its freshness gate intact; the ordering/host-contract rules that today live
in YAML comments become executable invariant tests.

## Context (measured 2026-08-24 on this machine, file:line verified during planning)

- **The registry chain today**: `bun-apps/s2-agent/s2-agent.registry.yaml` →
  `regen:manifest` (`bun-apps/s2-agent/scripts/regen-manifest.ts`) → derived
  `run-dir/manifest.json` (freshness-gated) → consumed by the loader and the
  schema-cost canary (`src/cli/commands/schema-cost.ts` derives from
  manifest.json). Documented in the 2026-08-22-ultracode-rename map (line 26).
- **Real parsers of the YAML (6)**: `run-dir/registry.ts` (authority),
  `run-dir/registry-to-manifest.ts`, `scripts/regen-manifest.ts`,
  `run-dir/registry-insert.ts`, `src/ext-new.ts` (scaffold), and devops
  `src/deploy/lib/config.ts` (`parseShConfig`). ~37 files mention the filename;
  the rest are prose/comments (extension headers, skills docs, tests).
- **The comment-out failure mode is real and recent**: tool-gate (registry
  lines ~245–251) and — as of PR #1958, today — hyperframes are "remembered"
  only as commented YAML: invisible to types, to enumeration, and to invariant
  tests. Re-enabling tool-gate requires uncommenting prose and hoping the
  schema still matches. This is the forcing argument for `enabled: false` as a
  typed field.
- **The proven in-repo specimen**: `bun-apps/s2-agent/src/pre-load-providers.ts`
  — typed config + helpers, side-effect-free by design (header lines 28–39),
  consumed by import (monkey-patch deliberately isolated in `patches/`), with
  direct unit tests (`pre-load-providers.test.ts`, 18 pass in #1957's verify).
- **Contract-suite immunity constraint**: `bun-apps/tests/lib/registry-base-set.ts`
  is a hand-rolled line scanner BECAUSE its consumers must stay immune to
  `bun-apps/node_modules/@repo/*` link state (same reasoning as
  seam-contract.test.ts's relative core-interface import; its header lines
  11–16). Whatever replaces the YAML must preserve this or the contract suites
  get a new failure mode on fresh clones with no `bun install`.
- **Invariant rules currently living in comments only** (registry header +
  entry comments): static order (subagent before ultracode/workflow),
  `hostApi` must equal `HOST_API` in `src/sh/host-modules.ts`, `hostModules`
  must equal `HOST_MODULE_IDS` (deploy hard-fails on drift already —
  ext-build), every non-deploy entry requires `excludeReason`, exactly one
  registry entry per extension folder + one `load:` value.
- **Deploy runtime does NOT read the YAML**: the deployed tree carries
  `deploy.json` / per-ext `ext.json` + `run-dir/manifest.json` written at
  deploy time; `parseShConfig` runs repo-side only (verified: deploy tree
  layout in `src/deploy/lib/ext-build.ts`, ext.json manifest at line ~627).

## Tickets

Execution order (confirm-gate passed 2026-08-24): 01 → 02 → 03 → 04.
01 and 04 are no-choice (module gates all; retirement gated on zero parsers);
02 before 03 by operator choice — 02 closes the registry-insert runtime fog
earliest, 03 is the mechanical surface.

Phase 1 — the module (gates the rest)
- `tickets/01-typed-registry-module.md` — DONE (PR #1962, merged CLEAN
  2026-08-24) — `src/registry-config.ts` shipped: typed entries, `enabled:
  false` first-class (hyperframes + tool-gate with disableReason +
  reEnableNote), zero-import (tokenizer-based test assertion, since notes
  mention require("#pi/ext-dir") in prose), equivalence net 9/9 vs the real
  YAML (parseRegistry + parseShConfig shapes), local_ci pass, s2-agent 0.6.5

Phase 2 — repo consumers flip (after 01)
- `tickets/02-flip-run-dir-consumers.md` — open — NEXT (queue head) —
  registry.ts / registry-to-manifest.ts / regen-manifest.ts /
  registry-insert.ts import the TS; manifest.json stays DERIVED; freshness +
  single-registry-guard gates stay green unchanged
- `tickets/03-flip-devops-and-scaffold.md` — open — devops
  `parseShConfig` reads the TS (deploy CLI + tests); `ext new` scaffold emits a
  TS entry edit; contract suites (registry-base-set line scanner, dep-guard,
  extension-isolation-contract) get a link-state-immune TS reader

Phase 3 — retirement (after 02+03)
- `tickets/04-retire-yaml-invariants-docs.md` — open — delete
  `s2-agent.registry.yaml`; add executable invariant tests (static order,
  hostApi/hostModules drift, excludeReason completeness, disabled entries
  enumerate); update CLAUDE.md / devops SKILL.md / ext headers / docs

## Decisions

- D1: Full replacement, not a hybrid. A TS module that emits YAML (or a YAML
  kept as generated output) would create two sources and re-introduce the
  parse layer; the whole point is one typed authority. Rejected: keep YAML +
  add TS types over it (no behavioral gain for comment-out visibility).
- D2: Disabled extensions are VALUES, not deletions (the tool-gate/hyperframes
  lesson from #1946/#1958): `enabled: false` entries stay in the array, are
  excluded from load/deploy by the consumers, and an invariant test asserts
  every disabled entry carries a reason + a re-enable path comment. This is
  the direct fix for "remembered only as a comment".
- D3: `run-dir/manifest.json` stays DERIVED and freshness-gated. The TS module
  is repo-side source only; the loader/schema-cost canary surfaces do not
  change (they read manifest.json today and keep doing so).
- D4: Contract suites keep link-state immunity: they must read the registry
  without `bun-apps/node_modules` — via a relative-path import of the new
  module (same pattern as seam-contract.test.ts importing core-interface
  relatively), NOT via `@repo/s2-agent`. The module therefore must be
  dependency-free (types + data + pure functions only).
- D5: Ordering matters as migration risk: the module lands first with the YAML
  still authoritative (ticket 01 proves equivalence), consumers flip one
  surface at a time (02, 03), and the YAML is deleted only when zero parsers
  remain (04). No big-bang cutover.

## Frontier

`tickets/02-flip-run-dir-consumers.md` — 01 landed the module + equivalence
net (PR #1962), so the flip is now mechanical; 02 is first because it closes
the registry-insert runtime-YAML fog while the net still guards continuity.

## Fog of war

- run-dir/ vs src/ placement (user flag, HIGH, 2026-08-24): why do the
  registry parsers sit in `run-dir/` instead of `src/`? Working answer:
  `run-dir/` is the source-mode runtime surface (resolve.ts / run-context.ts
  load extensions via `-e` from there; manifest.json is derived there), while
  `src/` is the compiled-core surface — but the PARSERS are repo-side and
  arguably belong beside registry-config.ts in `src/`. Ticket 02 touches
  exactly these four files; fold the placement decision into it (or split a
  ticket 02b) rather than moving files in passing.

- `run-dir/registry-insert.ts` (dynamic load path used by run-dir extensions)
  parses YAML at RUNTIME in some flows — whether it can import TS at that point
  (bun runtime: yes repo-side; verify no compiled-binary path reads it) is
  unconfirmed. If the compiled s2-agent binary needs registry data at runtime,
  the manifest.json path already covers it (D3), but the ticket must prove it.
- The schema-cost canary and `doctor.ts` mention the YAML filename — whether
  they PARSE it or only name it in help text is unverified (grep showed
  mentions, not call sites).
- `lazyExtensions: {}` (registry tail) — who consumes it and whether it needs
  a typed shape is unknown.
- Fresh-worktree CI: contract suites run in CI without `bun install`? If they
  do run with the workspace linked, D4's constraint is belt-and-suspenders;
  if not, it is load-bearing. Verify in ticket 03.

## Cross-effort links

Shares-decision-with: 2026-08-22-ultracode-rename — owns the registry-chain
naming convention this effort preserves (manifest.json DERIVED, one entry per
extension).
Builds-on: PR #1958 (2026-08-24, merged) — its hyperframes comment-out is the
second live instance of the comment-out failure mode (D2's forcing argument);
sv-analyzer's new excludeReason entry migrates as data.
