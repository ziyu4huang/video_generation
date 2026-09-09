---
effort: 2026-09-09-self-arc-20-dev-pipeline
created: 2026-09-09
last: 2026-09-10
status: done
---

# self-arc-20 — develop-pipeline sweep: seam purity + naming contract + deploy-e2e hardening

## Destination

The s2-agent extension layer runs its full develop pipeline (local CI, all 32
packages + 28 regression gates) green from a fresh main base, with the two
remaining direct ext→ext library couplings that belong in the shared core moved
onto `s2-agent-core-interface`/`s2-agent-core-runtime` contracts, the
extension-naming convention enforced by a workspace gate (not prose alone),
the declared-imports audit flipped from warn-only to enforcing, and the
s2-agent-sh deploy e2e able to express a model-call budget instead of
shrugging SKIPs under LM Studio contention.

## Context (measured 2026-09-09, this machine, worktree video_generation__movie @ 2e95efa3 = origin/main)

- Baseline local CI `--all`: **overall pass** — 32 packages, 28 gates, exit 0
  (JSON receipt /tmp/local-ci-all.json).
- Baseline deploy + e2e from clean main: `0.10.3+g2e95efa3` — boot/ext-load
  (16 exts)/cwd-independence/parity (71 tools, 57 skills)/providers-catalog/
  file2md-ocr/standalone-import **pass**; model-call **SKIP** (45.2s wall >
  35s budget under LM Studio contention — 4 large models resident),
  vision-call **SKIP** (no zai key in probe env). Verdict skip =
  environment-inconclusive, not a tree regression.
- Direct ext→ext production import edges (grep `from "@repo/s2-agent-ext-`,
  src+extensions, non-test):
  - `flux2 → file2md` (vlm.ts:26 — `askImage`, `resolveVisionLLM`)
  - `hermes-memory → file2md` — TEST-ONLY devDependency
    (image-card-ingest.test.ts), already legal per dep-guard invariant 7; the
    original audit over-claimed a production edge. No action needed.
  - `movie-director → ltx` (`resolveRepoRoot`/`resolveRunPyPaths`/
    `defaultBinaryPath` — ≥5 files), `→ flux2` (`runFlux2`),
    `→ krea2` (`runKrea2`), `→ ultracode` (`WorkflowManager`, `createWebTools`)
  - `task → subagent`, `knowledge-card → obsidian` (TIER-0→TIER-1 downward,
    allowed by dep-guard invariant 4), `tool-gate → power-tool`
    (`estimateToolCost`, extensions/tool-gate.ts:43)
- The seam pattern already exists: `s2-agent-core-interface` owns
  `SEAM_KEY_ENTRIES` (`__pi*` registry, seam-contract gate), `embedding-leaf.ts`
  (leaf + seam → env → defaults resolution), `read-all-tool-definitions`.
  `s2-agent-core-runtime` owns env/home/path-class helpers (`home.ts`).
- Naming: `extension-naming` SKILL.md is the declared single source of truth
  (snake_case verb_object tools, `<tool>_help` companions, kebab-case skills,
  flat-by-default family prefixes) — enforced today only by review; no gate.
