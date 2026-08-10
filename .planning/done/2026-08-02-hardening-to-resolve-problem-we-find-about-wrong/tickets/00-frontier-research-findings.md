# Frontier research findings

type: research
Status: closed

## Question

Three grounding facts the map's open decisions wait on — resolved by reading
code during charting so the grilling tickets are sharp, not guesses.

## Resolution

Resolved 2026-08-02 by reading `src/superpowers.ts`, the pinned skill dirs, and
`pi-agent-ext-wayfind/`. Findings:

- **R1 — The bootstrap injection is unconditional.** `getBootstrapContent()` is
  wired to `session_start` / `session_compact`, gated only by "already present
  in visible messages" and "until first `agent_end`". It is **not** effort-gated.
  So `piBoundaryOverrides()` text reaches *every* session — ad-hoc brainstorms
  included. ⇒ The gap is the **content** ("Never write to the upstream paths
  *when an effort is active*"), not delivery. Hardening = change the text, not
  add a delivery path.
- **R2 — Specs/plans are prose-only; SDD/mockups are script-backed.**
  `skills/brainstorming/scripts/` holds only the *visual-companion* server
  (`start-server.sh` etc.); `skills/writing-plans/` has no path-resolving script
  at all (only reviewer prompts). So a spec/plan path is decided by the model
  following SKILL.md prose + the injected boundary text — **there is no script
  to override**. By contrast `scripts/sdd-workspace` and the visual server honor
  `PI_PLANNING_EFFORT`. ⇒ For specs/plans, enforcement can only be (a) stronger
  injected text + (b) a test/lint guard. A script-level redirect is unavailable
  for those two artifact kinds.
- **R3 — wayfind is leak-free; scope is superpowers-only.** `grep` for
  `docs/superpowers` / `.superpowers/` across `pi-agent-ext-wayfind/src` and
  `skills/` returns nothing; its commands write to `.planning/<effort>/`
  unconditionally (`src/commands.ts`). ⇒ This effort touches superpowers only.

These close the research frontier; the remaining open items are decisions
(tickets 01–04), not unknowns.
