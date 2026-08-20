# PRD — s2-agent extension e2e testing (unified)

## Problem

Every `s2-agent-ext-*` package wraps a Swift/MLX image-director CLI as one agent
tool. Each has a deterministic `bun test` suite (flag mapping, path safety, manifest
parsing, coerceOptions) and `s2-agent/run-test.sh` covers the s2-agent core across
build/deploy/cwd tiers. But the question those tests **structurally cannot answer** —
*"does generation produce a GOOD image, semantically on-prompt?"* — has no unified
home. Today it is verified by hand, ad hoc, or not at all.

## Scope (in / out)

**In scope:** a single, unified e2e test **method** for every `s2-agent-ext-*`
package — one canonical dynamic-workflow per extension that judges generation quality
via a local VLM.

**Out of scope (do NOT migrate):**
- Per-package `bun test` (deterministic unit/contract tests) — stays the source of
  truth for everything machine-checkable.
- `s2-agent/run-test.sh` (the CI-safe deterministic backbone) — stays as-is; the
  workflow layer is opt-in and never gates CI.

The workflow layer is **additive**, on top of the deterministic layers.

## The 3-layer test model

| Layer | What | Deterministic? | Cost | Owner |
| --- | --- | --- | --- | --- |
| L0 unit/contract | `bun test` per package — flag↔CLI, path safety, manifest parse, coerceOptions | yes | ~0 | each `s2-agent-ext-*` |
| L1 core integration | `run-test.sh` tiers (build/deploy/cwd/readonly) | yes | ~5–40s | `s2-agent` |
| **L2 judgment e2e** | **this PRD** — one `workflows/test-*-e2e.js` per extension, VLM-scored | **no** | tokens + minutes | each `s2-agent-ext-*` |
| **L3 real-model integration** | `bash scripts/run-image-agent-e2e.sh` — spawn `s2-agent.sh` with a real model + NL prompt, assert zh-TW reply + a new timestamped PNG | **no** | tokens + minutes | `s2-agent` |

**What belongs in L2 (judgment only):**
- VLM quality gate (noise, artifacts, anatomy, sharpness).
- Prompt adherence / composition / identity preservation.
- Defect detection ("fused fingers", "extra limbs", "blank regions").

**What does NOT belong in L2 (it is L0's job):**
- exit codes, file existence, pixel dimensions, manifest JSON fields, flag presence.
- binary build correctness (L1).

If a test can be a `bun test`, it MUST be a `bun test` — do not pay an LLM to do what
`JSON.parse` does for free.

## L3 — real-model integration e2e (opt-in)

`src/__tests__/e2e-image-agent.test.ts` + `scripts/run-image-agent-e2e.sh`. The only
tier that calls a REAL model. It reproduces the operator's manual invocation —

```
./s2-agent.sh --model <model> -p "verify I can use the Flux tool, reply in zh-TW,
   generate <subject> to ./output/flux-output/<name>-<timestamp>.png and open it"
```

— and asserts the things only a real model-driven run can prove: the agent honors a
zh-TW reply instruction, actually INVOKES the flux2 tool (auto-loaded via the run-dir
manifest, no `-e`), and writes a real PNG at the requested `<name>-<timestamp>.png`
path pattern. Gated behind `PI_AGENT_E2E_IMAGE=1` (separate from `PI_AGENT_E2E`) and
NEVER wired into `run-test.sh` / CI. Default subject is neutral (a Japanese garden)
with identical mechanics; override via `PI_AGENT_E2E_PROMPT`. Model via
`PI_AGENT_E2E_MODEL` (default `google/gemma-4-12b`).

## Unified L2 contract

Every extension ships exactly one workflow at a fixed path:

```
bun-apps/s2-agent-ext-<ext>/workflows/test-<ext>-e2e.js
```

It follows a fixed 3-phase shape:

1. **Generate** — one agent drives the extension's CLI via bash (subagents under
   `-e workflow` get `createCodingTools`, NOT the parent's registered extension tool,
   so the workflow exercises the same CLI surface the tool forwards to). Produces ≥1
   output path.
2. **Judge** — one parallel agent per output runs the project's local VLM scorer:
   `python/venv/bin/python python/mlx-movie-director/run.py caption <out> --style score --lang en`
   and parses the `[score] {...}` line (overall / detail / sharpness / composition /
   prompt_adherence / artifacts / issues[]). Also saved to `<out>.caption.json`.
3. **Synthesize** — plain JS (no LLM): pass iff every output clears the thresholds.

Fixed return contract:

```jsonc
{
  "ok": true,                         // overall pass/fail — false if ANY output is unscored
  "ext": "flux2",
  "outputs": ["/abs/.../x.png"],
  "judgments": [{ "scored": true, "path": "...", "overall": 9, "artifacts": 10, "issues": [] }],
  "thresholds": { "overall": 6, "artifacts": 6 },
  "needsReview": false,               // true iff any output could not be scored (silent-failure path)
  "summary": "1/1 outputs cleared thresholds (median overall 9)",
  "genError": ""                      // non-empty when generation threw / returned ok=false / nulled
}
```

