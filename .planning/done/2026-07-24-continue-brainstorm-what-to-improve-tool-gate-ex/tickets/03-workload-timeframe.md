---
type: grilling
status: closed
claimed: agent/grilling-2026-07-24
blocked by: [01-metric]
---

# 03 — Choose the measurement workload + timeframe

## Question

**Over what sessions, and for how long, do we measure [01]'s metric to get a verdict we trust?** This is the one ticket that *cannot* be resolved in a single sitting — it needs elapsed real usage, which is exactly why this effort is wayfinder-class and not a one-session job.

The recall metric is workload-dependent to its core: a user who never generates video never misses `ltx`; a user who lives in image edits may hit `flux2` misses constantly. So "what workload" is really "whose real usage" — and the only honest sample is the user's own.

Candidate framings:

- **(a) Real usage, the user's own sessions, over a fixed window** — enable `TOOL_GATE_LOG_PATH` persistently, collect JSONL across ~1–2 weeks of normal work, run [02]'s aggregator. Highest ecological validity; needs the user to opt in to logging for the window and remember to keep it on. **Recommended.**
- **(b) Scripted representative corpus** — a fixed set of prompts (could reuse/extend `qa/probes.ts` MUST_FIRE or the L2 task suite) run deterministically. Reproducible and instant, but measures the *corpus author's* notion of common intents, not the user's real distribution — and the corpus already drives the gate's design, so it'll flatter the gate (circular).
- **(c) Hybrid** — (a) for the verdict, (b) as a regression guard (does the metric move when keywords change?). More work; only worth it if (a) alone is ambiguous.

**Recommended answer.** **(a) real usage over ~2 weeks**, `TOOL_GATE_LOG_PATH` pointed at a rolling file the user keeps active for the window. Acknowledge the verdict is *this user's* recall, not a universal claim — that's the right scope (the gate is personal config anyway). Revisit (c) only if the data is thin or borderline.

## What a good resolution records

- The workload source (real usage / corpus / hybrid) + the window length.
- The logging setup (env var, file path, rotation, how the user keeps it on).
- A note that the verdict generalizes to *this user's usage patterns*, not universally.

## Resolution (2026-07-24)

**Settled via grilling (1 question) + logging wired.**

**Workload:** real usage — the user's own pi sessions. The recall metric is workload-dependent to its core, so the only honest sample is the user's own; a scripted corpus would flatter the gate (it drives the gate's own design → circular).

**Window:** ~2 weeks. **Thin-window mitigation:** peek at the gated-domain-session count at ~1 week; if too few, extend the window or add a `MUST_FIRE` corpus run as a common-intent floor.

**Logging — ENABLED (the clock starts on the user's next terminal pi session):**
- `TOOL_GATE_LOG_PATH="$HOME/.pi/tool-gate/telemetry.jsonl"` — stable path under `~/.pi/` (survives worktree/branch switches; not inside any worktree).
- Wired persistently via `~/.zshrc` lines 41–44 (clearly marked; **remove after ticket 05** to stop logging).
- Local JSONL only — **no network egress**. Logs `promptHead` (first 80 chars) of `miss_candidate` prompts + `turn`/`activate` metadata.
- **Current session excluded** (it started without the var); all *new* terminal-launched pi sessions log. GUI/IDE-launched pi may not inherit the env — if that's the user's main launch path, revisit.

**Privacy:** promptHead(80ch) of miss_candidate prompts is written to a local file. The user chose real-usage knowing this; it's local-only and removed after the verdict.

**Verdict scope:** this is *this user's* recall, not a universal claim — the correct scope, since the gate is personal config.

**Hand-off to [02] (session segmentation):** the telemetry carries **no session-ID or boundary marker** — entries are just `ts` + `kind` + fields. [02] must **infer sessions via a `ts`-gap heuristic** (e.g. gap > N min = new session) to compute the "gated-domain session" denominator (01/04). If that heuristic proves unreliable for the verdict, [02] BLOCKS and surfaces a sub-decision — a candidate fix is adding a `session_start` marker to the `turn` event, but that's an instrumentation change to justify explicitly, not smuggle into the aggregator.
