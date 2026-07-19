# R1 — Probe run-pipeline story orchestrator viability

type: research
claimed: pi-agent
blocked by: (none)
status: closed

## Resolution (closed 2026-07-19 — PROBED + FIXED)

## Question

Does `run-pipeline` actually work end-to-end for `story`? The manifest is
schema-valid and every provider individually works, but the orchestrator has
never been driven with it. The probe: try to init a project with the story
pipeline and advance through the first stage(s) to see what breaks (if
anything).

## Method

1. `movie init-project` with `--pipeline story` — does it accept the pipeline?
2. `movie next-stage` — can the driver advance? Does it hit a model/API error
   on the research stage (which uses web_search)?
3. If it gets past research, what happens at proposal (the first LLM creative
   waypoint)?

The probe's success criterion is not "produces a video" — it's "identifies
the first concrete failure and the cause (model missing, API key, stage wiring,
schema mismatch, etc.)." We need ONE known failure point to ticket the fix.

## Result (2026-07-19 — PROBED)

✅ **Orchestrator is functional** — `init-project` accepts `story`, all 9 stages
listed including conditional `character_design`; `next-stage` advances
correctly. The failure at `proposal` is a concrete, actionable bug:

🐛 **`waypoint-runtime.ts:130` — `argv.push("--no-tools", "all")` bug.**
The `"all"` string becomes a positional argument (user prompt) in the pi-agent
CLI, swallowing the real prompt. Confirmed by direct test: `--no-tools all` →
user message content = "all"; `--no-tools` (bare) → correct prompt. Fix: change
to `--no-tools=all` (equals syntax) or `--no-tools` bare.

Also confirmed: **LM Studio is running** with `gemma-4-12b-qat` loaded, and the
pi-agent can complete with it (provider: lm-studio, api: openai-completions).
No API key or cloud dependency — local-only path is viable.
