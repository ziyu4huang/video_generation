# 03 — Trigger style: command-style (explicit only)

## Question

Matt-Pocock's skill is command-style (`disable-model-invocation: true` + `allow_implicit_invocation: false`) — explicit invocation, never auto-fires. Deliverables A and B in this repo are auto-invocable (description-based). How should C be invoked?

## Resolution (2026-08-08)

**Command-style.** `disable-model-invocation: true` in the SKILL.md front-matter (pi's equivalent of Matt-Pocock's `allow_implicit_invocation: false`). Invoked explicitly (e.g. `/improve-codebase-architecture`); never auto-fires. A codebase scan -> report -> grill is a deliberate, heavyweight act the user starts on demand — auto-triggering it would be surprising and costly. The `agents/openai.yaml` stub is NOT ported (OpenAI-platform artifact; pi uses SKILL.md front-matter + the extension manifest instead).

type: grilling
closed: 2026-08-08
blocked by: (none)