**`judgments` is always one entry per output** — a failed judge is NEVER dropped.
An output whose VLM scorer threw, exhausted retries, or returned a shapeless result
becomes `{ "scored": false, "path": "...", "error": "<reason>", "needsReview": true }`,
NOT a missing array element. This is the workflow-layer defense against the engine's
null→default silent-wrong-result pattern: a caller can never mistake "could not score"
for "scored and passed", because `ok` is false and `needsReview` is true whenever any
entry is `scored:false`. See `bun-apps/s2-agent-ext-workflow/tests/regression-rca.test.ts`
(RCA#4/#7) for the engine-side root cause this guard exists to neutralize.

### Thresholds & the over-praise caveat

The local VLM (Qwen3-VL / Gemma) over-scores — a clean apple routinely gets
overall=9, prompt_adherence=10 (see memory `vlm-caption-overpraise-qa-gap`). So:

- Keep absolute thresholds **conservative** (overall ≥ 6, artifacts ≥ 6, no
  blocking-issue keywords in `issues`).
- Prefer `--samples 3` for stability on borderline cases.
- L2's real value is **defect detection and comparative ranking**, not absolute
  pass/fail. A regression from overall 9 → 5 between commits is the signal; a single
  9-vs-6 is not.

## Unified runner

`bun-apps/s2-agent/scripts/run-ext-e2e.sh` — discovers and runs every extension's L2
workflow:

```bash
for wf in bun-apps/s2-agent-ext-*/workflows/test-*-e2e.js; do
  bun-apps/s2-agent/run.sh -e workflow -p \
    "read $wf and execute it via the workflow tool (background:false)"
done
```

- **Opt-in only.** Never wired into CI or `run-test.sh` (it spends tokens and is
  non-deterministic — a flaky LLM parse must not fail a build).
- Per-extension opt-out: skip a package by omitting the workflow file.

## Mechanics every L2 workflow must honor

Carry these into every new `test-<ext>-e2e.js` (learned from the flux2 prototype):

1. The `workflow` tool takes `script` as a **string** — there is no file-path param.
   The `-p` prompt instructs the parent agent to READ the file and forward its source.
   No `execute <path>` primitive exists.
2. `background:false` returns the structured result inline in the same `-p` turn;
   default `true` runs detached and delivers the result later. Use `false` for
   one-shot e2e; `true` only for long suites.
3. Output contracts are per-CLI and MUST be read from that CLI's Swift source — do
   not cross-apply. flux2 prints `✅ generated <name>` + indented abspath + a
   `.manifest.json` sidecar; krea2 prints `[krea2] saved <abspath>`.
4. Subagents get bash + coding tools only. They call the VLM scorer via
   `run.py caption` (a CLI), not via a registered `pi-file2md` tool.
5. In a worktree the MLX venv may live at `../video_generation__venv/bin/python`
   rather than `python/venv/bin/python` — probe both, or resolve via `run.py`'s own
   shebang from the repo root.
6. **Never silently drop a failed agent** (Generate or Judge). The engine converts
   a recoverable failure / schema-non-compliance / terminal error to `null` or a
   throw; the workflow MUST catch both and record the reason explicitly:
   - Generate: wrap in `try/catch`, keep `genThrown`; surface it via `genError`
     (don't collapse to a bare "no outputs generated").
   - Judge: a thrown / null / shapeless scorer result becomes an explicit
     `{scored:false, path, error, needsReview:true}` entry. Do NOT
     `.catch(() => null)` + `.filter(Boolean)` — that drops the failure and makes
     `judgments.length < outputs.length`, the canonical null→default smell.
   `judgments` is always one entry per output; `ok` is false and `needsReview` true
   while any entry is `scored:false`. (flux2 + krea2 already implement this.)

## Status

- [x] Prototype: `s2-agent-ext-flux2/workflows/test-flux2-e2e.js` — proved the
      mechanics end-to-end (generate → gate → verify; PNG verified on disk).
- [x] Refactor flux2 to the canonical judgment shape (Generate → parallel VLM
      `Judge` via `run.py caption --style score` → JS synthesize). Executed:
      3 agents / 85k tokens, 2/2 outputs scored overall=9, artifacts=10, `ok=true`.
      PNGs + `.caption.json` verified on disk.
- [x] Add `scripts/run-ext-e2e.sh` runner (`--list` discovery verified).
- [x] Add L2 workflow for `s2-agent-ext-krea2` (`workflows/test-krea2-e2e.js` +
      `workflows/README.md`). Adapted to krea2's contract: `[krea2] saved <abspath>`
      parse, explicit `--out` per run (no `--output-dir`/`--name`), 1024×1024 / 8
      steps (Turbo) defaults, `setup-metallib.sh release` build path. Syntax +
      runner discovery verified; execution is opt-in via the unified runner.
- [x] Cross-reference this PRD from each extension's L2 `workflows/README.md`
      (flux2, krea2).
- [x] Add L3 real-model integration e2e (`src/__tests__/e2e-image-agent.test.ts` +
      `scripts/run-image-agent-e2e.sh`). Spawns `s2-agent.sh` with a real model +
      NL prompt; asserts zh-TW reply + a new timestamped PNG under
      `output/flux-output/`. Gated behind `PI_AGENT_E2E_IMAGE=1`, never in CI.
      Skip behavior + suite green verified; live run is opt-in via the runner.
