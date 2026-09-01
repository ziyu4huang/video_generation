# Design — dev↔deploy surface-parity gate (fingerprint diff at deploy time)

**Date:** 2026-08-31
**Status:** Approved direction (survey-first, fingerprint diff, deploy-time baseline; user decisions D1–D3 below)
**Scope:** `bun-apps/s2-agent-ext-devops` (new parity probe + verify-deploy-e2e hook), reads `bun-apps/s2-agent/src/registry-config.ts`

## Problem

The repo ships two modes of the same extension set:

- **Dev mode** — `./s2-agent.sh` loads `bun-apps/s2-agent-ext-*` from the workspace via the run-dir registry.
- **Deploy mode** — `~/proj/dist/s2-agent-sh/<target>/current/s2-agent.sh` loads a frozen, bundled, minified copy of the (subset of) the same tree.

Nothing guarantees the two are the same session surface. The existing post-deploy check (`verify-deploy-e2e-cli.ts`) probes the **dist in isolation** (core builtins present, every deploy.json-enabled ext reports loaded); it never **diffs the dist against the dev tree**. Three real incident classes slipped past isolated checks in this repo's history:

1. **Silent `-e` skip** — a dist session skips an extension whose imports reach a specifier outside the host-module map (`typebox/compile` incident); the session boots fine without it.
2. **#1946 toolless deploy** — `setActiveTools([])` shipped two deploys past boot + ext-load + model-call; only an active-toolset probe observes it.
3. **Skill precedence** — bundled skills always win over discovered ones; a dist can load a different skill copy than dev.

## Evidence (survey, measured 2026-08-31 on this machine)

Three-way fingerprint comparison via a throwaway zero-import probe (tools + skills through `session_start`/`before_agent_start`; providers via `--list-models`):

| Surface | dev@783391f vs deploy@0.8.0+g783391f (same commit) | dev@783391f vs dev@01bd36cb (version lag) |
|---|---|---|
| Tools | deploy 64 ⊂ dev 88; shared 64: **0 desc-hash diffs**; only-dev 24 → all attributable to the 9 `excludeReason` exts | 0 diffs |
| Skills | only-dev 6 (research-tool/webui families); **0 content-hash diffs** | 0 diffs |
| Providers | `--list-models` 84 models **identical** | identical |

Today's parity holds. The gate exists because parity is a moving property, not a state.

Key mechanism facts established by the survey:

- Every tool object carries `sourceInfo: { path, source, scope, origin }` (88/88 in dev; builtins read `<builtin:read>`). **Tool→extension attribution is free** — no allowlist needed.
- Skills carry `filePath` — same free attribution.
- A zero-import probe runs identically through both launchers (`-e <probe> -p hi --no-session`, marker on stderr, `process.exit(0)` before any provider call).

## User decisions