- Declared-imports audit (scripts/check-declared-imports.mjs, warn-only v1,
  #1645): 4 findings — 1 real (devops test imports `fast-xml-parser`,
  undeclared), 2 string-artifact false positives (`}from"spec"`,
  `}from"x"` minified-re-export fixtures in ext-build.test.ts), 1 comment
  false positive (presets.ts:68 `Renamed from "glm-lmstudio"` — the audit
  lacks dep-guard's comment-line skip).
- Precedent gate to copy: `bun-apps/tests/routing-contract.test.ts` and
  `seam-contract.test.ts` (static source analysis, no runtime import).

## Tickets

### Phase 1 — shared-core abstraction (seam purity)

- [x] [01 vision-llm-contract.md](tickets/01-vision-llm-contract.md) — `askImage`/`resolveVisionLLM` contract → core-interface leaf; file2md keeps impl; flux2/hermes consume the leaf (status: done, green)
- [x] [02 repo-path-helpers.md](tickets/02-repo-path-helpers.md) — `resolveRepoRoot`/`resolveRunPyPaths`/`defaultBinaryPath` → core-runtime; ltx re-exports; movie-director switches (status: done, green)

### Phase 2 — naming + audit gates

- [x] [03 tool-naming-gate.md](tickets/03-tool-naming-gate.md) — workspace `tool-naming-contract` gate enforcing the extension-naming convention (status: done, green)
- [x] [04 declared-imports-enforce.md](tickets/04-declared-imports-enforce.md) — clean the 4 findings, add comment-skip + fixture allowance, flip to exit 1 (status: done, green)

### Phase 3 — deploy pipeline

- [x] [05 deploy-e2e-model-budget.md](tickets/05-deploy-e2e-model-budget.md) — model-call budget knob + SKIP receipt for the s2-agent-sh deploy e2e (status: done, green)

## Decisions

- **D1 — library contracts go in core, live coordination stays on `__pi*` seams.**
  vision-LLM and repo-path resolution are static capability surfaces (import-time),
  not runtime coordination, so they become core-interface/core-runtime leaves
  (embedding-leaf precedent) rather than new `__pi*` seam keys.
- **D2 — movie-director keeps its executor edges this arc.** `runFlux2`/`runKrea2`
  (and ultracode's WorkflowManager) are genuine media-executor/agent-construction
  couplings; abstracting them is a larger contract design (frontier T06), not a
  mechanical move.
- **D3 — knowledge-card→obsidian stays.** It is the TIER-0→TIER-1 downward edge
  dep-guard invariant 4 exists to protect; not a violation.
- **D4 — enforcing audits flip only from a clean baseline.** Declared-imports
  flips to exit 1 in the same change that cleans its findings, so the gate is
  born green.
- **D5 — rename-averse.** No wire-name changes (tool/skill names) in this arc —
  the naming GATE encodes the convention + documents outliers; renames follow
  the PR #1738 legacy-name pattern and are out of scope.

## Frontier

All five tickets landed. Next workable ticket (T06, new): parameterize the
flux2/krea2 binary walkers onto core-runtime resolveRepoRootByMarker (same
pattern ltx now delegates), and design the movie-director media-executor
contract (runFlux2/runKrea2/WorkflowManager).

## Fog of war

- Whether hermes-memory's file2md usage is the same `askImage`/`resolveVisionLLM`
  family or a second surface (agent will map exact call sites; if second
  surface, it moves too or stays with a note).
- Whether movie-director's ltx usage is path-helpers only (then its `ltx` dep
  can drop) or runpy execution too (dep stays).
- Exact minified-fixture false-positive shape in ext-build.test.ts — allowance
  design (per-file allowlist vs regex hardening) decided by the agent with the
  constraint: no blanket `.test.ts` skip.

## Cross-effort links

- Builds-on: 2026-08-29-slash-surface-consistency (D5 family-prefix decision
  reused as the flat-by-default rule the naming gate encodes).
- Shares-decision-with: 2026-08-23-deploy-platform-neutral-core (deploy tree
  shape untouched; only e2e budget semantics extended).
- Supersedes: nothing; closes no prior effort.

## Shipped-as (2026-09-10, side repair by self-arc-19's ledger)

The effort's implementation MERGED as #2248 ("self-arc-20 — seam purity +
naming gate + enforcing import audit + deploy-e2e budget") but its map was
never closed — frontmatter stayed `active` with no Shipped-as section, found
live by the arc-ledger's frontmatter-agreement check on its first day. Status
flipped to done on the strength of the merged PR; the detailed Shipped-as
prose this convention expects was NOT reconstructed (I did not author that
effort) — recorded as an honest gap rather than invented.
