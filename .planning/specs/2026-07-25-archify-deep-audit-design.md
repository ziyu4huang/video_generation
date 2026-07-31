# Archify — Deep Integration Audit (Design)

- **Date:** 2026-07-25
- **Scope:** `bun-apps/pi-agent-ext-archify/`
- **Status:** Approved (design)
- **Mode:** Read-only charter — produces findings, changes no code.

## Context

The two prior archify cycles covered **dispatch integrity** (#794 — `execute()`
plumbing, surfaced + fixed F1 abort-signal) and **generated-artifact
fidelity** (#799 — `inspect-artifact` + 5-type gated suite). Neither assessed
**integration hygiene**: how cleanly the 1.5 MB vendored snapshot is wired into
the pi-extension surface, whether it bloats the runtime bundle, what its
per-request schema cost is, how that cost is tracked, and whether dead code
accumulated. This design defines a one-shot, read-only, multi-dimension audit
to close that gap — "unknowns most, value highest."

## Goal

Produce a single findings receipt (`receipts/archify-deep-audit-2026-07-25.md`)
grading the extension's integration hygiene across five focus areas, each
finding carrying evidence (file:line, measured numbers), impact, and a
recommendation. Critical/Important findings are additionally rolled up into a
follow-up issue list (recorded in the receipt; not opened this cycle).

## Non-goals

- **No code changes** — no edits to `lib/`, `extensions/`, `vendored/`, tests,
  or manifest. No fix PRs.
- **No vendored re-sync** — the snapshot policy forbids editing vendored
  sources; dead-code findings inside `vendored/` are documented as
  "record-only" unless they imply a fix in our own `lib/`.
- **No re-evaluation of business correctness** — diagram semantics are out of
  scope; this is repo-integration hygiene only.
- **No re-do of #794 / #799** — dispatch integrity and artifact fidelity are
  already covered; reference their receipts, don't re-audit them.

## Approach: multi-dimension fan-out → opus synthesis

Five dimension subagents run concurrently, each scoped to one focus area with
its own brief, file list, and the global constraints below. A final opus pass
synthesizes the five reports into one receipt: cross-checks facts across
dimensions (e.g. dimension 2's "vendored is spawned not imported" must agree
with dimension 1's spawn mechanics), de-duplicates overlapping findings, assigns
final severity, and writes the receipt + the follow-up issue roll-up.

All subagents are **read-only**: they may read files and run measuring commands
(`schema-cost` canary, bundle-artifact inspection, `git ls-files`, `wc`,
`grep`), but must not edit, write, commit, or open anything.

## Dimensions

### D1 — Vendored bin integration

Audit `lib/run.ts` and the spawn seam:

- Path resolution: `VENDORED_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "vendored/bin/archify.mjs")` — correct under worktree, `node_modules` symlink, and the bundle? (per memory: bundle deploy symlinks node_modules → pi store; verify the package-local relative resolve survives.)
- `spawn(process.execPath, [VENDORED_BIN, ...args], { cwd, signal })` — no PATH dependency, no shell-out (`shell: false` implied), runtime portability (Bun vs node).
- Signal contract: `signal` threaded from `execute()` → `archifyRender/Validate/Delta` → `runArchify` (post-#797). Confirm the child's `'error'` vs `'close'` resolve semantics (both resolve, never reject — verify this is sound and that an aborted signal surfaces rather than silently succeeding).
- `manifest.json` entry: `bundleMode: "thin"`, `testGate: "cd bun-apps/pi-agent-ext-archify && bun test"` — the literal `cd` in the gate string vs the repo's no-top-level-`cd` SOP (note: it's a manifest literal, not a hook-executed command; assess whether it matters).

### D2 — Bundle-bloat risk

Audit what the thin bundle actually pulls in:

- Confirm `vendored/*.mjs` are **spawned, not imported** — i.e. not statically
  or dynamically imported by `extensions/archify.ts` / `lib/*`, so the bundler
  (jiti/single-js-bundle) cannot drag the 1.5 MB into `extensions/archify.js`.
- Inventory the `lib/*` (451 LOC) that *does* ship in the bundle; flag any
  heavy or removable surface.
- Verify dev-only `ajv` (^8.17.1) stays out of runtime (it is `devDependencies`;
  confirm no `lib/` import of `ajv` that would pull it into the thin bundle).
- Compare to sibling thin-bundle extensions for bundle-size parity.

### D3 — Schema cost

Measure the per-request schema token cost of the 3 registered tools:

- Run `pi-agent-cli schema-cost` (the canary) to get the measured
  `description + JSON.stringify(parameters)` token estimate for
  `archify_validate` / `archify_render` / `archify_delta`.
- Rank against sibling tools (power-tool, web-access, obsidian, …); flag any
  archify tool that is an outlier.
- Inspect each tool's `parameters` TypeBox shape for over-broad fields
  (e.g. `Type.Record(Type.String(), Type.Unknown())` on `ir` — does it bloat
  the schema vs a tighter typed alternative?).
- Inspect `description` length — is it justified or can it be trimmed without
  losing agent-callability?

### D4 — Relationship to the schema-cost canary

- Confirm archify is auto-measured: it is registered in
  `run-dir/manifest.json` `extensions[]`, so `discoverExtensionEntries()`
  derives it automatically (no manual `EXTRA_ENTRIES` row needed). Verify.
- Assess the token-ratio inconsistency noted in `schema-cost.ts` (submodule
  default 4 vs live `inspect_context` 3.7) — does it distort archify's ranking,
  and is archify affected differently from siblings?
- Check whether the canary's `checkToolContract` (hasExecute / schemaValid)
  passes cleanly for all 3 archify tools.

### D5 — Dead code

Inventory unused / unreachable surface:

- `vendored/bin/open-artifact.mjs` (86 LOC) and `vendored/bin/preview.mjs`
  (660 LOC): `lib/render.ts` comment claims "Never `--open` (headless; snapshot
  lacks open-artifact.mjs)" — but the file **is** present. Resolve this
  contradiction: is open-artifact reachable from the 3 registered tools'
  actual CLI surface, or dead weight?
- Map archify CLI subcommands actually invoked by `lib/*` (`deliver`, `validate`,
  `compare`) vs the full vendored subcommand set (`render`/`validate`/`compare`/
  `deliver`/`inspect`/`check`/`doctor`/`guide`/`examples`/`preview`/`demo`) —
  which are never reached?
- `vendored/scripts/` (`check-render-output`, `generate-validators`,
  `render-examples`), `vendored/recipes/scenarios.mjs` — reachable or dead?
- For dead-code findings **inside** `vendored/`: record-only (snapshot policy);
  for any dead code in **our own** `lib/`/`extensions/`/tests, that is actionable.

## Receipt format

`receipts/archify-deep-audit-2026-07-25.md`:

- Per-dimension section: findings table (`severity | finding | evidence
  (file:line / measured) | impact | recommendation`).
- Cross-dimension notes (where two dimensions touched the same fact).
- Overall verdict + a "Follow-up issues to open" roll-up (title + one-line
  body per Critical/Important finding; not opened this cycle).

## Verification

Each dimension's findings must be backed by a runnable measurement or a
file:line citation — no pure speculation. The synthesis pass rejects any
finding lacking evidence back to the source.

## Boundaries & safety

- Read-only enforced: subagents use search/read/measuring commands only; no
  Edit/Write/commit/`gh`.
- No changes to `vendored/` (snapshot policy), `lib/`, `extensions/`, tests,
  or `run-dir/manifest.json`.
- Scope confined to `bun-apps/pi-agent-ext-archify/` plus the
  `pi-agent-cli schema-cost.ts` canary surface it relates to.
