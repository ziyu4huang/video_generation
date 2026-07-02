# verify-bun-pi-agent-cli — Benchmarks (pi-runtime home)

This directory holds the **pi dynamic workflow** benchmark home for the
`verify-bun-pi-agent-cli` verification workflow. It is fully self-contained:
baselines, `compare.ts`, and the committed `stage1-seed-*` all live here.

> **Two independent runtimes.** This repository runs the verification workflow
> under two *independent* harnesses that mirror each other:
>
> | Home | Runtime | Driven by |
> |------|---------|-----------|
> | **this dir** — `docs/benchmarks/verify-bun-pi-agent-cli/` | pi dynamic workflow (pi-coding-agent) | `bun-apps/pi-agent/run-dir/workflows/verify-bun-pi-agent-cli.js` |
> | **sibling** — `.claude/benchmarks/verify-bun-pi-agent-cli/` | Claude Code Workflow (canonical) | `.claude/workflows/verify-bun-pi-agent-cli.js` |
>
> They are **not duplicates**. Each serves its own runtime and keeps its own
> copy of the baselines + `stage1-seed-*` so neither runtime crosses into the
> other's tree. Keep both in sync when refreshing baselines (same distill model
> → identical `.jsonl` content).

## Contents

- `compare.ts` — compares a `<run>/result.jsonl` against the per-model
  baselines below. Resolves bare baseline paths against this directory
  (`import.meta.dir`), so it works regardless of cwd.
- `stage1-seed-emnlp-893/` — committed stage1 (pdf→md) for the EMNLP fixture,
  pages 1-3. Pass `stage1From=docs/benchmarks/verify-bun-pi-agent-cli/stage1-seed-emnlp-893`
  to reuse it and skip the VLM (controlled distill-model comparison).
- `zai-glm-5.2.jsonl` — baseline (post-rebase paper-profile seed, 26/26 PASS)
- `zai-glm-4.7.jsonl` — baseline (post-rebase, 23/26 — non-CLI fails; see PR)
- `lm-studio-google-gemma-4-26b-a4b-qat.jsonl` — baseline (post-rebase, 26/26 PASS)

## Usage

```bash
# after a verify-bun-pi-agent-cli run produces tmp/<distill-slug>-<ts>/result.jsonl:
bun run docs/benchmarks/verify-bun-pi-agent-cli/compare.ts <path-to-result.jsonl>
```

## Methodology (the part that must survive across sessions)

The canonical methodology doc (controlled-variable strategy, signal-vs-noise,
rebase re-verify rule, iteration log) lives in the sibling:
[`../../.claude/benchmarks/verify-bun-pi-agent-cli/README.md`](../../../../.claude/benchmarks/verify-bun-pi-agent-cli/README.md).
This pi-side README intentionally stays thin and defers to the sibling to avoid
drift.