- **D1 — Fingerprint depth:** tool `name` + description hash + **parameters-schema hash**; skill `name` + content hash. (Hooks surface out of scope — pi API does not expose other extensions' registered handlers.)
- **D2 — Dirty source tree at deploy:** no special rule. Fingerprints and diff run as-is; real content drift fails honestly ("diff 照實判").
- **D3 — Delivery:** spec → plan → implement (this document is the spec).

## Design

### 1. Parity probe (asset, not a top-level script)

`bun-apps/s2-agent-ext-devops/src/deploy/probe-assets/parity-probe.ts`

- Default-export factory, **imports NOTHING** (deployed `-e` host-module-map constraint — the probe itself must never be the thing that gets silently skipped; marker-missing covers that).
- `session_start`: `pi.getAllTools()` → `{ n: name, s: sourceInfo.source, p: sourceInfo.path, dh: Bun.hash(description), sh: Bun.hash(JSON.stringify(parameters)) }`, sorted by name.
- `before_agent_start`: `systemPromptOptions.skills` → `{ n, p: normalized filePath, ch: Bun.hash(content) }`, sorted; then print `[PARITY-FP-START]<json>[PARITY-FP-END]` to stderr and `process.exit(0)`.
- Env `PARITY_MODE` recorded in the payload (label only).

### 2. Fingerprint capture + canonicalization (recipe side)

New module `src/deploy/parity-recipe.ts`:

- `captureFingerprint(launcher: string, mode: string, spawn: SpawnFn)`: spawn `<launcher> -e <probe-asset> -p hi --no-session` with the probe path resolved via `import.meta.dir`; guard-loop for the marker (no `timeout` on macOS — background + poll + kill, as in the survey). **Marker missing / probe error / non-zero exit without marker → FAIL verdict, never skip.** A skipped probe is exactly the class this gate exists to catch.
- Canonical JSON: sorted keys are inherent (sort by `n`); hashes are numbers via `Bun.hash`.

### 3. Gate semantics

`diffFingerprints(dev: Fp, deploy: Fp, registry: RegistryEntry[])` (pure — takes the registry as a parameter for testability, derives the excluded set inside) → verdict + itemized findings:

**FAIL** on any of:

- a tool/skill present in deploy but missing in dev (dist-only additions);
- a tool/skill present in both with differing `dh`/`sh`/`ch` (content drift — this is the dirty-tree/bug case);
- a tool/skill only in dev whose source is NOT attributable to an expected-excluded extension;
- fingerprint capture failure on either side (marker missing, boot failure);
- **symmetric degradation** — a fingerprint that is well-formed but empty (`sessionStartFired` false or zero tools) on either side; both-sides-empty would otherwise diff to a vacuous pass (final-review find 2026-09-01, landed in ce5a8e02);
- **providers health** — either `--list-models` spawn timing out, exiting non-zero, or parsing to an empty id list; both-sides-failing-identically would otherwise compare two empty lists to a vacuous pass (final-review find 2026-09-01).

**Expected-only-dev derivation (no allowlist):** import `REGISTRY` from `bun-apps/s2-agent/src/registry-config.ts` (recipe runs in the dev tree); entries without a `deploy` block contribute their folder name → for each only-dev tool, attribute via `sourceInfo.path` (dev paths match `bun-apps/s2-agent-ext-<folder>/…`; deploy paths `ext/<name>/…`); for skills, `filePath` prefix against the same set. Builtin-sourced tools (`source: "builtin"`) must exist on BOTH sides — a builtin only in dev is a FAIL.

**Providers parity:** recipe additionally runs `<launcher> --list-models` on both sides and diffs the sorted id lists (survey proved identical today); any difference is a FAIL with both lists in the note.

### 4. Wiring

- `DeployE2eProbe.id` union gains `"parity"` (deploy-e2e-recipe.ts probe list, alongside `cwd-independence`).
- New CLI flag `--dev-launcher <path>` on `verify-deploy-e2e-cli.ts` (and the `runDeployE2e` options). Default resolution: `<repo-root>/s2-agent.sh` relative to the recipe's own package location; if the file does not exist → **skip** with note (parity needs a dev tree; a dist-only environment like CI cannot run it).
- `deploy-cli.ts` already invokes `runDeployE2e` post-deploy (two call sites); both pass the dev launcher path explicitly, so every deploy runs the parity gate automatically.
- The parity probe runs after `ext-load`/`cwd-independence`, before `model-call`; it is fully offline (no provider call — probe exits at `before_agent_start`).
- Probe budget: 120s guard loop per side (survey measured ~10–60s cold).

### 5. Output / receipts

- Reuses the existing `DeployE2eProbe` result shape: `{ id: "parity", verdict, ms, note }` with the itemized diff in `note` (bounded — first 20 lines + counts).
- When verdict is fail, note ends with the exact observed only-dev set + its attribution, so a legitimately new excluded ext is a conscious registry edit, not a mystery.

## Non-goals

- Hooks/guidelines/context-file parity (no API surface to read other exts' registrations; revisit if pi exposes one).
- Behavior equivalence (running fixture tasks through both launchers) — possible later layer, deliberately out.
- Cross-target (win32) parity — same machinery applies, but this spec validates on darwin-arm64 only.

## Testing

- **Unit** (`tests/parity-recipe.test.ts`): canonicalization; the four FAIL classes with fixture fingerprints; expected-only-dev derivation from a fixture REGISTRY subset (mock import or extracted pure function taking the registry as a parameter — prefer the latter: `diffFingerprints(dev, deploy, registry)` so tests need no module mocking); builtin-only-in-dev → FAIL.
- **Integration** (spawn-injectable, no real launcher): `captureFingerprint` with a fake spawn that emits a marker JSON — asserts marker parsing, marker-missing → FAIL, stderr-noise tolerance.
- **Live check** (manual / PI_AGENT_E2E-gated, if added to a tier at all): one real `verify-deploy-e2e-cli --dev-launcher ./s2-agent.sh` run against the current dist must report `parity: pass` — the survey already demonstrates the expected outcome.

## Risks

- **Schema key-order instability** between dev TS and bundled CJS construction could false-FAIL. Mitigation: canonicalize before hashing (stable stringify: recursively sort object keys). Survey showed desc hashes already stable; schema hashing is the new surface, so stable-stringify is mandatory, not optional.
- **Probe asset path** must resolve from the packaged devops package at runtime (`import.meta.dir`-relative); test guards the file exists with the zero-import property (a lint-ish unit test greps for `^import`).
- **Excluded-ext attribution drift**: an excluded ext whose tools are registered under a builtin-ish path would fail attribution. Fail-loud is the chosen default; the note shows the path so the registry or attribution rule gets fixed consciously.
