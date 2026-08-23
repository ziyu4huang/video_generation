# Ticket 03 — impossible-tool pre-flight
**status:** done  **risk:** med  **size:** medium

## Goal
Fail fast when a task requires a tool absent from the subagent's allowlist.
Prevents impossible-task over-engineering (run mslovsnn: subagent lacked the
`memory` tool, burned 927k tok reverse-engineering a workaround instead of
failing).

## Design sketch
- Declaration-based: the dispatcher lists task-required tools; pre-flight
  verifies each is in the child's allowlist; else abort with a clear error
  ("task requires tool X, not in subagent allowlist").
- Pushes a small burden to the dispatcher but is deterministic and cheap.
- (Inference-based NLP on the task text is out of scope — too fuzzy.)

## Acceptance
1. declaration API chosen
2. pre-flight aborts with a clear message on a missing required tool
3. test: a dispatch requiring an absent tool fails fast (not a 900k-token loop)

## Files
subagent-tool.ts (dispatch path)

## Shipped
Shipped via #1277
