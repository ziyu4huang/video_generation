## Question
What are the concrete structural acceptance targets per package for the spec — file-count ceilings, layering rules, module map shape? Must be verifiable at spec acceptance time (structure, not LOC).
type: grilling
blocked by: 04

claimed: main-grilling (2026-08-17)

## Resolution
Four verifiable structure targets locked (user 2026-08-17):
1. Net file count across the four packages ≥ −3 (excluding tests).
2. Dead exports zero — re-run the ticket-02 census method at acceptance.
3. Docs match reality — re-run the ticket-01 drift census at acceptance; zero high/med findings remain.
4. Standing layering rule recorded: any new cross-package mirror must hoist to @repo/pi-agent-core-interface, never copy.
