# pi-agent-ext-ask-user

The ubiquitous language of pi-agent-ext-ask-user — the `ask_user_question` tool: a structured option selector with a free-text "Other" fallback. Extracted from power-tool; ported from @juicesharp/rpiv-ask-user-question.

## Language

**ask_user_question**:
The structured-choice tool — 1–4 questions, each with 2–4 options; the user picks one (or multi-selects), types a free-text answer, or abandons. The deterministic way to get a decision from the user mid-task.
_Avoid_: prompt, input (it is a structured multi-option selector, not a free prompt)

**Other fallback**:
The free-text escape hatch — every question auto-appends a "Type something." row so the user can always answer outside the offered options (or press Esc to abandon).
_Avoid_: custom input, free-text box (it is the auto-appended free-text fallback every question has)

**Reconciler** (`before_agent_start`):
Rewrites a pending `ask_user_question` tool call into the canonical question shape before the agent turn starts — so a malformed or model-shaped call still renders correctly.
_Avoid_: validator, normalizer (it is a pending-call canonicalization on `before_agent_start`)
